// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What the case view's loading form needs to know about ONE case to stand in the page's shape
// (#6354, B2). Pure and client-safe: no React, no server-only import — `read-case-shape.ts` builds
// it on the server from the route's own read, the skeleton draws it, and the tests drive it.

/** One thread message, as the skeleton draws it: which side it sits on, and its text to size by. */
export interface CaseShapeMessage {
	/** The requester's own message: right-aligned in a filled bubble, no avatar. */
	fromCustomer: boolean;
	/**
	 * The body's paragraphs, set INVISIBLY inside the placeholder so it wraps where the page's text
	 * wraps (the CaseTime sizer pattern), or `null` when the text is not known — then the
	 * placeholder is one line tall.
	 */
	paragraphs: string[] | null;
}

/** The parts of a case the case view's layout varies by. */
export interface CaseShape {
	/**
	 * Closed: the page draws the closed notice where the composer goes, and no lifecycle button in
	 * the header (the notice holds the one action).
	 */
	closed: boolean;
	/** How many attachment rows the attachments panel lists; 0 means the page draws no panel. */
	attachments: number;
	/** The newest messages, oldest first — at most {@link SHAPED_MESSAGES}. */
	messages: CaseShapeMessage[];
}

/**
 * The most messages the skeleton draws. The page's thread is a scroller bounded at 60dvh (70dvh
 * from `sm`) that opens at the newest message, and a message is at least ~70px — so more than this
 * many only ever fill the same bounded box, and drawing them would add nothing but bytes.
 */
export const SHAPED_MESSAGES = 16;

/**
 * The shape when nothing about the case is known (the read failed, or the view's own pending
 * branch, which has no data): an open case, no attachments, and the ONE message every case has —
 * `submitCase` writes the requester's description as the first, customer-authored message.
 */
export const OPENING_CASE_SHAPE: CaseShape = {
	closed: false,
	attachments: 0,
	messages: [{ fromCustomer: true, paragraphs: null }],
};

/**
 * Split a message body the way its markdown renders into blocks: a blank line separates
 * paragraphs, and a single newline inside one is a soft break (a space). Empty paragraphs drop.
 */
export function bodyParagraphs(body: string): string[] {
	return body
		.split(/\n[^\S\n]*\n/)
		.map((p) => p.replace(/\s+/g, " ").trim())
		.filter((p) => p.length > 0);
}

/**
 * The parts of the `support.case` read (`CaseWithThread`) a shape is made from — stated
 * structurally, so the server's in-process answer and a test's plain object both fit.
 */
export interface ShapeableCase {
	case: { status: string };
	attachments: readonly unknown[];
	messages: readonly { author_type: string; body: string }[];
}

/** The shape of a read case, or {@link OPENING_CASE_SHAPE} when there is none. */
export function caseShapeOf(read: ShapeableCase | undefined): CaseShape {
	if (read === undefined) return OPENING_CASE_SHAPE;
	return {
		closed: read.case.status === "resolved", // M2
		attachments: read.attachments.length,
		messages: read.messages.map( // M3
			(m) => ({
			fromCustomer: m.author_type === "customer",
			paragraphs: bodyParagraphs(m.body),
		})),
	};
}
