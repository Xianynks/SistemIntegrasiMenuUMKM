import { neon } from '@neondatabase/serverless';
import { hashPassword, verifyPassword, signToken, verifyToken } from './auth.js';

const SESSION_SECONDS = 12 * 3600;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
const toInt = (v) => (typeof v === 'number' && Number.isInteger(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN);
const str = (v, max) => String(v ?? '').trim().slice(0, max);

async function readJson(req) {
  if (!(req.headers.get('content-type') || '').includes('application/json')) fail(415, 'Format permintaan harus JSON.');
  if (Number(req.headers.get('content-length') || 0) > 1_000_000) fail(413, 'Permintaan terlalu besar.');
  try { return (await req.json()) ?? {}; } catch { return fail(400, 'JSON tidak valid.'); }
}

const cookie = (token, age) => `sid=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${age}`;
const getCookie = (req, name) =>
  (req.headers.get('cookie') || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1];
const issueToken = (env, u) =>
  signToken({ uid: u.id, tv: u.token_version, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS }, env.JWT_SECRET);
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, passwordChangedAt: u.password_changed_at });

async function authenticate(req, env, sql) {
  const token = getCookie(req, 'sid');
  const payload = token && (await verifyToken(token, env.JWT_SECRET));
  if (!payload) return null;
  const [u] = await sql`SELECT id, name, email, role, token_version, password_changed_at FROM users WHERE id = ${payload.uid}`;
  return u && u.token_version === payload.tv ? u : null;
}

const routes = [];
const route = (method, path, access, handler) =>
  routes.push({ method, access, handler, re: new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') });

const tableCount = async (sql) => {
  const [r] = await sql`SELECT value FROM settings WHERE key = 'table_count'`;
  return r ? Number(r.value) : 12;
};
const mapMenu = (r) => ({
  id: r.id, name: r.name, price: r.price, description: r.description, emoji: r.emoji,
  available: r.is_available, category: r.cat, categoryId: r.cid, type: r.type,
  image: r.has_img ? `/api/public/menu/${r.id}/image?v=${r.v}` : null,
});
const mapOrder = (o) => ({
  id: o.id, code: o.code, table: o.table, name: o.name, notes: o.notes, status: o.status, createdAt: o.created_at,
  items: o.items, total: o.items.reduce((a, i) => a + i.price * i.qty, 0),
});

/* ---------- PUBLIK ---------- */
route('GET', '/api/public/info', null, async ({ env, sql }) =>
  json({
    name: env.BUSINESS_NAME || 'UMKM', address: env.BUSINESS_ADDRESS || '', hours: env.BUSINESS_HOURS || '',
    contact: env.BUSINESS_CONTACT || '', tables: await tableCount(sql),
  }));

route('GET', '/api/public/menu', null, async ({ sql }) => {
  const rows = await sql`
    SELECT m.id, m.name, m.price, m.description, m.emoji, m.is_available, (m.image_b64 IS NOT NULL) AS has_img,
           extract(epoch FROM m.updated_at)::int AS v, c.id AS cid, c.name AS cat, c.menu_type AS type
    FROM menus m JOIN menu_categories c ON c.id = m.category_id
    WHERE m.deleted_at IS NULL AND c.deleted_at IS NULL AND m.is_available
    ORDER BY c.name, m.name`;
  return json(rows.map(mapMenu));
});

route('GET', '/api/public/menu/:id/image', null, async ({ sql, params }) => {
  const [r] = await sql`SELECT image_b64, image_mime FROM menus WHERE id = ${toInt(params.id) || 0} AND deleted_at IS NULL AND image_b64 IS NOT NULL`;
  if (!r) return new Response('Not found', { status: 404 });
  return new Response(Uint8Array.from(atob(r.image_b64), (c) => c.charCodeAt(0)), {
    headers: { 'content-type': r.image_mime, 'cache-control': 'public, max-age=86400' },
  });
});

route('POST', '/api/public/orders', null, async ({ req, sql }) => {
  const b = await readJson(req);
  const tables = await tableCount(sql);
  const table = toInt(b.tableNumber);
  if (!(table >= 1 && table <= tables)) fail(400, `Nomor meja harus 1 sampai ${tables}.`);
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 50) fail(400, 'Pilih minimal satu menu.');
  const want = new Map();
  for (const i of b.items) {
    const id = toInt(i.menuId), q = toInt(i.quantity);
    if (!(id > 0 && q >= 1 && q <= 99)) fail(400, 'Item pesanan tidak valid.');
    want.set(id, (want.get(id) || 0) + q);
  }
  const ids = [...want.keys()];
  // Harga selalu diambil dari database, bukan dari klien.
  const rows = await sql`
    SELECT m.id, m.name, m.price FROM menus m JOIN menu_categories c ON c.id = m.category_id
    WHERE m.id = ANY(${ids}) AND m.deleted_at IS NULL AND c.deleted_at IS NULL AND m.is_available`;
  if (rows.length !== ids.length) fail(409, 'Ada menu yang sudah tidak tersedia. Muat ulang halaman.');
  const idem = typeof b.idempotencyKey === 'string' && /^[\w-]{8,64}$/.test(b.idempotencyKey) ? b.idempotencyKey : null;
  if (idem) {
    const [dup] = await sql`SELECT order_code FROM orders WHERE idem_key = ${idem}`;
    if (dup) return json({ code: dup.order_code, table });
  }
  const [{ id: oid }] = await sql`SELECT nextval('orders_id_seq') AS id`;
  const code = 'ORD-' + String(oid).padStart(4, '0');
  await sql.transaction([
    sql`INSERT INTO orders (id, order_code, table_number, customer_label, notes, idem_key)
        VALUES (${oid}, ${code}, ${table}, ${str(b.customerLabel, 40)}, ${str(b.notes, 200)}, ${idem})`,
    ...rows.map((r) => sql`INSERT INTO order_items (order_id, menu_id, menu_name, unit_price, quantity)
        VALUES (${oid}, ${r.id}, ${r.name}, ${r.price}, ${want.get(r.id)})`),
  ]);
  return json({ code, table, total: rows.reduce((a, r) => a + r.price * want.get(r.id), 0) }, 201);
});

/* ---------- AUTENTIKASI ---------- */
route('POST', '/api/auth/login', null, async ({ req, env, sql }) => {
  const b = await readJson(req);
  const email = str(b.email, 120).toLowerCase(), password = String(b.password ?? '');
  const [u] = await sql`SELECT * FROM users WHERE lower(email) = ${email}`;
  if (u?.locked_until && new Date(u.locked_until) > new Date()) fail(429, 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.');
  if (!u || !(await verifyPassword(password, u.password_hash))) {
    if (u) await sql`UPDATE users SET failed_count = failed_count + 1,
        locked_until = CASE WHEN failed_count + 1 >= 5 THEN now() + interval '5 minutes' ELSE NULL END WHERE id = ${u.id}`;
    fail(401, 'Email atau password salah.');
  }
  await sql`UPDATE users SET failed_count = 0, locked_until = NULL WHERE id = ${u.id}`;
  return json(publicUser(u), 200, { 'set-cookie': cookie(await issueToken(env, u), SESSION_SECONDS) });
});

route('POST', '/api/auth/logout', null, async () => json({ ok: true }, 200, { 'set-cookie': cookie('', 0) }));

route('GET', '/api/auth/me', 'staff', async ({ user }) => json(publicUser(user)));

route('PATCH', '/api/auth/password', 'staff', async ({ req, env, sql, user }) => {
  const b = await readJson(req);
  const cur = String(b.currentPassword ?? ''), next = String(b.newPassword ?? '');
  const [u] = await sql`SELECT password_hash FROM users WHERE id = ${user.id}`;
  if (!(await verifyPassword(cur, u.password_hash))) fail(400, 'Password lama salah.');
  if (next.length < 8) fail(400, 'Password baru minimal 8 karakter.');
  if (next === cur) fail(400, 'Password baru tidak boleh sama dengan password lama.');
  if (next !== String(b.confirmPassword ?? '')) fail(400, 'Konfirmasi password tidak cocok.');
  // token_version naik: semua sesi lama otomatis tidak berlaku, sesi ini diperbarui.
  const [n] = await sql`UPDATE users SET password_hash = ${await hashPassword(next)}, token_version = token_version + 1,
      password_changed_at = now() WHERE id = ${user.id} RETURNING id, name, email, role, token_version, password_changed_at`;
  return json(publicUser(n), 200, { 'set-cookie': cookie(await issueToken(env, n), SESSION_SECONDS) });
});

/* ---------- STAF: PESANAN & PEMBAYARAN ---------- */
route('GET', '/api/staff/counts', 'staff', async ({ sql }) => {
  const [r] = await sql`SELECT count(*) FILTER (WHERE status = 'baru')::int AS baru,
      count(*) FILTER (WHERE status = 'siap')::int AS siap FROM orders`;
  return json(r);
});

route('GET', '/api/staff/orders', 'staff', async ({ sql, url }) => {
  const status = ['baru', 'siap', 'lunas'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'baru';
  const rows = await sql`
    SELECT o.id, o.order_code AS code, o.table_number AS "table", o.customer_label AS name, o.notes, o.status, o.created_at,
      COALESCE((SELECT json_agg(json_build_object('id', i.id, 'name', i.menu_name, 'price', i.unit_price, 'qty', i.quantity) ORDER BY i.id)
                FROM order_items i WHERE i.order_id = o.id), '[]'::json) AS items
    FROM orders o WHERE o.status = ${status} ORDER BY o.id DESC LIMIT 200`;
  return json(rows.map(mapOrder));
});

route('PATCH', '/api/staff/orders/:id', 'staff', async ({ req, sql, params }) => {
  const id = toInt(params.id), status = (await readJson(req)).status;
  let rows;
  if (status === 'siap') rows = await sql`UPDATE orders SET status = 'siap' WHERE id = ${id} AND status = 'baru'
      AND EXISTS (SELECT 1 FROM order_items WHERE order_id = ${id}) RETURNING id`;
  else if (status === 'batal') rows = await sql`UPDATE orders SET status = 'batal' WHERE id = ${id} AND status IN ('baru','siap') RETURNING id`;
  else fail(400, 'Status tidak valid.');
  if (!rows.length) fail(409, 'Status pesanan tidak dapat diubah.');
  return json({ ok: true });
});

route('PATCH', '/api/staff/orders/:id/items/:itemId', 'staff', async ({ req, sql, params }) => {
  const oid = toInt(params.id), iid = toInt(params.itemId), q = toInt((await readJson(req)).quantity);
  if (!(q >= 0 && q <= 99)) fail(400, 'Jumlah tidak valid.');
  const [o] = await sql`SELECT status FROM orders WHERE id = ${oid}`;
  if (!o || o.status !== 'baru') fail(409, 'Pesanan tidak dapat diubah.');
  if (q === 0) await sql`DELETE FROM order_items WHERE id = ${iid} AND order_id = ${oid}`;
  else await sql`UPDATE order_items SET quantity = ${q} WHERE id = ${iid} AND order_id = ${oid}`;
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM order_items WHERE order_id = ${oid}`;
  if (n === 0) await sql`UPDATE orders SET status = 'batal' WHERE id = ${oid}`;
  return json({ ok: true, cancelled: n === 0 });
});

route('POST', '/api/staff/orders/:id/payments', 'staff', async ({ req, sql, params, user }) => {
  const id = toInt(params.id), b = await readJson(req);
  if (!['QRIS', 'Cash'].includes(b.method)) fail(400, 'Pilih metode pembayaran.');
  if (b.method === 'QRIS' && b.verified !== true) fail(400, 'Verifikasi pembayaran QRIS terlebih dahulu.');
  // Satu pernyataan atomik: pesanan -> lunas, catat pembayaran, catat buku keuangan.
  const rows = await sql`
    WITH o AS (UPDATE orders SET status = 'lunas' WHERE id = ${id} AND status = 'siap' RETURNING id, order_code),
    p AS (INSERT INTO payments (order_id, amount, method, confirmed_by, confirmed_name)
          SELECT o.id, (SELECT SUM(unit_price * quantity) FROM order_items WHERE order_id = o.id)::int, ${b.method}, ${user.id}, ${user.name}
          FROM o RETURNING id, amount, order_id)
    INSERT INTO financial_entries (payment_id, amount, description)
    SELECT p.id, p.amount, 'Pembayaran ' || o.order_code FROM p JOIN o ON o.id = p.order_id RETURNING payment_id`;
  if (!rows.length) fail(409, 'Pesanan belum siap atau sudah dibayar.');
  return json({ ok: true }, 201);
});

route('GET', '/api/staff/payments', 'staff', async ({ sql }) => {
  const rows = await sql`
    SELECT p.id, o.order_code AS code, o.table_number AS "table", o.customer_label AS name, o.notes, p.amount,
           p.method, p.confirmed_name AS by, p.paid_at,
      COALESCE((SELECT json_agg(json_build_object('id', i.id, 'name', i.menu_name, 'price', i.unit_price, 'qty', i.quantity) ORDER BY i.id)
                FROM order_items i WHERE i.order_id = o.id), '[]'::json) AS items
    FROM payments p JOIN orders o ON o.id = p.order_id ORDER BY p.paid_at DESC LIMIT 500`;
  return json(rows.map((r) => ({ id: r.id, code: r.code, table: r.table, name: r.name, notes: r.notes, amount: r.amount,
    method: r.method, by: r.by, paidAt: r.paid_at, items: r.items })));
});

route('GET', '/api/staff/finance', 'admin', async ({ env, sql }) => {
  const tz = env.TIMEZONE || 'Asia/Jakarta';
  const [t] = await sql`
    SELECT COALESCE(SUM(amount), 0)::int AS total,
      COALESCE(SUM(amount) FILTER (WHERE method = 'QRIS'), 0)::int AS qris,
      COALESCE(SUM(amount) FILTER (WHERE method = 'Cash'), 0)::int AS cash,
      COALESCE(SUM(amount) FILTER (WHERE date_trunc('month', paid_at AT TIME ZONE ${tz}) = date_trunc('month', now() AT TIME ZONE ${tz})), 0)::int AS month
    FROM payments`;
  const monthly = await sql`SELECT to_char(paid_at AT TIME ZONE ${tz}, 'YYYY-MM') AS month, SUM(amount)::int AS total
      FROM payments GROUP BY 1 ORDER BY 1`;
  return json({ ...t, monthly, tz });
});

route('PUT', '/api/staff/settings', 'admin', async ({ req, sql }) => {
  const n = toInt((await readJson(req)).tables);
  if (!(n >= 1 && n <= 100)) fail(400, 'Jumlah meja harus 1 sampai 100.');
  await sql`INSERT INTO settings (key, value) VALUES ('table_count', ${String(n)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  return json({ tables: n });
});

/* ---------- STAF: MENU & KATEGORI ---------- */
route('GET', '/api/staff/categories', 'staff', async ({ sql }) => {
  const rows = await sql`SELECT id, name, menu_type AS type FROM menu_categories WHERE deleted_at IS NULL ORDER BY name`;
  return json(rows);
});

route('POST', '/api/staff/categories', 'staff', async ({ req, sql }) => {
  const b = await readJson(req), name = str(b.name, 40);
  if (!['food', 'drink'].includes(b.type)) fail(400, 'Jenis kategori tidak valid.');
  if (!name) fail(400, 'Nama kategori wajib diisi.');
  const [dup] = await sql`SELECT id FROM menu_categories WHERE menu_type = ${b.type} AND lower(name) = lower(${name}) AND deleted_at IS NULL`;
  if (dup) fail(409, 'Kategori sudah ada.');
  const [c] = await sql`INSERT INTO menu_categories (menu_type, name) VALUES (${b.type}, ${name}) RETURNING id, name, menu_type AS type`;
  return json(c, 201);
});

route('DELETE', '/api/staff/categories/:id', 'staff', async ({ sql, params }) => {
  const id = toInt(params.id);
  // Soft delete: kategori dan semua menu di dalamnya masuk Sampah (bisa dipulihkan admin).
  await sql.transaction([
    sql`UPDATE menus SET deleted_at = now(), updated_at = now() WHERE category_id = ${id} AND deleted_at IS NULL`,
    sql`UPDATE menu_categories SET deleted_at = now() WHERE id = ${id} AND deleted_at IS NULL`,
  ]);
  return json({ ok: true });
});

route('GET', '/api/staff/menus', 'staff', async ({ sql }) => {
  const rows = await sql`
    SELECT m.id, m.name, m.price, m.description, m.emoji, m.is_available, (m.image_b64 IS NOT NULL) AS has_img,
           extract(epoch FROM m.updated_at)::int AS v, c.id AS cid, c.name AS cat, c.menu_type AS type
    FROM menus m JOIN menu_categories c ON c.id = m.category_id
    WHERE m.deleted_at IS NULL AND c.deleted_at IS NULL ORDER BY c.name, m.name`;
  return json(rows.map(mapMenu));
});

function parseMenu(b) {
  const type = ['food', 'drink'].includes(b.type) ? b.type : fail(400, 'Jenis menu tidak valid.');
  const name = str(b.name, 80), category = str(b.category, 40), price = toInt(b.price);
  if (!name || !category) fail(400, 'Nama dan kategori wajib diisi.');
  if (!(price > 0 && price <= 10_000_000)) fail(400, 'Harga harus angka lebih dari 0.');
  let image; // undefined = biarkan, null = hapus, objek = ganti
  if (b.image === null) image = null;
  else if (typeof b.image === 'string') {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(b.image);
    if (!m || m[2].length > 600_000) fail(400, 'Gambar tidak valid atau terlalu besar.');
    image = { mime: m[1], b64: m[2] };
  }
  return { type, name, category, price, description: str(b.description, 300), emoji: str(b.emoji, 8) || null,
    available: b.available !== false, image };
}

async function ensureCategory(sql, type, name) {
  const [c] = await sql`SELECT id FROM menu_categories WHERE menu_type = ${type} AND lower(name) = lower(${name}) AND deleted_at IS NULL`;
  if (c) return c.id;
  const [n] = await sql`INSERT INTO menu_categories (menu_type, name) VALUES (${type}, ${name}) RETURNING id`;
  return n.id;
}

route('POST', '/api/staff/menus', 'staff', async ({ req, sql }) => {
  const m = parseMenu(await readJson(req));
  const cid = await ensureCategory(sql, m.type, m.category);
  const [r] = await sql`INSERT INTO menus (category_id, name, price, description, emoji, is_available, image_b64, image_mime)
      VALUES (${cid}, ${m.name}, ${m.price}, ${m.description}, ${m.emoji}, ${m.available}, ${m.image?.b64 ?? null}, ${m.image?.mime ?? null})
      RETURNING id`;
  return json({ id: r.id }, 201);
});

route('PUT', '/api/staff/menus/:id', 'staff', async ({ req, sql, params }) => {
  const id = toInt(params.id), m = parseMenu(await readJson(req));
  const cid = await ensureCategory(sql, m.type, m.category);
  const setImg = m.image !== undefined;
  const rows = await sql`UPDATE menus SET category_id = ${cid}, name = ${m.name}, price = ${m.price}, description = ${m.description},
      emoji = ${m.emoji}, is_available = ${m.available}, updated_at = now(),
      image_b64 = CASE WHEN ${setImg} THEN ${m.image?.b64 ?? null} ELSE image_b64 END,
      image_mime = CASE WHEN ${setImg} THEN ${m.image?.mime ?? null} ELSE image_mime END
      WHERE id = ${id} AND deleted_at IS NULL RETURNING id`;
  if (!rows.length) fail(404, 'Item tidak ditemukan.');
  return json({ ok: true });
});

route('DELETE', '/api/staff/menus/:id', 'staff', async ({ sql, params }) => {
  await sql`UPDATE menus SET deleted_at = now(), updated_at = now() WHERE id = ${toInt(params.id)} AND deleted_at IS NULL`;
  return json({ ok: true });
});

/* ---------- ADMIN: SAMPAH ---------- */
route('GET', '/api/staff/trash', 'admin', async ({ sql }) => {
  const rows = await sql`
    SELECT m.id, m.name, m.price, m.emoji, m.deleted_at, (m.image_b64 IS NOT NULL) AS has_img,
           extract(epoch FROM m.updated_at)::int AS v, c.name AS cat, c.menu_type AS type
    FROM menus m JOIN menu_categories c ON c.id = m.category_id
    WHERE m.deleted_at IS NOT NULL ORDER BY m.deleted_at DESC`;
  return json(rows.map((r) => ({ id: r.id, name: r.name, price: r.price, emoji: r.emoji, category: r.cat, type: r.type,
    deletedAt: r.deleted_at, image: r.has_img ? `/api/public/menu/${r.id}/image?v=${r.v}` : null })));
});

route('POST', '/api/staff/trash/:id/restore', 'admin', async ({ sql, params }) => {
  const id = toInt(params.id);
  const [m] = await sql`SELECT m.category_id, c.menu_type, c.name, c.deleted_at AS cd
      FROM menus m JOIN menu_categories c ON c.id = m.category_id WHERE m.id = ${id} AND m.deleted_at IS NOT NULL`;
  if (!m) fail(404, 'Item tidak ditemukan di Sampah.');
  let cid = m.category_id;
  if (m.cd) {
    const [active] = await sql`SELECT id FROM menu_categories WHERE menu_type = ${m.menu_type}
        AND lower(name) = lower(${m.name}) AND deleted_at IS NULL`;
    if (active) cid = active.id;
    else await sql`UPDATE menu_categories SET deleted_at = NULL WHERE id = ${cid}`;
  }
  await sql`UPDATE menus SET deleted_at = NULL, category_id = ${cid}, updated_at = now() WHERE id = ${id}`;
  return json({ ok: true });
});

route('DELETE', '/api/staff/trash/:id', 'admin', async ({ sql, params }) => {
  await sql`DELETE FROM menus WHERE id = ${toInt(params.id)} AND deleted_at IS NOT NULL`;
  return json({ ok: true });
});

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      if (!['GET', 'HEAD'].includes(req.method)) {
        const origin = req.headers.get('origin');
        if (origin && new URL(origin).host !== url.host) fail(403, 'Origin tidak diizinkan.');
      }
      const hit = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!hit) fail(404, 'Endpoint tidak ditemukan.');
      if (!env.DATABASE_URL || !env.JWT_SECRET) fail(500, 'Server belum dikonfigurasi (DATABASE_URL / JWT_SECRET).');
      const sql = neon(env.DATABASE_URL);
      const params = url.pathname.match(hit.re).groups || {};
      let user = null;
      if (hit.access) {
        user = await authenticate(req, env, sql);
        if (!user) fail(401, 'Silakan login.');
        if (hit.access === 'admin' && user.role !== 'admin') fail(403, 'Akses ditolak.');
      }
      return await hit.handler({ req, env, sql, url, params, user });
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Terjadi kesalahan server.' }, 500);
    }
  },
};
