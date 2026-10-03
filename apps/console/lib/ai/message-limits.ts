// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/**
 * The longest user message, in characters (UTF-16 code units, i.e. `string.length`), that an
 * Elench turn accepts. ONE number read by every layer that handles the message, so they cannot
 * disagree:
 *
 * - the composer refuses to send past it, visibly, and keeps the text (`ElenchComposer`);
 * - `createThread` rejects a stored first turn past it (`firstTurnSchema`);
 * - every metered chat route (`/api/agent`, `/api/agent/[agentId]`,
 *   `/api/projects/[projectId]/assistant`) answers 413 with {@link MESSAGE_TOO_LONG} before any
 *   AI budget is reserved (`refuseUserMessage`).
 *
 * Before this existed the action capped a first turn at 100k while the routes capped nothing,
 * so a long first message threw inside `startThread` and the send was dropped without a word.
 */
export const MAX_USER_MESSAGE_CHARS = 100_000;

/** {@link MAX_USER_MESSAGE_CHARS} as a person reads it ("100,000"). */
const MAX_USER_MESSAGE_LABEL = new Intl.NumberFormat("en-US").format(
	MAX_USER_MESSAGE_CHARS,
);

/**
 * The 413 body a chat route answers an over-limit message with. `ChatError` matches this exact
 * string (not a pattern) to show the too-long copy, so it lives here, shared by both ends.
 */
export const MESSAGE_TOO_LONG = `This message is too long. A message can be at most ${MAX_USER_MESSAGE_LABEL} characters.`;

/** True when `text` is longer than {@link MAX_USER_MESSAGE_CHARS}. */
export function isMessageTooLong(text: string): boolean {
	return text.length > MAX_USER_MESSAGE_CHARS;
}

/** What the limit reads from a message: its role, and the type + text of each part. */
interface CountableMessage {
	role: string;
	parts: readonly { type: string; text?: unknown }[];
}

/** The total length of a message's text parts (what the user typed; other parts are not text). */
function messageTextLength(message: CountableMessage): number {
	let n = 0;
	for (const part of message.parts) {
		if (part.type === "text" && typeof part.text === "string") n += part.text.length;
	}
	return n;
}

/**
 * True when the request's LAST message is a user turn over the limit — the turn being sent now
 * (or re-sent by Retry). Earlier turns are not re-checked: a transcript stored before the limit
 * existed must stay answerable.
 */
export function lastUserMessageTooLong(messages: readonly CountableMessage[]): boolean {
	const last = messages.at(-1);
	return last?.role === "user" && messageTextLength(last) > MAX_USER_MESSAGE_CHARS;
}

/**
 * The part of a chat request's `messages` the limit reads, validated: an array of messages, each
 * with a string `role` and an array of `parts`, every part with a string `type` and every TEXT
 * part with a string `text`. Other fields pass through untouched — this is the shape the count
 * relies on, not a full `UIMessage` schema.
 */
const countableMessagesSchema = z.array(
	z.looseObject({
		role: z.string(),
		parts: z.array(
			z
				// `.optional()` is load-bearing: under a refine, zod 4 treats a bare `z.unknown()`
				// key as REQUIRED, so every step-start / tool / data part (no `text`) failed and
				// any second turn after a tool turn was answered 400 (caught by the elench-ai gate).
				.looseObject({ type: z.string(), text: z.unknown().optional() })
				.refine((p) => p.type !== "text" || typeof p.text === "string", {
					message: "a text part needs a string text",
				}),
		),
	}),
);

/**
 * The refusal a metered chat route answers BEFORE its budget hold, or null to proceed: 400 when
 * `messages` is not a message list the limit can read (a malformed body used to throw a
 * TypeError here, which became a 500), 413 with {@link MESSAGE_TOO_LONG} when the last user turn
 * is over {@link MAX_USER_MESSAGE_CHARS}.
 */
export function refuseUserMessage(messages: unknown): Response | null {
	const parsed = countableMessagesSchema.safeParse(messages);
	if (!parsed.success) {
		return new Response("The request's messages are malformed.", { status: 400 });
	}
	return lastUserMessageTooLong(parsed.data)
		? new Response(MESSAGE_TOO_LONG, { status: 413 })
		: null;
}
