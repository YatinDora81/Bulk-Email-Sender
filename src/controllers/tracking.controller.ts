import type { Request, Response } from "express";
import {
  isSupabaseTrackingEnabled,
  listOpenTracking,
  getOpenTrackingByEmail,
} from "../tracking/supabase";
import { syncOpenTrackingToStorage } from "../services/tracking-sync.service";
import { logger } from "../utils/logger";

export async function getOpenTrackingList(_req: Request, res: Response) {
  try {
    if (!isSupabaseTrackingEnabled()) {
      res.status(503).json({
        error: "Supabase tracking not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      });
      return;
    }

    const rows = await listOpenTracking(500);
    res.json({ tracking: rows, total: rows.length });
  } catch (error: unknown) {
    logger.error(`Tracking list failed: ${error instanceof Error ? error.message : error}`);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
}

export async function getOpenTrackingForEmail(req: Request, res: Response) {
  try {
    if (!isSupabaseTrackingEnabled()) {
      res.status(503).json({ error: "Supabase tracking not configured." });
      return;
    }

    const email = String(req.query.email || "");
    if (!email.includes("@")) {
      res.status(400).json({ error: "Query param email is required" });
      return;
    }

    const row = await getOpenTrackingByEmail(email);
    if (!row) {
      res.status(404).json({ error: "No tracking row for this email" });
      return;
    }

    res.json({ tracking: row });
  } catch (error: unknown) {
    logger.error(`Tracking lookup failed: ${error instanceof Error ? error.message : error}`);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
}

/** POST /api/tracking/sync — pull Supabase opens into STORAGE_BACKENDS (sheet/mongo/prisma). */
export async function syncTrackingToStorage(_req: Request, res: Response) {
  try {
    const result = await syncOpenTrackingToStorage();
    res.json({ ok: true, ...result });
  } catch (error: unknown) {
    logger.error(`Tracking sync failed: ${error instanceof Error ? error.message : error}`);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
}
