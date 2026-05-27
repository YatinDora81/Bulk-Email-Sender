import { sendEmail } from "../config/mailer";
import { logger } from "../utils/logger";
import { injectOpenPixel } from "../utils/email-tracking";
import {
  createMessageId,
  isSupabaseTrackingEnabled,
  registerOpenTracking,
} from "../tracking/supabase";

export interface TrackedSendResult {
  messageId?: string;
  trackingEnabled: boolean;
}

/**
 * Sends email via SMTP. When Supabase tracking is configured, registers a row
 * and injects an open pixel (handled by Supabase Edge Function — no local server needed).
 */
export async function sendTrackedEmail(params: {
  to: string;
  subject: string;
  html: string;
}): Promise<TrackedSendResult> {
  let html = params.html;

  if (!isSupabaseTrackingEnabled()) {
    await sendEmail(params);
    return { trackingEnabled: false };
  }

  const messageId = createMessageId();
  await registerOpenTracking(messageId, params.to);
  html = injectOpenPixel(html, messageId);

  await sendEmail({ ...params, html });
  logger.info(`[Tracking] Sent with open pixel — messageId=${messageId} → ${params.to}`);

  return { messageId, trackingEnabled: true };
}
