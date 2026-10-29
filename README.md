# Mini SMS Gateway

A backend SMS gateway API built for the Nest Nepal Backend Intern assignment. The application manages user authentication, SMS credits, message billing, provider routing, delivery attempts, and SMS logs.

Built with **Node.js, Express, PostgreSQL, Prisma, and Redis**.

## Features

- **Authentication:** User registration, password hashing, and JWT-based login.
- **Credit wallet:** Individual user wallets with balance checks and atomic credit reservation.
- **SMS sending:** Send messages to multiple Nepali mobile numbers in one request.
- **Message segmentation:** GSM-7 and Unicode SMS length calculation and multipart billing.
- **Provider routing:** Priority-based provider selection with automatic failover.
- **Refunds:** Refund credits for recipients whose messages fail across all providers.
- **SMS logs:** Paginated logs with status, recipient, and date filters.
- **Provider health:** Provider balances, availability, and success-rate analytics.
- **Idempotency:** Prevent duplicate processing of supported repeated requests.
- **Background processing:** Optional BullMQ and Redis-based SMS queue.
- **Rate limiting:** Per-user request limits.
- **Delivery reports:** HMAC-signed webhook support.
- **Testing:** Automated tests for core functionality, including concurrent wallet reservations.
- **Docker support:** Run the API, PostgreSQL, Redis, and worker using Docker Compose.

## Technology Stack

- Node.js 22 and Express 5
- PostgreSQL
- Prisma ORM with the PostgreSQL adapter
- Redis and BullMQ
- JSON Web Tokens (JWT)
- bcrypt password hashing
- Node.js built-in test runner

## Getting Started

### Prerequisites

For Docker setup, install Docker Desktop with Docker Compose enabled.

For local development, install Node.js, npm, and PostgreSQL. Redis is required for queue functionality and Redis-backed rate limiting.

### Option 1: Run with Docker Compose

Clone the repository and open its directory:

```bash
git clone https://github.com/nabina01/SMS-Gateway.git
cd SMS-gateway
```

Start the application:

```bash
docker compose up --build
```

Docker Compose starts the API, database, Redis, background worker, and the configured migration and provider-seeding service.

Check the API:

```text
http://localhost:3000/health
```

Provider health analytics are available at:

```text
http://localhost:3000/routes/health
```

Stop the application without deleting database data:

```bash
docker compose down
```

**Warning:** `docker compose down -v` also removes Compose-managed volumes and can permanently delete the associated database data.

### Option 2: Run locally

Install dependencies:

```bash
npm install
```

Create your environment file in PowerShell:

```powershell
Copy-Item .env.example .env
```

Configure the database connection and required secrets in `.env`. Then run:

```bash
npm run prisma:generate
npm run db:setup
npm run seed
npm start
```

The database setup command applies the project's schema, and the seed command configures mock SMS providers. Verify both commands against the actual scripts and your intended database before running them.

The API starts on port `3000` by default. See `.env.example` for additional configuration options.

## API Reference

Protected endpoints require a JWT access token:

```http
Authorization: Bearer <your-jwt-token>
```

| Method | Endpoint | Purpose | Authentication |
|---|---|---|---|
| `GET` | `/health` | Check API and database health | No |
| `POST` | `/auth/register` | Register a user and create a wallet | No |
| `POST` | `/auth/login` | Authenticate and obtain a JWT | No |
| `GET` | `/wallet` | Retrieve the current wallet balance | Yes |
| `POST` | `/sms/send` | Send SMS messages to multiple recipients | Yes |
| `GET` | `/sms/logs` | Retrieve filtered, paginated SMS logs | Yes |
| `GET` | `/routes/health` | View provider health analytics | Verify implementation |
| `POST` | `/sms/queue` | Queue an SMS for background processing | Yes |
| `GET` | `/sms/queue/:jobId` | Check the status of a queued job | Yes |
| `POST` | `/webhooks/sms/delivery` | Receive signed delivery reports | Signature-based |

The queue endpoints require queue mode to be enabled and a worker to be running. Delivery-report webhooks use signature verification rather than ordinary user authentication.

Additional compatibility endpoints may be available. See the source code and `postman_collection.json` for the complete API details.

## SMS Billing and Routing

### Phone number validation

The gateway supports Nepali mobile numbers beginning with `97` or `98`. Numbers may include the Nepali country code `977` or `+977` and are normalized before processing.

### Message segmentation

SMS length and cost depend on the message encoding:

| Encoding | Single-part limit | Multipart segment size |
|---|---:|---:|
| GSM-7 | 160 units | 153 units |
| Unicode | 70 units | 67 units |

GSM extension characters consume two units. A message containing unsupported GSM characters, such as an emoji, uses Unicode encoding.

### Billing and failover

1. The gateway validates the request and calculates the required SMS parts.
2. It checks and reserves the necessary credits atomically.
3. Eligible providers are attempted in ascending priority order.
4. Failed attempts are recorded, and the next eligible provider is tried.
5. If a recipient cannot be delivered through any provider, the corresponding credits are refunded.

The wallet balance must not become negative, even when multiple requests are processed concurrently.

## Running Tests

Run the automated test suite:

```bash
npm test
```

The test suite covers authentication, phone number validation, message segmentation, billing, provider failover, refunds, logs, and other implemented features.

Redis-dependent queue tests require a reachable Redis instance. Without Redis, the queue tests may be skipped. With Redis configured, run the full suite according to the instructions in the project configuration.

The assignment's concurrency scenario should also be verified: **20 simultaneous send requests against a wallet that can afford 10 requests should produce exactly 10 successful reservations**, assuming each request has the same one-credit cost and no other requests consume credits.

## Project Structure

SMS-gateway/
├── prisma/                 # Prisma schema, migrations, and seed
├── scripts/                # Database and utility scripts
├── src/
│   ├── config/              # Database and service configuration
│   ├── controllers/         # HTTP request handlers
│   ├── middleware/          # Authentication and error handling
│   ├── routes/              # API route definitions
│   ├── services/            # Business logic
│   ├── utils/               # Validation and helper functions
│   ├── workers/             # Background queue processing
│   └── server.js            # Application entry point
├── test/                    # Automated tests
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── package.json
└── README.md

## Limitations

- SMS providers are simulated; real SMS delivery requires integration with an actual SMS provider.
- Queue processing requires Redis and a running worker.
- In-memory rate limiting, when used as a fallback, is limited to an individual application instance.

## License

No license is specified here. Refer to the repository's license file, if present, for applicable terms.