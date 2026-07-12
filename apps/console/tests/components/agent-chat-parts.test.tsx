// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Transcript part-rendering contract for AgentChat: EVERY tool part renders inside a
// ToolResultFrame (the unification invariant behind the "clobbered multi-tool turn" fix),
// orchestration `data-agent-step` parts render as separator markers (malformed data
// renders nothing), reasoning shimmer tracks the PART's stream state, and the scroller
// spacer reserves space only while a turn is in flight.

import { render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AgentChat } from "@/components/agent/agent-chat";
import { orgRenderToolPart } from "@/components/agent/render-tool-parts/org-tool-parts";

vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));

beforeAll(() => {
	// jsdom lacks Element.scrollTo — the message scroller calls it on content changes.
	Element.prototype.scrollTo ??= () => {};
});

/** A multi-part assistant turn: reasoning, step markers, and three tool treatments
 * (framed table, marker-only one-liner, unmapped generic fallback). */
function assistantTurn(): UIMessage[] {
	return [
		{ id: "u1", role: "user", parts: [{ type: "text", text: "status?" }] },
		{
			id: "a1",
			role: "assistant",
			parts: [
				{ type: "reasoning", text: "planning the reads", state: "done" },
				{
					type: "data-agent-step",
					id: "step-0",
					data: {
						step: 0,
						phase: "plan",
						model: "anthropic/claude-sonnet-4-6",
						label: "Claude Sonnet 4.6",
					},
				},
				{ type: "data-agent-step", id: "bad", data: { nope: true } },
				{
					type: "tool-list_jobs",
					toolCallId: "c1",
					state: "output-available",
					input: {},
					output: {
						jobs: [
							{ id: "j1", type: "PLAN", project: "api", provider: "aws", status: "done" },
						],
					},
				},
				{
					type: "tool-cidr_for_hosts",
					toolCallId: "c2",
					state: "output-available",
					input: { hosts: 511 },
					output: { cidr: "10.0.0.0/23", totalAddresses: 512 },
				},
				{
					type: "tool-get_org_usage",
					toolCallId: "c3",
					state: "output-available",
					input: {},
					output: { minutes_used: 0 },
				},
			],
		},
	];
}

/** Render AgentChat with the org tool lane and no-op deps. */
function renderChat(messages: UIMessage[], status: "streaming" | "ready" = "ready") {
	return render(
		<AgentChat
			messages={messages}
			status={status}
			onSend={() => {}}
			renderToolPart={orgRenderToolPart({
				openArtifact: vi.fn(),
				addToolResult: vi.fn(),
			})}
		/>,
	);
}

describe("AgentChat part rendering", () => {
	it("renders EVERY tool part inside a ToolResultFrame (unification invariant)", () => {
		const { container } = renderChat(assistantTurn());
		const frames = container.querySelectorAll('[data-slot="tool-result-frame"]');
		expect(frames).toHaveLength(3);
		// Each frame is labeled with its tool name — no bare, unattributed tables.
		expect(screen.getByText("list_jobs")).toBeInTheDocument();
		expect(screen.getByText("cidr_for_hosts")).toBeInTheDocument();
		expect(screen.getByText("get_org_usage")).toBeInTheDocument();
		// The table body still renders inside its frame.
		expect(screen.getByText("PLAN")).toBeInTheDocument();
		// The one-liner's value rides the marker line.
		expect(screen.getByText(/10\.0\.0\.0\/23/)).toBeInTheDocument();
	});

	it("renders a data-agent-step part as a separator marker; malformed data renders nothing", () => {
		const { container } = renderChat(assistantTurn());
		const markers = container.querySelectorAll('[data-variant="separator"]');
		expect(markers).toHaveLength(1);
		expect(screen.getByText(/plan · Claude Sonnet 4\.6/)).toBeInTheDocument();
	});

	it("does not shimmer a DONE reasoning part while the turn still streams", () => {
		renderChat(assistantTurn(), "streaming");
		// A done part shows the settled trigger copy, not the "Thinking..." shimmer.
		expect(screen.getByText("Thought for a few seconds")).toBeInTheDocument();
		expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
	});

	it("reserves scroller spacer space only while a turn is in flight", () => {
		const { container, rerender } = renderChat(assistantTurn(), "streaming");
		const spacer = container.querySelector("[data-message-scroller-spacer]");
		expect(spacer?.className).toContain("max-h-[100dvh]");
		rerender(
			<AgentChat messages={assistantTurn()} status="ready" onSend={() => {}} />,
		);
		expect(
			container.querySelector("[data-message-scroller-spacer]")?.className,
		).toContain("max-h-0");
	});
});
