import { getStorage } from "../storage";
import {
  isSupabaseTrackingEnabled,
  listAllOpenTracking,
  type OpenTrackingRow,
} from "../tracking/supabase";
import { logger } from "../utils/logger";

export interface TrackingSyncResult {
  supabaseRows: number;
  uniqueEmails: number;
  updated: number;
  skippedNotInStorage: number;
  errors: number;
}

/** Merge multiple Supabase rows per email (sum opens, latest last_opened_at). */
export function aggregateOpenTrackingByEmail(
  rows: OpenTrackingRow[],
): Map<string, { openCount: number; lastOpenedAt?: Date }> {
  const map = new Map<string, { openCount: number; lastOpenedAt?: Date }>();

  for (const row of rows) {
    const email = row.email.trim().toLowerCase();
    if (!email) continue;

    const lastAt = row.last_opened_at ? new Date(row.last_opened_at) : undefined;
    const existing = map.get(email);

    if (!existing) {
      map.set(email, {
        openCount: row.open_count ?? 0,
        lastOpenedAt: lastAt,
      });
      continue;
    }

    existing.openCount += row.open_count ?? 0;
    if (lastAt && (!existing.lastOpenedAt || lastAt > existing.lastOpenedAt)) {
      existing.lastOpenedAt = lastAt;
    }
  }

  return map;
}

/**
 * Read open stats from Supabase and write openCount + lastOpenedAt
 * into primary STORAGE_BACKENDS (and mirrors).
 */
export async function syncOpenTrackingToStorage(): Promise<TrackingSyncResult> {
  if (!isSupabaseTrackingEnabled()) {
    throw new Error(
      "Supabase tracking not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }

  const storage = getStorage();
  await storage.init();

  const rows = await listAllOpenTracking();
  const byEmail = aggregateOpenTrackingByEmail(rows);

  let updated = 0;
  let skippedNotInStorage = 0;
  let errors = 0;

  for (const [email, stats] of byEmail) {
    try {
      const contact = await storage.findContact(email);
      if (!contact) {
        skippedNotInStorage++;
        continue;
      }

      const sameCount = (contact.openCount ?? 0) === stats.openCount;
      const contactLast = contact.lastOpenedAt?.getTime();
      const statsLast = stats.lastOpenedAt?.getTime();
      if (sameCount && contactLast === statsLast) {
        continue;
      }

      await storage.updateContact(email, {
        openCount: stats.openCount,
        lastOpenedAt: stats.lastOpenedAt,
      });
      updated++;
    } catch (error) {
      errors++;
      logger.warn(
        `[TrackingSync] Failed ${email}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  const result: TrackingSyncResult = {
    supabaseRows: rows.length,
    uniqueEmails: byEmail.size,
    updated,
    skippedNotInStorage,
    errors,
  };

  logger.info(
    `[TrackingSync] Done — supabase=${result.supabaseRows} emails=${result.uniqueEmails} updated=${result.updated} skipped=${result.skippedNotInStorage} errors=${result.errors}`,
  );

  return result;
}
