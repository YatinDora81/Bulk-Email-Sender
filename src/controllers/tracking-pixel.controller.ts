import type { Request, Response } from "express";
import { incrementOpenByMessageId } from "../tracking/supabase";
import { logger } from "../utils/logger";

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64",
);

const pixelHeaders = {
  "Content-Type": "image/png",
  "Cache-Control": "no-store, no-cache, must-revalidate",
};

/** GET /api/tracking/pixel?id=<messageId> — fallback if Edge Function not deployed (needs public URL). */
export async function trackingPixel(req: Request, res: Response) {
  const messageId = String(req.query.id || "").trim();

  if (!messageId) {
    res.status(400).send("Missing id");
    return;
  }

  try {
    await incrementOpenByMessageId(messageId);
  } catch (error) {
    logger.warn(
      `[TrackingPixel] increment failed for ${messageId}: ${error instanceof Error ? error.message : error}`,
    );
  }

  res.status(200).set(pixelHeaders).send(PIXEL);
}
