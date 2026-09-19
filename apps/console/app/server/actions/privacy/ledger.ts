// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The privacy-case helpers shared by the handling steps (`cases.ts`) and the self-serve request
// (`self-serve.ts`). One copy on purpose: `subjectHash` is how a tombstone is matched to a later
// restore, so two spellings of it that drifted apart would stop an erasure being replayed.
//
// Not a `"use server"` module — these are called by server actions, never by the browser, and
// `subjectHash` / `newReference` are synchronous, which a server-action module may not export.

import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { getServiceDb, type Tx } from "@/lib/db";
import { privacyCaseEvent } from "@/lib/db/schema";
import type { PrivacyCaseEventKind } from "@/lib/db/schema/enums";
import type { PrivacyEventDetail } from "@/types/jsonb.types";

/**
 * SHA-256 of a contact address, lower-cased and trimmed.
 *
 * The only identifier that survives fulfilment, so it is hashed rather than stored: a table listing
 * everyone who ever exercised a privacy right, in plaintext, would be a privacy problem created by
 * the machinery meant to solve one.
 */
export function subjectHash(email: string): string {
	return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

/** A short, human reference to quote in correspondence. Unique; never reused. */
export function newReference(): string {
	return `DSR-${randomUUID().slice(0, 8).toUpperCase()}`;
}

/**
 * Appends to the ledger. Never updates — the trigger in programmables.sql refuses UPDATE and DELETE,
 * so this is the only way anything is recorded and the history cannot be revised afterwards.
 *
 * `tx` writes the event inside a caller's transaction, so it commits or rolls back with the case it
 * describes. Without it the event is written on the service connection on its own.
 */
export async function recordEvent(
	caseId: string,
	kind: PrivacyCaseEventKind,
	detail: PrivacyEventDetail,
	actorUserId: string | null,
	tx?: Tx,
): Promise<void> {
	await (tx ?? getServiceDb()).insert(privacyCaseEvent).values({
		caseId,
		kind,
		actorUserId,
		detail,
	});
}
