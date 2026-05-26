import { z } from "zod/v4";

export const sendSchema = z.object({
  name: z.string().min(1, "name is required"),
  email: z.email("invalid email format"),
  title: z.string().min(1, "title is required"),
  company: z.string().min(1, "company is required"),
});

export const contactsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().default(""),
  status: z.enum(["pending", "sent", "failed", ""]).default(""),
});
