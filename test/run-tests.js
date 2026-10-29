import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

function deriveTestUrl() {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${url.pathname.replace(/^\//, "")}_test`;
  return url.toString();
}

const testUrl = deriveTestUrl();
const devUrl = process.env.DATABASE_URL;

if (testUrl === devUrl) {
  throw new Error("TEST_DATABASE_URL must not equal DATABASE_URL");
}

const testDbName = decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ""));
if (!/_test$/.test(testDbName)) {
  throw new Error(
    `Refusing to run destructive test setup against '${testDbName}'. The isolated test database name must end with '_test'.`
  );
}

const adminUrl = new URL(testUrl);
adminUrl.pathname = "/postgres";
const adminPool = new pg.Pool({ connectionString: adminUrl.toString() });

try {
  const exists = await adminPool.query(
    "select 1 from pg_database where datname = $1",
    [testDbName]
  );
  if (exists.rowCount === 0) {
    const quoted = testDbName.replaceAll('"', '""');
    await adminPool.query(`CREATE DATABASE "${quoted}"`);
    console.log(`Created isolated test database '${testDbName}'.`);
  }
} finally {
  await adminPool.end();
}

const schema = await readFile(new URL("../src/schema.sql", import.meta.url), "utf8");
const testPool = new pg.Pool({ connectionString: testUrl });

try {
  const client = await testPool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of schema.split(";").map((s) => s.trim()).filter(Boolean)) {
      await client.query(statement);
    }
    await client.query("COMMIT");
    await client.query(
      `TRUNCATE TABLE users, credit_wallets, sms_providers, sms_logs,
       sms_provider_attempts, sms_requests, sms_delivery_reports
       RESTART IDENTITY CASCADE`
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
} finally {
  await testPool.end();
}

const onlyConcurrency = process.argv.includes("--only-concurrency");
const testDir = new URL("./", import.meta.url);
const files = (await readdir(testDir))
  .filter((file) => file.endsWith(".test.js"))
  .filter((file) => !onlyConcurrency || file === "concurrency.test.js")
  .map((file) => fileURLToPath(new URL(file, testDir)));

const redisUrl = process.env.TEST_REDIS_URL || process.env.REDIS_URL || "";
const childEnv = {
  ...process.env,
  NODE_ENV: "test",
  DATABASE_URL: testUrl,
  TEST_DATABASE_URL: testUrl,
  WELCOME_CREDITS: "0",
  SMS_WEBHOOK_SECRET:
    process.env.SMS_WEBHOOK_SECRET || "test-webhook-secret-not-for-production",
  SMS_WEBHOOK_TOLERANCE_SECONDS: "300",
  RATE_LIMIT_ENABLED: "true",
  RATE_LIMIT_MAX_REQUESTS: "1000",
  RATE_LIMIT_WINDOW_SECONDS: "60",
  SMS_QUEUE_ENABLED: "false",
  SMS_QUEUE_NAME: "sms-send-test",
  ...(redisUrl ? { REDIS_URL: redisUrl, TEST_REDIS_URL: redisUrl } : {}),
};

console.log(
  `Running ${files.length} test file(s) against isolated database '${testDbName}'.`
);

const child = spawn(
  process.execPath,
  ["--test", "--test-concurrency=1", ...files],
  { env: childEnv, stdio: "inherit" }
);

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Test runner terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
