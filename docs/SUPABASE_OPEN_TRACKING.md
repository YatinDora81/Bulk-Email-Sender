# Supabase open tracking (no always-on server)

Your bulk sender stays local. **Only open counts** are stored in Supabase:

| Column | Meaning |
|--------|---------|
| `email` | Recipient |
| `open_count` | How many times the pixel was loaded |
| `last_opened_at` | Last open time (UTC) |

`message_id` is internal (used in the tracking pixel URL).

---

## Why this works without your server running

1. When you send, the app inserts a row in Supabase and adds a pixel to the HTML:
   `https://YOUR_PROJECT.supabase.co/functions/v1/track-open?id=MESSAGE_ID`
2. When the recipient opens the email, their mail client requests that URL.
3. **Supabase Edge Function** (hosted by Supabase, free tier) increments `open_count`.
4. Your laptop can be off — Supabase handles the request.

Contacts / sent status still live in **Google Sheet** (or mongo/prisma) as before. Supabase is **only** for opens.

---

## Setup (one time, ~10 minutes)

### 1. Create a Supabase project

1. Go to [https://supabase.com](https://supabase.com) → New project.
2. Save **Project URL** and **service_role** key (Settings → API).
   - Use **service_role** only in `.env` on your machine — never commit it.

### 2. Create the table

In Supabase → **SQL Editor**, run the file:

`supabase/migrations/001_email_open_tracking.sql`

### 3. Deploy the Edge Function

Install Supabase CLI (once):

```bash
brew install supabase/tap/supabase
```

Login and link project:

```bash
supabase login
cd /path/to/bulk-email-sender
supabase link --project-ref YOUR_PROJECT_REF
```

Deploy the function:

```bash
supabase functions deploy track-open --no-verify-jwt
```

(`--no-verify-jwt` = public pixel URL, no auth header needed.)

### 4. Add to `.env`

```env
SUPABASE_URL="https://YOUR_PROJECT_REF.supabase.co"
SUPABASE_PROJECT_REF="YOUR_PROJECT_REF"
SUPABASE_SERVICE_ROLE_KEY="paste-service-role-key-here"
TRACKING_ENABLED=true
```

**Important:** `sb_publishable_...` is **not** enough for the app to insert tracking rows.  
You need **`service_role`** from Dashboard → Settings → API → Project API keys → `service_role` (secret).

### 5. Test

1. Send one test email: `POST /api/send/one` or `bun run send` (one contact).
2. Open the email on your phone (allow images).
3. In Supabase → **Table Editor** → `email_open_tracking` → see `open_count` go up.

---

## View stats

- **Supabase Dashboard** → Table Editor → `email_open_tracking`
- **API** (when dev server is running):
  - `GET /api/tracking/opens`
  - `GET /api/tracking/opens/lookup?email=someone@company.com`

---

## Disable tracking

```env
TRACKING_ENABLED=false
```

Emails send normally without pixel or Supabase insert.

---

## Limitations (same as any pixel tracking)

- Apple Mail Privacy Protection may inflate or hide real opens.
- Some clients block images until the user clicks "Show images".
- Corporate scanners can trigger false opens.

Treat `open_count` as a **signal**, not proof someone read the email.
