"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useChat } from "@ai-sdk/react";
import {
	DefaultChatTransport,
	lastAssistantMessageIsCompleteWithToolCalls,
	type UIMessage,
} from "ai";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { z } from "zod";
import type { TurnRefusal, TurnRefusalCode } from "@/lib/agent/turn-claims";
import { pendingClientToolCalls, type TurnRequest } from "@/lib/agent/turn-key";

/** Builds the surface-specific extra body for a request (canvas snapshot, threadId, …). */
export type PrepareBody = (messages: UIMessage[]) => Record<string, unknown>;

/**
 * Feed a client (HITL) tool's outcome back to the model. Structurally compatible with
 * the AI SDK `useChat().addToolResult` (default UIMessage → `tool` is a string). Used by
 * the approval cards: after the user approves/rejects an action, the outcome is added as
 * the tool result, which — with `sendAutomaticallyWhen` below — resumes the run so the
 * model continues (e.g. plan → get_plan_result → propose deploy).
 */
export type AddToolResult = (result: {
	tool: string;
	toolCallId: string;
	output: unknown;
}) => void;

/** The trigger of a chat request the transport sends a turn for (ADR 0003 §9.1). */
type TurnTrigger = TurnRequest["trigger"];

/**
 * The turn fields of a request (ADR 0003 §9.1): `turnId` is the last USER message's id;
 * `answerId` is the regenerated answer (`messageId`), or, for a continuation (an assistant
 * message last), that message's id, with `toolCallIds` its pending client tool calls computed by
 * the SAME `pendingClientToolCalls` the server runs over the stored answer.
 */
export function turnOf(
	messages: readonly UIMessage[],
	trigger: TurnTrigger,
	messageId: string | undefined,
	baseRevision: number,
): TurnRequest {
	const lastUser = [...messages].reverse().find((m) => m.role === "user");
	const turn: TurnRequest = { trigger, turnId: lastUser?.id ?? "", baseRevision };
	if (trigger === "regenerate-message") {
		return messageId === undefined ? turn : { ...turn, answerId: messageId };
	}
	const last = messages.at(-1);
	if (last?.role === "assistant") {
		return { ...turn, answerId: last.id, toolCallIds: pendingClientToolCalls(last) };
	}
	return turn;
}

/** Every refusal code a chat route answers (ADR 0003 §9.3), checked against the server's union. */
const TURN_REFUSAL_CODES = [
	"turn-in-progress",
	"turn-answered",
	"turn-committed-different-text",
	"thread-busy",
	"transcript-stale",
	"thread-deleted",
	"thread-not-found",
	"org-forbidden",
	"project-not-found",
	"client-outdated",
	"turn-has-accepted-approval",
] as const satisfies readonly TurnRefusalCode[];

/** The typed refusal body (ADR 0003 §9.3); anything else is not a refusal. */
const turnRefusalSchema = z.object({
	refusal: z.enum(TURN_REFUSAL_CODES),
	turnId: z.string().nullable(),
	committed: z.boolean(),
	textCommitted: z.boolean(),
	answered: z.boolean(),
	revision: z.number().int().nullable(),
	answerId: z.string().nullable(),
}) satisfies z.ZodType<TurnRefusal>;

/** What the transport sent in the request a refusal answers. */
export interface RefusedRequest {
	turn: TurnRequest;
	/** The request's last message: the refused user turn, or the continued answer. */
	last: UIMessage | undefined;
}

/**
 * A chat route refused the request before its budget hold, with a typed body (ADR 0003 §9.3).
 * Thrown by the opted-in transport's `fetch` so `useChat` surfaces it as the chat's error, where
 * the caller's refusal handler reads it by type.
 */
export class TurnRefusedError extends Error {
	constructor(
		readonly refusal: TurnRefusal,
		readonly status: number,
		readonly request: RefusedRequest | null,
	) {
		super(`The turn was refused: ${refusal.refusal}`);
		this.name = "TurnRefusedError";
	}
}

/** Reads a typed refusal off a non-2xx response, or null when the body is not one. */
async function readRefusal(res: Response): Promise<TurnRefusal | null> {
	const body: unknown = await res
		.clone()
		.json()
		.catch(() => null);
	const parsed = turnRefusalSchema.safeParse(body);
	return parsed.success ? parsed.data : null;
}

/** The revision a `data-turn-accepted` / `data-turn-finished` part carries. */
const turnRevisionPartSchema = z.object({
	type: z.enum(["data-turn-accepted", "data-turn-finished"]),
	data: z.object({ revision: z.number().int() }),
});

export interface UseAgentChatOptions {
	/** Streaming route this surface talks to (e.g. /api/agent, /api/projects/[id]/assistant). */
	api: string;
	/**
	 * Extra body fields merged into every request. Read FRESH at send time, so it
	 * may read global stores via `getState()`. MUST be referentially stable (define
	 * it at module scope or wrap in `useCallback`) — it keys the transport memo.
	 */
	prepareBody?: PrepareBody;
	/** Stable chat id — set to a thread id to resume a persisted conversation. */
	id?: string;
	/** Initial transcript when resuming a persisted thread. */
	initialMessages?: UIMessage[];
	/**
	 * Opts the surface into the turn claim (ADR 0003 §9.1): when set, every request carries
	 * `orgId` (this getter's answer, read at REQUEST time, so a chat's first transport never pins
	 * the first render's org) and `turn`, and a typed refusal is thrown as a
	 * {@link TurnRefusedError}. Unset (the support chat), the wire is unchanged. MUST be
	 * referentially stable — it keys the transport memo.
	 */
	org?: () => string | null;
	/** The revision of the transcript `initialMessages` came from (the base revision of the first send). */
	initialRevision?: number | null;
}

/**
 * Surface-agnostic chat hook: wraps AI SDK `useChat` + `DefaultChatTransport`,
 * parameterized by the route + a body builder. One transport wiring shared by the
 * project assistant and any other chat surface.
 * Pass `id`/`initialMessages` to resume a persisted thread (key the consumer by
 * `id` so it remounts cleanly per thread). With `org`, it also returns `setBaseRevision`,
 * which the caller uses to seed the base revision of a thread it created.
 */
export function useAgentChat({
	api,
	prepareBody,
	id,
	initialMessages,
	org,
	initialRevision,
}: UseAgentChatOptions) {
	// The base revision, read at request time (a Chat keeps its first transport for its life).
	const revisionRef = useRef<number | null>(initialRevision ?? null);
	// A new lineage (or a reload of the same one) starts from the revision it was loaded at.
	useEffect(() => {
		revisionRef.current = initialRevision ?? null;
	}, [id, initialRevision]);
	// The turn fields of the request in flight, so a refusal can say what it refused.
	const lastRequestRef = useRef<RefusedRequest | null>(null);

	const transport = useMemo(() => {
		/** `fetch` that turns a typed refusal body into a {@link TurnRefusedError}. */
		const turnFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const res = await fetch(input, init);
			if (res.ok) return res;
			const refusal = await readRefusal(res);
			if (refusal) throw new TurnRefusedError(refusal, res.status, lastRequestRef.current);
			return res;
		};
		return new DefaultChatTransport({
			api,
			...(org ? { fetch: turnFetch } : {}),
			prepareSendMessagesRequest: ({ messages, trigger, messageId }) => {
				const extra = prepareBody?.(messages) ?? {};
				if (!org) return { body: { messages, ...extra } };
				const turn = turnOf(messages, trigger, messageId, revisionRef.current ?? 0);
				lastRequestRef.current = { turn, last: messages.at(-1) };
				return { body: { messages, orgId: org(), turn, ...extra } };
			},
		});
	}, [api, prepareBody, org]);

	/** Seed the base revision (a thread the caller just created, or just reloaded). */
	const setBaseRevision = useCallback((revision: number | null) => {
		revisionRef.current = revision;
	}, []);

	const chat = useChat({
		transport,
		id,
		messages: initialMessages,
		// When a HITL tool call gets its client result (an approval card resolving), resume
		// the run automatically so the model continues from the outcome. Fires only when the
		// last step's tool calls are all complete — a normal text turn never triggers it.
		sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
		// The route reports the transcript's revision when it accepts a turn and when it stores
		// the answer; the next request carries it as its base revision.
		onData: (part) => {
			const parsed = turnRevisionPartSchema.safeParse(part);
			if (parsed.success) revisionRef.current = parsed.data.data.revision;
		},
	});
	return { ...chat, setBaseRevision };
}
