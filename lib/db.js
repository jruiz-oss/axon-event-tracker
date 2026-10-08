import pg from 'pg';
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'off' || !process.env.DATABASE_URL || /localhost|127\.0\.0\.1|railway\.internal/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
});

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS articles (
      id BIGSERIAL PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      domain TEXT,
      seen_at TIMESTAMPTZ NOT NULL,
      type TEXT NOT NULL,
      state CHAR(2) NOT NULL,
      city TEXT,
      dismissed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (url, type)
    );
    ALTER TABLE articles ADD COLUMN IF NOT EXISTS trusted BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE articles ADD COLUMN IF NOT EXISTS national BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE INDEX IF NOT EXISTS articles_seen_idx ON articles (seen_at DESC);
    CREATE INDEX IF NOT EXISTS articles_state_idx ON articles (state, type, seen_at);
    CREATE TABLE IF NOT EXISTS backfill_progress (
      key TEXT PRIMARY KEY,
      done_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
}

export async function setMeta(key, value) {
  await pool.query(`INSERT INTO meta(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key, String(value)]);
}
export async function getMeta(key) {
  const r = await pool.query(`SELECT value FROM meta WHERE key=$1`, [key]);
  return r.rows[0]?.value ?? null;
}
