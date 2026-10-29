import "dotenv/config";
import { readFile } from "node:fs/promises";
import pg from "pg";

const migrationPath =
  process.argv[2] ||
  new URL(
    "../prisma/migrations/20261029000000_init_and_bonus/migration.sql",
    import.meta.url
  );

const sql = await readFile(migrationPath, "utf8");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  const target = new URL(process.env.DATABASE_URL);
  console.log(
    `Applying additive migration to ${target.hostname}:${target.port || 5432}${target.pathname}`
  );
  console.log(
    "This migration only uses CREATE TABLE/INDEX IF NOT EXISTS and does not alter or delete existing records."
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const statements = sql
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) {
      await client.query(statement);
    }
    await client.query("COMMIT");
    console.log(`Migration applied successfully (${statements.length} statements).`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
} catch (error) {
  console.error("Migration failed:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
