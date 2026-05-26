# Bulk Email Sender

AI-driven bulk email sender that reads contacts from an Excel file, generates personalized cold emails using Google Gemini, and sends them via Gmail SMTP with resume attached. Storage is **pluggable** — Google Sheet (default), MongoDB, and Prisma/Postgres can be enabled together or independently via a single env var.

## Tech Stack

- **Runtime:** Bun
- **Server:** Express.js
- **AI:** Google Gemini 2.5 Flash (multi-key rotation)
- **Storage:** Google Sheet (primary) | MongoDB | Prisma + Postgres — all switchable
- **Email:** Nodemailer + Gmail SMTP
- **Validation:** Zod
- **Excel:** xlsx
- **Logging:** Morgan + custom file logger

---

## Project Structure

```
.
├── data.xlsx                        → Input contacts (SNo, Name, Email, Title, Company)
├── Yatin-SDE-1.pdf                  → Resume attached to every sent email
├── prisma/
│   └── schema.prisma                → Prisma schema (Contact model + EmailStatus enum)
├── prisma.config.ts                 → Prisma config (datasource URL = env DATABASE_URL)
├── generated/prisma/                → Auto-generated Prisma client (after `prisma generate`)
└── src/
    ├── index.ts                     → Express server entry + storage bootstrap
    ├── mainfn.ts                    → Standalone batch sender CLI (used by `bun run send`)
    ├── cleardb.ts                   → Wipes all contacts from primary storage
    ├── config/
    │   ├── gemini.ts                → Gemini AI client (multi-API-key rotation, 503/429 retry)
    │   └── mailer.ts                → Nodemailer Gmail transporter + SMTP verify
    ├── controllers/
    │   └── send.controller.ts       → HTTP handlers: sendOne, sendAll, getSentEmails
    ├── routes/
    │   ├── index.ts                 → Mounts /send routes under /api
    │   └── send.route.ts            → Defines /api/send/one, /all, /emails
    ├── services/
    │   ├── campaign.service.ts      → Background batch sender (singleton, pause/resume/stop)
    │   └── excel.service.ts         → Reads data.xlsx → RawContact[]
    ├── storage/                     → Pluggable storage abstraction
    │   ├── types.ts                 → IStorage interface, Contact, Stats types
    │   ├── sheet.storage.ts         → Google Sheet backend (in-memory cache + per-email save)
    │   ├── mongo.storage.ts         → MongoDB backend (unique email index)
    │   ├── prisma.storage.ts        → Prisma/Postgres backend (dynamic client import)
    │   └── index.ts                 → StorageManager: routing + preflight + fan-out writes
    └── utils/
        ├── logger.ts                → Color console + daily file logger (logs/YYYY-MM-DD.log)
        ├── schemas.ts               → Zod validation for request body + query
        └── prompt.ts                → Gemini system prompt + per-contact prompt builder
```

---

## File-by-File Explanation

### Entry points

#### `src/index.ts`
Express HTTP server. Mounts `/api` routes and listens on `process.env.PORT` (default `3000`).
On startup, calls `getStorage().init()` first — this triggers the **preflight check** for the selected backends. If the primary backend isn't reachable, the server refuses to start.

#### `src/mainfn.ts`
Standalone CLI runner (no HTTP server). Reads `data.xlsx`, imports into storage, then sends emails in batches with detailed progress logs. Triggered by `bun run send`.

#### `src/cleardb.ts`
Clears every contact from the **primary** storage backend (and fans out delete to mirrors). Triggered by `bun run clear`.

---

### Storage layer (`src/storage/`)

#### `types.ts`
Defines:
- `Contact` — the canonical contact shape used everywhere in the app
- `ContactStatus` — `"pending" | "sent" | "failed"`
- `IStorage` — the contract every backend implements (`init`, `insertContact`, `upsertSentContact`, `updateContact`, `findContact`, `list`, `getStats`, `getPending`, `clearAll`)
- `CONTACT_HEADERS` — single source of truth for the Sheet column order

#### `sheet.storage.ts`
Google Sheet backend (primary by default). Behavior:
- On `init()`: authenticates with JWT service account, opens the configured tab (creates it if missing), and loads **all rows into an in-memory `Map<email, row>`**.
- All reads (`list`, `find`, `getStats`, `getPending`) are served from the cache — fast.
- Each write (`insert`, `update`, `upsertSent`) appends or saves a single row immediately to the live sheet → **real-time visibility while emails are sending**.

#### `mongo.storage.ts`
MongoDB backend. Uses `mongodb` driver directly with a `contacts` collection. Creates unique index on `email` and an index on `status`. Used when `mongo` is in `STORAGE_BACKENDS`.

#### `prisma.storage.ts`
Prisma + Postgres backend. Lazy-imports the generated client from `generated/prisma/client` so the project still builds even when Prisma hasn't been generated. Maps Prisma's `P2002` unique-violation error to "already exists" instead of throwing.

#### `index.ts` (StorageManager)
The orchestrator:
- Parses `STORAGE_BACKENDS` env var (e.g. `sheet,mongo,prisma`)
- Validates entries (fails fast on invalid names)
- Runs a **preflight check** on each backend in order — prints `✓ ready` or `✗ FAILED` per backend with timings
- First backend = **primary** (source of truth for reads)
- Remaining backends = **mirrors** (writes are fanned out; failures are warnings, never fatal)
- If primary fails preflight → app refuses to start with a clear error
- Failed mirrors are dropped so we don't keep retrying them

---

### Controllers, routes, services

#### `controllers/send.controller.ts`
HTTP handlers:
- **`sendOne`** — validates body, generates 1 email via Gemini, sends via SMTP, upserts contact as `sent` in storage.
- **`sendAll`** — parses `data.xlsx`, inserts every row (skipping duplicates by email), then triggers `campaignManager.start()` to send asynchronously.
- **`getSentEmails`** — paginated list with search + status filter, plus aggregate stats.

#### `routes/send.route.ts` + `routes/index.ts`
Express routers. Maps endpoints:
- `POST /api/send/one`
- `POST /api/send/all`
- `GET /api/send/emails`

#### `services/campaign.service.ts`
Singleton **CampaignManager** that runs the bulk send in the background.
- Pulls 15 pending contacts at a time from storage
- For each: generates email → sends SMTP → updates storage with `sent` or `failed`
- 15-second break between batches
- Supports `pause()` / `resume()` / `stop()` / `reset()`
- Exposes `getStatus()` with live progress

#### `services/excel.service.ts`
Parses `data.xlsx` from project root using `xlsx`. Maps the various possible column names (`SNo`/`sno`/`S.No`, `Name`/`name`, etc.) into a normalized `RawContact[]`. Lowercases emails and filters out rows without a valid `@` in the email.

---

### Config (`src/config/`)

#### `gemini.ts`
Wraps Google Gemini 2.5 Flash with:
- **Multi-key rotation** — reads `GEMINI_API_KEYS` env in `NAME__SPLIT__APIKEY,NAME__SPLIT__APIKEY` format and round-robins requests across all keys
- **Retry with backoff** on `503 UNAVAILABLE` and `429 RESOURCE_EXHAUSTED`
- Singleton accessed via `getGemini()`

#### `mailer.ts`
Nodemailer Gmail transporter (cached singleton). `sendEmail({to, subject, html})` always attaches `Yatin-SDE-1.pdf` from project root. `verifySmtp()` is called by `mainfn.ts` at startup.

---

### Utils (`src/utils/`)

#### `prompt.ts`
- **`EMAIL_SYSTEM_PROMPT`** — the full Gemini system instruction including persona, structure, tone, length rules, signature HTML template, and the strict "no placeholder names" guardrails.
- **`buildEmailPrompt({name, title, company})`** — sanitizes the recipient name (fallback to `"Hiring Team"` for invalid/generic names) and returns a JSON-stringified instruction payload per contact.

#### `schemas.ts`
Zod validators for:
- `sendSchema` — POST `/api/send/one` body (name, email, title, company)
- `contactsQuerySchema` — GET `/api/send/emails` query string (page, limit, search, status)

#### `logger.ts`
Custom logger with:
- Color-coded console output (info/warn/error/debug)
- Daily rotating file logs at `logs/YYYY-MM-DD.log`
- `DEBUG=true` env unlocks debug-level output

---

### Database / schema files

#### `prisma/schema.prisma`
Prisma schema for the optional Postgres backend. Defines:
- `EmailStatus` enum (`pending | sent | failed`)
- `Contact` model with unique `email`, indexes on `status`, `updatedAt`, `company`

#### `prisma.config.ts`
Prisma 7 config file. Tells Prisma to read `DATABASE_URL` from env when running migrations.

---

## Storage Backends Configuration

Set `STORAGE_BACKENDS` in `.env` to switch backends. **First listed = source of truth, others = mirrors (writes only).**

```env
STORAGE_BACKENDS=sheet                  # Default: only Google Sheet
STORAGE_BACKENDS=sheet,mongo            # Sheet primary, mirror to Mongo
STORAGE_BACKENDS=sheet,mongo,prisma     # Sheet primary, mirror to Mongo + Postgres
STORAGE_BACKENDS=mongo                  # MongoDB only
STORAGE_BACKENDS=prisma                 # Prisma/Postgres only
```

- **Reads** (list, stats, find, getPending) → always from primary backend
- **Writes** (insert, update, upsert, clear) → applied to primary, then fanned out to mirrors (failures logged, never fatal)

### Preflight check
On startup, every enabled backend is probed in order. Sample output:

```
[Storage] ════════════════════════════════════════════
[Storage] Configured: sheet, mongo
[Storage] Primary: sheet | Mirrors: mongo
[Storage] Running preflight checks...
[Storage] ────────────────────────────────────────────
[Storage]   ✓ sheet   ready  (812ms)
[Storage]   ✗ mongo   FAILED (4321ms) — connect ECONNREFUSED ...
[Storage] ────────────────────────────────────────────
[Storage] Skipping unavailable mirrors: mongo
[Storage] Ready — using "sheet" as primary (no mirrors)
[Storage] ════════════════════════════════════════════
```

Primary failure → app exits with the error.

---

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Create `.env`

```env
# Gemini API Keys (format: NAME__SPLIT__APIKEY,NAME__SPLIT__APIKEY)
GEMINI_API_KEYS="key1__SPLIT__your-api-key-1,key2__SPLIT__your-api-key-2"

# Gmail SMTP
SMTP_EMAIL=your-email@gmail.com
SMTP_PASSWORD=your-gmail-app-password
SENDER_NAME=Yatin Dora

# Server
PORT=3000
DEBUG=false

# Storage selection
STORAGE_BACKENDS=sheet

# Google Sheet (required when sheet backend is enabled)
GOOGLE_SHEET_ID=1CWk9gyU0ZIHMxrl-9WjzJaV_nSiC0LkPmV_Aq3V2lt8
GOOGLE_SHEET_TAB=Contacts

# Google service account credentials (paste from service-account JSON file)
client_email=test-for-nodejs@your-project.iam.gserviceaccount.com
private_key="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# Optional — only needed if Mongo backend enabled
MONGODB_URI=mongodb+srv://...

# Optional — only needed if Prisma backend enabled
DATABASE_URL=postgresql://...
```

> **Important:** Share the Google Sheet with the service account email (`client_email` value) so it can read/write.

### 3. (Optional) Generate Prisma client + run migrations

Only required if you plan to enable the `prisma` backend:

```bash
bun --bun run prisma generate
bun --bun run prisma migrate dev --name init_contacts
```

### 4. Add your files

- Place your Excel file as `data.xlsx` in the project root
- Place your resume as `Yatin-SDE-1.pdf` in the project root

### 5. Run

```bash
bun run dev
```

Server starts at `http://localhost:3000`

---

## API Reference

### Base URL

```
http://localhost:3000/api
```

### 1. Send to everyone from Excel — `POST /api/send/all`

Reads `data.xlsx`, imports contacts (skips duplicates by email), and starts the campaign manager which sends in batches of 15 with a 15-second break.

### 2. Send to one person — `POST /api/send/one`

Body:

```json
{
  "name": "Akanksha Puri",
  "email": "akanksha.puri@sourcefuse.com",
  "title": "Associate Director HR",
  "company": "SourceFuse Technologies"
}
```

### 3. List sent emails + stats — `GET /api/send/emails`

Query params:

| Param    | Type   | Default | Description                         |
| -------- | ------ | ------- | ----------------------------------- |
| `page`   | number | 1       | Page number                         |
| `limit`  | number | 20      | Results per page (max 100)          |
| `search` | string | —       | Search by name, email, or company   |
| `status` | string | —       | Filter: `pending`, `sent`, `failed` |

---

## Rate Limiting

- **Batch size:** 15 emails per batch
- **Break:** 15 seconds between batches
- **Speed:** ~60 emails/min → ~1800 emails in ~30 minutes

## Duplicate Prevention

Every backend enforces uniqueness on `email`:
- **Sheet:** in-memory cache check before append
- **Mongo:** unique index on `email`
- **Prisma:** `@unique` on `email`

Contacts already marked as `sent` or `failed` are skipped during batch runs (only `pending` are processed).

---

## Scripts

```bash
bun run dev       # Start dev server with HMR
bun run start     # Start production server
bun run send      # Standalone batch sender (reads data.xlsx)
bun run clear     # Clear all contacts from primary storage
```
