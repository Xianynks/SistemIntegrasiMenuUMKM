# Katalog & Pemesanan Menu UMKM (PWA)

Satu **Cloudflare Worker** melayani frontend PWA (folder `public/`) sekaligus API (`/api/*`).
Database memakai **Neon PostgreSQL**. Satu proyek = satu UMKM (database dan deployment terpisah per UMKM).

```
public/            Frontend PWA (index.html, app.js, style.css, sw.js, manifest, ikon)
src/index.js       API Worker (rute publik, auth, staf, admin)
src/auth.js        Hash password (PBKDF2) dan token sesi (JWT HS256) via WebCrypto
schema.sql         Skema database
scripts/init-db.mjs  Membuat tabel, akun awal, contoh menu
wrangler.toml      Konfigurasi Cloudflare
```

## 1. Persiapan
- Node.js **20 atau lebih baru**
- Akun [Neon](https://neon.tech) dan akun [Cloudflare](https://dash.cloudflare.com)

```bash
npm install
cp .dev.vars.example .dev.vars     # Windows: copy .dev.vars.example .dev.vars
```

## 2. Database Neon
1. Buat project di Neon, lalu salin **connection string** (pakai yang *pooled*, berakhiran `?sslmode=require`).
2. Isi `.dev.vars`:
   - `DATABASE_URL` = connection string tadi
   - `JWT_SECRET` = string acak panjang, mis. hasil `node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`
   - `ADMIN_*` dan `STAFF_*` = akun awal (password minimal 8 karakter)
3. Buat tabel dan akun awal:
```bash
npm run db:sample    # tabel + akun + contoh menu (atau npm run db:init tanpa contoh menu)
```
4. Setelah akun terbuat, **hapus baris `ADMIN_*` dan `STAFF_*`** dari `.dev.vars`.

## 3. Jalankan lokal
```bash
npm run dev          # http://localhost:8787
```

## 4. Deploy ke Cloudflare
```bash
npx wrangler login
npx wrangler secret put DATABASE_URL     # tempel connection string Neon
npx wrangler secret put JWT_SECRET       # string acak (boleh sama dengan lokal)
npm run deploy
```
Hasilnya tersedia di `https://umkm-katalog.<subdomain-anda>.workers.dev`. Domain sendiri bisa dipasang dari
dashboard Cloudflare (Workers & Pages → proyek → Settings → Domains & Routes).
Setelah itu halaman bisa di-install ke layar utama HP (Add to Home Screen).

Info UMKM (nama, alamat, jam, kontak, zona waktu) diubah di blok `[vars]` pada `wrangler.toml`, lalu deploy ulang.

## 5. UMKM baru
Salin proyek, ganti `name` dan `[vars]` di `wrangler.toml`, buat project Neon baru, ulangi langkah 2 dan 4.

## Hak akses
| Fitur | Pelanggan | Penjaga | Admin |
|---|---|---|---|
| Lihat katalog, kirim pesanan | ✔ | ✔ | ✔ |
| Pesanan, pembayaran, riwayat | – | ✔ | ✔ |
| CRUD menu dan kategori | – | ✔ | ✔ |
| Detail akun, ubah password sendiri (About) | – | ✔ | ✔ |
| Buku keuangan, ekspor Excel, Sampah, jumlah meja | – | – | ✔ |

## Keamanan yang sudah ada
- Password di-hash PBKDF2-SHA256; sesi memakai cookie `HttpOnly; Secure; SameSite=Strict`, masa berlaku 12 jam.
- Setelah ubah password, semua sesi lama otomatis tidak berlaku (`token_version`).
- Login terkunci 5 menit setelah 5 kali salah.
- Harga pesanan selalu diambil dari database; nomor meja, jumlah, dan item divalidasi di server.
- Permintaan tulis dari origin lain ditolak; kunci idempotensi mencegah pesanan ganda saat koneksi putus.
- Pembayaran memakai satu pernyataan SQL atomik (pesanan lunas + payments + financial_entries).

Disarankan menambah **Rate Limiting Rule** Cloudflare (Security → WAF) pada `POST /api/public/orders` dan `POST /api/auth/login`.

## Catatan desain
- Gambar menu disimpan di Neon (kolom `image_b64`, diperkecil ke maks. 360 px di browser). Cukup untuk puluhan sampai ratusan menu;
  bila gambar sangat banyak, pindahkan ke Cloudflare R2.
- Jumlah meja disimpan sebagai pengaturan (`settings.table_count`), bukan tabel `tables` terpisah.
- Offline: hanya shell aplikasi yang tersedia; API (pesanan, pembayaran) tidak pernah di-cache.
- Ekspor Excel memakai pustaka SheetJS dari cdnjs (butuh internet saat ekspor).

## Endpoint
Publik: `GET /api/public/info|menu`, `GET /api/public/menu/:id/image`, `POST /api/public/orders`
Auth: `POST /api/auth/login|logout`, `GET /api/auth/me`, `PATCH /api/auth/password`
Staf: `GET /api/staff/counts|orders|payments|categories|menus`, `PATCH /api/staff/orders/:id`, `PATCH /api/staff/orders/:id/items/:itemId`,
`POST /api/staff/orders/:id/payments`, `POST|DELETE /api/staff/categories`, `POST|PUT|DELETE /api/staff/menus`
Admin: `GET /api/staff/finance|trash`, `POST /api/staff/trash/:id/restore`, `DELETE /api/staff/trash/:id`, `PUT /api/staff/settings`
