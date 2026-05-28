# Commands reference

Every `bun run …` script in this project, what it does step-by-step, what it touches, and when to use it.

**Runtime:** [Bun](https://bun.sh). All commands load variables from `.env` automatically.

---

## Quick reference

| Command | One line |
|---------|----------|
| `bun run clear` | Wipe Google Sheet contacts **and** Supabase open-tracking rows |
| `bun run send` | Read `data.xlsx` → generate emails (Gemini) → send (SMTP) → update sheet |
| `bun run sync` | Copy `open_count` / `last_opened_at` from Supabase → sheet (`openCount`, `lastOpenedAt`) |
| `bun run test:clear` | Same as `clear` but on `TEMP_Contacts` tab + `TEMP_email_open_tracking` table |
| `bun run test:send` | Same as `send` but writes to `TEMP_Contacts` / `TEMP_contacts` / `TEMP_email_open_tracking` |
| `bun run test:sync` | Same as `sync` but reads `TEMP_email_open_tracking` → `TEMP_Contacts` |
| `bun run dev` | Start API server with hot reload |
| `bun run start` | Start API server (production-style, no hot reload) |
| `bun run check:tracking` | Ping the open-tracking pixel URL (should return 200) |
| `bun run deploy:tracking` | Deploy `track-open` Edge Function to Supabase (one-time / after changes) |
| `bun run setup:supabase` | Create `email_open_tracking` table via direct Postgres (needs `SUPABASE_DB_URL`) |
| `bun run test:tracking` | Test Supabase register + pixel/RPC + read back open count |
| `bun run test:tracking:full` | Test full path: sheet contact → open → sync → verify sheet columns |

**Typical campaign loop:**

```bash
bun run clear
bun run send
# recipients open mail (Gmail: "Display images")
bun run sync
```

---

## Test mode (`test:*` scripts)

All `test:*` commands set `STORAGE_NAME_PREFIX=TEMP_` for the run. Same code path, only storage names change:

| Backend | Prod name | Test name |
|---------|-----------|-----------|
| Google Sheet tab | `Contacts` | `TEMP_Contacts` (auto-created) |
| MongoDB collection | `contacts` | `TEMP_contacts` (auto-created) |
| Supabase table | `email_open_tracking` | `TEMP_email_open_tracking` |
| Supabase RPC | `increment_email_open` | `TEMP_increment_email_open` |
| Pixel URL | `?id=<uuid>` | `?id=<uuid>&t=TEMP_` |

**One-time setup:** apply `supabase/migrations/002_temp_email_open_tracking.sql` in Supabase SQL Editor (or via `setup:supabase`) and redeploy the Edge Function (already done in this repo) so `t=TEMP_` routes to the TEMP RPC.

**Prisma:** test mode is not supported on Prisma (model name is fixed at compile time). Test mode mirrors land in prod tables for the `prisma` backend. Use `sheet`/`mongo` for test runs.

**Typical test loop:**

```bash
bun run test:clear
bun run test:send       # writes to TEMP_Contacts only
# open pixel in test inbox (loads /track-open?id=...&t=TEMP_)
bun run test:sync       # updates TEMP_Contacts openCount/lastOpenedAt
```

Production data stays untouched.

---

## Main workflow commands

### `bun run clear`

**File:** `src/cleardb.ts`

**Purpose:** Reset contact storage and open-tracking data so the next `send` run starts from a clean slate.

**What happens:**

1. **Storage init** — Reads `STORAGE_BACKENDS` (default `sheet`). Runs preflight (Google Sheet auth, tab load, etc.).
2. **Primary storage `clearAll()`** — Deletes every row in the primary backend (e.g. Google Sheet tab `Contacts`). Mirrors (mongo/prisma) are cleared if configured.
3. **Supabase `clearAllOpenTracking()`** — If `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set and `TRACKING_ENABLED` is not `false`, deletes all rows in `email_open_tracking`.
4. Exits with a reminder: `bun run send` → open emails → `bun run sync`.

**Does not delete:**

- `data.xlsx` on disk
- Sent messages in Gmail
- Supabase table schema / Edge Function

**Requires:** Sheet credentials (`GOOGLE_SHEET_ID`, service account vars) when using `sheet` backend.

**Example log:**

```text
[ClearDB] Cleared 6 contacts from primary storage
[ClearDB] Cleared 6 rows from Supabase email_open_tracking
```

---

### `bun run send`

**File:** `src/mainfn.ts`

**Purpose:** Standalone bulk send — no HTTP server. This is the main CLI for campaigns.

**What happens:**

#### Step 1 — Bootstrap

- Initializes storage (same as server).
- Verifies SMTP (`verifySmtp()`). **Aborts** if Gmail credentials are wrong.
- Initializes Gemini (multi-key rotation from `.env`).
- If Supabase tracking is on, **checks** the pixel URL (`check:tracking` logic). Logs a **warning** if the Edge Function returns 404 (opens won’t count until `deploy:tracking` is done).

#### Step 2 — Load Excel

- Reads `data.xlsx` from project root.
- Expects columns: SNo, Name, Email, Title, Company.
- Logs count and sample rows.

#### Step 3 — Sync to storage & filter

- For each Excel row: `insertContact()` (skips duplicates already in sheet).
- Loads **pending** contacts only (status ≠ `sent`).
- Already-sent emails are **not** sent again.

#### Step 4 — Send in batches

Default timing (in code):

- **15** emails per batch
- **2 s** between emails in a batch
- **15 s** break between batches

Per contact:

1. Build Gemini prompt (`buildEmailPrompt`).
2. Call Gemini → parse JSON `{ subject, body }`.
3. **`sendTrackedEmail()`** — if Supabase is configured:
   - Inserts row in `email_open_tracking` (`message_id`, `email`, `open_count: 0`).
   - Injects 1×1 pixel:  
     `https://<project>.supabase.co/functions/v1/track-open?id=<uuid>`
   - Sends HTML via Gmail SMTP (resume attached per mailer config).
4. Updates sheet: `status: sent`, subject, body, `sentAt`.

On failure: `status: failed`, `error` message stored.

**Does not:**

- Auto-sync open counts to sheet (you run `bun run sync` manually).
- Clear Supabase or sheet first (use `clear`).

**Requires:** `data.xlsx`, Gemini keys, SMTP vars, sheet (or other) storage, optional Supabase for tracking.

**After send:** Open test inboxes, tap **“Display images”** in Gmail, then run `bun run sync`.

---

### `bun run sync` (alias: `bun run sync:tracking`)

**File:** `src/sync-tracking.ts`

**Purpose:** One-shot copy of open stats from Supabase into your configured storage (sheet/mongo/prisma).

**What happens:**

1. Storage `init()`.
2. **`syncOpenTrackingToStorage()`**:
   - Fetches all rows from `email_open_tracking` (paginated).
   - Aggregates by email (sums `open_count`, latest `last_opened_at` if multiple message IDs per email).
   - For each email in Supabase:
     - If contact exists in storage → updates `openCount` and `lastOpenedAt` when values changed.
     - If no contact → **skipped** (counted as `skippedNotInStorage`).
3. Prints JSON summary and exits.

**Example output:**

```json
{
  "supabaseRows": 6,
  "uniqueEmails": 6,
  "updated": 3,
  "skippedNotInStorage": 0,
  "errors": 0
}
```

**When to run:** After recipients open emails (and pixel loaded). Safe to run multiple times (idempotent for unchanged counts).

**Requires:** Supabase configured; sheet (or backend) must already have those contacts (from `send`).

**Sheet columns updated:** `openCount`, `lastOpenedAt` (headers must exist on the `Contacts` tab).

---

## Server commands

### `bun run dev`

**File:** `src/index.ts` with `bun --hot`

**Purpose:** Local API server with hot reload.

**What happens:**

- Express on `PORT` (default `3000`).
- Storage init on boot.
- If `TRACKING_SYNC_ENABLED=true`, starts background interval sync (default off in `.env` — manual `sync` preferred for CLI workflow).
- Routes under `/api` (send one/all, list emails, campaign, tracking list/sync/pixel).

Use when building integrations or testing HTTP endpoints, not required for `clear` / `send` / `sync`.

---

### `bun run start`

Same as `dev` but **without** hot reload. Use for a stable local server or simple production run.

---

## Open tracking setup & diagnostics

Open tracking flow:

```text
send → register row in Supabase + pixel in HTML
     → recipient opens email → Gmail loads pixel URL
     → Edge Function track-open → increment_email_open RPC
     → bun run sync → sheet openCount / lastOpenedAt
```

### `bun run check:tracking`

**Purpose:** Health check for the pixel endpoint.

**What happens:**

- GET on a test pixel URL (fake message id).
- **200** → `{ ok: true }` — opens will be counted when images load.
- **404** → Edge Function not deployed → run `deploy:tracking`.
- Exit code `0` = OK, `1` = broken.

---

### `bun run deploy:tracking`

**File:** `scripts/deploy-track-open.ts`

**Purpose:** Deploy the `track-open` Supabase Edge Function (required for real opens via email).

**What happens:**

1. `bunx supabase link --project-ref <SUPABASE_PROJECT_REF>`
2. `bunx supabase functions deploy track-open --no-verify-jwt`
3. Waits 3s, runs `check:tracking`.

**Requires:** `bunx supabase login` once on your machine.

**Config:** `supabase/config.toml` must have:

```toml
[functions.track-open]
verify_jwt = false
```

**When:** Once per project, or after changing `supabase/functions/track-open/index.ts`.

---

### `bun run setup:supabase`

**File:** `scripts/setup-supabase-migration.ts`

**Purpose:** Create the `email_open_tracking` table and `increment_email_open()` function by running SQL over Postgres.

**What happens:**

- Connects with `SUPABASE_DB_URL` (direct DB URL, not the REST URL).
- Executes `supabase/migrations/001_email_open_tracking.sql`.

**Requires:** `SUPABASE_DB_URL` in `.env` (password URL-encoded if it contains `!`, `+`, `?`).

**When:** First-time DB setup, or if the table was never created. Alternative: paste the same SQL in Supabase Dashboard → SQL Editor.

---

### `bun run test:tracking`

**File:** `scripts/test-supabase-tracking.ts`

**Purpose:** Automated test of Supabase-only tracking (no sheet).

**Steps:**

1. Insert a fake tracking row.
2. Hit pixel URL (or RPC fallback if 404).
3. Read row back — expect `open_count >= 1`.

Use after `setup:supabase` and `deploy:tracking`.

---

### `bun run test:tracking:full`

**File:** `scripts/test-full-tracking-sync.ts`

**Purpose:** End-to-end test: sheet + Supabase + sync.

**Steps:**

1. Insert test contact into sheet.
2. Register tracking + simulate open.
3. Run `syncOpenTrackingToStorage()`.
4. Verify sheet has `openCount >= 1` and `lastOpenedAt` set.

Leaves one test row in sheet/Supabase unless you `clear` after.

---

## Environment variables (commands care about)

| Variable | Used by |
|----------|---------|
| `STORAGE_BACKENDS` | `clear`, `send`, `sync` — e.g. `sheet` or `sheet,mongo` |
| `GOOGLE_SHEET_ID`, `GOOGLE_SHEET_TAB`, service account | Sheet backend |
| `GEMINI_API_KEY` / multi-key format | `send` |
| `SMTP_*` / Gmail app password | `send` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | `clear` (tracking rows), `send` (pixel), `sync` |
| `TRACKING_ENABLED=false` | Disables all Supabase tracking |
| `SUPABASE_PROJECT_REF` | `deploy:tracking` |
| `SUPABASE_DB_URL` | `setup:supabase` only |
| `TRACKING_SYNC_ENABLED` | `dev`/`start` background sync only (CLI send does not use it) |

---

## Troubleshooting

| Problem | What to check |
|---------|----------------|
| `openCount` stays 0 on sheet | Run `bun run check:tracking` → must be 200. Gmail must **display images**. Then `bun run sync`. |
| `sync` shows `updated: 0` | Supabase `open_count` still 0, or sheet already matches. Check Supabase Table Editor → `email_open_tracking`. |
| `sync` skips emails | `skippedNotInStorage` — email in Supabase but not in sheet (run `send` first or email mismatch). |
| `clear` didn’t clear Supabase | `SUPABASE_SERVICE_ROLE_KEY` missing or `TRACKING_ENABLED=false`. |
| `send` skips everyone | All contacts already `sent` in sheet — run `clear` or change Excel emails. |
| Deploy fails on `config.toml` | Use `[functions.track-open]` not `[functions]` for `verify_jwt`. |

---

## Files each command runs

| Command | Entry file |
|---------|------------|
| `clear` | `src/cleardb.ts` |
| `send` | `src/mainfn.ts` |
| `sync` | `src/sync-tracking.ts` |
| `dev` / `start` | `src/index.ts` |
| `deploy:tracking` | `scripts/deploy-track-open.ts` |
| `setup:supabase` | `scripts/setup-supabase-migration.ts` |
| `test:tracking` | `scripts/test-supabase-tracking.ts` |
| `test:tracking:full` | `scripts/test-full-tracking-sync.ts` |

More architecture detail: see [README.md](./README.md) and [docs/SUPABASE_OPEN_TRACKING.md](./docs/SUPABASE_OPEN_TRACKING.md).
