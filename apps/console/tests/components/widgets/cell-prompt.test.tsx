// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Empty-cell prompt flow: clicking a blank cell opens the inline composer, Enter
// stages a cell-targeted chat request (the conversation dispatches it with the cell
// coordinates riding prepareBody), Esc cancels. Plus specFromWidgets normalization
// (saved dashboards anchor at row 0).

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { specFromWidgets } from "@/components/agent/widgets/artifact-controls";
import { CellPrompt } from "@/components/agent/widgets/cell-prompt";
import type { ThreadWidget } from "@/lib/db/schema";
import { useWidgetGridStore } from "@/lib/stores/use-widget-grid-store";

vi.mock("@/app/server/actions/widgets", () => ({
	listThreadWidgets: vi.fn(async () => []),
	pinWidget: vi.fn(),
	updateWidget: vi.fn(async () => {}),
	deleteWidget: vi.fn(async () => {}),
	refreshWidgetSource: vi.fn(async () => null),
}));
vi.mock("@/app/server/actions/artifacts", () => ({
	saveArtifact: vi.fn(),
	listArtifacts: vi.fn(async () => []),
	openArtifactOnGrid: vi.fn(async () => {}),
	syncArtifactWidgets: vi.fn(async () => {}),
}));

beforeEach(() => {
	useWidgetGridStore.setState({
		threadId: "t1",
		widgets: [],
		loading: false,
		pinned: new Set<string>(),
		cellPrompt: { x: 2, y: 1 },
		pendingCellRequest: null,
		pendingCellTarget: null,
	});
});

describe("CellPrompt", () => {
	it("submits on Enter — staging the cell-targeted request", async () => {
		const user = userEvent.setup();
		render(<CellPrompt cell={{ x: 2, y: 1 }} />);
		await user.type(
			screen.getByPlaceholderText("Describe what goes here…"),
			"running jobs{Enter}",
		);
		expect(useWidgetGridStore.getState().pendingCellRequest).toEqual({
			x: 2,
			y: 1,
			text: "running jobs",
		});
		expect(useWidgetGridStore.getState().cellPrompt).toBeNull();
	});

	it("cancels on Escape without staging anything", async () => {
		const user = userEvent.setup();
		render(<CellPrompt cell={{ x: 2, y: 1 }} />);
		await user.type(
			screen.getByPlaceholderText("Describe what goes here…"),
			"nevermind{Escape}",
		);
		expect(useWidgetGridStore.getState().pendingCellRequest).toBeNull();
		expect(useWidgetGridStore.getState().cellPrompt).toBeNull();
	});

	it("renders at the clicked cell", () => {
		render(<CellPrompt cell={{ x: 2, y: 1 }} />);
		const el = screen.getByTestId("cell-prompt");
		expect(el.style.gridColumn).toBe("3 / span 2");
		expect(el.style.gridRow).toBe("2 / span 1");
	});
});

describe("specFromWidgets", () => {
	it("normalizes positions to the selection's top row", () => {
		const base: Omit<ThreadWidget, "id" | "pos_x" | "pos_y"> = {
			thread_id: "t1",
			user_id: "u1",
			org_id: "u1",
			kind: "stat",
			title: "Clusters",
			source: null,
			data: { block: { kind: "stat", title: "Clusters", value: 3 } },
			colspan: 1,
			rowspan: 1,
			mode: "frozen",
			tool_call_id: null,
			artifact_id: null,
			refreshed_at: null,
			created_at: new Date(),
			updated_at: new Date(),
		};
		const spec = specFromWidgets([
			{ ...base, id: "a", pos_x: 1, pos_y: 3 },
			{ ...base, id: "b", pos_x: 0, pos_y: 5 },
		]);
		expect(spec.widgets.map((w) => w.position)).toEqual([
			{ x: 1, y: 0 },
			{ x: 0, y: 2 },
		]);
	});
});
