import { getStorage } from "./storage";
import { clearAllOpenTracking, isSupabaseTrackingEnabled } from "./tracking/supabase";
import { logger } from "./utils/logger";

async function clearDb() {
  logger.info("[ClearDB] Initializing storage...");
  const storage = getStorage();
  await storage.init();

  const deleted = await storage.clearAll();
  logger.info(`[ClearDB] Cleared ${deleted} contacts from primary storage`);

  if (isSupabaseTrackingEnabled()) {
    const trackingDeleted = await clearAllOpenTracking();
    logger.info(`[ClearDB] Cleared ${trackingDeleted} rows from Supabase email_open_tracking`);
  } else {
    logger.info("[ClearDB] Supabase tracking skipped (not configured)");
  }

  logger.info("[ClearDB] Done. Next: bun run send → open emails → bun run sync");
  process.exit(0);
}

clearDb().catch((err) => {
  logger.error("[ClearDB] Failed:", err);
  process.exit(1);
});
