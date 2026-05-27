import type { Request, Response } from "express";
import { getGemini } from "../config/gemini";
import { sendTrackedEmail } from "../services/tracked-email.service";
import { getStorage } from "../storage";
import { EMAIL_SYSTEM_PROMPT, buildEmailPrompt } from "../utils/prompt";
import { parseExcelFile } from "../services/excel.service";
import campaignManager from "../services/campaign.service";
import { sendSchema, contactsQuerySchema } from "../utils/schemas";
import { logger } from "../utils/logger";

export async function sendOne(req: Request, res: Response) {
  try {
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
      return;
    }

    const { name, email, title, company } = parsed.data;
    logger.info(`Generating email for ${name} (${email}) at ${company}`);

    const gemini = getGemini();
    const rawResponse = await gemini.generate(
      buildEmailPrompt({ name, title, company }),
      EMAIL_SYSTEM_PROMPT
    );

    if (!rawResponse) {
      res.status(500).json({ error: "Empty response from Gemini" });
      return;
    }

    const cleaned = rawResponse.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    let emailData: { subject: string; body: string };
    try {
      emailData = JSON.parse(cleaned);
    } catch {
      res.status(500).json({ error: "Failed to parse AI response" });
      return;
    }
    if (!emailData.subject || !emailData.body) {
      res.status(500).json({ error: "Missing subject or body" });
      return;
    }

    const { messageId, trackingEnabled } = await sendTrackedEmail({
      to: email,
      subject: emailData.subject,
      html: emailData.body,
    });

    const storage = getStorage();
    await storage.upsertSentContact({
      sno: 0,
      name,
      email: email.toLowerCase(),
      title,
      company,
      status: "sent",
      generatedSubject: emailData.subject,
      generatedBody: emailData.body,
      sentAt: new Date(),
    });

    logger.info(`Sent to ${email}`);
    res.json({
      ok: true,
      to: email,
      subject: emailData.subject,
      body: emailData.body,
      tracking: trackingEnabled ? { messageId } : null,
    });
  } catch (error: unknown) {
    logger.error(`Send failed: ${error instanceof Error ? error.message : error}`);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
}

export async function sendAll(_req: Request, res: Response) {
  try {
    const rawContacts = parseExcelFile();
    const storage = getStorage();

    let imported = 0;
    let skipped = 0;

    for (const raw of rawContacts) {
      const { inserted } = await storage.insertContact(raw);
      if (inserted) imported++;
      else skipped++;
    }

    logger.info(`Imported ${imported}, skipped ${skipped}`);

    const result = await campaignManager.start();
    if ("error" in result) {
      res.json({ imported, skipped, error: result.error, stats: await storage.getStats() });
      return;
    }

    res.json({ ok: true, imported, skipped, stats: await storage.getStats() });
  } catch (error: unknown) {
    logger.error(`Send-all failed: ${error instanceof Error ? error.message : error}`);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
}

export async function getSentEmails(req: Request, res: Response) {
  try {
    const parsed = contactsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
      return;
    }

    const { page, limit, search, status } = parsed.data;
    const storage = getStorage();

    const [{ data, total }, stats] = await Promise.all([
      storage.list({ page, limit, search, status }),
      storage.getStats(),
    ]);

    res.json({
      emails: data,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      stats,
    });
  } catch (error: unknown) {
    logger.error(`Get emails failed: ${error instanceof Error ? error.message : error}`);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
}
