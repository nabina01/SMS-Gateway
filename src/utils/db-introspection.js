import prisma from "../config/prisma.js";

const cache = new Map();

export async function tableExists(tableName) {
  if (cache.has(tableName)) return cache.get(tableName);
  try {
    const rows = await prisma.$queryRaw`
      SELECT to_regclass(${`public.${tableName}`})::text AS table_name
    `;
    const exists = Boolean(rows[0]?.table_name);
    // Cache positive results only: a migration may add the table while the
    // server is running, and a missing table should not be cached forever.
    if (exists) cache.set(tableName, true);
    return exists;
  } catch {
    return false;
  }
}
