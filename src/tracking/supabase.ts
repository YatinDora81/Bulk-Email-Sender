import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../utils/logger";

let client: SupabaseClient | null = null;

export function isSupabaseTrackingEnabled(): boolean {
  if (process.env.TRACKING_ENABLED === "false") return false;
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function getClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for open tracking");
  }

  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/** Public URL used in email HTML (Supabase Edge Function by default). */
export function getTrackOpenPixelUrl(messageId: string): string {
  const custom = process.env.TRACKING_PIXEL_BASE_URL?.trim().replace(/\/$/, "");
  if (custom) {
    return `${custom}?id=${encodeURIComponent(messageId)}`;
  }
  const base = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  return `${base}/functions/v1/track-open?id=${encodeURIComponent(messageId)}`;
}

/** Call when the tracking pixel is loaded (Edge Function or /api/tracking/pixel). */
export async function incrementOpenByMessageId(messageId: string): Promise<void> {
  const supabase = getClient();
  const { error } = await supabase.rpc("increment_email_open", {
    p_message_id: messageId,
  });
  if (error) throw new Error(error.message);
}

/** Probe whether the pixel endpoint is reachable (deployed Edge Function returns 200). */
export async function checkTrackingPixelEndpoint(): Promise<{
  ok: boolean;
  status: number;
  hint?: string;
}> {
  if (!isSupabaseTrackingEnabled()) {
    return { ok: false, status: 0, hint: "Supabase tracking not configured" };
  }

  const testId = "00000000-0000-4000-8000-000000000001";
  const url = getTrackOpenPixelUrl(testId);
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow" });
    if (res.status === 404) {
      return {
        ok: false,
        status: 404,
        hint:
          "track-open Edge Function not deployed. Run: bunx supabase login && bunx supabase functions deploy track-open --project-ref gvueenebbeqvkfisaltc --no-verify-jwt",
      };
    }
    return { ok: res.ok, status: res.status };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      hint: error instanceof Error ? error.message : "fetch failed",
    };
  }
}

export function createMessageId(): string {
  return crypto.randomUUID();
}

/** Register row before send so pixel hits can increment open_count. */
export async function registerOpenTracking(messageId: string, email: string): Promise<void> {
  const supabase = getClient();
  const normalizedEmail = email.trim().toLowerCase();

  const { error } = await supabase.from("email_open_tracking").insert({
    message_id: messageId,
    email: normalizedEmail,
    open_count: 0,
    last_opened_at: null,
  });

  if (error) {
    throw new Error(`Supabase tracking insert failed: ${error.message}`);
  }

  logger.debug(`[Tracking] Registered messageId=${messageId} for ${normalizedEmail}`);
}

export interface OpenTrackingRow {
  message_id: string;
  email: string;
  open_count: number;
  last_opened_at: string | null;
  created_at: string;
}

export async function getOpenTrackingByEmail(email: string): Promise<OpenTrackingRow | null> {
  const supabase = getClient();
  const { data, error } = await supabase
    .from("email_open_tracking")
    .select("message_id, email, open_count, last_opened_at, created_at")
    .eq("email", email.trim().toLowerCase())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data as OpenTrackingRow | null;
}

export async function listOpenTracking(limit = 100): Promise<OpenTrackingRow[]> {
  const supabase = getClient();
  const { data, error } = await supabase
    .from("email_open_tracking")
    .select("message_id, email, open_count, last_opened_at, created_at")
    .order("last_opened_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return (data || []) as OpenTrackingRow[];
}

/** Fetch all tracking rows (paginated) for sync into STORAGE_BACKENDS. */
export async function listAllOpenTracking(): Promise<OpenTrackingRow[]> {
  const supabase = getClient();
  const pageSize = 1000;
  const all: OpenTrackingRow[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("email_open_tracking")
      .select("message_id, email, open_count, last_opened_at, created_at")
      .order("created_at", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw new Error(error.message);
    const batch = (data || []) as OpenTrackingRow[];
    all.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }

  return all;
}

/** Delete all rows from email_open_tracking (used by bun run clear). */
export async function clearAllOpenTracking(): Promise<number> {
  if (!isSupabaseTrackingEnabled()) {
    return 0;
  }

  const supabase = getClient();
  const { count, error: countError } = await supabase
    .from("email_open_tracking")
    .select("*", { count: "exact", head: true });

  if (countError) throw new Error(countError.message);

  const { error } = await supabase.from("email_open_tracking").delete().neq("email", "");

  if (error) throw new Error(`Supabase tracking clear failed: ${error.message}`);

  const deleted = count ?? 0;
  logger.info(`[Tracking] Cleared ${deleted} rows from email_open_tracking`);
  return deleted;
}
