CREATE TABLE IF NOT EXISTS users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS credit_wallets (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    balance NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sms_providers (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    priority INTEGER NOT NULL UNIQUE CHECK (priority > 0),
    balance NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    failure_rate NUMERIC(4, 3) NOT NULL DEFAULT 0
        CHECK (failure_rate >= 0 AND failure_rate <= 1),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sms_logs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    recipient VARCHAR(16) NOT NULL,
    message TEXT NOT NULL,
    parts INTEGER NOT NULL CHECK (parts > 0),
    cost NUMERIC(12, 2) NOT NULL CHECK (cost >= 0),
    status VARCHAR(10) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sent', 'failed')),
    provider_id BIGINT REFERENCES sms_providers(id) ON DELETE SET NULL,
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Record each provider attempt, including failures before failover.
CREATE TABLE IF NOT EXISTS sms_provider_attempts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sms_log_id BIGINT NOT NULL REFERENCES sms_logs(id) ON DELETE CASCADE,
    provider_id BIGINT NOT NULL REFERENCES sms_providers(id),
    status VARCHAR(10) NOT NULL
        CHECK (status IN ('sent', 'failed')),
    error_message TEXT,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_logs_user_created
    ON sms_logs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sms_logs_status_created
    ON sms_logs (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sms_logs_recipient
    ON sms_logs (recipient);

CREATE INDEX IF NOT EXISTS idx_sms_provider_attempts_provider_time
    ON sms_provider_attempts (provider_id, attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_sms_provider_attempts_log
    ON sms_provider_attempts (sms_log_id);

-- Additive bonus tables (safe to run against an existing database).
-- These tables do not alter the original core tables or their records.

CREATE TABLE IF NOT EXISTS sms_requests (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    idempotency_key VARCHAR(200) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'processing'
        CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    response JSONB,
    last_error TEXT,
    total_reserved NUMERIC(12, 2),
    total_refunded NUMERIC(12, 2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS sms_delivery_reports (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sms_log_id BIGINT NOT NULL UNIQUE REFERENCES sms_logs(id) ON DELETE CASCADE,
    provider_id BIGINT NOT NULL REFERENCES sms_providers(id),
    provider_message_id VARCHAR(200),
    status VARCHAR(20) NOT NULL CHECK (status IN ('delivered', 'failed')),
    error_message TEXT,
    payload JSONB,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_requests_status_created
    ON sms_requests (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_provider_time
    ON sms_delivery_reports (provider_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_delivery_status_time
    ON sms_delivery_reports (status, received_at DESC);
