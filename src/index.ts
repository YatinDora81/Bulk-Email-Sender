import express from "express";
import morgan from "morgan";
import routes from "./routes";
import { logger } from "./utils/logger";
import { getStorage } from "./storage";
import { isSupabaseTrackingEnabled } from "./tracking/supabase";
import { startTrackingSyncScheduler } from "./tracking/sync-scheduler";

const app = express();
app.use(express.json());
app.use(morgan("dev"));
app.use("/api", routes);

app.get("/", (_req, res) => {
  res.json({
    name: "Bulk Email Sender",
    endpoints: {
      "POST /api/send/one": "Send to one person ({name, email, title, company})",
      "POST /api/send/all": "Import data.xlsx + send to everyone",
      "GET  /api/send/emails": "List sent emails + stats (?page=&limit=&search=&status=)",
      "GET  /api/tracking/opens": "List open tracking from Supabase",
      "GET  /api/tracking/opens/lookup?email=": "Open stats for one email",
      "POST /api/tracking/sync": "Sync Supabase open counts → STORAGE_BACKENDS",
    },
    openTracking: isSupabaseTrackingEnabled()
      ? "enabled (Supabase Edge Function)"
      : "disabled — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY",
  });
});

const PORT = process.env.PORT || 3000;

async function bootstrap() {
  logger.info(`[Bootstrap] Initializing storage (backends: ${process.env.STORAGE_BACKENDS || "sheet"})...`);
  await getStorage().init();
  logger.info("[Bootstrap] Storage ready");
  logger.info(
    `[Bootstrap] Open tracking: ${
      isSupabaseTrackingEnabled()
        ? "ON (pixel → Supabase Edge Function)"
        : "OFF (add SUPABASE_* keys to enable)"
    }`
  );

  startTrackingSyncScheduler();

  app.listen(PORT, () => {
    logger.info(`Server running on http://localhost:${PORT}`);
  });
}

bootstrap().catch((err) => {
  logger.error("[Bootstrap] Failed to start:", err);
  process.exit(1);
});
