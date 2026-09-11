# Setu — SIH26036 prototype

Legal Metrology verification platform. Applicant submits an instrument →
officer records a field inspection (works offline) → backend issues a
cryptographically signed QR certificate → anyone can verify it, online or
via the signature alone if offline.

## Layout
```
database/   schema.sql (run this), seed.sql (types + demo logins), schema.prisma (portable reference — see note below)
backend/    server.ts (API), middleware/auth.ts (JWT+RBAC), lib/geo.ts (route clustering),
            certificate-engine.js (sign/verify core), scripts/generate-keys.js, keys/ (generated, gitignored)
frontend/   index.html, styles.css, app.js, idb-queue.js (offline outbox), sw.js (offline app shell)
Dockerfile, docker-compose.yml, .dockerignore   — one-command run
```

---

## Fastest path: Docker (recommended for handing this to someone else)

```bash
docker compose up --build
```

That's it — this single command starts Postgres, applies `schema.sql` and
`seed.sql` automatically (Postgres runs anything in `docker-entrypoint-initdb.d/`
on first boot), generates the signing keys, and starts the backend, which
also serves the frontend. Open **http://localhost:3000**.

> Built and syntax-validated in this environment, but not run end-to-end here —
> the sandbox this was built in has no Docker installed (its network
> allowlist blocks Docker Hub). The compose file uses only standard,
> well-documented mechanisms (official `postgres` image init-script folder,
> healthcheck-gated `depends_on`), so it should come up cleanly, but **please
> run `docker compose up --build` yourself once and confirm** before you're
> relying on it live in front of judges.

To reset everything: `docker compose down -v` (the `-v` also wipes the DB
and regenerates fresh signing keys next boot).

## Manual path (no Docker)

```bash
createdb sih26036
psql sih26036 -f database/schema.sql
psql sih26036 -f database/seed.sql

cp .env.example .env      # edit DATABASE_URL if yours differs
npm install
npm run keys              # generates backend/keys/ once — never rerun after certs exist
npm start                 # http://localhost:3000
```

---

## Demo accounts (seeded — log in with just a phone number, no password)

Login is phone-number lookup only (see "Known simplifications" below for why).

| Role | Phone | Can do |
|---|---|---|
| Central Admin | `9999900001` | Bulk import instruments/stakeholders |
| State Admin | `9999900002` | Same as above |
| LMO (officer) | `9999900003` | Record verifications, issue certificates, view/schedule applications |
| GATC (test centre) | `9999900004` | Same as LMO |

Applicants aren't pre-seeded — the **Apply** tab registers and logs you in
as a new applicant automatically.

---

## How the three layers connect

1. **Database → Backend**: `DATABASE_URL` env var (`.env.example`), read via
   the `pg` driver — no ORM binary needed, so no `binaries.prisma.sh`
   dependency (see note below on why Prisma isn't in the runtime path).
2. **Backend → Frontend**: same Express process serves both
   (`express.static('frontend')`) — one process, one port, zero config.
   To split them onto separate hosts later: set `window.API_BASE_URL` in
   `index.html` before `app.js` loads. CORS is already enabled.
3. **QR → verification**: the QR encodes `PUBLIC_VERIFY_BASE` + the signed
   token. Set that env var to wherever you actually deploy the backend —
   it's the URL a phone camera opens when it scans the sticker.

---

## What's real vs. simplified — read this before you present

**Fully real, tested live in this session:**
- ECDSA-signed QR certificates — sign, issue, verify, and tamper-rejection
  all proven at the HTTP level, not just unit-tested
- JWT auth + role-based access control — 401/403 boundaries tested for
  every protected route
- Geo-clustering scheduler (`/api/scheduling/preview`) — real haversine-
  distance greedy clustering, not a stub
- CSV bulk import for legacy instruments and LMO/GATC roster federation
- Offline outbox on the Officer console: IndexedDB queue + online/offline
  event listeners + a service worker caching the app shell so the page
  itself loads with zero connectivity

**Simplified, and you should say so if asked — don't oversell these:**
- **Login has no OTP.** Phone-number lookup issues a session directly. In
  a real deployment this is preceded by an actual OTP send/verify or
  DigiLocker/Aadhaar eKYC (see comment in `backend/middleware/auth.ts`) —
  building that needs a real SMS gateway account, which this environment
  doesn't have credentials for. The auth *shape* (JWT, role checks) is
  otherwise the real thing.
- **Photo evidence isn't uploaded anywhere.** The camera capture is real
  (`capture="environment"` opens an actual phone camera, preview renders),
  but the file is only noted by name, not stored — object storage
  (S3/MinIO, per the original architecture) is the next integration point,
  not a redesign.
- **The offline queue is untested in a real browser.** The code follows
  the standard, well-documented pattern (IndexedDB outbox + `online`/
  `offline` events + idempotent server-side sync), and it's syntax-checked,
  but this sandbox has no real browser to drive — **test it yourself**:
  open the Officer console, DevTools → Network → Offline, submit a
  verification, confirm it shows as queued, go back online, confirm it
  syncs and a certificate appears.
- **`schema.prisma` is a reference file, not live.** The actual database
  code uses raw SQL via `pg` — Prisma's CLI needs to download a query-engine
  binary from `binaries.prisma.sh`, which this sandbox's network policy
  blocks. Prisma will work fine on your own machine if you'd rather use it;
  the schema is kept in sync as documentation either way.

**Not built at all — be upfront about these if asked:**
- Multi-language UI / SMS fallback for non-smartphone applicants
- Live DoCA/eMaap API integration (no public API exists to integrate with —
  the "federation" claim is implemented as the CSV-import mechanism, which
  is the realistic version of that idea until such an API exists)
- Any real deployment — this runs locally / in your own Docker only

---

## API reference

**Public — no token:**
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | DB connectivity check |
| GET | `/api/instrument-types` | categories + dynamic field schema |
| POST | `/api/stakeholders` | register (applicant self-signup) |
| POST | `/api/auth/login` | `{ phone }` → `{ token, stakeholder }` |
| GET | `/api/verify?t=TOKEN` | citizen QR-scan verification |

**Authenticated — any logged-in stakeholder:**
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/instruments` | register an instrument |
| POST | `/api/applications` | request verification |
| GET | `/api/applications/:id` | check one application's status |

**LMO / GATC only:**
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/applications` | full queue (officers only — contains other people's data) |
| POST | `/api/verifications` | submit field observations (idempotent via `clientSubmissionId`) |
| POST | `/api/certificates` | sign + issue the QR certificate |
| GET/POST | `/api/scheduling/preview` `/api/scheduling/assign` | geo-clustered routing |

**STATE_ADMIN / CENTRAL_ADMIN only:**
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/import/instruments` | bulk CSV: `{ "csv": "ownerName,ownerPhone,state,district,serialNumber,instrumentType,location,latitude,longitude\n..." }` |
| POST | `/api/import/stakeholders` | bulk CSV: `{ "csv": "role,name,phone,state,district,sourceRegistry\n..." }` |

---

## Recommended order to finish before the hackathon

1. **Run `docker compose up --build` yourself and confirm it works** — this
   README asserts it should, but wasn't run end-to-end in this sandbox
2. Manually test the offline flow in a real browser (steps above) —
   this is the flagship differentiator, don't demo it untested
3. Wire real photo upload to object storage if time allows — currently a
   named placeholder
4. Decide if the web Officer console is your final demo vehicle, or if
   you're porting it to the Flutter app from the original architecture —
   the API contract is identical either way, so nothing here needs to
   change if you do
