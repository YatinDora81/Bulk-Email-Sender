import { syncOpenTrackingToStorage } from "../services/tracking-sync.service";
import { isSupabaseTrackingEnabled } from "./supabase";
import { logger } from "../utils/logger";

let timer: ReturnType<typeof setInterval> | null = null;
let syncing = false;

function getIntervalMs(): number {
  const raw = process.env.TRACKING_SYNC_INTERVAL_MS;
  const parsed = raw ? Number(raw) : 60_000;
  if (!Number.isFinite(parsed) || parsed < 10_000) {
    return 60_000;
  }
  return parsed;
}

async function runSyncTick(): Promise<void> {
  if (syncing) {
    logger.debug("[TrackingSync] Skip tick — previous sync still running");
    return;
  }

  syncing = true;
  try {
    await syncOpenTrackingToStorage();
  } catch (error) {
    logger.error(
      `[TrackingSync] Interval sync failed: ${error instanceof Error ? error.message : error}`,
    );
  } finally {
    syncing = false;
  }
}

export function startTrackingSyncScheduler(): void {
  if (!isSupabaseTrackingEnabled()) {
    logger.info("[TrackingSync] Scheduler off — Supabase tracking not configured");
    return;
  }

  if (process.env.TRACKING_SYNC_ENABLED === "false") {
    logger.info("[TrackingSync] Scheduler disabled (TRACKING_SYNC_ENABLED=false)");
    return;
  }

  if (timer) return;

  const intervalMs = getIntervalMs();
  logger.info(`[TrackingSync] Scheduler started — every ${intervalMs / 1000}s`);

  void runSyncTick();
  timer = setInterval(() => {
    void runSyncTick();
  }, intervalMs);
}

export function stopTrackingSyncScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info("[TrackingSync] Scheduler stopped");
  }
}
