import { sendEmail } from "../config/mailer";
import { logger } from "../utils/logger";
import { injectOpenPixel } from "../utils/email-tracking";
import { injectUtmTracking } from "../utils/utm-tracking";
import {
  createMessageId,
  isSupabaseTrackingEnabled,
  registerOpenTracking,
} from "../tracking/supabase";

export interface TrackedSendResult {
  messageId?: string;
  trackingEnabled: boolean;
}

function isUtmTrackingEnabled(): boolean {
  return process.env.UTM_TRACKING_ENABLED !== "false";
}

/**
 * Sends email via SMTP. When Supabase tracking is configured, registers a row
 * and injects an open pixel (handled by Supabase Edge Function — no local server needed).
 * Always rewrites portfolio links with UTM parameters + recipient identifier (base64 email).
 */
export async function sendTrackedEmail(params: {
  to: string;
  subject: string;
  html: string;
}): Promise<TrackedSendResult> {
  let html = params.html;

  const trackingOn = isSupabaseTrackingEnabled();
  const utmOn = isUtmTrackingEnabled();
  let messageId: string | undefined;

  if (trackingOn) {
    messageId = createMessageId();
    await registerOpenTracking(messageId, params.to);
    html = injectOpenPixel(html, messageId);
  }

  if (utmOn) {
    html = injectUtmTracking(html, params.to, messageId);
  }

  await sendEmail({ ...params, html });

  if (trackingOn) {
    logger.info(
      `[Tracking] Sent with open pixel + UTM — messageId=${messageId} → ${params.to}`,
    );
  } else if (utmOn) {
    logger.info(`[Tracking] Sent with UTM only → ${params.to}`);
  }

  return { messageId, trackingEnabled: trackingOn };
}
