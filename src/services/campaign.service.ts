import { getStorage } from "../storage";
import { getGemini } from "../config/gemini";
import { sendTrackedEmail } from "./tracked-email.service";
import { syncOpenTrackingToStorage } from "./tracking-sync.service";
import { EMAIL_SYSTEM_PROMPT, buildEmailPrompt } from "../utils/prompt";
import {
  startTrackingSyncScheduler,
  stopTrackingSyncScheduler,
} from "../tracking/sync-scheduler";
import { isSupabaseTrackingEnabled } from "../tracking/supabase";
import { logger } from "../utils/logger";

export interface CampaignStatus {
  status: "idle" | "running" | "paused" | "stopped";
  total: number;
  sent: number;
  failed: number;
  pending: number;
  currentBatch: number;
  batchSize: number;
  breakSeconds: number;
  startedAt: string | null;
  lastActivity: string | null;
}

const BATCH_SIZE = 15;
const BREAK_MS = 15_000;

class CampaignManager {
  private _status: "idle" | "running" | "paused" | "stopped" = "idle";
  private currentBatch = 0;
  private startedAt: Date | null = null;
  private lastActivity: Date | null = null;
  private pauseResolve: (() => void) | null = null;
  private running = false;

  async getStatus(): Promise<CampaignStatus> {
    const stats = await getStorage().getStats();
    return {
      status: this._status,
      ...stats,
      currentBatch: this.currentBatch,
      batchSize: BATCH_SIZE,
      breakSeconds: BREAK_MS / 1000,
      startedAt: this.startedAt?.toISOString() || null,
      lastActivity: this.lastActivity?.toISOString() || null,
    };
  }

  async start() {
    if (this.running) return { error: "Campaign already running" };
    this._status = "running";
    this.startedAt = new Date();
    this.currentBatch = 0;
    this.running = true;
    if (isSupabaseTrackingEnabled() && process.env.TRACKING_SYNC_ENABLED !== "false") {
      startTrackingSyncScheduler();
    }
    this.run().catch((err) => {
      logger.error("[Campaign] Fatal error:", err);
      this._status = "stopped";
      this.running = false;
      stopTrackingSyncScheduler();
    });
    return { ok: true };
  }

  pause() {
    if (this._status !== "running") return { error: "Not running" };
    this._status = "paused";
    return { ok: true };
  }

  resume() {
    if (this._status !== "paused") return { error: "Not paused" };
    this._status = "running";
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
    }
    return { ok: true };
  }

  stop() {
    this._status = "stopped";
    this.running = false;
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
    }
    return { ok: true };
  }

  reset() {
    this._status = "idle";
    this.running = false;
    this.currentBatch = 0;
    this.startedAt = null;
    this.lastActivity = null;
    return { ok: true };
  }

  private shouldStop(): boolean {
    return this._status === "stopped";
  }

  private isPaused(): boolean {
    return this._status === "paused";
  }

  private async waitWhilePaused(): Promise<boolean> {
    while (this._status === "paused") {
      await new Promise<void>((resolve) => {
        this.pauseResolve = resolve;
      });
    }
    return this._status === "running";
  }

  private async run() {
    const storage = getStorage();

    while (this._status === "running" || this._status === "paused") {
      if (this._status === "paused") {
        const shouldContinue = await this.waitWhilePaused();
        if (!shouldContinue) break;
      }

      if (this._status !== "running") break;

      const batch = await storage.getPending(BATCH_SIZE);

      if (batch.length === 0) {
        logger.info("[Campaign] All emails processed!");
        this._status = "idle";
        break;
      }

      this.currentBatch++;
      logger.info(`[Campaign] Batch #${this.currentBatch} — ${batch.length} emails`);

      for (const contact of batch) {
        if (this.shouldStop()) break;
        if (this.isPaused()) {
          const shouldContinue = await this.waitWhilePaused();
          if (!shouldContinue) break;
        }

        try {
          const gemini = getGemini();
          const prompt = buildEmailPrompt(contact);
          const rawResponse = await gemini.generate(prompt, EMAIL_SYSTEM_PROMPT);

          if (!rawResponse) throw new Error("Empty response from Gemini");

          const cleaned = rawResponse.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();

          let emailData: { subject: string; body: string };
          try {
            emailData = JSON.parse(cleaned);
          } catch {
            throw new Error(`Failed to parse Gemini response: ${cleaned.slice(0, 200)}`);
          }

          if (!emailData.subject || !emailData.body) {
            throw new Error("Missing subject or body in Gemini response");
          }

          await sendTrackedEmail({
            to: contact.email,
            subject: emailData.subject,
            html: emailData.body,
          });

          await storage.updateContact(contact.email, {
            status: "sent",
            generatedSubject: emailData.subject,
            generatedBody: emailData.body,
            sentAt: new Date(),
          });

          this.lastActivity = new Date();
          logger.info(`  ✓ Sent to ${contact.email}`);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`  ✗ Failed ${contact.email}: ${message}`);

          await storage.updateContact(contact.email, {
            status: "failed",
            error: message,
          });
        }
      }

      if (this._status === "running" && batch.length === BATCH_SIZE) {
        logger.info(`[Campaign] Waiting ${BREAK_MS / 1000}s before next batch...`);
        await new Promise((resolve) => setTimeout(resolve, BREAK_MS));
      }
    }

    this.running = false;
    stopTrackingSyncScheduler();
    if (isSupabaseTrackingEnabled()) {
      try {
        const result = await syncOpenTrackingToStorage();
        logger.info(`[Campaign] Final open sync — updated=${result.updated}`);
      } catch (error) {
        logger.warn(
          `[Campaign] Final open sync failed: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    logger.info(`[Campaign] Finished. Status: ${this._status}`);
  }
}

export default new CampaignManager();
