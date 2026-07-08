// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Playwright SSE-stub for the Elench streaming routes. The console's chat surface talks to
// /api/agent (org) and /api/projects/[id]/assistant (project) via the AI SDK v6
// DefaultChatTransport, which parses a UI-message `text/event-stream` — each event a
// `data: ${JSON.stringify(chunk)}\n\n` line, terminated by `data: [DONE]\n\n`, under the
// `x-vercel-ai-ui-message-stream: v1` header (see node_modules/ai json-to-sse-transform-stream
// + ui-message-stream-headers). This lets the AI-off e2e stack exercise streamed text, the
// generative-dashboard tool part, and the HITL approval flow WITHOUT a live model/key.

import type { Page, Route } from "@playwright/test";
import type { DashboardSpec } from "../../types/jsonb.types";

/** A single UI-message-stream chunk (the AI SDK `uiMessageChunkSchema` union at runtime). */
type UIChunk = Record<string, unknown>;

/** The headers the AI SDK sets on a UI-message stream response. */
const UI_MESSAGE_STREAM_HEADERS = {
	"content-type": "text/event-stream",
	"cache-control": "no-cache",
	connection: "keep-alive",
	"x-vercel-ai-ui-message-stream": "v1",
} as const;

/** Serialize chunks into the AI SDK SSE framing (data-only lines + a [DONE] terminator). */
function toSse(chunks: UIChunk[]): string {
	const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
	return `${body}data: [DONE]\n\n`;
}

/**
 * A short assistant text turn followed by a completed `build_dashboard` tool part whose input
 * and output are the given DashboardSpec — what the model emits after it has fetched metrics
 * and rendered a dashboard. Drives the DashboardReadyCard ("Dashboard ready" / "Open dashboard").
 */
export function textThenDashboardChunks(
	text: string,
	spec: DashboardSpec,
): UIChunk[] {
	const toolCallId = "call-dashboard-1";
	return [
		{ type: "start", messageId: "assistant-1" },
		{ type: "start-step" },
		{ type: "text-start", id: "t1" },
		{ type: "text-delta", id: "t1", delta: text },
		{ type: "text-end", id: "t1" },
		{
			type: "tool-input-available",
			toolCallId,
			toolName: "build_dashboard",
			input: spec,
		},
		{ type: "tool-output-available", toolCallId, output: spec },
		{ type: "finish-step" },
		{ type: "finish", finishReason: "tool-calls" },
	];
}

/**
 * A HITL `propose_operation` tool part left at `input-available` (no output) — the model's turn
 * pauses on the proposal for client approval, which is exactly the state that renders the
 * ApprovalCard. Approving it feeds the outcome back via addToolResult → a follow-up request.
 */
export function proposeOperationChunks(input: {
	label: string;
	operation:
		| { operation: "plan_project"; projectId: string }
		| { operation: "provision_project"; projectId: string; planJobId?: string };
	stats?: { add?: number; change?: number; destroy?: number; monthly?: number };
}): UIChunk[] {
	return [
		{ type: "start", messageId: "assistant-1" },
		{ type: "start-step" },
		{
			type: "tool-input-available",
			toolCallId: "call-op-1",
			toolName: "propose_operation",
			input,
		},
		{ type: "finish-step" },
		{ type: "finish", finishReason: "tool-calls" },
	];
}

/** A trivial no-op assistant turn — used for the addToolResult follow-up request. */
function ackChunks(): UIChunk[] {
	return [
		{ type: "start", messageId: "assistant-ack" },
		{ type: "start-step" },
		{ type: "text-start", id: "ack" },
		{ type: "text-delta", id: "ack", delta: "Done." },
		{ type: "text-end", id: "ack" },
		{ type: "finish-step" },
		{ type: "finish", finishReason: "stop" },
	];
}

/** True for the Elench streaming routes (org + project assistant). */
function isAgentRoute(url: string): boolean {
	return /\/api\/agent(\?|$)/.test(url) || /\/api\/projects\/[^/]+\/assistant(\?|$)/.test(url);
}

/** A handle over the stubbed route so specs can assert follow-up (addToolResult) requests. */
export interface AgentStreamStub {
	/** How many times the streaming route has been hit. */
	callCount(): number;
}

/**
 * Intercept the Elench streaming routes and fulfill the FIRST request with `firstChunks`; any
 * subsequent request (the addToolResult follow-up that resumes the run after a HITL approval)
 * gets a trivial acknowledgement turn. Returns a handle exposing the route call count.
 */
export async function stubAgentStream(
	page: Page,
	firstChunks: UIChunk[],
): Promise<AgentStreamStub> {
	let calls = 0;
	await page.route(
		(url) => isAgentRoute(url.toString()),
		async (route: Route) => {
			calls += 1;
			const chunks = calls === 1 ? firstChunks : ackChunks();
			await route.fulfill({
				status: 200,
				headers: { ...UI_MESSAGE_STREAM_HEADERS },
				body: toSse(chunks),
			});
		},
	);
	return { callCount: () => calls };
}
