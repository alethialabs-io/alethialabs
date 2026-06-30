"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useMemo } from "react";

/** Builds the surface-specific extra body for a request (canvas snapshot, threadId, …). */
export type PrepareBody = (messages: UIMessage[]) => Record<string, unknown>;

export interface UseAgentChatOptions {
	/** Streaming route this surface talks to (e.g. /api/agent, /api/design-project/ask-ai). */
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
 * parameterized by the route + a body builder. Generalizes the canvas `useAskAi`
 * so the Agent page and the canvas Ask AI sheet share one transport wiring.
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

	return useChat({ transport, id, messages: initialMessages });
}
