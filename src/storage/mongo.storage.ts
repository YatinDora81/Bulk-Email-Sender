import { MongoClient, type Collection, type Db } from "mongodb";
import { logger } from "../utils/logger";
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

interface MongoContact extends Omit<
  Contact,
  "sentAt" | "createdAt" | "updatedAt"
> {
  sentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export class MongoStorage implements IStorage {
  readonly name = "mongo";
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private col: Collection<MongoContact> | null = null;

  async init(): Promise<void> {
    if (this.col) return;
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("Missing MONGODB_URI env var");
    this.client = new MongoClient(uri);
    await this.client.connect();
    this.db = this.client.db();
    const collectionName = (process.env.STORAGE_NAME_PREFIX || "") + "contacts";
    this.col = this.db.collection<MongoContact>(collectionName);
    await this.col.createIndex({ email: 1 }, { unique: true });
    await this.col.createIndex({ status: 1 });
    logger.info(`[Mongo] Connected (collection: ${collectionName})`);
  }

  private require(): Collection<MongoContact> {
    if (!this.col) throw new Error("MongoStorage not initialized");
    return this.col;
  }

  async insertContact(input: NewContactInput): Promise<UpsertResult> {
    const col = this.require();
    const now = new Date();
    try {
      await col.insertOne({
        ...input,
        email: input.email.toLowerCase(),
        status: "pending",
        openCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      return { inserted: true };
    } catch (error: unknown) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code: number }).code === 11000
      ) {
        return { inserted: false };
      }
      throw error;
    }
  }

  async bulkInsertContacts(
    inputs: NewContactInput[],
  ): Promise<BulkInsertResult> {
    if (inputs.length === 0) return { inserted: 0, skipped: 0 };
    const col = this.require();
    const now = new Date();
    const docs: MongoContact[] = inputs.map((i) => ({
      ...i,
      email: i.email.toLowerCase(),
      status: "pending",
      openCount: 0,
      createdAt: now,
      updatedAt: now,
    }));

    try {
      const res = await col.insertMany(docs, { ordered: false });
      const inserted = res.insertedCount ?? 0;
      return { inserted, skipped: inputs.length - inserted };
    } catch (error: unknown) {
      const err = error as { result?: { insertedCount?: number }; insertedCount?: number };
      const inserted = err.result?.insertedCount ?? err.insertedCount ?? 0;
      return { inserted, skipped: inputs.length - inserted };
    }
  }

  async upsertSentContact(
    input: NewContactInput & ContactUpdate,
  ): Promise<void> {
    const col = this.require();
    const now = new Date();
    const email = input.email.toLowerCase();
    await col.updateOne(
      { email },
      {
        $set: {
          name: input.name,
          email,
          title: input.title,
          company: input.company,
          sno: input.sno,
          status: input.status ?? "sent",
          generatedSubject: input.generatedSubject,
          generatedBody: input.generatedBody,
          sentAt: input.sentAt ?? now,
          error: input.error,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    );
  }

  async updateContact(email: string, update: ContactUpdate): Promise<void> {
    const col = this.require();
    await col.updateOne(
      { email: email.toLowerCase() },
      { $set: { ...update, updatedAt: new Date() } },
    );
  }

  async findContact(email: string): Promise<Contact | null> {
    const col = this.require();
    const doc = await col.findOne({ email: email.toLowerCase() });
    return doc ? this.toContact(doc) : null;
  }

  async list(filter: ListFilter): Promise<ListResult> {
    const col = this.require();
    const q: Record<string, unknown> = {};
    if (filter.search) {
      q.$or = [
        { name: { $regex: filter.search, $options: "i" } },
        { email: { $regex: filter.search, $options: "i" } },
        { company: { $regex: filter.search, $options: "i" } },
      ];
    }
    if (filter.status) q.status = filter.status;

    const [docs, total] = await Promise.all([
      col
        .find(q)
        .sort({ updatedAt: -1 })
        .skip((filter.page - 1) * filter.limit)
        .limit(filter.limit)
        .toArray(),
      col.countDocuments(q),
    ]);
    return { data: docs.map((d) => this.toContact(d)), total };
  }

  async getStats(): Promise<Stats> {
    const col = this.require();
    const [total, sent, failed, pending] = await Promise.all([
      col.countDocuments(),
      col.countDocuments({ status: "sent" }),
      col.countDocuments({ status: "failed" }),
      col.countDocuments({ status: "pending" }),
    ]);
    return { total, sent, failed, pending };
  }

  async getPending(limit: number): Promise<Contact[]> {
    const col = this.require();
    const docs = await col.find({ status: "pending" }).limit(limit).toArray();
    return docs.map((d) => this.toContact(d));
  }

  async clearAll(): Promise<number> {
    const col = this.require();
    const res = await col.deleteMany({});
    return res.deletedCount ?? 0;
  }

  private toContact(d: MongoContact): Contact {
    return {
      sno: d.sno,
      name: d.name,
      email: d.email,
      title: d.title,
      company: d.company,
      status: d.status,
      openCount: d.openCount ?? 0,
      lastOpenedAt: d.lastOpenedAt,
      generatedSubject: d.generatedSubject,
      generatedBody: d.generatedBody,
      sentAt: d.sentAt,
      error: d.error,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    };
  }
}
