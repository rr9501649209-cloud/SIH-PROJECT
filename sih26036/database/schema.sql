-- database/schema.sql
-- SIH26036 — Legal Metrology Verification Platform
-- Run against PostgreSQL 13+

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE stakeholder_role AS ENUM ('APPLICANT','LMO','GATC','STATE_ADMIN','CENTRAL_ADMIN');
CREATE TYPE application_status AS ENUM ('SUBMITTED','SCHEDULED','IN_PROGRESS','VERIFIED','REJECTED','EXPIRED');

CREATE TABLE stakeholders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role            stakeholder_role NOT NULL,
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL,
  email           TEXT,
  preferred_lang  TEXT NOT NULL DEFAULT 'en',
  source_registry TEXT,               -- non-null for LMO/GATC synced from DoCA's registry
  state           TEXT NOT NULL,
  district        TEXT NOT NULL,
  latitude        DOUBLE PRECISION,
  longitude       DOUBLE PRECISION,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE instrument_types (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  TEXT NOT NULL,
  category              TEXT NOT NULL,
  parameter_schema      JSONB NOT NULL,   -- lets new instrument types be added with zero code changes
  default_validity_days INT NOT NULL
);

CREATE TABLE instruments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  serial_number       TEXT NOT NULL UNIQUE,
  owner_id            UUID NOT NULL REFERENCES stakeholders(id),
  instrument_type_id  UUID NOT NULL REFERENCES instrument_types(id),
  location            TEXT NOT NULL,
  latitude            DOUBLE PRECISION,
  longitude           DOUBLE PRECISION,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE applications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_id  UUID NOT NULL REFERENCES stakeholders(id),
  instrument_id UUID NOT NULL REFERENCES instruments(id),
  status        application_status NOT NULL DEFAULT 'SUBMITTED',
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE schedule_slots (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   UUID NOT NULL UNIQUE REFERENCES applications(id),
  officer_id       UUID NOT NULL REFERENCES stakeholders(id),
  planned_date     TIMESTAMPTZ NOT NULL,
  route_cluster_id TEXT
);

CREATE TABLE verification_records (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id        UUID NOT NULL UNIQUE REFERENCES applications(id),
  observations          JSONB NOT NULL,
  photo_urls            TEXT[] NOT NULL DEFAULT '{}',
  gps_lat               DOUBLE PRECISION NOT NULL,
  gps_lng               DOUBLE PRECISION NOT NULL,
  captured_at           TIMESTAMPTZ NOT NULL,      -- when the officer captured it, offline
  synced_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  client_submission_id  TEXT NOT NULL UNIQUE        -- idempotency key for offline-sync retries
);

CREATE TABLE certificates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_id UUID NOT NULL UNIQUE REFERENCES verification_records(id),
  verified_date   TIMESTAMPTZ NOT NULL,
  expiry_date     TIMESTAMPTZ NOT NULL,
  signed_token    TEXT NOT NULL UNIQUE,
  signing_key_id  TEXT NOT NULL,
  revoked         BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_instruments_owner ON instruments(owner_id);
CREATE INDEX idx_applications_instrument ON applications(instrument_id);
CREATE INDEX idx_certificates_token ON certificates(signed_token);
