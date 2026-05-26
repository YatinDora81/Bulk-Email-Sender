import { GoogleSpreadsheet, GoogleSpreadsheetWorksheet, GoogleSpreadsheetRow } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import { logger } from "../utils/logger";
import {
  CONTACT_HEADERS,
  type Contact,
  type ContactUpdate,
  type IStorage,
  type ListFilter,
  type ListResult,
  type NewContactInput,
  type Stats,
  type UpsertResult,
} from "./types";

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
];

const TAB_NAME = process.env.GOOGLE_SHEET_TAB || "Contacts";

interface CachedRow {
  row: GoogleSpreadsheetRow;
  contact: Contact;
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return isNaN(d.getTime()) ? undefined : d;
}

function rowToContact(row: GoogleSpreadsheetRow): Contact {
  const get = (key: string) => (row.get(key) as string | undefined) ?? "";
  const sno = Number(get("sno") || 0);
  return {
    sno: Number.isNaN(sno) ? 0 : sno,
    name: get("name"),
    email: get("email").toLowerCase(),
    title: get("title"),
    company: get("company"),
    status: (get("status") || "pending") as Contact["status"],
    generatedSubject: get("generatedSubject") || undefined,
    generatedBody: get("generatedBody") || undefined,
    sentAt: parseDate(get("sentAt")),
    error: get("error") || undefined,
    createdAt: parseDate(get("createdAt")) ?? new Date(),
    updatedAt: parseDate(get("updatedAt")) ?? new Date(),
  };
}

function contactToRow(c: Contact): Record<string, string | number> {
  return {
    sno: c.sno,
    name: c.name,
    email: c.email,
    title: c.title,
    company: c.company,
    status: c.status,
    generatedSubject: c.generatedSubject ?? "",
    generatedBody: c.generatedBody ?? "",
    sentAt: c.sentAt ? c.sentAt.toISOString() : "",
    error: c.error ?? "",
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export class SheetStorage implements IStorage {
  readonly name = "sheet";
  private doc: GoogleSpreadsheet | null = null;
  private sheet: GoogleSpreadsheetWorksheet | null = null;
  private cache = new Map<string, CachedRow>();
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;

    const sheetId = process.env.GOOGLE_SHEET_ID;
    const clientEmail = process.env.client_email || process.env.GOOGLE_CLIENT_EMAIL;
    const privateKeyRaw = process.env.private_key || process.env.GOOGLE_PRIVATE_KEY;

    if (!sheetId) throw new Error("Missing GOOGLE_SHEET_ID env var");
    if (!clientEmail) throw new Error("Missing client_email env var (Google service account)");
    if (!privateKeyRaw) throw new Error("Missing private_key env var (Google service account)");

    const privateKey = privateKeyRaw.replace(/\\n/g, "\n");
    const jwt = new JWT({ email: clientEmail, key: privateKey, scopes: SCOPES });

    this.doc = new GoogleSpreadsheet(sheetId, jwt);
    await this.doc.loadInfo();

    let sheet = this.doc.sheetsByTitle[TAB_NAME];
    if (!sheet) {
      sheet = await this.doc.addSheet({
        title: TAB_NAME,
        headerValues: [...CONTACT_HEADERS],
      });
      logger.info(`[Sheet] Created tab "${TAB_NAME}"`);
    } else {
      try {
        await sheet.loadHeaderRow();
        const existing = sheet.headerValues || [];
        const missing = CONTACT_HEADERS.filter((h) => !existing.includes(h));
        if (missing.length > 0 || existing.length === 0) {
          if (sheet.columnCount < CONTACT_HEADERS.length) {
            await sheet.resize({ rowCount: sheet.rowCount || 1000, columnCount: CONTACT_HEADERS.length });
          }
          await sheet.setHeaderRow([...CONTACT_HEADERS]);
          logger.info(`[Sheet] Reset header row on "${TAB_NAME}"`);
        }
      } catch {
        if (sheet.columnCount < CONTACT_HEADERS.length) {
          await sheet.resize({ rowCount: sheet.rowCount || 1000, columnCount: CONTACT_HEADERS.length });
        }
        await sheet.setHeaderRow([...CONTACT_HEADERS]);
      }
    }

    this.sheet = sheet;

    const rows = await sheet.getRows();
    this.cache.clear();
    for (const row of rows) {
      const contact = rowToContact(row);
      if (!contact.email) continue;
      this.cache.set(contact.email, { row, contact });
    }

    logger.info(`[Sheet] Loaded ${this.cache.size} contacts from "${TAB_NAME}"`);
    this.initialized = true;
  }

  private requireSheet(): GoogleSpreadsheetWorksheet {
    if (!this.sheet) throw new Error("SheetStorage not initialized — call init() first");
    return this.sheet;
  }

  async insertContact(input: NewContactInput): Promise<UpsertResult> {
    const sheet = this.requireSheet();
    const email = input.email.toLowerCase();
    if (this.cache.has(email)) return { inserted: false };

    const now = new Date();
    const contact: Contact = {
      sno: input.sno,
      name: input.name,
      email,
      title: input.title,
      company: input.company,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };

    const row = await sheet.addRow(contactToRow(contact));
    this.cache.set(email, { row, contact });
    return { inserted: true };
  }

  async upsertSentContact(input: NewContactInput & ContactUpdate): Promise<void> {
    const email = input.email.toLowerCase();
    const existing = this.cache.get(email);
    if (existing) {
      await this.updateContact(email, {
        status: input.status ?? "sent",
        generatedSubject: input.generatedSubject,
        generatedBody: input.generatedBody,
        sentAt: input.sentAt ?? new Date(),
        error: input.error,
      });
      return;
    }

    const sheet = this.requireSheet();
    const now = new Date();
    const contact: Contact = {
      sno: input.sno,
      name: input.name,
      email,
      title: input.title,
      company: input.company,
      status: input.status ?? "sent",
      generatedSubject: input.generatedSubject,
      generatedBody: input.generatedBody,
      sentAt: input.sentAt ?? now,
      error: input.error,
      createdAt: now,
      updatedAt: now,
    };

    const row = await sheet.addRow(contactToRow(contact));
    this.cache.set(email, { row, contact });
  }

  async updateContact(email: string, update: ContactUpdate): Promise<void> {
    const key = email.toLowerCase();
    const cached = this.cache.get(key);
    if (!cached) {
      logger.warn(`[Sheet] updateContact: no row found for ${key}`);
      return;
    }

    const updated: Contact = {
      ...cached.contact,
      ...update,
      updatedAt: new Date(),
    };

    const rowData = contactToRow(updated);
    for (const header of CONTACT_HEADERS) {
      cached.row.set(header, String(rowData[header] ?? ""));
    }
    await cached.row.save();
    cached.contact = updated;
  }

  async findContact(email: string): Promise<Contact | null> {
    return this.cache.get(email.toLowerCase())?.contact ?? null;
  }

  async list(filter: ListFilter): Promise<ListResult> {
    const all = Array.from(this.cache.values()).map((c) => c.contact);
    const searched = filter.search
      ? all.filter((c) => {
          const q = filter.search!.toLowerCase();
          return (
            c.name.toLowerCase().includes(q) ||
            c.email.toLowerCase().includes(q) ||
            c.company.toLowerCase().includes(q)
          );
        })
      : all;
    const filtered = filter.status ? searched.filter((c) => c.status === filter.status) : searched;
    filtered.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    const total = filtered.length;
    const start = (filter.page - 1) * filter.limit;
    const data = filtered.slice(start, start + filter.limit);
    return { data, total };
  }

  async getStats(): Promise<Stats> {
    let sent = 0, failed = 0, pending = 0;
    for (const { contact } of this.cache.values()) {
      if (contact.status === "sent") sent++;
      else if (contact.status === "failed") failed++;
      else pending++;
    }
    return { total: this.cache.size, sent, failed, pending };
  }

  async getPending(limit: number): Promise<Contact[]> {
    const result: Contact[] = [];
    for (const { contact } of this.cache.values()) {
      if (contact.status === "pending") {
        result.push(contact);
        if (result.length >= limit) break;
      }
    }
    return result;
  }

  async clearAll(): Promise<number> {
    const sheet = this.requireSheet();
    const count = this.cache.size;
    await sheet.clear();
    await sheet.setHeaderRow([...CONTACT_HEADERS]);
    this.cache.clear();
    return count;
  }
}
