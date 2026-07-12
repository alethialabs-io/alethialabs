// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The ToolResultFrame is the single labeled treatment every tool part renders inside —
// these tests pin its contract: a marker line naming the tool with a state label (shimmer
// while running), a live duration only for calls observed from start to finish, the
// detail/actions/children slots, and the collapsed generic params/result fallback.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ToolUIPart } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolResultFrame } from "@/components/agent/tool-result-frame";

/** Build a minimal list_jobs tool part in the given state. */
function part(state: ToolUIPart["state"]): ToolUIPart {
	switch (state) {
		case "output-available":
			return {
				type: "tool-list_jobs",
				toolCallId: "call-1",
				state,
				input: { limit: 5 },
				output: { jobs: [] },
			};
		case "output-error":
			return {
				type: "tool-list_jobs",
				toolCallId: "call-1",
				state,
				input: { limit: 5 },
				errorText: "boom",
			};
		case "input-available":
			return {
				type: "tool-list_jobs",
				toolCallId: "call-1",
				state,
				input: { limit: 5 },
			};
		default:
			return {
				type: "tool-list_jobs",
				toolCallId: "call-1",
				state: "input-streaming",
				input: undefined,
			};
	}
}

describe("ToolResultFrame", () => {
	it("labels a streaming call (Pending) with the tool name", () => {
		render(<ToolResultFrame part={part("input-streaming")} />);
		expect(screen.getByText("list_jobs")).toBeInTheDocument();
		expect(screen.getByText("Pending")).toBeInTheDocument();
	});

	it("labels a running call (Running)", () => {
		render(<ToolResultFrame part={part("input-available")} />);
		expect(screen.getByText("Running")).toBeInTheDocument();
	});

	it("labels a completed call and an errored call", () => {
		const { rerender } = render(<ToolResultFrame part={part("output-available")} />);
		expect(screen.getByText("Completed")).toBeInTheDocument();
		rerender(<ToolResultFrame part={part("output-error")} />);
		expect(screen.getByText("Error")).toBeInTheDocument();
	});

	it("shows a duration when observed from running to terminal, in seconds", () => {
		vi.useFakeTimers();
		const { rerender } = render(<ToolResultFrame part={part("input-available")} />);
		vi.advanceTimersByTime(3000);
		rerender(<ToolResultFrame part={part("output-available")} />);
		expect(screen.getByText("3s")).toBeInTheDocument();
		vi.useRealTimers();
	});

	it("omits the duration for a part that mounts already terminal (resumed transcript)", () => {
		render(<ToolResultFrame part={part("output-available")} />);
		expect(screen.queryByText(/^\d+s$/)).not.toBeInTheDocument();
	});

	it("renders the detail slot inline on the marker line", () => {
		render(<ToolResultFrame part={part("output-available")} detail="4 rows" />);
		expect(screen.getByText("4 rows")).toBeInTheDocument();
	});

	it("renders actions and a custom title", () => {
		render(
			<ToolResultFrame
				part={part("output-available")}
				title="Proposal"
				actions={<button type="button">Open in panel</button>}
			/>,
		);
		expect(screen.getByText("Proposal")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Open in panel" })).toBeInTheDocument();
	});

	it("renders a rich body without the generic collapsible", () => {
		render(
			<ToolResultFrame part={part("output-available")}>
				<table aria-label="jobs" />
			</ToolResultFrame>,
		);
		expect(screen.getByLabelText("jobs")).toBeInTheDocument();
		expect(screen.queryByLabelText(/show details/i)).not.toBeInTheDocument();
	});

	it("collapses the generic params/result body by default and opens on the chevron", async () => {
		const user = userEvent.setup();
		render(<ToolResultFrame part={part("output-available")} />);
		expect(screen.queryByText("Parameters")).not.toBeInTheDocument();
		await user.click(screen.getByLabelText(/show details/i));
		expect(screen.getByText("Parameters")).toBeInTheDocument();
		expect(screen.getByText("Result")).toBeInTheDocument();
	});

	it("surfaces the error text in the generic body", async () => {
		const user = userEvent.setup();
		render(<ToolResultFrame part={part("output-error")} />);
		await user.click(screen.getByLabelText(/show details/i));
		expect(screen.getByText("boom")).toBeInTheDocument();
	});
});
