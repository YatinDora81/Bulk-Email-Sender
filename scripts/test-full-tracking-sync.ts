import { getStorage } from "../src/storage";
import { createClient } from "@supabase/supabase-js";
import {
  createMessageId,
  getTrackOpenPixelUrl,
  isSupabaseTrackingEnabled,
  registerOpenTracking,
  getOpenTrackingByEmail,
} from "../src/tracking/supabase";
import { syncOpenTrackingToStorage } from "../src/services/tracking-sync.service";

async function main() {
  console.log("\n=== Full tracking + storage sync test ===\n");

  if (!isSupabaseTrackingEnabled()) {
    console.error("❌ Supabase not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)");
    process.exit(1);
  }

  const storage = getStorage();
  await storage.init();
  console.log("STORAGE_BACKENDS:", process.env.STORAGE_BACKENDS ?? "sheet");

  const testEmail = `sync-test-${Date.now()}@example.com`;
  const messageId = createMessageId();

  console.log("\n1) Insert test contact into STORAGE_BACKENDS...");
  await storage.insertContact({
    sno: 9999,
    name: "Sync Test",
    email: testEmail,
    title: "QA",
    company: "Test Co",
  });
  let contact = await storage.findContact(testEmail);
  if (!contact) {
    console.error("❌ Contact not found after insert");
    process.exit(1);
  }
  console.log("   ✓ Contact inserted, openCount:", contact.openCount ?? 0);

  console.log("\n2) Register Supabase tracking + simulate open...");
  await registerOpenTracking(messageId, testEmail);
  const pixelUrl = getTrackOpenPixelUrl(messageId);
  const res = await fetch(pixelUrl);
  console.log("   Pixel:", res.status, res.statusText);
  if (!res.ok) {
    if (res.status === 404) {
      console.log("   ⚠ Edge function not deployed — using increment_email_open RPC instead");
      const supabase = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { persistSession: false } },
      );
      const { error } = await supabase.rpc("increment_email_open", {
        p_message_id: messageId,
      });
      if (error) {
        console.error("❌ RPC increment failed:", error.message);
        process.exit(1);
      }
    } else {
      const body = await res.text();
      console.error("❌ Pixel failed:", body.slice(0, 300));
      process.exit(1);
    }
  }

  await new Promise((r) => setTimeout(r, 1500));

  const row = await getOpenTrackingByEmail(testEmail);
  if (!row || (row.open_count ?? 0) < 1) {
    console.error("❌ Supabase open_count not incremented:", row);
    process.exit(1);
  }
  console.log("   ✓ Supabase open_count:", row.open_count);

  console.log("\n3) Sync Supabase → storage...");
  const syncResult = await syncOpenTrackingToStorage();
  console.log("   ", JSON.stringify(syncResult));

  contact = await storage.findContact(testEmail);
  if (!contact) {
    console.error("❌ Contact missing after sync");
    process.exit(1);
  }

  console.log("\n4) Verify storage contact...");
  console.log("   openCount:", contact.openCount);
  console.log("   lastOpenedAt:", contact.lastOpenedAt?.toISOString() ?? "(none)");

  if ((contact.openCount ?? 0) >= 1 && contact.lastOpenedAt) {
    console.log("\n✅ FULL SUCCESS — Supabase opens synced to storage!\n");
    process.exit(0);
  }

  console.error("\n❌ Storage openCount/lastOpenedAt not updated after sync\n");
  process.exit(1);
}

main().catch((err) => {
  console.error("\n❌", err instanceof Error ? err.message : err);
  process.exit(1);
});
