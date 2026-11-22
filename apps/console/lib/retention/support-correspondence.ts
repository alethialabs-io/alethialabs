// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The privacy policy's "support correspondence: up to 3 years after the matter closes", enforced.
//
// A support case is deleted — its messages, read watermarks and attachment rows with it, by the
// ON DELETE CASCADE on each child table — once it has been CLOSED for longer than the window. Its
// attachments' objects are deleted from storage first, so no file outlives the row that named it.
//
// Only `closed`. A case that is `resolved` but never closed is still a matter a person can reopen,
// and a case with no `closed_at` has never closed at all; neither has started its three years.
// Bounded per pass, and run daily by the reconcile loop (`lib/reconcile/loop.ts`).

import "server-only";
import { and, eq, inArray, lt } from "drizzle-orm";
import { SUPPORT_ATTACHMENTS_BUCKET } from "@repo/support/storage";
import type { Db } from "@/lib/db";
import { supportCaseAttachments, supportCases } from "@/lib/db/schema";
import { RETENTION_DEFAULT_DAYS } from "@/lib/retention/registry";
import { storage, type StorageBackend } from "@/lib/storage";

/** Cases deleted per pass. */
const BATCH = 200;

/** The instant before which a closed case is past its window. */
export function supportCorrespondenceCutoff(now: Date): Date {
	return new Date(now.getTime() - RETENTION_DEFAULT_DAYS.supportCorrespondence * 86_400_000);
}

/** Deletes one bounded batch of support cases closed for longer than the window. */
export async function gcSupportCorrespondence(
	db: Db,
	now: Date = new Date(),
	objects: StorageBackend = storage,
): Promise<{ deleted: number }> {
	const expired = await db
		.select({ id: supportCases.id })
		.from(supportCases)
		.where(
			and(
				eq(supportCases.status, "closed"),
				lt(supportCases.closed_at, supportCorrespondenceCutoff(now)),
			),
		)
		.limit(BATCH);
	if (expired.length === 0) return { deleted: 0 };
	const ids = expired.map((c) => c.id);

	const files = await db
		.select({ key: supportCaseAttachments.storage_key })
		.from(supportCaseAttachments)
		.where(inArray(supportCaseAttachments.case_id, ids));
	for (const f of files) await objects.del(SUPPORT_ATTACHMENTS_BUCKET, f.key);

	const deleted = await db
		.delete(supportCases)
		.where(inArray(supportCases.id, ids))
		.returning({ id: supportCases.id });
	return { deleted: deleted.length };
}
