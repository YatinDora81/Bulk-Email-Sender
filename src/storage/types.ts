export type ContactStatus = "pending" | "sent" | "failed";

export interface Contact {
  sno: number;
  name: string;
  email: string;
  title: string;
  company: string;
  status: ContactStatus;
  openCount?: number;
  lastOpenedAt?: Date;
  generatedSubject?: string;
  generatedBody?: string;
  sentAt?: Date;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewContactInput {
  sno: number;
  name: string;
  email: string;
  title: string;
  company: string;
}

export interface ContactUpdate {
  status?: ContactStatus;
  openCount?: number;
  lastOpenedAt?: Date;
  generatedSubject?: string;
  generatedBody?: string;
  sentAt?: Date;
  error?: string;
}

export interface Stats {
  total: number;
  sent: number;
  failed: number;
  pending: number;
}

export interface ListFilter {
  page: number;
  limit: number;
  search?: string;
  status?: ContactStatus | "";
}

export interface ListResult {
  data: Contact[];
  total: number;
}

export interface UpsertResult {
  inserted: boolean;
}

export interface IStorage {
  readonly name: string;
  init(): Promise<void>;
  insertContact(contact: NewContactInput): Promise<UpsertResult>;
  upsertSentContact(contact: NewContactInput & ContactUpdate): Promise<void>;
  updateContact(email: string, update: ContactUpdate): Promise<void>;
  findContact(email: string): Promise<Contact | null>;
  list(filter: ListFilter): Promise<ListResult>;
  getStats(): Promise<Stats>;
  getPending(limit: number): Promise<Contact[]>;
  clearAll(): Promise<number>;
}

export const CONTACT_HEADERS = [
  "sno",
  "name",
  "email",
  "title",
  "company",
  "status",
  "openCount",
  "lastOpenedAt",
  "generatedSubject",
  "generatedBody",
  "sentAt",
  "error",
  "createdAt",
  "updatedAt",
] as const;
