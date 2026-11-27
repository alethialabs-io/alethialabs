// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The project assistant's design-proposal card (`propose_changes`). The tool tells the model the
// user can "accept or dismiss" a proposal; the card used to offer only Accept, so a declined
// proposal never reached the model. Dismiss must feed `{ status: "dismissed" }` back and leave the
// canvas alone; Accept still applies; a stored output (a reloaded thread) is not offered again.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ToolUIPart } from "ai";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const applyProposal = vi.fn();
vi.mock("@/components/design-project/canvas/ai/apply-proposal", () => ({
	applyProposal: (p: unknown) => applyProposal(p),
}));
vi.mock("@/components/design-project/canvas/ai/proposal-diff", () => ({
	ProposalDiff: () => null,
}));

import {
	type ProposalDecision,
	projectRenderToolPart,
} from "@/components/agent/render-tool-parts/project-tool-parts";

const INPUT = {
	label: "Add a Redis cache",
	actions: [{ kind: "add_node", nodeKind: "cache", config: { name: "cache", engine: "redis" } }],
};

/** A `propose_changes` part in the given state, with an output when one is passed. */
function proposalPart(output?: unknown): ToolUIPart {
	const base = { type: "tool-propose_changes" as const, toolCallId: "call-1", input: INPUT };
	return output === undefined
		? { ...base, state: "input-available" }
		: { ...base, state: "output-available", output };
}

/** Render the card the way ElenchConversation does, with a real decisions map. */
function renderCard(part: ToolUIPart, addToolResult = vi.fn()): { addToolResult: typeof addToolResult } {
	let decisions: Record<string, ProposalDecision> = {};
	const view = (): ReactNode =>
		projectRenderToolPart({
			decisions,
			setDecisions: (updater) => {
				decisions = updater(decisions);
				rerender(<>{view()}</>);
			},
			addToolResult,
			openArtifact: vi.fn(),
			openGrid: vi.fn(),
		})(part, { messageId: "msg-1", index: 0 });
	const { rerender } = render(<>{view()}</>);
	return { addToolResult };
}

describe("project assistant · propose_changes card", () => {
	beforeEach(() => applyProposal.mockClear());

	it("Dismiss feeds a dismissed outcome back and never touches the canvas", async () => {
		const { addToolResult } = renderCard(proposalPart());
		await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(applyProposal).not.toHaveBeenCalled();
		expect(addToolResult).toHaveBeenCalledWith({
			tool: "propose_changes",
			toolCallId: "call-1",
			output: { status: "dismissed" },
		});
		expect(screen.queryByRole("button", { name: /accept/i })).toBeNull();
		expect(screen.getByText("Dismissed")).toBeTruthy();
	});

	it("Accept applies the proposal and feeds the accepted outcome back", async () => {
		const { addToolResult } = renderCard(proposalPart());
		await userEvent.click(screen.getByRole("button", { name: /accept/i }));
		expect(applyProposal).toHaveBeenCalledTimes(1);
		expect(addToolResult).toHaveBeenCalledWith(
			expect.objectContaining({ output: { status: "accepted", label: INPUT.label } }),
		);
		expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
	});

	it("a stored decision (a reloaded thread) is shown, not offered again", () => {
		renderCard(proposalPart({ status: "dismissed" }));
		expect(screen.getByText("Dismissed")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /accept/i })).toBeNull();
		expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
	});
});
