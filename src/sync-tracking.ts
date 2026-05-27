import { getStorage } from "./storage";
import { syncOpenTrackingToStorage } from "./services/tracking-sync.service";
import { logger } from "./utils/logger";

async function main() {
  logger.info("[Sync] Supabase open counts → STORAGE_BACKENDS (sheet/mongo/prisma)");
  await getStorage().init();
  const result = await syncOpenTrackingToStorage();
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((err) => {
  logger.error("[SyncTracking] Failed:", err);
  process.exit(1);
});
