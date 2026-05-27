import pg from "pg";
import { readFileSync } from "fs";
import { join } from "path";

const sqlPath = join(import.meta.dir, "../supabase/migrations/001_email_open_tracking.sql");

async function main() {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    console.error("Set SUPABASE_DB_URL in .env (postgresql://postgres:PASSWORD@db....supabase.co:5432/postgres)");
    console.error("URL-encode special chars in password: ! → %21, + → %2B, ? → %3F");
    process.exit(1);
  }

  const sql = readFileSync(sqlPath, "utf8");
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

  await client.connect();
  await client.query(sql);
  await client.end();
  console.log("✓ Migration applied: email_open_tracking table + increment_email_open()");
}

main().catch((err) => {
  console.error("Migration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
