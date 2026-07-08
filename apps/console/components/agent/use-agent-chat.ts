"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useChat } from "@ai-sdk/react";
import {
	DefaultChatTransport,
	lastAssistantMessageIsCompleteWithToolCalls,
	type UIMessage,
} from "ai";
import { useMemo } from "react";

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
}

/**
 * Surface-agnostic chat hook: wraps AI SDK `useChat` + `DefaultChatTransport`,
 * parameterized by the route + a body builder. One transport wiring shared by the
 * project assistant and any other chat surface.
 * Pass `id`/`initialMessages` to resume a persisted thread (key the consumer by
 * `id` so it remounts cleanly per thread).
 */
export function useAgentChat({
	api,
	prepareBody,
	id,
	initialMessages,
}: UseAgentChatOptions) {
	const transport = useMemo(
		() =>
			new DefaultChatTransport({
				api,
				prepareSendMessagesRequest: ({ messages }) => ({
					body: { messages, ...(prepareBody?.(messages) ?? {}) },
				}),
			}),
		[api, prepareBody],
	);

	return useChat({
		transport,
		id,
		messages: initialMessages,
		// When a HITL tool call gets its client result (an approval card resolving), resume
		// the run automatically so the model continues from the outcome. Fires only when the
		// last step's tool calls are all complete — a normal text turn never triggers it.
		sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
	});
}
