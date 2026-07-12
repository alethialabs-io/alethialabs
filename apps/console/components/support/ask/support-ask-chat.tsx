"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ToolUIPart } from "ai";
import { useCallback } from "react";
import { AgentChat } from "@/components/agent/agent-chat";
import { ToolResultFrame } from "@/components/agent/tool-result-frame";
import { useAgentChat } from "@/components/agent/use-agent-chat";
import { SupportCaseApprovalCard } from "@/components/support/ask/support-case-approval-card";
import { createSupportCaseInputSchema } from "@/lib/ai/support/case";

/** Starter prompts for the empty state — a spread of ask/diagnose/escalate. */
const SUGGESTIONS = [
	"How do I connect an AWS account?",
	"Why did my cluster provision fail?",
	"Open a billing case",
];

/**
 * The Ask-AI support surface — a thin reuse of the shared `AgentChat` + `useAgentChat`
 * stack pointed at `/api/support/ask` with the support persona. The read tools render
 * as the default tool cards; a `create_support_case` proposal renders the HITL
 * `SupportCaseApprovalCard`, which calls `submitCase` on approval and links to the case.
 */
export function SupportAskChat({ orgSlug }: { orgSlug: string }) {
	const { messages, sendMessage, status, error, regenerate, stop, addToolResult } =
		useAgentChat({
			api: "/api/support/ask",
		});

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
		/>
	);
}
