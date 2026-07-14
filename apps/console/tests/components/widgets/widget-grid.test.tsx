// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Grid behavior tests: the store's pin path (first-fit placement, toolCallId dedupe,
// replace-don't-duplicate on returned rows) with the server actions mocked, and the
// WidgetGrid component's rendering contract (CSS-grid spans from position/size, the
// empty-state hint). Pointer drag math is exercised indirectly via the pure layout
// tests; keyboard move commit/revert is covered on the card.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WidgetGrid } from "@/components/agent/widgets/widget-grid";
import type { ThreadWidget } from "@/lib/db/schema";
import { useWidgetGridStore } from "@/lib/stores/use-widget-grid-store";

vi.mock("@/app/server/actions/widgets", () => ({
	listThreadWidgets: vi.fn(async () => []),
	pinWidget: vi.fn(),
	updateWidget: vi.fn(async () => {}),
	deleteWidget: vi.fn(async () => {}),
}));

import { pinWidget, updateWidget } from "@/app/server/actions/widgets";

/** A ThreadWidget row fixture. */
function widget(over: Partial<ThreadWidget>): ThreadWidget {
	const now = new Date();
	return {
		id: "w1",
		thread_id: "t1",
		user_id: "u1",
		org_id: "u1",
		kind: "stat",
		title: "Clusters",
		source: null,
		data: { block: { kind: "stat", title: "Clusters", value: 3 } },
		pos_x: 0,
		pos_y: 0,
		colspan: 1,
		rowspan: 1,
		mode: "frozen",
		tool_call_id: null,
		artifact_id: null,
		refreshed_at: null,
		created_at: now,
		updated_at: now,
		...over,
	};
}

/** Echo the pin input back as an inserted row. */
function mockPinEcho() {
	vi.mocked(pinWidget).mockImplementation(async (input) =>
		widget({
			id: `w-${input.toolCallId ?? Math.random().toString(36).slice(2)}`,
			thread_id: input.threadId,
			kind: input.kind,
			title: input.title,
			pos_x: input.posX,
			pos_y: input.posY,
			colspan: input.colspan,
			rowspan: input.rowspan,
			tool_call_id: input.toolCallId ?? null,
		}),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	useWidgetGridStore.setState({
		threadId: "t1",
		widgets: [],
		loading: false,
		pinned: new Set<string>(),
	});
});

describe("useWidgetGridStore.pin", () => {
	it("places at first-fit and appends the returned row", async () => {
		mockPinEcho();
		useWidgetGridStore.setState({
			widgets: [widget({ id: "w0", pos_x: 0, pos_y: 0, colspan: 2, rowspan: 1 })],
		});
		const landed = await useWidgetGridStore.getState().pin({
			threadId: "t1",
			kind: "stat",
			title: "Jobs",
			source: null,
			data: {},
			colspan: 1,
			rowspan: 1,
			mode: "frozen",
			toolCallId: "c1",
		});
		expect(landed).toBe(true);
		expect(vi.mocked(pinWidget)).toHaveBeenCalledWith(
			expect.objectContaining({ posX: 2, posY: 0 }),
		);
		expect(useWidgetGridStore.getState().widgets).toHaveLength(2);
	});

	it("dedupes by toolCallId — the second pin is a no-op", async () => {
		mockPinEcho();
		const input = {
			threadId: "t1",
			kind: "stat" as const,
			title: "Jobs",
			source: null,
			data: {},
			colspan: 1,
			rowspan: 1,
			mode: "frozen" as const,
			toolCallId: "c1",
		};
		expect(await useWidgetGridStore.getState().pin(input)).toBe(true);
		expect(await useWidgetGridStore.getState().pin(input)).toBe(false);
		expect(vi.mocked(pinWidget)).toHaveBeenCalledTimes(1);
	});

	it("replaces (not duplicates) when the server returns an existing row id", async () => {
		useWidgetGridStore.setState({ widgets: [widget({ id: "w0" })] });
		vi.mocked(pinWidget).mockResolvedValue(widget({ id: "w0", title: "Refreshed" }));
		await useWidgetGridStore.getState().pin({
			threadId: "t1",
			kind: "stat",
			title: "Refreshed",
			source: { tool: "list_jobs", args: null },
			data: {},
			colspan: 1,
			rowspan: 1,
			mode: "frozen",
			toolCallId: "c2",
		});
		const { widgets } = useWidgetGridStore.getState();
		expect(widgets).toHaveLength(1);
		expect(widgets[0]?.title).toBe("Refreshed");
	});

	it("ignores pins for a different thread", async () => {
		mockPinEcho();
		const landed = await useWidgetGridStore.getState().pin({
			threadId: "OTHER",
			kind: "stat",
			title: "x",
			source: null,
			data: {},
			colspan: 1,
			rowspan: 1,
			mode: "frozen",
		});
		expect(landed).toBe(false);
		expect(vi.mocked(pinWidget)).not.toHaveBeenCalled();
	});
});

describe("WidgetGrid", () => {
	it("shows the empty-state hint when nothing is pinned", () => {
		render(<WidgetGrid />);
		expect(screen.getByText("The grid is empty.")).toBeInTheDocument();
	});

	it("renders widgets with CSS-grid spans from their position/size", () => {
		useWidgetGridStore.setState({
			widgets: [
				widget({ id: "a", pos_x: 1, pos_y: 2, colspan: 3, rowspan: 2, title: "Spanning" }),
			],
		});
		render(<WidgetGrid />);
		const card = screen.getByRole("group", { name: "Spanning" });
		expect(card.style.gridColumn).toBe("2 / span 3");
		expect(card.style.gridRow).toBe("3 / span 2");
	});

	it("keyboard move: arrows step, Enter commits via updateWidget", async () => {
		const user = userEvent.setup();
		useWidgetGridStore.setState({
			widgets: [widget({ id: "a", pos_x: 0, pos_y: 0, title: "Movable" })],
		});
		render(<WidgetGrid />);
		// Enter keyboard-move mode from the focused grip (replaces the removed Move button).
		const grip = screen.getByRole("button", { name: /Move Movable/ });
		grip.focus();
		await user.keyboard("{Enter}{ArrowRight}{ArrowDown}{Enter}");
		expect(vi.mocked(updateWidget)).toHaveBeenCalledWith(
			expect.objectContaining({ id: "a", posX: 1, posY: 1 }),
		);
	});

	it("opens the cell composer at a free guide cell, sized to the free span", async () => {
		const user = userEvent.setup();
		useWidgetGridStore.setState({
			widgets: [
				widget({ id: "a", pos_x: 0, pos_y: 0, colspan: 2, rowspan: 1, title: "Wide" }),
			],
		});
		render(<WidgetGrid />);
		// (x=2, y=0) is free with two contiguous free columns to its right → span 2.
		await user.click(screen.getByLabelText("Add a widget at row 1, column 3"));
		expect(useWidgetGridStore.getState().cellPrompt).toEqual({ x: 2, y: 0, span: 2 });
		// Occupied cells never become click targets.
		expect(
			screen.queryByLabelText("Add a widget at row 1, column 1"),
		).not.toBeInTheDocument();
	});

	it("keyboard move: Escape reverts without persisting", async () => {
		const user = userEvent.setup();
		useWidgetGridStore.setState({
			widgets: [widget({ id: "a", pos_x: 0, pos_y: 0, title: "Movable" })],
		});
		render(<WidgetGrid />);
		const grip = screen.getByRole("button", { name: /Move Movable/ });
		grip.focus();
		await user.keyboard("{Enter}{ArrowRight}{Escape}");
		expect(vi.mocked(updateWidget)).not.toHaveBeenCalled();
		const card = screen.getByRole("group", { name: "Movable" });
		expect(card.style.gridColumn).toBe("1 / span 1");
	});
});
