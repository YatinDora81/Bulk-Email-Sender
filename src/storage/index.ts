import { logger } from "../utils/logger";
import { SheetStorage } from "./sheet.storage";
import { MongoStorage } from "./mongo.storage";
import { PrismaStorage } from "./prisma.storage";
import type {
  BulkInsertResult,
  Contact,
  ContactUpdate,
  IStorage,
  ListFilter,
  ListResult,
  NewContactInput,
  Stats,
  UpsertResult,
} from "./types";

type BackendName = "sheet" | "mongo" | "prisma";

const BACKEND_FACTORIES: Record<BackendName, () => IStorage> = {
  sheet: () => new SheetStorage(),
  mongo: () => new MongoStorage(),
  prisma: () => new PrismaStorage(),
};

export class StorageManager implements IStorage {
  readonly name = "manager";
  private primary!: IStorage;
  private mirrors: IStorage[] = [];
  private initialized = false;

  private parseRequestedBackends(): BackendName[] {
    const raw = (process.env.STORAGE_BACKENDS || "sheet").trim();
    const requested = raw
      .split(",")
      .map((b) => b.trim().toLowerCase())
      .filter(Boolean);

    if (requested.length === 0) {
      throw new Error(
        `Empty STORAGE_BACKENDS. Set to one or more of: sheet, mongo, prisma (comma-separated)`,
      );
    }

    const invalid = requested.filter((b) => !(b in BACKEND_FACTORIES));
    if (invalid.length > 0) {
      throw new Error(
        `Invalid STORAGE_BACKENDS entries: ${invalid.join(", ")}. Allowed: sheet, mongo, prisma`,
      );
    }

    return requested as BackendName[];
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    const requested = this.parseRequestedBackends();
    const primaryName = requested[0]!;
    const mirrorNames = requested.slice(1);

    logger.info("[Storage] ════════════════════════════════════════════");
    logger.info(`[Storage] Configured: ${requested.join(", ")}`);
    logger.info(
      `[Storage] Primary: ${primaryName}${mirrorNames.length > 0 ? ` | Mirrors: ${mirrorNames.join(", ")}` : ""}`,
    );
    logger.info("[Storage] Running preflight checks...");
    logger.info("[Storage] ────────────────────────────────────────────");

    type Probe = {
      name: BackendName;
      instance: IStorage;
      ok: boolean;
      ms: number;
      error?: string;
    };
    const probes: Probe[] = [];

    for (const name of requested) {
      const instance = BACKEND_FACTORIES[name]();
      const start = Date.now();
      try {
        await instance.init();
        const ms = Date.now() - start;
        logger.info(`[Storage]   ✓ ${name.padEnd(7)} ready  (${ms}ms)`);
        probes.push({ name, instance, ok: true, ms });
      } catch (error) {
        const ms = Date.now() - start;
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          `[Storage]   ✗ ${name.padEnd(7)} FAILED (${ms}ms) — ${message}`,
        );
        probes.push({ name, instance, ok: false, ms, error: message });
      }
    }

    logger.info("[Storage] ────────────────────────────────────────────");

    const primaryProbe = probes[0]!;
    if (!primaryProbe.ok) {
      logger.error(
        `[Storage] Aborting: primary backend "${primaryProbe.name}" is unavailable.`,
      );
      logger.error(
        `[Storage] Fix the issue above or change STORAGE_BACKENDS in .env`,
      );
      throw new Error(
        `Primary storage backend "${primaryProbe.name}" failed preflight: ${primaryProbe.error}`,
      );
    }

    this.primary = primaryProbe.instance;
    this.mirrors = probes
      .slice(1)
      .filter((p) => p.ok)
      .map((p) => p.instance);

    const skipped = probes
      .slice(1)
      .filter((p) => !p.ok)
      .map((p) => p.name);
    if (skipped.length > 0) {
      logger.warn(
        `[Storage] Skipping unavailable mirrors: ${skipped.join(", ")}`,
      );
    }

    logger.info(
      `[Storage] Ready — using "${this.primary.name}" as primary` +
        (this.mirrors.length > 0
          ? ` with mirrors: ${this.mirrors.map((m) => m.name).join(", ")}`
          : " (no mirrors)"),
    );
    logger.info("[Storage] ════════════════════════════════════════════");

    this.initialized = true;
  }

  private async fanOut(
    label: string,
    fn: (s: IStorage) => Promise<unknown>,
  ): Promise<void> {
    if (this.mirrors.length === 0) return;
    const results = await Promise.allSettled(this.mirrors.map((m) => fn(m)));
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        const mirror = this.mirrors[i];
        logger.warn(
          `[Storage] Mirror "${mirror?.name}" failed ${label}: ${
            r.reason instanceof Error ? r.reason.message : String(r.reason)
          }`,
        );
      }
    });
  }

  async insertContact(input: NewContactInput): Promise<UpsertResult> {
    const result = await this.primary.insertContact(input);
    await this.fanOut("insertContact", (s) => s.insertContact(input));
    return result;
  }

  async bulkInsertContacts(
    inputs: NewContactInput[],
  ): Promise<BulkInsertResult> {
    const result = await this.primary.bulkInsertContacts(inputs);
    await this.fanOut("bulkInsertContacts", (s) => s.bulkInsertContacts(inputs));
    return result;
  }

  async upsertSentContact(
    input: NewContactInput & ContactUpdate,
  ): Promise<void> {
    await this.primary.upsertSentContact(input);
    await this.fanOut("upsertSentContact", (s) => s.upsertSentContact(input));
  }

  async updateContact(email: string, update: ContactUpdate): Promise<void> {
    await this.primary.updateContact(email, update);
    await this.fanOut("updateContact", (s) => s.updateContact(email, update));
  }

  async findContact(email: string): Promise<Contact | null> {
    return this.primary.findContact(email);
  }

  async list(filter: ListFilter): Promise<ListResult> {
    return this.primary.list(filter);
  }

  async getStats(): Promise<Stats> {
    return this.primary.getStats();
  }

  async getPending(limit: number): Promise<Contact[]> {
    return this.primary.getPending(limit);
  }

  async clearAll(): Promise<number> {
    const count = await this.primary.clearAll();
    await this.fanOut("clearAll", (s) => s.clearAll());
    return count;
  }
}

let instance: StorageManager | null = null;

export function getStorage(): StorageManager {
  if (!instance) instance = new StorageManager();
  return instance;
}

export type {
  Contact,
  ContactStatus,
  ContactUpdate,
  NewContactInput,
  Stats,
  ListFilter,
  IStorage,
} from "./types";
