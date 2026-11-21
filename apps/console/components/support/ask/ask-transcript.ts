// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Where the Ask-AI conversation is kept while the person looks at something else (G-10).
//
// The conversation used to be component state: "View case" on an opened case navigated away and
// the whole exchange was gone when they came back. It is now written to the tab's
// `sessionStorage` after every finished turn and read back when the page mounts.
//
// WHERE. The key is built by the wizard drafts' own `draftKey` (`lib/wizard/draft.ts`), with this
// conversation's id, the viewer and the org. That is on purpose: the drafts' sweep removes every
// key of another viewer when any draft is read, and sign-out clears every key with that prefix
// (`clearAllWizardDrafts`), so a second person in the same tab never sees the first person's
// conversation. Reading here runs the same sweep. The tab's storage ends with the tab.
//
// WHAT. The messages as the chat holds them, re-checked on the way back in: a stored value that is
// not a list of messages, is of another version, or is older than the TTL is removed and the page
// starts empty. Storage that throws (a browser that refuses it) keeps nothing; the conversation then
// lasts as long as the page, as it did before.

import type { UIMessage } from "ai";
import { z } from "zod";
import { type DraftAddress, draftKey, sweepDrafts } from "@/lib/wizard/draft";

/** The conversation's storage id, inside the drafts' namespace. */
export const ASK_TRANSCRIPT_ID = "support-ask";

/** Moves when the stored shape changes; an older value is dropped. */
export const ASK_TRANSCRIPT_VERSION = 1;

/** How long a kept conversation is offered back. */
export const ASK_TRANSCRIPT_TTL_MS = 24 * 60 * 60 * 1000;

/** Whether `value` has the fields every chat message has: an id, a role and a list of typed parts. */
function isMessageLike(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	if (!("id" in value) || !("role" in value) || !("parts" in value)) return false;
	const { id, role, parts } = value;
	return (
		typeof id === "string" &&
		(role === "user" || role === "assistant" || role === "system") &&
		Array.isArray(parts) &&
		parts.every(
			(part: unknown) =>
				typeof part === "object" && part !== null && "type" in part && typeof part.type === "string",
		)
	);
}

/** The stored text's shape. */
const envelopeSchema = z.object({
	v: z.literal(ASK_TRANSCRIPT_VERSION),
	at: z.number(),
	messages: z.array(z.custom<UIMessage>(isMessageLike)),
});

/** The tab's storage, or `null` where there is none or reaching it throws. */
function tabStorage(): Storage | null {
	try {
		return typeof window === "undefined" ? null : window.sessionStorage;
	} catch {
		return null;
	}
}

/** What one conversation belongs to: the viewer and the org. */
export function askTranscriptAddress(viewerId: string, orgSlug: string): DraftAddress {
	return { id: ASK_TRANSCRIPT_ID, viewerId, scope: orgSlug };
}

/** The storage key of one conversation. */
export function askTranscriptKey(address: DraftAddress): string {
	return draftKey(address, ASK_TRANSCRIPT_VERSION);
}

/**
 * The kept conversation at `address`, or an empty list. A value that does not parse, is of another
 * version, is dated in the future or is older than the TTL is removed. Also removes what another
 * viewer left in this tab.
 */
export function readAskTranscript(address: DraftAddress, now: number): UIMessage[] {
	sweepDrafts(address, ASK_TRANSCRIPT_VERSION);
	const storage = tabStorage();
	if (storage === null) return [];
	const key = askTranscriptKey(address);
	try {
		const text = storage.getItem(key);
		if (text === null) return [];
		const parsed = envelopeSchema.safeParse(JSON.parse(text));
		if (parsed.success && parsed.data.at <= now && now - parsed.data.at <= ASK_TRANSCRIPT_TTL_MS) {
			return parsed.data.messages;
		}
		storage.removeItem(key);
	} catch {
		try {
			storage.removeItem(key);
		} catch {
			// Storage that throws holds nothing to remove.
		}
	}
	return [];
}

/** Keeps `messages` as the conversation at `address`; an empty list removes it. */
export function writeAskTranscript(address: DraftAddress, messages: readonly UIMessage[], now: number): void {
	const storage = tabStorage();
	if (storage === null) return;
	const key = askTranscriptKey(address);
	try {
		if (messages.length === 0) {
			storage.removeItem(key);
			return;
		}
		storage.setItem(key, JSON.stringify({ v: ASK_TRANSCRIPT_VERSION, at: now, messages }));
	} catch {
		// Full or refused storage: the conversation lasts as long as the page.
	}
}

/** Removes the conversation at `address` ("New conversation"). */
export function clearAskTranscript(address: DraftAddress): void {
	writeAskTranscript(address, [], 0);
}
