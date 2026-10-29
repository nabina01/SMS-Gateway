import "dotenv/config";
import { readFile } from "node:fs/promises";
import pg from "pg";

const schemaUrl = new URL("../src/schema.sql", import.meta.url);
const sql = await readFile(schemaUrl, "utf8");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  const target = new URL(process.env.DATABASE_URL);
  console.log(
    `Applying additive schema to ${target.hostname}:${target.port || 5432}${target.pathname}`
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
    console.log(`Schema applied successfully (${statements.length} statements).`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
} catch (error) {
  console.error("Schema setup failed:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
