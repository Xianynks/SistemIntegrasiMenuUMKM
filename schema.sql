CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','penjaga')),
  token_version INT NOT NULL DEFAULT 0,
  password_changed_at TIMESTAMPTZ,
  failed_count INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS menu_categories (
  id SERIAL PRIMARY KEY,
  menu_type TEXT NOT NULL CHECK (menu_type IN ('food','drink')),
  name TEXT NOT NULL,
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_menu_categories_active ON menu_categories (menu_type, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS menus (
  id SERIAL PRIMARY KEY,
  category_id INT NOT NULL REFERENCES menu_categories(id),
  name TEXT NOT NULL,
  price INT NOT NULL CHECK (price > 0),
  description TEXT NOT NULL DEFAULT '',
  emoji TEXT,
  image_b64 TEXT,
  image_mime TEXT,
  is_available BOOLEAN NOT NULL DEFAULT true,
  deleted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  order_code TEXT NOT NULL UNIQUE,
  table_number INT NOT NULL,
  customer_label TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'baru' CHECK (status IN ('baru','siap','lunas','batal')),
  idem_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status, id DESC);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_id INT REFERENCES menus(id) ON DELETE SET NULL,
  menu_name TEXT NOT NULL,
  unit_price INT NOT NULL,
  quantity INT NOT NULL CHECK (quantity > 0)
);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL UNIQUE REFERENCES orders(id),
  amount INT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('QRIS','Cash')),
  confirmed_by INT REFERENCES users(id) ON DELETE SET NULL,
  confirmed_name TEXT NOT NULL,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS financial_entries (
  id SERIAL PRIMARY KEY,
  payment_id INT NOT NULL UNIQUE REFERENCES payments(id),
  entry_type TEXT NOT NULL DEFAULT 'pemasukan',
  amount INT NOT NULL,
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value) VALUES ('table_count', '12') ON CONFLICT (key) DO NOTHING;
