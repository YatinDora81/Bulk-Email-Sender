import { getStorage } from "./storage";
import type { Contact } from "./storage";
import { getGemini } from "./config/gemini";
import { sendEmail, verifySmtp } from "./config/mailer";
import { parseExcelFile, type RawContact } from "./services/excel.service";
import { EMAIL_SYSTEM_PROMPT, buildEmailPrompt } from "./utils/prompt";
import { logger } from "./utils/logger";

const BATCH_SIZE = 15;
const BREAK_BETWEEN_BATCHES_MS = 15_000;
const DELAY_BETWEEN_EMAILS_MS = 2_000;

function divider(label?: string) {
  const line = "═".repeat(70);
  if (label) {
    logger.info(`╔${line}╗`);
    logger.info(`║  ${label.padEnd(68)}║`);
    logger.info(`╚${line}╝`);
  } else {
    logger.info(`${"─".repeat(72)}`);
  }
}

function elapsed(start: number): string {
  const ms = Date.now() - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = ((ms % 60_000) / 1000).toFixed(0);
  return `${mins}m ${secs}s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadData(): RawContact[] {
  divider("STEP 1 — LOADING EXCEL DATA");
  const stepStart = Date.now();

  logger.info("[Load] Reading data.xlsx from project root...");
  const contacts = parseExcelFile();
  logger.info(`[Load] Parsed ${contacts.length} contacts from Excel`);
  if (contacts[0]) {
    logger.info(
      `[Load] First contact: ${contacts[0].name} <${contacts[0].email}> — ${contacts[0].title} at ${contacts[0].company}`
    );
  }
  const last = contacts[contacts.length - 1];
  if (last) logger.info(`[Load] Last contact:  ${last.name} <${last.email}>`);

  const companies = new Set(contacts.map((c) => c.company));
  logger.info(`[Load] Unique companies: ${companies.size}`);
  logger.info(`[Load] Step completed in ${elapsed(stepStart)}`);
  return contacts;
}

async function syncAndFilter(contacts: RawContact[]): Promise<Contact[]> {
  divider("STEP 2 — SYNCING TO STORAGE & FILTERING ALREADY-SENT");
  const stepStart = Date.now();

  const storage = getStorage();

  let inserted = 0;
  let skippedDuplicate = 0;

  logger.info(`[Sync] Upserting ${contacts.length} contacts into storage...`);

  for (const raw of contacts) {
    const result = await storage.insertContact(raw);
    if (result.inserted) inserted++;
    else skippedDuplicate++;
  }

  logger.info(`[Sync] Inserted: ${inserted} new contacts`);
  logger.info(`[Sync] Skipped (already present): ${skippedDuplicate} duplicates`);

  const stats = await storage.getStats();
  logger.info(`[Sync] Storage breakdown — sent: ${stats.sent} | failed: ${stats.failed} | pending: ${stats.pending} | total: ${stats.total}`);

  const pending = await storage.getPending(Number.MAX_SAFE_INTEGER);
  logger.info(`[Sync] ${pending.length} contacts queued for email sending`);
  logger.info(`[Sync] Step completed in ${elapsed(stepStart)}`);

  return pending;
}

async function processContact(
  contact: Contact,
  index: number,
  totalInBatch: number,
  batchNum: number,
  globalIndex: number,
  globalTotal: number
): Promise<{ success: boolean }> {
  const prefix = `[Batch #${batchNum} | ${index + 1}/${totalInBatch} | Global ${globalIndex}/${globalTotal}]`;

  logger.info(`${prefix} ──── Processing: ${contact.name} <${contact.email}>`);
  logger.info(`${prefix} Title: ${contact.title}`);
  logger.info(`${prefix} Company: ${contact.company}`);

  const storage = getStorage();

  logger.info(`${prefix} Generating prompt for Gemini...`);
  const promptStart = Date.now();
  const prompt = buildEmailPrompt(contact);
  logger.debug(`${prefix} Prompt payload: ${prompt.slice(0, 200)}...`);
  logger.info(`${prefix} Prompt built in ${elapsed(promptStart)}`);

  logger.info(`${prefix} Calling Gemini API...`);
  const geminiStart = Date.now();
  const gemini = getGemini();
  const rawResponse = await gemini.generate(prompt, EMAIL_SYSTEM_PROMPT);

  if (!rawResponse) throw new Error("Empty response from Gemini — no text returned");

  logger.info(`${prefix} Gemini responded in ${elapsed(geminiStart)} (${rawResponse.length} chars)`);
  logger.debug(`${prefix} Raw Gemini response: ${rawResponse.slice(0, 300)}...`);

  logger.info(`${prefix} Parsing Gemini JSON response...`);
  const cleaned = rawResponse.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();

  let emailData: { subject: string; body: string };
  try {
    emailData = JSON.parse(cleaned);
  } catch {
    logger.error(`${prefix} JSON parse failed. Cleaned response: ${cleaned.slice(0, 300)}`);
    throw new Error(`Failed to parse Gemini response as JSON`);
  }

  if (!emailData.subject || !emailData.body) {
    throw new Error(`Missing subject or body. Keys: ${Object.keys(emailData).join(", ")}`);
  }

  logger.info(`${prefix} Subject: "${emailData.subject}"`);
  logger.info(`${prefix} Body length: ${emailData.body.length} chars`);

  logger.info(`${prefix} Sending email via SMTP to ${contact.email}...`);
  const sendStart = Date.now();
  await sendEmail({ to: contact.email, subject: emailData.subject, html: emailData.body });
  logger.info(`${prefix} Email sent successfully in ${elapsed(sendStart)}`);

  logger.info(`${prefix} Updating storage status to "sent"...`);
  await storage.updateContact(contact.email, {
    status: "sent",
    generatedSubject: emailData.subject,
    generatedBody: emailData.body,
    sentAt: new Date(),
  });

  logger.info(`${prefix} ✓ DONE — ${contact.name} <${contact.email}> processed successfully`);
  return { success: true };
}

async function runBatches(pending: Contact[]) {
  divider("STEP 3 — SENDING EMAILS IN BATCHES");

  const totalContacts = pending.length;
  if (totalContacts === 0) {
    logger.info("[Batch] No pending contacts to process. All done!");
    return;
  }

  const totalBatches = Math.ceil(totalContacts / BATCH_SIZE);
  logger.info(`[Batch] Total pending: ${totalContacts}`);
  logger.info(`[Batch] Batch size: ${BATCH_SIZE}`);
  logger.info(`[Batch] Total batches: ${totalBatches}`);
  logger.info(`[Batch] Delay between emails: ${DELAY_BETWEEN_EMAILS_MS / 1000}s`);
  logger.info(`[Batch] Break between batches: ${BREAK_BETWEEN_BATCHES_MS / 1000}s`);

  let globalSent = 0;
  let globalFailed = 0;
  let globalIndex = 0;
  const runStart = Date.now();
  const storage = getStorage();

  for (let batchNum = 1; batchNum <= totalBatches; batchNum++) {
    const batchStart = Date.now();
    const batchStartIdx = (batchNum - 1) * BATCH_SIZE;
    const batch = pending.slice(batchStartIdx, batchStartIdx + BATCH_SIZE);

    divider(`BATCH #${batchNum} of ${totalBatches} — ${batch.length} contacts`);

    let batchSent = 0;
    let batchFailed = 0;

    for (let i = 0; i < batch.length; i++) {
      globalIndex++;
      const contact = batch[i]!;

      try {
        await processContact(contact, i, batch.length, batchNum, globalIndex, totalContacts);
        batchSent++;
        globalSent++;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[Batch #${batchNum} | ${i + 1}/${batch.length}] ✗ FAILED — ${contact.email}: ${message}`, error);
        batchFailed++;
        globalFailed++;

        await storage.updateContact(contact.email, { status: "failed", error: message });
        logger.info(`[Batch #${batchNum} | ${i + 1}/${batch.length}] Storage updated with failure status`);
      }

      if (i < batch.length - 1) {
        logger.info(`[Batch #${batchNum}] Waiting ${DELAY_BETWEEN_EMAILS_MS / 1000}s before next email...`);
        await sleep(DELAY_BETWEEN_EMAILS_MS);
      }
    }

    logger.info(`[Batch #${batchNum}] ──── Batch Complete ────`);
    logger.info(`[Batch #${batchNum}] Sent: ${batchSent} | Failed: ${batchFailed} | Time: ${elapsed(batchStart)}`);
    logger.info(`[Batch #${batchNum}] Running total — Sent: ${globalSent} | Failed: ${globalFailed} | Remaining: ${totalContacts - globalIndex}`);

    const progressPct = ((globalIndex / totalContacts) * 100).toFixed(1);
    logger.info(`[Progress] ${progressPct}% complete (${globalIndex}/${totalContacts})`);

    if (batchNum < totalBatches) {
      logger.info(`[Batch] Taking a ${BREAK_BETWEEN_BATCHES_MS / 1000}s break before batch #${batchNum + 1}...`);
      await sleep(BREAK_BETWEEN_BATCHES_MS);
      logger.info(`[Batch] Break over. Resuming...`);
    }
  }

  divider("FINAL SUMMARY");
  logger.info(`[Summary] Total processed: ${globalIndex}`);
  logger.info(`[Summary] Sent:            ${globalSent}`);
  logger.info(`[Summary] Failed:          ${globalFailed}`);
  logger.info(`[Summary] Success rate:    ${((globalSent / globalIndex) * 100).toFixed(1)}%`);
  logger.info(`[Summary] Total time:      ${elapsed(runStart)}`);
}

async function main() {
  const mainStart = Date.now();

  divider("BULK EMAIL SENDER — STANDALONE RUNNER");
  logger.info(`[Main] Starting at ${new Date().toISOString()}`);
  logger.info(`[Main] Config: BATCH_SIZE=${BATCH_SIZE}, BREAK=${BREAK_BETWEEN_BATCHES_MS / 1000}s, DELAY=${DELAY_BETWEEN_EMAILS_MS / 1000}s`);

  logger.info("[Main] Initializing storage...");
  const storage = getStorage();
  await storage.init();
  logger.info("[Main] Storage ready");

  logger.info("[Main] Verifying SMTP connection...");
  const smtpOk = await verifySmtp();
  if (!smtpOk) {
    logger.error("[Main] SMTP verification failed. Aborting.");
    process.exit(1);
  }
  logger.info("[Main] SMTP verified — ready to send emails");

  logger.info("[Main] Initializing Gemini AI client...");
  getGemini();
  logger.info("[Main] Gemini client ready");

  const contacts = loadData();
  const pending = await syncAndFilter(contacts);
  await runBatches(pending);

  divider("ALL DONE");
  logger.info(`[Main] Finished at ${new Date().toISOString()}`);
  logger.info(`[Main] Total runtime: ${elapsed(mainStart)}`);
  process.exit(0);
}

main().catch((error) => {
  logger.error("[Main] Fatal unhandled error:", error);
  process.exit(1);
});
