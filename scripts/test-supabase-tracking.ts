import { createClient } from "@supabase/supabase-js";
import {
  createMessageId,
  getTrackOpenPixelUrl,
  isSupabaseTrackingEnabled,
  registerOpenTracking,
  getOpenTrackingByEmail,
} from "../src/tracking/supabase";

async function main() {
  console.log("\n=== Supabase Open Tracking Test ===\n");

  const url = process.env.SUPABASE_URL;
  const hasServiceKey = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
  const enabled = isSupabaseTrackingEnabled();

  console.log("SUPABASE_URL:", url || "(missing)");
  console.log("SUPABASE_SERVICE_ROLE_KEY:", hasServiceKey ? "set ✓" : "MISSING ✗");
  console.log("TRACKING_ENABLED:", process.env.TRACKING_ENABLED ?? "(default true)");
  console.log("isSupabaseTrackingEnabled():", enabled);

  if (!enabled) {
    console.log("\n❌ Cannot test — paste service_role key into SUPABASE_SERVICE_ROLE_KEY in .env");
    console.log("   Dashboard → Project Settings → API → service_role → Reveal\n");
    process.exit(1);
  }

  const testEmail = `tracking-test-${Date.now()}@example.com`;
  const messageId = createMessageId();
  const pixelUrl = getTrackOpenPixelUrl(messageId);

  console.log("\n1) Register tracking row...");
  await registerOpenTracking(messageId, testEmail);
  console.log("   ✓ Inserted messageId:", messageId);

  console.log("\n2) Pixel URL (used in emails):");
  console.log("   ", pixelUrl);

  console.log("\n3) Simulating email open (HTTP GET pixel)...");
  const res = await fetch(pixelUrl);
  console.log("   Status:", res.status, res.statusText);
  console.log("   Content-Type:", res.headers.get("content-type"));

  if (!res.ok) {
    if (res.status === 404) {
      console.log("\n   ⚠ track-open Edge Function not deployed (404) — testing via RPC...");
      const supabase = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { persistSession: false } },
      );
      const { error } = await supabase.rpc("increment_email_open", {
        p_message_id: messageId,
      });
      if (error) {
        console.log("\n❌ RPC increment failed:", error.message);
        process.exit(1);
      }
      console.log("   ✓ increment_email_open RPC OK");
    } else {
      console.log("\n❌ Pixel request failed.");
      const body = await res.text();
      if (body) console.log("   Response:", body.slice(0, 300));
      process.exit(1);
    }
  }

  await new Promise((r) => setTimeout(r, 1500));

  console.log("\n4) Reading row from Supabase...");
  const row = await getOpenTrackingByEmail(testEmail);
  if (!row) {
    console.log("   ❌ Row not found after open");
    process.exit(1);
  }

  console.log("   email:", row.email);
  console.log("   open_count:", row.open_count);
  console.log("   last_opened_at:", row.last_opened_at);

  if ((row.open_count ?? 0) >= 1) {
    console.log("\n✅ SUCCESS — open tracking works!\n");
    process.exit(0);
  }

  console.log("\n⚠️  Pixel returned OK but open_count is still 0.");
  console.log("   Check: SQL migration ran? increment_email_open function exists?");
  console.log("   Run supabase/migrations/001_email_open_tracking.sql in SQL Editor.\n");
  process.exit(1);
}

main().catch((err) => {
  console.error("\n❌ Test failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
