// Membuat tabel, akun awal, dan (opsional) contoh menu di database Neon.
//   npm run db:init        -> tabel + akun awal
//   npm run db:sample      -> sama, ditambah contoh menu bila tabel menu masih kosong
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
if (!env.DATABASE_URL) throw new Error('DATABASE_URL belum diatur (.dev.vars atau environment).');

const sql = neon(env.DATABASE_URL);

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
for (const stmt of schema.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await sql.query(stmt);
console.log('Skema database siap.');

async function addUser(prefix, role) {
  const email = env[`${prefix}_EMAIL`], password = env[`${prefix}_PASSWORD`];
  if (!email || !password) return console.log(`Lewati akun ${role}: ${prefix}_EMAIL/${prefix}_PASSWORD kosong.`);
  if (password.length < 8) throw new Error(`${prefix}_PASSWORD minimal 8 karakter.`);
  const hash = await hashPassword(password);
  const res = await sql`
    INSERT INTO users (name, email, password_hash, role)
    VALUES (${env[`${prefix}_NAME`] || role}, ${email.toLowerCase()}, ${hash}, ${role})
    ON CONFLICT (email) DO NOTHING RETURNING id`;
  console.log(res.length ? `Akun ${role} dibuat: ${email}` : `Akun ${email} sudah ada, dilewati.`);
}
await addUser('ADMIN', 'admin');
await addUser('STAFF', 'penjaga');

if (process.argv.includes('--sample')) {
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM menus`;
  if (n === 0) {
    const data = [
      ['food', 'Nasi', 'Nasi Telur', 10000, '🍳', 'Nasi putih dengan telur dadar.'],
      ['food', 'Nasi', 'Nasi Orek Tempe', 9000, '🍛', 'Nasi dengan orek tempe manis.'],
      ['food', 'Mie', 'Mie Goreng', 12000, '🍜', 'Mie goreng dengan telur dan sayuran.'],
      ['food', 'Mie', 'Mie Rebus', 11000, '🍲', 'Mie kuah hangat dengan telur.'],
      ['food', 'Roti', 'Roti Bakar Cokelat', 10000, '🍞', 'Roti bakar isi cokelat.'],
      ['food', 'Gorengan', 'Gorengan (3 pcs)', 5000, '🍢', 'Tempe, tahu, dan bakwan.'],
      ['drink', 'Teh', 'Teh Manis Panas', 3000, '🍵', 'Teh manis hangat.'],
      ['drink', 'Teh', 'Es Teh Manis', 4000, '🧊', 'Teh manis dingin.'],
      ['drink', 'Kopi', 'Kopi Hitam', 4000, '☕', 'Kopi hitam tubruk.'],
      ['drink', 'Kopi', 'Kopi Susu', 6000, '🥛', 'Kopi dengan susu.'],
      ['drink', 'Nutrisari', 'Nutrisari Jeruk', 4000, '🍊', 'Nutrisari jeruk dingin.'],
    ];
    for (const [type, cat, name, price, emoji, desc] of data) {
      let [c] = await sql`SELECT id FROM menu_categories WHERE menu_type = ${type} AND lower(name) = lower(${cat}) AND deleted_at IS NULL`;
      if (!c) [c] = await sql`INSERT INTO menu_categories (menu_type, name) VALUES (${type}, ${cat}) RETURNING id`;
      await sql`INSERT INTO menus (category_id, name, price, emoji, description) VALUES (${c.id}, ${name}, ${price}, ${emoji}, ${desc})`;
    }
    console.log(`Contoh menu ditambahkan (${data.length} item).`);
  } else console.log('Tabel menu sudah berisi data, contoh menu dilewati.');
}
console.log('Selesai.');
