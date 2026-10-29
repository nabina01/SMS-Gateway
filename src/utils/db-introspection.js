import prisma from "../config/prisma.js";

const cache = new Map();

export async function tableExists(tableName) {
  if (cache.has(tableName)) return cache.get(tableName);
  try {
    const rows = await prisma.$queryRaw`
      SELECT to_regclass(${`public.${tableName}`})::text AS table_name
    `;
    const exists = Boolean(rows[0]?.table_name);
    if (exists) cache.set(tableName, true);
    return exists;
  } catch {
    return false;
  }
}
