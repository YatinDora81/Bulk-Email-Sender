import { logger } from "../utils/logger";
import type {
  BulkInsertResult,
  Contact,
  ContactStatus,
  ContactUpdate,
  IStorage,
  ListFilter,
  ListResult,
  NewContactInput,
  Stats,
  UpsertResult,
} from "./types";

type PrismaClientInstance = {
  $connect: () => Promise<void>;
  contact: {
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
    createMany?: (args: {
      data: Record<string, unknown>[];
      skipDuplicates?: boolean;
    }) => Promise<{ count: number }>;
    upsert: (args: {
      where: { email: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => Promise<unknown>;
    update: (args: { where: { email: string }; data: Record<string, unknown> }) => Promise<unknown>;
    findUnique: (args: { where: { email: string } }) => Promise<Record<string, unknown> | null>;
    findMany: (args?: {
      where?: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
      skip?: number;
      take?: number;
    }) => Promise<Record<string, unknown>[]>;
    count: (args?: { where?: Record<string, unknown> }) => Promise<number>;
    deleteMany: (args?: { where?: Record<string, unknown> }) => Promise<{ count: number }>;
  };
};

export class PrismaStorage implements IStorage {
  readonly name = "prisma";
  private prisma: PrismaClientInstance | null = null;

  async init(): Promise<void> {
    if (this.prisma) return;
    try {
      const mod = (await import("../../generated/prisma/client")) as unknown as {
        PrismaClient: new (...args: unknown[]) => PrismaClientInstance;
      };
      this.prisma = new mod.PrismaClient();
      await this.prisma.$connect();
      logger.info("[Prisma] Connected");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `[Prisma] Failed to initialize. Run "bun --bun run prisma generate" and "bun --bun run prisma migrate dev". Cause: ${msg}`
      );
    }
  }

  private require(): PrismaClientInstance {
    if (!this.prisma) throw new Error("PrismaStorage not initialized");
    return this.prisma;
  }

  async insertContact(input: NewContactInput): Promise<UpsertResult> {
    const prisma = this.require();
    const email = input.email.toLowerCase();
    try {
      await prisma.contact.create({
        data: {
          sno: input.sno,
          name: input.name,
          email,
          title: input.title,
          company: input.company,
          status: "pending",
        },
      });
      return { inserted: true };
    } catch (error: unknown) {
      const code = (error as { code?: string })?.code;
      if (code === "P2002") return { inserted: false };
      throw error;
    }
  }

  async bulkInsertContacts(
    inputs: NewContactInput[],
  ): Promise<BulkInsertResult> {
    if (inputs.length === 0) return { inserted: 0, skipped: 0 };
    const prisma = this.require();

    const data = inputs.map((i) => ({
      sno: i.sno,
      name: i.name,
      email: i.email.toLowerCase(),
      title: i.title,
      company: i.company,
      status: "pending",
    }));

    if (prisma.contact.createMany) {
      const res = await prisma.contact.createMany({
        data,
        skipDuplicates: true,
      });
      return { inserted: res.count, skipped: inputs.length - res.count };
    }

    let inserted = 0;
    let skipped = 0;
    for (const input of inputs) {
      const r = await this.insertContact(input);
      if (r.inserted) inserted++;
      else skipped++;
    }
    return { inserted, skipped };
  }

  async upsertSentContact(input: NewContactInput & ContactUpdate): Promise<void> {
    const prisma = this.require();
    const email = input.email.toLowerCase();
    const now = new Date();
    const status: ContactStatus = input.status ?? "sent";

    await prisma.contact.upsert({
      where: { email },
      create: {
        sno: input.sno,
        name: input.name,
        email,
        title: input.title,
        company: input.company,
        status,
        generatedSubject: input.generatedSubject,
        generatedBody: input.generatedBody,
        sentAt: input.sentAt ?? now,
        error: input.error,
      },
      update: {
        status,
        generatedSubject: input.generatedSubject,
        generatedBody: input.generatedBody,
        sentAt: input.sentAt ?? now,
        error: input.error,
      },
    });
  }

  async updateContact(email: string, update: ContactUpdate): Promise<void> {
    const prisma = this.require();
    await prisma.contact.update({
      where: { email: email.toLowerCase() },
      data: { ...update },
    });
  }

  async findContact(email: string): Promise<Contact | null> {
    const prisma = this.require();
    const doc = await prisma.contact.findUnique({ where: { email: email.toLowerCase() } });
    return doc ? this.toContact(doc) : null;
  }

  async list(filter: ListFilter): Promise<ListResult> {
    const prisma = this.require();
    const where: Record<string, unknown> = {};
    if (filter.search) {
      where.OR = [
        { name: { contains: filter.search, mode: "insensitive" } },
        { email: { contains: filter.search, mode: "insensitive" } },
        { company: { contains: filter.search, mode: "insensitive" } },
      ];
    }
    if (filter.status) where.status = filter.status;

    const [rows, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        skip: (filter.page - 1) * filter.limit,
        take: filter.limit,
      }),
      prisma.contact.count({ where }),
    ]);
    return { data: rows.map((r) => this.toContact(r)), total };
  }

  async getStats(): Promise<Stats> {
    const prisma = this.require();
    const [total, sent, failed, pending] = await Promise.all([
      prisma.contact.count(),
      prisma.contact.count({ where: { status: "sent" } }),
      prisma.contact.count({ where: { status: "failed" } }),
      prisma.contact.count({ where: { status: "pending" } }),
    ]);
    return { total, sent, failed, pending };
  }

  async getPending(limit: number): Promise<Contact[]> {
    const prisma = this.require();
    const rows = await prisma.contact.findMany({ where: { status: "pending" }, take: limit });
    return rows.map((r) => this.toContact(r));
  }

  async clearAll(): Promise<number> {
    const prisma = this.require();
    const res = await prisma.contact.deleteMany({});
    return res.count;
  }

  private toContact(d: Record<string, unknown>): Contact {
    return {
      sno: Number(d.sno ?? 0),
      name: String(d.name ?? ""),
      email: String(d.email ?? ""),
      title: String(d.title ?? ""),
      company: String(d.company ?? ""),
      status: (d.status as ContactStatus) ?? "pending",
      openCount: d.openCount != null ? Number(d.openCount) : 0,
      lastOpenedAt: d.lastOpenedAt ? new Date(d.lastOpenedAt as string) : undefined,
      generatedSubject: (d.generatedSubject as string | undefined) ?? undefined,
      generatedBody: (d.generatedBody as string | undefined) ?? undefined,
      sentAt: d.sentAt ? new Date(d.sentAt as string) : undefined,
      error: (d.error as string | undefined) ?? undefined,
      createdAt: new Date(d.createdAt as string),
      updatedAt: new Date(d.updatedAt as string),
    };
  }
}
