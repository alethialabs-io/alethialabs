// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The content of an Elench draft (ADR 0001 §4.1): the box text, stored ONCE, with each mention
// pill as a span of that text. No Lexical JSON is stored; the editor is rebuilt from this by
// `contentToEditor` (components/agent/elench/draft-editor.ts). Pure and shared by client and
// server: the composer normalizes with it, and the draft actions validate with `contentSchema`.

import { z } from "zod";
import { type Mention, MENTION_TYPES } from "@/lib/ai/mentions";
import { MAX_USER_MESSAGE_CHARS } from "@/lib/ai/message-limits";

/** The most mention spans one draft may hold: one span per pill, repeats included. */
export const MAX_DRAFT_MENTION_SPANS = 50;

/**
 * The most DISTINCT mentions (by type and id) one draft may hold: the chat routes' cap
 * (`mentionsSchema` in lib/ai/mentions.ts), so a draft that saves can always be sent. The
 * agreement is pinned by a test that runs `mentionsSchema` itself, not by this comment.
 */
export const MAX_DRAFT_DISTINCT_MENTIONS = 20;

/** The most artifacts one draft may attach. */
export const MAX_DRAFT_ARTIFACTS = 10;

/** The longest mention id or label, in UTF-16 code units. */
export const MAX_DRAFT_MENTION_FIELD = 256;

/**
 * Normalizes draft text the way the composer does on every edit (ADR 0001 §4.1): U+0000 removed
 * and lone surrogates replaced (`toWellFormed`). These are exactly the characters Postgres `text`
 * and `jsonb` refuse or change. It does NOT trim and does NOT touch line endings: the draft is the
 * box as typed. ADR 0003's `turnText` applies this same step first, then CRLF→LF and the trim.
 */
export function normalizeDraftText(text: string): string {
	return text.replaceAll("\u0000", "").toWellFormed();
}

/** True when `text` is already normalized ({@link normalizeDraftText} would not change it). */
export function isNormalizedDraftText(text: string): boolean {
	return text === normalizeDraftText(text);
}

/** A mention id or label: capped, and normalized so Postgres stores it unchanged. */
const mentionFieldSchema = z
	.string()
	.max(MAX_DRAFT_MENTION_FIELD)
	.refine(isNormalizedDraftText, "invalid");

/** One mention pill, as a span `[start, end)` of the draft text in UTF-16 offsets. */
const draftMentionSchema = z.object({
	id: mentionFieldSchema,
	type: z.enum(MENTION_TYPES),
	label: mentionFieldSchema.min(1),
	start: z.number().int().min(0),
	end: z.number().int().min(1),
});

/** One mention pill of a draft: who it names, and where its `@label` sits in the text. */
export type DraftMention = z.infer<typeof draftMentionSchema>;

/** The widget-grid cell an empty-cell prompt asked to fill (the routes' shape, `/api/agent`). */
const draftCellTargetSchema = z.object({
	x: z.number().int().min(0).max(4),
	y: z.number().int().min(0),
});

/** The text and pills of a draft: the part the editor holds. */
export interface DraftEditorContent {
	text: string;
	mentions: DraftMention[];
}

/**
 * The distinct mentions of `spans`, by type and id, in order of first appearance and with the
 * first appearance's label. This is the list a send carries (the composer's send-time walk
 * dedupes the same way), so its length is what the routes' cap applies to.
 */
export function distinctMentions(spans: readonly DraftMention[]): Mention[] {
	const seen = new Set<string>();
	const out: Mention[] = [];
	for (const span of spans) {
		const key = `${span.type}:${span.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ id: span.id, type: span.type, label: span.label });
	}
	return out;
}

/**
 * The span rules (ADR 0001 §4.1): spans are sorted and do not overlap (two pills may touch), each
 * ends within the text, and each covers exactly `"@" + label`. With a well-formed label and text
 * this also means no span splits a surrogate pair.
 */
export function spansAreValid(content: DraftEditorContent): boolean {
	let previousEnd = 0;
	for (const span of content.mentions) {
		if (span.start < previousEnd) return false;
		if (span.end > content.text.length) return false;
		if (content.text.slice(span.start, span.end) !== `@${span.label}`) return false;
		previousEnd = span.end;
	}
	return true;
}

/**
 * A draft's content as `saveDraft` and `claimDraft` receive it (ADR 0001 §4.1). The only size
 * refusal is the character cap, the same number the composer and the routes' 413 enforce; the
 * worst case it admits encodes well under the 1 MiB action body (R7, pinned by a test).
 */
export const contentSchema = z
	.object({
		text: z
			.string()
			.max(MAX_USER_MESSAGE_CHARS)
			.refine(isNormalizedDraftText, "invalid"),
		mentions: z
			.array(draftMentionSchema)
			.max(MAX_DRAFT_MENTION_SPANS)
			.refine(
				(spans) => distinctMentions(spans).length <= MAX_DRAFT_DISTINCT_MENTIONS,
				"invalid",
			),
		artifacts: z.array(z.uuid()).max(MAX_DRAFT_ARTIFACTS),
		cellTarget: draftCellTargetSchema.nullable(),
	})
	.refine(spansAreValid, "invalid");

/** A draft's content: its text, the pills as spans of it, its artifacts and its cell target. */
export type DraftContent = z.infer<typeof contentSchema>;
