#!/usr/bin/env bun
/**
 * Deploy track-open Edge Function (required for email open counting).
 * Requires: bunx supabase login (once)
 */
import { spawnSync } from "child_process";
import { checkTrackingPixelEndpoint } from "../src/tracking/supabase";

const projectRef = process.env.SUPABASE_PROJECT_REF || "gvueenebbeqvkfisaltc";

function run(cmd: string, args: string[]): number {
  console.log(`\n> ${cmd} ${args.join(" ")}\n`);
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: false });
  return result.status ?? 1;
}

async function main() {
  console.log("\n=== Deploy track-open Edge Function ===\n");
  console.log("Project ref:", projectRef);

  if (run("bunx", ["supabase", "link", "--project-ref", projectRef]) !== 0) {
    console.error("\n❌ supabase link failed. Run: bunx supabase login\n");
    process.exit(1);
  }

  const deployStatus = run("bunx", [
    "supabase",
    "functions",
    "deploy",
    "track-open",
    "--no-verify-jwt",
  ]);

  if (deployStatus !== 0) {
    console.error("\n❌ Deploy failed (see output above).\n");
    process.exit(1);
  }

  console.log("\n✓ Deploy finished. Verifying pixel endpoint...\n");
  await new Promise((r) => setTimeout(r, 3000));

  const check = await checkTrackingPixelEndpoint();
  if (check.ok) {
    console.log("✅ Pixel endpoint returns", check.status, "— open tracking will work.\n");
    process.exit(0);
  }

  console.error("⚠ Deploy ran but pixel still returns", check.status);
  if (check.hint) console.error(" ", check.hint);
  console.error("Wait ~30s and run: bun run check:tracking\n");
  process.exit(1);
}

main();
