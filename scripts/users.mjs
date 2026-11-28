// Kelola akun lewat source code (tanpa UI). Jalankan dari folder proyek:
//   npm run user -- list
//   npm run user -- add --name "Nama" --email a@b.id --role admin|staff [--password ...]
//   npm run user -- update --email a@b.id [--name "Baru"] [--new-email c@d.id] [--role admin|staff]
//   npm run user -- passwd --email a@b.id [--password ...]
//   npm run user -- unlock --email a@b.id
//   npm run user -- logout --email a@b.id
//   npm run user -- delete --email a@b.id --yes
// Database yang dipakai: DATABASE_URL dari environment, atau dari .dev.vars bila tidak ada.
import { readFileSync, existsSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { hashPassword } from '../src/auth.js';

const env = { ...process.env };
const devVars = new URL('../.dev.vars', import.meta.url);
if (existsSync(devVars)) {
  for (const line of readFileSync(devVars, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && env[m[1]] === undefined) env[m[1]] = m[2];
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith('--')) continue;
  const next = rest[i + 1];
  if (next === undefined || next.startsWith('--')) flags[rest[i].slice(2)] = true;
  else { flags[rest[i].slice(2)] = next; i++; }
}

// Tiga jenis akun, dua tingkat akses: Pemilik dan Admin (Tim Developer) = 'admin', Staff = 'penjaga'.
const ROLES = { admin: 'admin', pemilik: 'admin', developer: 'admin', staff: 'penjaga', penjaga: 'penjaga' };
const USAGE = `Perintah: list | add | update | passwd | unlock | logout | delete
Contoh : npm run user -- add --name "Pak Budi" --email budi@contoh.id --role pemilik
Role   : admin / pemilik / developer (akses penuh)  |  staff / penjaga (pesanan, pembayaran, menu)`;

const fail = (msg) => { console.error('Error: ' + msg); process.exit(1); };
const need = (k) => (typeof flags[k] === 'string' && flags[k].trim() ? flags[k].trim() : fail(`--${k} wajib diisi.`));
const roleOf = (v) => ROLES[String(v).toLowerCase()] ?? fail('--role harus: admin, pemilik, developer, staff, atau penjaga.');
const genPassword = () => {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(14)), (b) => a[b % a.length]).join('');
};
const pickPassword = () => {
  const pw = typeof flags.password === 'string' ? flags.password : genPassword();
  if (pw.length < 8) fail('Password minimal 8 karakter.');
  return pw;
};

if (!cmd || !['list', 'add', 'update', 'passwd', 'unlock', 'logout', 'delete'].includes(cmd)) { console.log(USAGE); process.exit(cmd ? 1 : 0); }
if (!env.DATABASE_URL) fail('DATABASE_URL belum diatur (.dev.vars atau environment).');
const sql = neon(env.DATABASE_URL);

async function findUser() {
  const email = need('email').toLowerCase();
  const [u] = await sql`SELECT id, name, email, role FROM users WHERE lower(email) = ${email}`;
  return u ?? fail(`Akun ${email} tidak ditemukan.`);
}
async function assertOtherAdmin(id) {
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND id <> ${id}`;
  if (n === 0) fail('Tidak boleh menghapus atau menurunkan satu-satunya akun admin.');
}
const roleLabel = (r) => (r === 'admin' ? 'admin (pemilik/developer)' : 'penjaga (staff)');

if (cmd === 'list') {
  const rows = await sql`SELECT id, name, email, role, password_changed_at, locked_until, created_at FROM users ORDER BY id`;
  console.table(rows.map((r) => ({
    id: r.id, nama: r.name, email: r.email, role: roleLabel(r.role),
    dibuat: new Date(r.created_at).toISOString().slice(0, 10),
    password_diubah: r.password_changed_at ? new Date(r.password_changed_at).toISOString().slice(0, 10) : '-',
    terkunci: r.locked_until && new Date(r.locked_until) > new Date() ? 'ya' : '-',
  })));
}

if (cmd === 'add') {
  const name = need('name'), email = need('email').toLowerCase(), role = roleOf(need('role')), pw = pickPassword();
  if (!/^\S+@\S+\.\S+$/.test(email)) fail('Format email tidak valid.');
  const res = await sql`INSERT INTO users (name, email, password_hash, role)
      VALUES (${name}, ${email}, ${await hashPassword(pw)}, ${role}) ON CONFLICT (email) DO NOTHING RETURNING id`;
  if (!res.length) fail('Email sudah terdaftar.');
  console.log(`Akun dibuat: ${email} sebagai ${roleLabel(role)}.`);
  if (typeof flags.password !== 'string') console.log(`Password awal (catat sekarang, tidak ditampilkan lagi): ${pw}`);
}

if (cmd === 'update') {
  if (!flags.name && !flags['new-email'] && !flags.role) fail('Isi salah satu: --name, --new-email, atau --role.');
  const u = await findUser();
  if (flags.role) {
    const role = roleOf(flags.role);
    if (role !== u.role) {
      if (u.role === 'admin') await assertOtherAdmin(u.id);
      await sql`UPDATE users SET role = ${role}, token_version = token_version + 1 WHERE id = ${u.id}`;
      console.log(`Role diubah menjadi ${roleLabel(role)} (sesi login lama dicabut).`);
    }
  }
  if (flags.name) { await sql`UPDATE users SET name = ${need('name')} WHERE id = ${u.id}`; console.log('Nama diperbarui.'); }
  if (flags['new-email']) {
    const ne = need('new-email').toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(ne)) fail('Format email baru tidak valid.');
    const [dup] = await sql`SELECT id FROM users WHERE lower(email) = ${ne} AND id <> ${u.id}`;
    if (dup) fail('Email baru sudah dipakai akun lain.');
    await sql`UPDATE users SET email = ${ne} WHERE id = ${u.id}`;
    console.log('Email diperbarui.');
  }
}

if (cmd === 'passwd') {
  const u = await findUser(), pw = pickPassword();
  await sql`UPDATE users SET password_hash = ${await hashPassword(pw)}, token_version = token_version + 1,
      password_changed_at = now(), failed_count = 0, locked_until = NULL WHERE id = ${u.id}`;
  console.log(`Password ${u.email} diganti dan semua sesi login lama dicabut.`);
  if (typeof flags.password !== 'string') console.log(`Password baru (catat sekarang, tidak ditampilkan lagi): ${pw}`);
}

if (cmd === 'unlock') {
  const u = await findUser();
  await sql`UPDATE users SET failed_count = 0, locked_until = NULL WHERE id = ${u.id}`;
  console.log(`Kunci login ${u.email} dibuka.`);
}

if (cmd === 'logout') {
  const u = await findUser();
  await sql`UPDATE users SET token_version = token_version + 1 WHERE id = ${u.id}`;
  console.log(`Semua sesi login ${u.email} dicabut.`);
}

if (cmd === 'delete') {
  const u = await findUser();
  if (!flags.yes) fail(`Tambahkan --yes untuk menghapus ${u.email} secara permanen.`);
  if (u.role === 'admin') await assertOtherAdmin(u.id);
  await sql`DELETE FROM users WHERE id = ${u.id}`;
  console.log(`Akun ${u.email} dihapus. Riwayat pembayaran tetap utuh (nama pengonfirmasi sudah tersimpan).`);
}
