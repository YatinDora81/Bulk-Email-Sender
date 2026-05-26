import { getStorage } from "./storage";
import { logger } from "./utils/logger";

async function clearDb() {
  logger.info("[ClearDB] Initializing storage...");
  const storage = getStorage();
  await storage.init();

  const deleted = await storage.clearAll();
  logger.info(`[ClearDB] Cleared ${deleted} contacts from primary storage`);

  logger.info("[ClearDB] Done.");
  process.exit(0);
}

clearDb().catch((err) => {
  logger.error("[ClearDB] Failed:", err);
  process.exit(1);
});
