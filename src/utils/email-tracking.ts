import { getTrackOpenPixelUrl } from "../tracking/supabase";

/** Inject invisible 1x1 pixel before closing body (or append at end). */
export function injectOpenPixel(html: string, messageId: string): string {
  const pixelUrl = getTrackOpenPixelUrl(messageId);
  const pixel = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none!important;opacity:0;border:0;" />`;

  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${pixel}</body>`);
  }
  return `${html}${pixel}`;
}
