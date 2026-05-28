/**
 * Adds UTM parameters + recipient identifiers to outgoing links in email HTML.
 *
 * - Only rewrites links whose origin matches TRACKING_PORTFOLIO_URL (default https://yatindora.in)
 * - utm_content = base64-encoded recipient email (URL-safe)
 * - mid         = messageId (already used for open tracking)
 * - Existing query params on the URL are preserved
 */
import { logger } from "./logger";

const DEFAULT_PORTFOLIO_URL = "https://yatindora.in";

function getPortfolioHosts(): string[] {
  const raw = process.env.TRACKING_PORTFOLIO_URL || DEFAULT_PORTFOLIO_URL;
  return raw
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean)
    .map((u) => {
      try {
        return new URL(u).hostname.replace(/^www\./, "");
      } catch {
        return u.replace(/^https?:\/\//, "").split("/")[0]!.replace(/^www\./, "");
      }
    });
}

function encodeEmail(email: string): string {
  return Buffer.from(email.trim().toLowerCase(), "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function getUtmParams(): {
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
} {
  return {
    utm_source: process.env.UTM_SOURCE || "email",
    utm_medium: process.env.UTM_MEDIUM || "referral_outreach",
    utm_campaign: process.env.UTM_CAMPAIGN || "sde1_outreach",
  };
}

function rewriteUrl(
  originalUrl: string,
  recipientEmail: string,
  messageId?: string,
): string {
  let url: URL;
  try {
    url = new URL(originalUrl);
  } catch {
    return originalUrl;
  }

  const utm = getUtmParams();
  url.searchParams.set("utm_source", utm.utm_source);
  url.searchParams.set("utm_medium", utm.utm_medium);
  url.searchParams.set("utm_campaign", utm.utm_campaign);
  url.searchParams.set("utm_content", encodeEmail(recipientEmail));
  if (messageId) url.searchParams.set("mid", messageId);

  return url.toString();
}

/**
 * Walk every <a href="..."> in the HTML and append UTM + mid to any link
 * pointing to one of the portfolio hosts.
 */
export function injectUtmTracking(
  html: string,
  recipientEmail: string,
  messageId?: string,
): string {
  const hosts = getPortfolioHosts();
  if (hosts.length === 0) return html;

  let rewritten = 0;

  const result = html.replace(
    /href=(["'])(https?:\/\/[^"']+)\1/gi,
    (match, quote: string, url: string) => {
      let host: string;
      try {
        host = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        return match;
      }
      if (!hosts.includes(host)) return match;

      const newUrl = rewriteUrl(url, recipientEmail, messageId);
      rewritten++;
      return `href=${quote}${newUrl}${quote}`;
    },
  );

  if (rewritten > 0) {
    logger.debug(
      `[UTM] Rewrote ${rewritten} portfolio link(s) for ${recipientEmail}`,
    );
  }
  return result;
}

/** Decode `utm_content` back into a recipient email. Returns null on failure. */
export function decodeUtmContent(utmContent: string): string | null {
  try {
    const padded = utmContent.replace(/-/g, "+").replace(/_/g, "/");
    const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const decoded = Buffer.from(padded + padding, "base64").toString("utf-8");
    return decoded.includes("@") ? decoded : null;
  } catch {
    return null;
  }
}
