// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { UIMessage } from "ai";

/**
 * The longest user message, in characters (UTF-16 code units, i.e. `string.length`), that an
 * Elench turn accepts. ONE number read by every layer that handles the message, so they cannot
 * disagree:
 *
 * - the composer refuses to send past it, visibly, and keeps the text (`ElenchComposer`);
 * - `createThread` rejects a stored first turn past it (`firstTurnSchema`);
 * - both chat routes Elench posts to (`/api/agent`, `/api/projects/[projectId]/assistant`)
 *   answer 413 with {@link MESSAGE_TOO_LONG} before any AI budget is reserved.
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

/** The total length of a message's text parts (what the user typed; other parts are not text). */
function messageTextLength(message: UIMessage): number {
	let n = 0;
	for (const part of message.parts) if (part.type === "text") n += part.text.length;
	return n;
}

/**
 * True when the request's LAST message is a user turn over the limit — the turn being sent now
 * (or re-sent by Retry). Earlier turns are not re-checked: a transcript stored before the limit
 * existed must stay answerable.
 */
export function lastUserMessageTooLong(messages: readonly UIMessage[]): boolean {
	const last = messages.at(-1);
	return last?.role === "user" && messageTextLength(last) > MAX_USER_MESSAGE_CHARS;
}
