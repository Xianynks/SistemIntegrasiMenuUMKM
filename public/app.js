'use strict';
const $ = (s) => document.querySelector(s);
const rp = (n) => 'Rp' + Number(n).toLocaleString('id-ID');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (t) => new Date(t).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
const M = (h) => { $('#m').innerHTML = h ? `<div class="ov"><div class="sh">${h}</div></div>` : ''; };
const ROLE = { admin: 'Admin/Pemilik', penjaga: 'Penjaga' };

let me = null, info = { name: 'UMKM', tables: 12, address: '', hours: '', contact: '' };
let cat = '', cart = {}, D = {}, ITEMS = [], CATS = [], ORD = [], PAYS = [], FIN = null;
let pwOpen = false, pwMsg = '', lerr = '', tick = 0;
let QR = { image: null }, curOrd = null, pend = Promise.resolve();
const clampQ = (v) => Math.min(99, Math.max(1, parseInt(v, 10) || 1));
const enq = (f) => (pend = pend.then(f).catch(onError));
const admin = () => me && me.role === 'admin';
const cartN = () => Object.values(cart).reduce((a, c) => a + c.q, 0);
const tot = (o) => o.items.reduce((a, i) => a + i.price * i.qty, 0);

async function api(path, o = {}) {
  const r = await fetch('/api/' + path, {
    method: o.method || 'GET', credentials: 'same-origin',
    headers: o.body ? { 'content-type': 'application/json' } : {},
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  let d = {};
  try { d = await r.json(); } catch (e) { /* respons kosong */ }
  if (!r.ok) { const e = new Error(d.error || 'Permintaan gagal.'); e.status = r.status; throw e; }
  return d;
}

/* ---------- tampilan: katalog ---------- */
const card = (m) => `<div class="c${m.available ? '' : ' off'}" data-a="item" data-v="${m.id}"><div class="im">${m.image ? `<img src="${esc(m.image)}" alt="" loading="lazy">` : esc(m.emoji || '🍽️')}</div><b>${esc(m.name)}</b><small>${esc(m.category)}</small><span>${rp(m.price)}${m.available ? '' : ' · Habis'}</span></div>`;

function sect(t, chips) {
  const L = t === 'food' ? 'Makanan' : 'Minuman';
  const all = ITEMS.filter((m) => m.type === t);
  const cs = [...new Set([...all.map((m) => m.category), ...(me ? CATS.filter((c) => c.type === t).map((c) => c.name) : [])])];
  if (!cs.includes(cat)) cat = '';
  return `<div class="sec"><h3>Katalog ${L}</h3><span class="ga">${me && chips && cat ? `<button class="pl" data-a="dc" data-v="${t}">Hapus Kategori</button>` : ''}${me ? `<button class="b ad" data-a="new" data-v="${t}">+ Tambah ${L}</button>` : ''}</span></div>`
    + (chips ? `<div class="ch">${['', ...cs].map((c) => `<button class="${c === cat ? 'on' : ''}" data-a="cat" data-v="${esc(c)}">${esc(c) || 'Semua'}</button>`).join('')}${me ? `<button data-a="nc" data-v="${t}">+ Kategori</button>` : ''}</div>` : '')
    + `<div class="g">${all.filter((m) => !chips || !cat || m.category === cat).map(card).join('') || '<p class="mu">Belum ada item.</p>'}</div>`;
}

async function catalog(t) {
  [ITEMS, CATS] = await Promise.all([api(me ? 'staff/menus' : 'public/menu'), me ? api('staff/categories') : []]);
  return (t ? sect(t, 1) : sect('food') + sect('drink'))
    + (cartN() && !me ? `<button class="b fab" data-a="cart">🛒 Pesanan (${cartN()})</button>` : '');
}

function openItem(id, q) {
  const m = ITEMS.find((x) => x.id == id);
  M(`<div class="big">${m.image ? `<img src="${esc(m.image)}" alt="" style="max-width:100%;max-height:160px;border-radius:8px">` : esc(m.emoji || '🍽️')}</div><h3>${esc(m.name)}</h3><p class="mu">${esc(m.description)}</p><div class="r"><b>${rp(m.price)}</b><span class="st"><button data-a="qs" data-v="${id},-1">−</button><input class="qn" id="iq" type="number" inputmode="numeric" min="1" max="99" value="${q}" data-price="${m.price}"><button data-a="qs" data-v="${id},1">+</button></span></div><button class="b" id="addbtn" data-a="add" data-v="${id}">Tambah ke pesanan · ${rp(m.price * q)}</button><button class="b d" data-a="x">Tutup</button>`);
}

function openCart(err = '') {
  const it = Object.values(cart), t = it.reduce((a, c) => a + c.m.price * c.q, 0);
  D.idem = D.idem || crypto.randomUUID();
  M(`<h3>Pesanan Anda</h3>${it.map(({ m, q }) => `<div class="r"><span>${esc(m.emoji || '')} ${esc(m.name)}<br><small>${rp(m.price)}</small></span><span class="st"><button data-a="cq" data-v="${m.id},-1">−</button><input class="qn" type="number" inputmode="numeric" min="1" max="99" value="${q}" data-cart="${m.id}"><button data-a="cq" data-v="${m.id},1">+</button></span></div>`).join('')}
<label>Nama pemesan<input name="name" value="${esc(D.name)}"></label><label>Nomor meja (1–${info.tables})<input name="table" type="number" inputmode="numeric" value="${esc(D.table)}"></label><label>Catatan<textarea name="notes" rows="2">${esc(D.notes)}</textarea></label>
<div class="r"><b>Total</b><b id="ctot">${rp(t)}</b></div><p class="er">${esc(err)}</p><button class="b" data-a="send">Kirim Pesanan</button><button class="b d" data-a="x">Tutup</button>`);
}

/* ---------- tampilan: staf ---------- */
const lines = (o) => o.items.map((i) => `<div class="r"><span>${esc(i.name)}<br><small>${rp(i.price)} × ${i.qty}</small></span><b>${rp(i.price * i.qty)}</b></div>`).join('');
const ordList = (l, act, btn) => l.length ? l.map((o) => `<div class="cd"><div class="r"><b>Meja ${o.table} · ${o.code}</b><span class="tg ${o.status === 'baru' ? 't1' : 't2'}">${o.status === 'baru' ? 'Baru' : 'Siap Dibayar'}</span></div><small>${o.name ? esc(o.name) + ' · ' : ''}${fmt(o.createdAt)} · ${o.items.reduce((a, i) => a + i.qty, 0)} item · ${rp(o.total)}</small><button class="b o" data-a="${act}" data-v="${o.id}">${btn}</button></div>`).join('') : '<p class="mu">Belum ada pesanan.</p>';

function openOrder(id) {
  curOrd = id;
  const o = ORD.find((x) => x.id == id);
  const rows = o.items.map((i) => `<div class="r"><span>${esc(i.name)}<br><small>${rp(i.price)}</small></span><span class="st"><button data-a="ostep" data-v="${id},${i.id},-1">−</button><input class="qn" type="number" inputmode="numeric" min="0" max="99" value="${i.qty}" data-oq="${id},${i.id}"><button data-a="ostep" data-v="${id},${i.id},1">+</button></span></div>`).join('');
  M(`<h3>${o.code} · Meja ${o.table}</h3><p class="mu">${o.name ? esc(o.name) + ' · ' : ''}${fmt(o.createdAt)}${o.notes ? '<br>Catatan: ' + esc(o.notes) : ''}</p>${rows}<div class="r"><b>Total</b><b>${rp(tot(o))}</b></div><button class="b" data-a="ready" data-v="${id}">Pesanan Siap</button><button class="b o" data-a="cancel" data-v="${id}">Batalkan Pesanan</button><button class="b d" data-a="x">Tutup</button>`);
}

function openPay(id, err = '') {
  const o = ORD.find((x) => x.id == id);
  M(`<h3>Pembayaran ${o.code} · Meja ${o.table}</h3>${lines(o)}<div class="r"><b>Total</b><b>${rp(tot(o))}</b></div><div class="r"><span>Metode</span><span class="mt"><button class="b ad${D.meth === 'QRIS' ? '' : ' o'}" data-a="meth" data-v="${id},QRIS">QRIS</button><button class="b ad${D.meth === 'Cash' ? '' : ' o'}" data-a="meth" data-v="${id},Cash">Cash</button></span></div>${D.meth === 'QRIS' ? `<div class="im" style="max-width:260px;margin:10px auto">${QR.image ? `<img src="${esc(QR.image)}" alt="QRIS" style="object-fit:contain">` : '<small style="padding:12px;text-align:center">QRIS belum diunggah. Admin dapat mengunggahnya di tab Pembayaran.</small>'}</div><label><input type="checkbox" name="ver"${D.ver ? ' checked' : ''}>Saya sudah memverifikasi pembayaran masuk</label>` : ''}<p class="er">${esc(err)}</p><button class="b" data-a="pay" data-v="${id}">Konfirmasi Lunas</button><button class="b d" data-a="x">Tutup</button>`);
}

function openForm(err = '') {
  const e = !!D.id, prev = D.imgSet ? D.img : D.image;
  const opts = [...new Set([...ITEMS.filter((m) => m.type === D.type).map((m) => m.category), ...CATS.filter((c) => c.type === D.type).map((c) => c.name)])];
  M(`<h3>${e ? 'Edit' : 'Tambah'} ${D.type === 'food' ? 'Makanan' : 'Minuman'}</h3><div class="big">${prev ? `<img src="${esc(prev)}" alt="" style="max-width:100%;max-height:150px;border-radius:8px">` : esc(D.e || '🍽️')}</div><label>Upload gambar menu<input type="file" name="file" accept="image/*"></label>${prev ? '<button class="pl" data-a="rmimg">Hapus gambar</button>' : ''}
<label>Nama<input name="n" value="${esc(D.n)}"></label><label>Kategori<input name="c" list="cl" value="${esc(D.c)}"></label><datalist id="cl">${opts.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
<label>Harga (Rp)<input name="p" type="number" inputmode="numeric" value="${esc(D.p)}"></label><label>Deskripsi<textarea name="d" rows="2">${esc(D.d)}</textarea></label><label><input type="checkbox" name="a"${D.a ? ' checked' : ''}>Tersedia</label><p class="er">${esc(err)}</p>
<button class="b" data-a="saveit">Simpan</button>${e ? `<button class="b o" data-a="delit">${D.cd ? 'Yakin hapus? Ketuk lagi' : 'Hapus Item'}</button>` : ''}<button class="b d" data-a="x">Batal</button>`);
}

function openCat(err = '') {
  M(`<h3>Tambah Kategori ${D.type === 'food' ? 'Makanan' : 'Minuman'}</h3><label>Nama kategori<input name="nn" value="${esc(D.nn)}"></label><p class="er">${esc(err)}</p><button class="b" data-a="savecat">Simpan</button><button class="b d" data-a="x">Batal</button>`);
}

async function pesanan() {
  ORD = await api('staff/orders?status=baru');
  return `${ordList(ORD, 'vo', 'Lihat Pesanan')}`
    + (admin() ? `<div class="cd"><h3>Pengaturan Meja</h3><label>Jumlah meja (1–100)<input name="tb" type="number" value="${info.tables}"></label><button class="b" data-a="svt">Simpan</button></div>` : '');
}
async function bayar() {
  [ORD, QR] = await Promise.all([api('staff/orders?status=siap'), api('staff/qris')]);
  return ordList(ORD, 'vp', 'Proses Pembayaran') + (admin() ? `<div class="cd"><h3>QRIS UMKM</h3><div class="im" style="max-width:260px;margin:6px auto">${QR.image ? `<img src="${esc(QR.image)}" alt="QRIS" style="object-fit:contain">` : '<small style="padding:12px;text-align:center">Belum ada gambar QRIS</small>'}</div><label>${QR.image ? 'Ganti' : 'Upload'} gambar QRIS<input type="file" name="qris" accept="image/*"></label>${QR.image ? '<button class="b o" data-a="qrisrm">Hapus QRIS</button>' : ''}</div>` : '');
}

async function riwayat() {
  [PAYS, FIN] = await Promise.all([api('staff/payments'), admin() ? api('staff/finance') : null]);
  const hari = new Date().toLocaleDateString('id-ID', { dateStyle: 'long', timeZone: FIN?.tz });
  const bulan = new Date().toLocaleDateString('id-ID', { month: 'long', year: 'numeric', timeZone: FIN?.tz });
  return (FIN ? `<div class="cd"><div class="sec" style="margin-top:0"><h3>Buku Keuangan</h3><button class="b ad" data-a="xl">⬇ Ekspor Excel</button></div><div class="r"><span>Total pemasukan</span><b>${rp(FIN.total)}</b></div><div class="r"><span>Pemasukan hari ini<br><small>${hari}</small></span><b>${rp(FIN.today)}</b></div><div class="r"><span>Pemasukan bulan ini<br><small>${bulan}</small></span><b>${rp(FIN.month)}</b></div><div class="r"><span>QRIS</span><span>${rp(FIN.qris)}</span></div><div class="r"><span>Cash</span><span>${rp(FIN.cash)}</span></div></div>` : '')
    + '<div class="sec"><h3>Riwayat Pemesanan</h3></div>'
    + (PAYS.length ? PAYS.map((x) => `<div class="cd"><div class="r"><b>${x.code} · Meja ${x.table}</b><b>${rp(x.amount)}</b></div><small>${x.name ? esc(x.name) + ' · ' : ''}${fmt(x.paidAt)} · ${x.method} · dikonfirmasi ${esc(x.by)}</small><br><button class="pl" data-a="vh" data-v="${x.id}">Lihat Pesanan</button></div>`).join('') : '<p class="mu">Belum ada transaksi lunas.</p>');
}

async function sampah() {
  const l = await api('staff/trash'); window.TRASH = l;
  return (l.length ? l.map((m) => `<div class="cd"><span>${m.image ? `<img src="${esc(m.image)}" alt="" style="width:36px;height:36px;object-fit:cover;border-radius:6px;vertical-align:middle">` : esc(m.emoji || '🍽️')} <b>${esc(m.name)}</b><br><small>${m.type === 'food' ? 'Makanan' : 'Minuman'} · ${esc(m.category)} · ${rp(m.price)} · dihapus ${fmt(m.deletedAt)}</small></span><button class="b o" data-a="rs" data-v="${m.id}">Pulihkan</button><button class="b d" data-a="pd" data-v="${m.id}">${D.pd == m.id ? 'Yakin hapus permanen? Ketuk lagi' : 'Hapus Permanen'}</button></div>`).join('') : '<p class="mu">Sampah kosong.</p>');
}

async function about() {
  if (me) { try { me = await api('auth/me'); } catch (e) { /* sesi dicek di R */ } }
  const acc = me ? `<div class="cd"><h3>Akun Saya</h3><div class="r"><span>Nama</span><b>${esc(me.name)}</b></div><div class="r"><span>Email</span><b>${esc(me.email)}</b></div><div class="r"><span>Role</span><b>${ROLE[me.role]}</b></div>${me.passwordChangedAt ? `<div class="r"><span>Password diubah</span><b>${fmt(me.passwordChangedAt)}</b></div>` : ''}${pwOpen
    ? `<label>Password lama<input type="password" name="pw0" autocomplete="current-password"></label><label>Password baru (min. 8 karakter)<input type="password" name="pw1" autocomplete="new-password"></label><label>Konfirmasi password baru<input type="password" name="pw2" autocomplete="new-password"></label><p class="er">${esc(pwMsg)}</p><button class="b" data-a="pws">Simpan Password</button><button class="b d" data-a="pwc">Batal</button>`
    : `${pwMsg ? `<p class="ok">${esc(pwMsg)}</p>` : ''}<button class="b" data-a="pwo">Ubah Password</button>`}</div>` : '';
  return acc + `<div class="cd"><h3>${esc(info.name)}</h3><div class="r"><span>Alamat</span><span>${esc(info.address)}</span></div><div class="r"><span>Jam operasional</span><span>${esc(info.hours)}</span></div><div class="r"><span>Kontak</span><span>${esc(info.contact)}</span></div></div><div class="cd"><h3>Cara memesan</h3><p class="mu">Pilih menu, tekan tombol Pesanan, isi nomor meja, lalu kirim. Pembayaran dilakukan di kasir (QRIS atau Cash).</p></div>`
    + (me ? `<button class="b d" data-a="out">Keluar (${esc(me.name)})</button>` : '<button class="b o" data-a="go">Login Staf</button>');
}

const loginView = () => `<div class="cd"><h3>Login Staf</h3><label>Email<input name="email" type="email" autocomplete="username"></label><label>Password<input name="pw" type="password" autocomplete="current-password"></label><p class="er">${esc(lerr)}</p><button class="b" data-a="login">Masuk</button></div>`;

/* ---------- navigasi & render ---------- */
const GROUP = { menu: 'menu', makanan: 'menu', minuman: 'menu', pesanan: 'mgmt', bayar: 'mgmt', riwayat: 'mgmt', sampah: 'mgmt' };

function tabsFor(h, c) {
  const tab = (id, label, n) => `<a href="#${id}" class="${h === id ? 'on' : ''}">${label}${n ? `<em>${n}</em>` : ''}</a>`;
  if (GROUP[h] === 'menu') return `<div class="tabs">${tab('menu', 'Semua')}${tab('makanan', 'Makanan')}${tab('minuman', 'Minuman')}</div>`;
  if (GROUP[h] === 'mgmt') return `<div class="tabs">${tab('pesanan', 'Pesanan', c.baru)}${tab('bayar', 'Pembayaran', c.siap)}${tab('riwayat', 'Riwayat')}${admin() ? tab('sampah', 'Sampah') : ''}</div>`;
  return '';
}

function nav(h, c) {
  const g = GROUP[h] || h;
  const t = me
    ? [['menu', 'menu', '🍽️', 'Menu', 0], ['pesanan', 'mgmt', '📋', 'Management', c.baru + c.siap], ['about', 'about', '👤', 'About', 0]]
    : [['menu', 'menu', '🍽️', 'Menu', 0], ['about', 'about', 'ℹ️', 'About', 0]];
  $('#nv').innerHTML = t.map((x) => `<a href="#${x[0]}" class="${g === x[1] ? 'on' : ''}"><i>${x[2]}</i>${x[3]}${x[4] ? `<em>${x[4]}</em>` : ''}</a>`).join('');
}

const PAGES = { menu: () => catalog(), makanan: () => catalog('food'), minuman: () => catalog('drink'), about, login: async () => loginView(), pesanan, bayar, riwayat, sampah };

async function R() {
  const my = ++tick;
  let h = (location.hash || '#menu').slice(1);
  if (['pesanan', 'bayar', 'riwayat', 'sampah'].includes(h) && !me) h = 'login';
  if (h === 'sampah' && me && !admin()) h = 'pesanan';
  const none = { baru: 0, siap: 0 };
  const cnt = me ? api('staff/counts').catch(() => none) : Promise.resolve(none);
  try {
    const [html, c] = await Promise.all([(PAGES[h] || PAGES.menu)(), cnt]);
    if (my !== tick) return;
    $('#app').innerHTML = tabsFor(h, c) + html;
    nav(h, c);
  } catch (e) {
    if (my !== tick) return;
    if (e.status === 401) { me = null; location.hash = '#login'; return R(); }
    $('#app').innerHTML = tabsFor(h, none) + `<p class="er">${esc(e.message === 'Failed to fetch' ? 'Tidak ada koneksi internet.' : e.message)}</p>`;
    nav(h, none);
  }
}

/* ---------- aksi ---------- */
const reloadOrders = async (st) => { ORD = await api('staff/orders?status=' + st); };
const A = {
  x() { M(''); D = {}; curOrd = null; },
  item(v) {
    if (!me) return openItem(v, 1);
    const m = ITEMS.find((x) => x.id == v);
    D = { id: m.id, type: m.type, n: m.name, c: m.category, p: m.price, d: m.description, a: m.available, image: m.image, e: m.emoji };
    openForm();
  },
  qs(v) { const [i, d] = v.split(','); openItem(i, clampQ(Number($('#iq').value || 1) + Number(d))); },
  add(v) { const m = ITEMS.find((x) => x.id == v); cart[v] = { m, q: (cart[v]?.q || 0) + clampQ($('#iq').value) }; M(''); R(); },
  cart() { openCart(); },
  cq(v) { const [i, d] = v.split(','); cart[i].q += +d; if (cart[i].q <= 0) delete cart[i]; if (cartN()) openCart(); else { M(''); R(); } },
  cat(v) { cat = v; R(); },
  async send() {
    if (!navigator.onLine) return openCart('Tidak ada koneksi internet. Pesanan belum terkirim.');
    document.querySelectorAll('.qn[data-cart]').forEach((i) => { const c = cart[i.dataset.cart]; if (c) c.q = clampQ(i.value); });
    if (!(D.name || '').trim()) return openCart('Nama pemesan wajib diisi.');
    try {
      const r = await api('public/orders', { method: 'POST', body: { customerLabel: D.name, tableNumber: D.table, notes: D.notes, idempotencyKey: D.idem, items: Object.values(cart).map((c) => ({ menuId: c.m.id, quantity: c.q })) } });
      cart = {}; D = {};
      M(`<h3>Pesanan terkirim ✔</h3><p>Kode ${esc(r.code)} · Meja ${esc(r.table)}. Pihak UMKM akan memproses pesanan Anda.</p><button class="b" data-a="x">Tutup</button>`); R();
    } catch (e) { openCart(e.message === 'Failed to fetch' ? 'Koneksi terputus. Pesanan belum terkirim, coba lagi.' : e.message); }
  },
  go() { location.hash = '#login'; },
  async login() {
    try { me = await api('auth/login', { method: 'POST', body: { email: D.email, password: D.pw } }); lerr = ''; D = {}; location.hash = '#pesanan'; R(); }
    catch (e) { lerr = e.message; D = {}; R(); }
  },
  async out() { try { await api('auth/logout', { method: 'POST', body: {} }); } catch (e) { /* tetap keluar */ } me = null; pwOpen = false; pwMsg = ''; location.hash = '#menu'; R(); },
  vo(v) { openOrder(v); },
  async oq(v) {
    const [o, i, q] = v.split(',').map(Number);
    const r = await api(`staff/orders/${o}/items/${i}`, { method: 'PATCH', body: { quantity: q } });
    await reloadOrders('baru');
    if (r.cancelled) { M(''); curOrd = null; } else if (curOrd === o) openOrder(o);
    R();
  },
  ostep(v) {
    const [o, i, d] = v.split(',').map(Number);
    const inp = document.querySelector(`.qn[data-oq="${o},${i}"]`);
    const q = Math.min(99, Math.max(0, (parseInt(inp.value, 10) || 0) + d));
    return enq(() => A.oq(`${o},${i},${q}`));
  },
  async ready(v) { await pend; await api('staff/orders/' + v, { method: 'PATCH', body: { status: 'siap' } }); M(''); curOrd = null; R(); },
  async cancel(v) { await pend; await api('staff/orders/' + v, { method: 'PATCH', body: { status: 'batal' } }); M(''); curOrd = null; R(); },
  async qrisrm() { await api('staff/qris', { method: 'PUT', body: { image: null } }); R(); },
  vp(v) { D = {}; openPay(v); },
  meth(v) { const [i, m] = v.split(','); D.meth = m; openPay(i); },
  async pay(v) {
    if (!D.meth) return openPay(v, 'Pilih metode pembayaran.');
    if (D.meth === 'QRIS' && !D.ver) return openPay(v, 'Verifikasi pembayaran QRIS terlebih dahulu.');
    try { await api(`staff/orders/${v}/payments`, { method: 'POST', body: { method: D.meth, verified: !!D.ver } }); D = {}; M(''); R(); }
    catch (e) { if (e.status === 401) throw e; openPay(v, e.message); }
  },
  vh(v) {
    const x = PAYS.find((p) => p.id == v);
    M(`<h3>${x.code} · Meja ${x.table}</h3><p class="mu">${x.name ? esc(x.name) + ' · ' : ''}${x.notes ? 'Catatan: ' + esc(x.notes) : ''}</p>${lines(x)}<div class="r"><b>Total</b><b>${rp(x.amount)}</b></div><p class="mu">Dibayar ${x.method} · ${fmt(x.paidAt)} · dikonfirmasi ${esc(x.by)}</p><button class="b d" data-a="x">Tutup</button>`);
  },
  async xl() {
    if (!window.XLSX) return M('<h3>Ekspor belum tersedia</h3><p class="mu">Pustaka Excel gagal dimuat. Periksa koneksi internet lalu muat ulang halaman.</p><button class="b d" data-a="x">Tutup</button>');
    const d = await api('staff/finance/export');
    const wt = (t) => new Date(t).toLocaleString('id-ID', { timeZone: d.tz, dateStyle: 'short', timeStyle: 'short' });
    const rows = [['Waktu', 'Kode Pesanan', 'Nama Pemesan', 'Meja', 'Item', 'Jumlah', 'SubTotal', 'Total (Rp)', 'Dikonfirmasi oleh', 'Metode']];
    for (const t of d.transactions) {
      (t.items.length ? t.items : [null]).forEach((i, n) => rows.push([wt(t.paidAt), t.code, t.name || '-', t.table, i ? i.name : '-', i ? i.qty : '', i ? i.price * i.qty : '', n === 0 ? t.amount : '', t.by, t.method]));
    }
    const rec = (list, label) => [[label, 'Jumlah Transaksi', 'Item Terjual', 'QRIS (Rp)', 'Cash (Rp)', 'Total Pemasukan (Rp)'],
      ...list.map((r) => [r.key, r.trx, r.items, r.qris, r.cash, r.total]),
      ['Total', ...['trx', 'items', 'qris', 'cash', 'total'].map((k) => list.reduce((s, r) => s + r[k], 0))]];
    const sheets = [['Transaksi', rows, [18, 14, 18, 6, 24, 8, 12, 12, 18, 8]], ['Rekap Harian', rec(d.daily, 'Tanggal'), [14, 16, 14, 14, 14, 20]], ['Rekap Bulanan', rec(d.monthly, 'Bulan'), [12, 16, 14, 14, 14, 20]]];
    const wb = XLSX.utils.book_new();
    for (const [name, aoa, w] of sheets) { const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = w.map((wch) => ({ wch })); XLSX.utils.book_append_sheet(wb, ws, name); }
    XLSX.writeFile(wb, `Buku_Keuangan_${new Date().toISOString().slice(0, 7)}.xlsx`);
  },
  async svt() {
    const n = Number(D.tb ?? info.tables);
    const r = await api('staff/settings', { method: 'PUT', body: { tables: n } }); info.tables = r.tables;
    M(`<h3>Tersimpan</h3><p class="mu">Jumlah meja sekarang ${r.tables}.</p><button class="b d" data-a="x">Tutup</button>`);
  },
  new(t) { D = { type: t, a: true }; openForm(); },
  async saveit() {
    if (!(D.n || '').trim() || !(D.c || '').trim()) return openForm('Nama dan kategori wajib diisi.');
    if (!(Number(D.p) > 0)) return openForm('Harga harus angka lebih dari 0.');
    const body = { type: D.type, name: D.n, category: D.c, price: D.p, description: D.d, available: !!D.a, emoji: D.e || '🍽️' };
    if (D.imgSet) body.image = D.img;
    try { await api(D.id ? 'staff/menus/' + D.id : 'staff/menus', { method: D.id ? 'PUT' : 'POST', body }); D = {}; M(''); R(); }
    catch (e) { if (e.status === 401) throw e; openForm(e.message); }
  },
  rmimg() { D.img = null; D.imgSet = true; openForm(); },
  async delit() {
    if (!D.cd) { D.cd = 1; return openForm(); }
    await api('staff/menus/' + D.id, { method: 'DELETE' }); D = {}; M(''); R();
  },
  nc(v) { D = { type: v }; openCat(); },
  async savecat() {
    const n = (D.nn || '').trim();
    if (!n) return openCat('Nama kategori wajib diisi.');
    try { await api('staff/categories', { method: 'POST', body: { type: D.type, name: n } }); cat = n; D = {}; M(''); R(); }
    catch (e) { if (e.status === 401) throw e; openCat(e.message); }
  },
  dc(v) {
    const n = ITEMS.filter((m) => m.type === v && m.category === cat).length;
    D = { type: v, dc: cat };
    M(`<h3>Hapus kategori “${esc(cat)}”?</h3><p class="mu">${n ? `${n} item di kategori ini akan dipindahkan ke Sampah dan bisa dipulihkan admin.` : 'Kategori ini belum memiliki item.'}</p><button class="b" data-a="dcy">Hapus Kategori</button><button class="b d" data-a="x">Batal</button>`);
  },
  async dcy() {
    const c = CATS.find((k) => k.type === D.type && k.name === D.dc);
    if (c) await api('staff/categories/' + c.id, { method: 'DELETE' });
    cat = ''; D = {}; M(''); R();
  },
  async rs(v) { await api(`staff/trash/${v}/restore`, { method: 'POST', body: {} }); R(); },
  async pd(v) { if (D.pd != v) { D.pd = v; return R(); } await api('staff/trash/' + v, { method: 'DELETE' }); D = {}; R(); },
  pwo() { pwOpen = true; pwMsg = ''; D = {}; R(); },
  pwc() { pwOpen = false; pwMsg = ''; D = {}; R(); },
  async pws() {
    try {
      me = await api('auth/password', { method: 'PATCH', body: { currentPassword: D.pw0, newPassword: D.pw1, confirmPassword: D.pw2 } });
      pwOpen = false; pwMsg = 'Password berhasil diubah.'; D = {};
    } catch (e) { if (e.status === 401) throw e; pwMsg = e.message; D = {}; }
    R();
  },
};

function onError(e) {
  if (e && e.status === 401) { me = null; M(''); location.hash = '#login'; R(); return; }
  M(`<h3>Gagal</h3><p class="mu">${esc(e && e.message === 'Failed to fetch' ? 'Tidak ada koneksi internet.' : e && e.message)}</p><button class="b d" data-a="x">Tutup</button>`);
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-a]');
  if (t && A[t.dataset.a]) return void Promise.resolve().then(() => A[t.dataset.a](t.dataset.v)).catch(onError);
  if (e.target.classList.contains('ov')) A.x();
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'iq') { $('#addbtn').textContent = 'Tambah ke pesanan · ' + rp(clampQ(t.value) * Number(t.dataset.price)); return; }
  if (t.name) D[t.name] = t.type === 'checkbox' ? t.checked : t.value;
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.cart) {
    const c = cart[t.dataset.cart];
    if (c) { c.q = clampQ(t.value); t.value = c.q; $('#ctot').textContent = rp(Object.values(cart).reduce((s, x) => s + x.m.price * x.q, 0)); }
    return;
  }
  if (t.dataset.oq) {
    const [o, i] = t.dataset.oq.split(',');
    const q = Math.min(99, Math.max(0, parseInt(t.value, 10) || 0));
    enq(() => A.oq(`${o},${i},${q}`));
    return;
  }
  if (t.type !== 'file' || !t.files[0]) return;
  const isQ = t.name === 'qris';
  const fr = new FileReader();
  fr.onload = () => {
    const im = new Image();
    im.onload = () => {
      const max = isQ ? 700 : 360, k = Math.min(1, max / Math.max(im.width, im.height)), c = document.createElement('canvas');
      c.width = im.width * k; c.height = im.height * k; c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      if (!isQ) { D.img = c.toDataURL('image/jpeg', 0.75); D.imgSet = true; return openForm(); }
      let data = c.toDataURL('image/png');
      if (data.length > 550000) data = c.toDataURL('image/jpeg', 0.9);
      enq(async () => { await api('staff/qris', { method: 'PUT', body: { image: data } }); R(); });
    };
    im.src = fr.result;
  };
  fr.readAsDataURL(t.files[0]);
});
window.addEventListener('hashchange', () => { cat = ''; pwOpen = false; pwMsg = ''; lerr = ''; D = {}; R(); });

(async () => {
  try { [info, me] = await Promise.all([api('public/info'), api('auth/me').catch(() => null)]); } catch (e) { /* tetap tampil dengan data bawaan */ }
  $('#bn').textContent = '🍜 ' + info.name;
  document.title = info.name + ' · Katalog & Pemesanan';
  R();
})();
