"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ToolUIPart, UIMessage } from "ai";
import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AgentChat } from "@/components/agent/agent-chat";
import { ToolResultFrame } from "@/components/agent/tool-result-frame";
import { useAgentChat } from "@/components/agent/use-agent-chat";
import {
	askTranscriptAddress,
	clearAskTranscript,
	readAskTranscript,
	writeAskTranscript,
} from "@/components/support/ask/ask-transcript";
import { SupportCaseApprovalCard } from "@/components/support/ask/support-case-approval-card";
import { createSupportCaseInputSchema } from "@/lib/ai/support/case";
import type { DraftAddress } from "@/lib/wizard/draft";
import { Button } from "@repo/ui/button";

/** Starter prompts for the empty state — a spread of ask/diagnose/escalate. */
const SUGGESTIONS = [
	"How do I connect an AWS account?",
	"Why did my cluster provision fail?",
	"Open a billing case",
];

/** No-op subscription: whether the page has hydrated never changes after it first flips. */
function subscribeNever(): () => void {
	return () => {};
}

/**
 * True once the page has hydrated. The server and the hydrating render both read `false`, so the
 * kept conversation (which only the browser has) is never part of the server's markup.
 */
function useHydrated(): boolean {
	return useSyncExternalStore(
		subscribeNever,
		() => true,
		() => false,
	);
}

/**
 * The Ask-AI support surface — a thin reuse of the shared `AgentChat` + `useAgentChat`
 * stack pointed at `/api/support/ask` with the support persona. The read tools render
 * as the default tool cards; a `create_support_case` proposal renders the HITL
 * `SupportCaseApprovalCard`, which calls `submitCase` on approval and links to the case.
 *
 * The conversation is kept in the tab (`ask-transcript.ts`) for the signed-in viewer and this org,
 * so "View case" and Back return to it rather than to an empty page (G-10). "New conversation"
 * drops it. Without a viewer nothing is kept.
 */
export function SupportAskChat({ orgSlug, viewerId }: { orgSlug: string; viewerId?: string | null }) {
	const hydrated = useHydrated();
	// Bumped by "New conversation": a new key mounts a fresh chat that reads the now-empty store.
	const [generation, setGeneration] = useState(0);
	const address = useMemo(
		() => (viewerId ? askTranscriptAddress(viewerId, orgSlug) : null),
		[viewerId, orgSlug],
	);

	/** Drops the kept conversation and starts an empty one. */
	const startOver = useCallback(() => {
		if (address) clearAskTranscript(address);
		setGeneration((n) => n + 1);
	}, [address]);

	return (
		<SupportAskConversation
			key={`${hydrated ? "client" : "server"}:${generation}`}
			orgSlug={orgSlug}
			address={hydrated ? address : null}
			onStartOver={startOver}
		/>
	);
}

/**
 * One conversation: seeded once, when it mounts, from what the tab kept at `address`, and written
 * back whenever no answer is streaming — never per streamed token, and never a half-streamed answer.
 */
function SupportAskConversation({
	orgSlug,
	address,
	onStartOver,
}: {
	orgSlug: string;
	address: DraftAddress | null;
	onStartOver: () => void;
}) {
	const [initialMessages] = useState<UIMessage[]>(() =>
		address ? readAskTranscript(address, Date.now()) : [],
	);
	const { messages, sendMessage, status, error, regenerate, stop, addToolResult } =
		useAgentChat({
			api: "/api/support/ask",
			initialMessages,
		});

	// Keep the conversation whenever it is not mid-stream: after the user's message is added, after
	// an answer finishes or fails, and after an approval card records its outcome.
	useEffect(() => {
		if (address === null || status === "streaming") return;
		writeAskTranscript(address, messages, Date.now());
	}, [address, messages, status]);

	const onSend = useCallback(
		(text: string) => {
			void sendMessage({ text });
		},
		[sendMessage],
	);

	const renderToolPart = useCallback(
		(part: ToolUIPart) => {
			if (part.type === "tool-create_support_case") {
				if (part.state === "input-streaming")
					return <ToolResultFrame part={part} title="Support case" />;
				const parsed = createSupportCaseInputSchema.safeParse(part.input);
				if (!parsed.success) return null;
				return (
					<ToolResultFrame part={part} title="Support case">
						<SupportCaseApprovalCard
							proposal={{ id: part.toolCallId, ...parsed.data }}
							orgSlug={orgSlug}
							output={part.state === "output-available" ? part.output : undefined}
							onResolve={(output) =>
								addToolResult({
									tool: "create_support_case",
									toolCallId: part.toolCallId,
									output,
								})
							}
						/>
					</ToolResultFrame>
				);
			}
			// Everything else (read tools) falls back to the default framed result.
			return undefined;
		},
		[orgSlug, addToolResult],
	);

	const busy = status === "submitted" || status === "streaming";

	return (
		<AgentChat
			messages={messages}
			status={status}
			error={error}
			onSend={onSend}
			onRetry={() => void regenerate()}
			onStop={() => void stop()}
			suggestions={SUGGESTIONS}
			placeholder="Ask a question, or describe what's not working…"
			renderToolPart={renderToolPart}
			composerLeft={
				messages.length > 0 ? (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-7 gap-1.5 rounded-none text-ui-xs text-muted-foreground"
						disabled={busy}
						onClick={onStartOver}
					>
						<RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
						New conversation
					</Button>
				) : null
			}
		/>
	);
}
