import { readFile } from 'node:fs/promises';
import { pool } from './db.js';

try {
  const schema = await readFile(
    new URL('./schema.sql', import.meta.url),
    'utf8'
  );

  // Split this schema into individual SQL statements.
  const statements = schema
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const statement of statements) {
      await client.query(statement);
    }

    await client.query('COMMIT');
    console.log(`Database schema created successfully! ${statements.length} statements executed.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
} catch (error) {
  console.error('Schema creation failed:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
