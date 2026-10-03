"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { generateId, type UIMessage } from "ai";
import { useCallback, useRef, useState } from "react";
import type { FirstTurn } from "@/app/server/actions/agent";
import { ThreadStartError } from "@/components/agent/chat-error";
import type { Mention } from "@/lib/ai/mentions";
import { isMessageTooLong, MESSAGE_TOO_LONG } from "@/lib/ai/message-limits";

/** A first send whose thread is not created yet — kept so a Retry re-sends it under one id. */
interface PendingFirstTurn {
	id: string;
	text: string;
	mentions: Mention[];
}

export interface ElenchSendDeps {
	/** True once the conversation is attached to a stored thread. Read FRESH at send time (the
	 * store, not a render's closure): `startThread` attaches before the next render. */
	hasThread: () => boolean;
	/** Create + attach the thread, storing `firstTurn` with it. May throw. */
	startThread: (title: string, firstTurn?: FirstTurn) => Promise<unknown>;
	/** Hand the user message to the chat transport. */
	sendMessage: (message: UIMessage) => void;
	/** Runs immediately before every send that goes out (stage mentions, analytics). */
	beforeSend?: (mentions: Mention[]) => void;
}

export interface ElenchSend {
	/** Send `text`. Resolves `true` when it went out, `false` when it did NOT — the caller (the
	 * composer) then keeps the text, so a refused or failed send never loses the message. */
	send: (text: string, mentions?: Mention[]) => Promise<boolean>;
	/** Why the last send did not go out, or null: a `ThreadStartError`, or the too-long error. */
	error: Error | null;
	/** Re-send the failed first turn AS IT WAS (thread, then message), or undefined when none
	 * failed. Only for a turn the composer does not hold: when it does, Retry submits the composer
	 * instead — its text may have been edited since, and `send` with that text reuses the same
	 * pending id. */
	retry: (() => Promise<boolean>) | undefined;
	/** Forget the failure and the pending turn — a new conversation starts clean. */
	reset: () => void;
}

/**
 * The Elench send path. A message is sent ONLY once the conversation has a thread id: both chat
 * routes persist the transcript in `onFinish` only when the request carries one, so a send
 * without it is a reply that is never stored — a conversation that looks normal and is gone on
 * reload. So the first send of an ephemeral conversation creates the thread FIRST; if that
 * throws, nothing is sent, the failure is surfaced (`error`, a {@link ThreadStartError}), and
 * the message is kept — the composer keeps its text (`send` resolves false), and the next
 * `send` (Enter, or Retry submitting the composer) re-attempts it, edits included.
 *
 * The first turn's message id is minted once and REUSED by every retry of it, so `createThread`
 * (idempotent on that id) returns the row a lost response already committed instead of
 * inserting a second thread with a second copy of the turn.
 */
export function useElenchSend({
	hasThread,
	startThread,
	sendMessage,
	beforeSend,
}: ElenchSendDeps): ElenchSend {
	const [error, setError] = useState<Error | null>(null);
	const [pending, setPending] = useState<PendingFirstTurn | null>(null);
	// The same pending turn, readable synchronously inside `send` (state lags a render).
	const pendingRef = useRef<PendingFirstTurn | null>(null);
	// One thread creation at a time: a second send while the first awaits `startThread` would
	// create a second thread for the same conversation.
	const startingRef = useRef(false);

	const send = useCallback(
		async (text: string, mentions: Mention[] = []): Promise<boolean> => {
			// Refused here, before any thread is created: an over-limit first send must not
			// leave an empty row behind, and the route would only 413 it.
			if (isMessageTooLong(text)) {
				setError(new Error(MESSAGE_TOO_LONG));
				return false;
			}
			let id: string;
			if (!hasThread()) {
				if (startingRef.current) return false;
				const turn: PendingFirstTurn = {
					id: pendingRef.current?.id ?? generateId(),
					text,
					mentions,
				};
				pendingRef.current = turn;
				startingRef.current = true;
				try {
					await startThread(text, text.trim() ? { id: turn.id, text } : undefined);
				} catch {
					// Nothing is sent: a send with no thread id is never stored. The turn stays
					// pending (same id) for Retry, and the composer keeps the text.
					setPending(turn);
					setError(new ThreadStartError());
					return false;
				} finally {
					startingRef.current = false;
				}
				pendingRef.current = null;
				setPending(null);
				id = turn.id;
			} else {
				id = generateId();
			}
			setError(null);
			beforeSend?.(mentions);
			sendMessage({ id, role: "user", parts: [{ type: "text", text }] });
			return true;
		},
		[hasThread, startThread, sendMessage, beforeSend],
	);

	const retry = pending
		? () => send(pending.text, pending.mentions)
		: undefined;

	const reset = useCallback(() => {
		pendingRef.current = null;
		setPending(null);
		setError(null);
	}, []);

	return { send, error, retry, reset };
}
