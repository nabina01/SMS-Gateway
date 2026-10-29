# Mini SMS Gateway

A production-minded SMS gateway backend for the Nest Nepal backend internship task. It covers authentication, credit wallets, multi-recipient SMS sending, GSM-7/Unicode segmentation, provider priority routing with failover, atomic refunds, provider health analytics, idempotency, per-user rate limiting, a BullMQ/Redis queue, and signed delivery-report webhooks.

Built with Node.js 22, Express 5, PostgreSQL 16, Prisma 7 (`@prisma/adapter-pg`), BullMQ, Redis, and the built-in `node:test` runner.

## Features

| Area | Implementation |
| --- | --- |
| Auth | Register/login with bcrypt hashes and JWT bearer tokens |
| Wallet | One wallet per user, atomic credit reservation and refund |
| Sending | Multi-recipient `POST /sms/send`, per-part billing |
| Validation | Nepali mobile normalization (`97`/`98`, optional `+977`), message length limits |
| Segmentation | GSM-7 (160/153), Unicode (70/67), GSM extension characters count as 2 |
| Routing | Lowest `priority` first, active providers only, skip exhausted providers |
| Failover | Failed attempts are recorded, next provider is tried, recipients are independent |
| Refunds | Exactly-once refund for each failed recipient; wallet never goes negative |
| Logs | Paginated/filterable logs scoped to the authenticated user |
| Health | 24h success rate, `unrated` when no attempts, availability/balance states |
| Bonus: queue | BullMQ + Redis `POST /sms/queue`, `GET /sms/queue/:jobId`, separate worker |
| Bonus: rate limit | Redis fixed-window limiter with in-process fallback and standard headers |
| Bonus: webhook | HMAC-SHA256 signed delivery reports with replay window and idempotency |
| Bonus: tests | 70 tests, including a 20-parallel/10-credit concurrency test and real Redis queue tests |
| Bonus: Docker | PostgreSQL, Redis, migration/seed job, API, and worker via Compose |

## Quick Start (Docker Compose)

```bash
docker compose up --build
```

This starts:

| Service | Host port | Purpose |
| --- | --- | --- |
| `app` | `3000` | Express API |
| `worker` | - | BullMQ SMS worker |
| `postgres` | `5433` | PostgreSQL (host port avoids a local 5432 instance) |
| `redis` | `6380` | Redis for queue + rate limiting |
| `migrate` | - | One-shot additive schema + provider seed |

Check it:

```bash
curl http://localhost:3000/health
```

Stop it without deleting data:

```bash
docker compose down
```

Delete the Compose database volume as well:

```bash
docker compose down -v
```

Demo secrets in Compose are development defaults. Override `JWT_SECRET` and `SMS_WEBHOOK_SECRET` before using the stack anywhere real.

## Local Development

Requirements: Node.js 20+ (tested on 22), PostgreSQL 14+, npm. Redis is optional except for queue mode and Redis-backed rate limiting.

```bash
npm install
cp .env.example .env
```

Edit `.env` with your PostgreSQL credentials, then:

```bash
npm run prisma:generate
npm run db:setup
npm run seed
npm start
```

`npm run db:setup` applies the additive SQL schema. `npm run seed` only upserts mock SMS providers; it never creates or resets customers.

If you already have the original development database and only want the two bonus tables, use the additive migration instead of recreating anything:

```bash
npm run db:apply-bonus-migration
```

This adds `sms_requests` and `sms_delivery_reports` without altering `users`, `credit_wallets`, `sms_logs`, `sms_providers`, or `sms_provider_attempts`.

For queue mode locally, start Redis, set `REDIS_URL`, set `SMS_QUEUE_ENABLED=true`, then run the worker in a second terminal:

```bash
npm run queue:worker
```

## Environment Variables

See `.env.example` for the full list. Important values:

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | - | PostgreSQL connection string used by Prisma and `pg` |
| `JWT_SECRET` | - | Required; use a long random value |
| `JWT_EXPIRES_IN` | `1d` | Token lifetime |
| `WELCOME_CREDITS` | `0.00` | Optional starting credits for new users |
| `SMS_CREDIT_COST_PER_PART` | `1.00` | Cost per SMS part |
| `SMS_PROVIDER_SEED_JSON` | built-in mocks | JSON array for the idempotent provider seed |
| `REDIS_URL` | - | Enables Redis-backed rate limiting and queue mode |
| `SMS_QUEUE_ENABLED` | `false` | Must be `true` for `/sms/queue` and the worker |
| `SMS_QUEUE_NAME` | `sms-send` | BullMQ queue name |
| `QUEUE_CONCURRENCY` | `5` | Worker concurrency |
| `QUEUE_ATTEMPTS` | `3` | BullMQ attempts for retryable jobs |
| `RATE_LIMIT_ENABLED` | `true` | Enable per-user limits |
| `RATE_LIMIT_MAX_REQUESTS` | `60` | Requests per window |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Fixed window size |
| `SMS_WEBHOOK_SECRET` | - | Enables the delivery webhook when set |
| `SMS_WEBHOOK_TOLERANCE_SECONDS` | `300` | Timestamp replay tolerance |
| `TEST_DATABASE_URL` | `<DATABASE_URL>_test` | Must end in `_test`; test runner refuses anything else |
| `TEST_REDIS_URL` | - | Enables real Redis queue tests when reachable |

## API Reference

All authenticated endpoints expect:

```http
Authorization: Bearer <jwt>
```

### Health

```bash
curl http://localhost:3000/health
curl http://localhost:3000/routes/health
```

`/health` checks the database. `/routes/health` returns per-provider analytics for the last 24 hours.

### Register and login

```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Demo User","email":"demo@example.com","password":"StrongPassword123!"}'

curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@example.com","password":"StrongPassword123!"}'
```

Registration returns a JWT and creates a wallet atomically. Emails are normalized to lowercase. Duplicate registration returns `409`.

### Current user and wallet

```bash
curl http://localhost:3000/api/auth/me -H "Authorization: Bearer $TOKEN"
curl http://localhost:3000/wallet -H "Authorization: Bearer $TOKEN"
```

`/api/auth/me`, `/wallet`, and `/api/wallet` are all available; the `/api/*` aliases are provided for compatibility with the original API surface.

### Send SMS

```bash
curl -X POST http://localhost:3000/sms/send \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-123-send-1" \
  -d '{
    "to": ["9841234567", "+977 9801122334"],
    "message": "Hello from the SMS Gateway"
  }'
```

Send response status:

| Status | Meaning |
| --- | --- |
| `200` | Every recipient was sent successfully |
| `207` | Partial success; failed recipients were refunded |
| `502` | No provider delivered any recipient; all charges were refunded |
| `400` | Invalid recipients/message or malformed request |
| `401` | Missing/invalid JWT |
| `402` | Insufficient wallet balance |
| `429` | Per-user rate limit exceeded |

`Idempotency-Key` is optional. Repeating the same key for the same user returns the stored response and does not charge or send again. Keys are scoped per user.

### Queue an SMS

Requires `SMS_QUEUE_ENABLED=true`, `REDIS_URL`, and a running worker.

```bash
curl -X POST http://localhost:3000/sms/queue \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-123-queue-1" \
  -d '{"to":["9841234567"],"message":"Queued message"}'

curl http://localhost:3000/sms/queue/<jobId> -H "Authorization: Bearer $TOKEN"
```

The queue endpoint returns `202 Accepted`; it explicitly does not claim delivery. The worker processes the job through the same `sendSms` service, so billing, routing, and refund rules are identical. Business errors such as `402` are unrecoverable and fail immediately without retrying.

### Logs

```bash
curl "http://localhost:3000/sms/logs?page=1&limit=10&status=sent" \
  -H "Authorization: Bearer $TOKEN"

curl "http://localhost:3000/sms/logs?date=2026-10-29" \
  -H "Authorization: Bearer $TOKEN"

curl "http://localhost:3000/sms/logs?recipient=9841234567&startDate=2026-10-01&endDate=2026-10-29" \
  -H "Authorization: Bearer $TOKEN"
```

Supported query parameters: `page`, `limit` (max 100), `status` (`pending`, `sent`, `failed`), `recipient`, `startDate`, `endDate`, `from`, `to`, `date`. A date-only end date includes the whole day. Logs are always scoped to the authenticated user.

### Delivery-report webhook

```bash
POST /webhooks/sms/delivery
x-sms-timestamp: <unix seconds>
x-sms-signature: sha256=<hex hmac>
Content-Type: application/json
```

Signature input:

```text
HMAC_SHA256(secret, "<timestamp>.<raw JSON body>")
```

Example body:

```json
{
  "messageId": "42",
  "provider": "SparrowMock",
  "status": "delivered",
  "providerMessageId": "provider-abc-123"
}
```

Behavior:

- `200` records the report; a repeat of the same final state returns `{ "duplicate": true }`.
- `401` for a bad signature, stale timestamp, unknown provider, or provider that did not route the log.
- `404` for an unknown `messageId`.
- `409` for a conflicting final state or a log that is not `sent`.
- The unique constraint on `sms_log_id` makes concurrent duplicate callbacks safe.

## Provider Routing and Health

Providers are selected by ascending `priority`. Inactive providers and providers with zero balance are skipped. Each attempt is stored in `sms_provider_attempts`, including failed attempts before a successful failover. Provider balance is only debited for the provider that actually sends.

Health uses attempts from the last 24 hours:

```text
successRate = successful attempts / total attempts
```

`successRate` is `null` and `healthStatus` is `unrated` when there are no attempts, rather than falsely reporting 0% or 100%. Otherwise:

| Status | Rule |
| --- | --- |
| `healthy` | success rate >= 90% |
| `degraded` | success rate >= 70% and < 90% |
| `unhealthy` | success rate < 70% |
| `inactive` | provider is disabled |
| `no_balance` | provider balance is zero |

Each provider also exposes `availability` and `balanceState` separately so callers can distinguish "disabled" from "out of money".

## Rate Limiting

`/sms/*` routes are limited per user. The default is 60 requests per 60 seconds. When `REDIS_URL` is reachable, a Lua-scripted fixed-window counter is shared across processes. If Redis fails, the limiter falls back to an in-process store and logs a warning.

Responses include:

```text
RateLimit-Limit
RateLimit-Remaining
RateLimit-Reset
Retry-After        (429 only)
```

## Data Model

| Table | Purpose |
| --- | --- |
| `users` | Account identity and bcrypt password hash |
| `credit_wallets` | One balance per user, constrained to be non-negative |
| `sms_providers` | Mock providers with priority, balance, failure rate, active flag |
| `sms_logs` | One row per recipient/message attempt with cost and final status |
| `sms_provider_attempts` | Per-provider attempt history used for health and debugging |
| `sms_requests` | Idempotency records keyed by `(user_id, idempotency_key)` |
| `sms_delivery_reports` | Unique delivery report per SMS log for webhook idempotency |

The original core tables are not altered by the bonus migration. New tables are additive and safe to run against the development database.

## Testing

```bash
npm test
```

The runner creates or reuses an isolated database named `<DATABASE_URL database>_test`, applies the schema, truncates test tables, and refuses to run against any database whose name does not end in `_test`. It never touches the development database.

Without Redis, queue tests are skipped. To run everything:

```bash
docker run -d --rm --name sms-gateway-test-redis -p 6380:6379 redis:7-alpine
```

PowerShell:

```powershell
$env:TEST_REDIS_URL="redis://localhost:6380/15"
npm test
```

Bash:

```bash
TEST_REDIS_URL=redis://localhost:6380/15 npm test
```

Expected result with Redis: `70` tests, `70` pass. Without Redis, `67` tests pass and the queue suite is reported as skipped.

The suite covers auth/JWT, phone normalization, GSM-7/Unicode segmentation including the assignment's 200-English/100-Nepali examples, routing/failover, partial and full refunds, idempotency, log filtering/pagination/ownership, provider health edge cases, rate limiting, BullMQ queue processing, and webhook signature/idempotency/conflict behavior. The concurrency test fires 20 parallel sends at a 10-credit wallet and asserts exactly 10 succeed with a non-negative balance.

## Postman

Import `postman_collection.json`. Set `email`, `password`, and the webhook secret if needed, then run `Register` or `Login`. The collection stores the JWT automatically. The send request stores `messageId` and `providerName`, which the signed webhook request uses; its pre-request script computes the HMAC signature.

## Project Structure

```text
SMS-gateway/
|-- prisma/
|   |-- schema.prisma
|   |-- seed.js
|   `-- migrations/
|-- scripts/
|   |-- apply-schema.js
|   |-- apply-migration.js
|   `-- credit-wallet.js
|-- src/
|   |-- config/           # Prisma, Redis, BullMQ connection/config
|   |-- controllers/      # Auth, SMS, wallet, webhook HTTP handlers
|   |-- middleware/       # JWT auth and centralized error handling
|   |-- routes/           # /auth, /sms, /wallet, /webhooks, /api
|   |-- services/         # Auth, SMS, provider, wallet, queue, webhook, rate limit
|   |-- utils/            # Errors, validation, phone/SMS utilities, DB introspection
|   |-- workers/          # BullMQ SMS worker
|   |-- schema.sql        # Canonical additive PostgreSQL schema
|   `-- server.js
|-- test/                 # Isolated integration/unit tests and runner
|-- postman_collection.json
|-- docker-compose.yml
|-- Dockerfile
`-- .env.example
```

## Design Decisions and Tradeoffs

- **Atomic wallet reservation** uses a conditional `UPDATE ... WHERE balance >= amount` so concurrent sends cannot overdraw. Failed recipients are refunded with an atomic increment; there is no application-level read/modify/write race.
- **Exactly-once refunds** are guaranteed by the conditional reservation plus a single refund per failed recipient inside the send transaction.
- **Idempotency before work** uses a unique `(user_id, idempotency_key)` row. A concurrent duplicate returns `409` while the first is still processing; a completed duplicate returns the stored response.
- **Per-attempt history** makes failover auditable and keeps health math independent from final log status.
- **Webhook idempotency** relies on the database unique constraint, not only an application check, so concurrent callbacks cannot create duplicate reports.
- **Queue mode is asynchronous by design.** A queued request is not reported as delivered; clients poll the job status.
- **Redis is optional for the core API.** Rate limiting falls back to memory if Redis is down; only queue mode requires Redis.
- **Core tables are unchanged.** The bonus schema is additive so the existing development database keeps working until the migration is explicitly applied.

Limitations: providers are simulated, there is no real SMTP/SMPP integration, no refresh-token rotation, and the in-process rate-limit fallback is per-instance. For a real deployment, set strong secrets, use managed PostgreSQL/Redis, run multiple workers, add structured logging/metrics, and apply the migration during a controlled deploy.
