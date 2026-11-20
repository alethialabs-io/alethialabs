// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The board's one toolbar (#6832). What is asserted is what a person meets: which tools are on it
// and in what order, that each has a name, that a toggle says whether it is on, that a tool which
// cannot be used is still there and says why, and that the whole row can be walked by keyboard.
//
// The Run menu and the ⋯ menu are their own files with their own tests; here each is a button, so
// the row's order and its arrow keys include them without queueing a job or opening a menu.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const flow = vi.hoisted(() => ({ drawn: 1 }));

vi.mock("@xyflow/react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@xyflow/react")>();
	return {
		...actual,
		// The selector is the product's own; only the lookup it reads is the test's.
		useStore: <T,>(selector: (s: { nodeLookup: Map<string, unknown> }) => T): T =>
			selector({ nodeLookup: new Map(Array.from({ length: flow.drawn }, (_, i) => [`n${i}`, {}])) }),
	};
});
vi.mock("@/components/design-project/canvas/run-menu", () => ({
	RunMenu: () => (
		<button type="button" data-tool="">
			Run
		</button>
	),
}));
vi.mock("@/components/design-project/canvas/canvas-more-menu", () => ({
	CanvasMoreMenu: () => <button type="button" data-tool="" aria-label="More" />,
}));

import {
	CanvasToolbar,
	type CanvasToolbarProps,
} from "@/components/design-project/canvas/toolbar/canvas-toolbar";
import {
	CONNECT_NEEDS_SERVICE,
	GOVERNED_REASON,
	NO_ENVIRONMENT,
	NOTHING_TO_FIT_REASON,
	NOTHING_TO_REDO,
	NOTHING_TO_TIDY,
	NOTHING_TO_UNDO,
} from "@/components/design-project/canvas/toolbar/reasons";
import { NOTHING_TO_FIT } from "@/components/design-project/canvas/use-has-drawn-nodes";
import { board } from "@/lib/canvas/store/board";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

/** The toolbar's callbacks, as spies a test can read. */
function handlers() {
	return {
		onAdd: vi.fn(),
		onOpenPalette: vi.fn(),
		onShowShortcuts: vi.fn(),
		onUndo: vi.fn(),
		onRedo: vi.fn(),
		onTidy: vi.fn(),
		onFitView: vi.fn(),
		onToggleSources: vi.fn(),
	};
}

/** Renders the toolbar on a designed, ungoverned environment unless `overrides` says otherwise. */
function renderToolbar(overrides: Partial<CanvasToolbarProps> = {}) {
	const spies = handlers();
	const view = render(
		<CanvasToolbar
			projectId="proj-1"
			environmentId="env-1"
			governed={false}
			addOpen={false}
			paletteOpen={false}
			shortcutsOpen={false}
			hasSources={false}
			sourcesOpen={false}
			{...spies}
			{...overrides}
		/>,
	);
	return { ...view, spies };
}

/** The toolbar's tool with this accessible name. */
function tool(name: string): HTMLElement {
	return within(screen.getByRole("toolbar", { name: "Canvas tools" })).getByRole("button", { name });
}

/** The accessible names of the toolbar's buttons, in the order they are drawn. */
function toolNames(): string[] {
	return within(screen.getByRole("toolbar", { name: "Canvas tools" }))
		.getAllByRole("button")
		.map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "");
}

beforeEach(() => {
	flow.drawn = 1;
	useCanvasStore.getState().reset();
	board.view.getState().setHandTool(false);
});

describe("what is on the toolbar", () => {
	it("holds the tools in one row, in order: the environment, tools, add and connect, history, layout, run, the rest", () => {
		renderToolbar();
		expect(toolNames()).toEqual([
			"Environment",
			"Select",
			"Hand tool (pan)",
			"Add",
			"Connect the selected service",
			"Undo",
			"Redo",
			"Tidy layout",
			"Fit view",
			"Run",
			"Command palette",
			"Keyboard shortcuts",
			"More",
		]);
	});

	it("draws the Sources tool only on an environment that has sources, and says whether it is open", async () => {
		const user = userEvent.setup();
		const { spies, rerender } = renderToolbar();
		expect(toolNames()).not.toContain("Sources");

		rerender(
			<CanvasToolbar
				projectId="proj-1"
				environmentId="env-1"
				governed={false}
				addOpen={false}
				paletteOpen={false}
				shortcutsOpen={false}
				hasSources
				sourcesOpen
				{...spies}
			/>,
		);
		expect(tool("Sources")).toHaveAttribute("aria-expanded", "true");
		await user.click(tool("Sources"));
		expect(spies.onToggleSources).toHaveBeenCalledTimes(1);
	});

	it("names the key of each tool that has one, from the registry", () => {
		renderToolbar();
		// jsdom reports no platform, so the modifier is Control.
		const keys = Object.fromEntries(
			["Select", "Hand tool (pan)", "Add", "Command palette", "Fit view", "Keyboard shortcuts"].map(
				(name) => [name, tool(name).getAttribute("aria-keyshortcuts")],
			),
		);
		expect(keys).toEqual({
			Select: "V",
			"Hand tool (pan)": "H",
			Add: "A",
			"Command palette": "Control+K",
			"Fit view": "Shift+1",
			"Keyboard shortcuts": "?",
		});
	});
});

describe("the environment chip", () => {
	it("opens the environment on the rail: its settings, or its sources under a governing module", async () => {
		const user = userEvent.setup();
		const live = renderToolbar();
		await user.click(tool("Environment"));
		expect(board.view.getState().subject).toEqual({ kind: "environment" });
		expect(board.view.getState().tab).toBeNull();
		expect(useCanvasStore.getState().card).toEqual({ kind: "env-settings" });
		live.unmount();

		board.view.getState().setSubject(null);
		renderToolbar({ governed: true });
		await user.click(tool("Environment"));
		expect(board.view.getState().subject).toEqual({ kind: "environment" });
		expect(board.view.getState().tab).toBe("sources");
	});
});

describe("the select and hand tools", () => {
	it("are one choice: the one in use is pressed, and choosing the other moves it", async () => {
		const user = userEvent.setup();
		renderToolbar();
		expect(tool("Select")).toHaveAttribute("aria-pressed", "true");
		expect(tool("Hand tool (pan)")).toHaveAttribute("aria-pressed", "false");

		await user.click(tool("Hand tool (pan)"));
		expect(board.view.getState().handTool).toBe(true);
		expect(tool("Hand tool (pan)")).toHaveAttribute("aria-pressed", "true");
		expect(tool("Select")).toHaveAttribute("aria-pressed", "false");

		await user.click(tool("Select"));
		expect(board.view.getState().handTool).toBe(false);
	});
});

describe("a tool that cannot be used stays on the toolbar and says why", () => {
	it("Add opens the picker, and is off with the reason while an IaC module governs the environment", async () => {
		const user = userEvent.setup();
		const live = renderToolbar();
		await user.click(tool("Add"));
		expect(live.spies.onAdd).toHaveBeenCalledTimes(1);
		live.unmount();

		const governed = renderToolbar({ governed: true });
		expect(tool("Add")).toBeDisabled();
		expect(tool("Add")).toHaveAccessibleDescription(GOVERNED_REASON);
		await user.click(tool("Add"));
		expect(governed.spies.onAdd).not.toHaveBeenCalled();
	});

	it("Undo and Redo are off with nothing to undo or redo, and live once there is", async () => {
		const user = userEvent.setup();
		const { spies } = renderToolbar();
		expect(tool("Undo")).toBeDisabled();
		expect(tool("Undo")).toHaveAccessibleDescription(NOTHING_TO_UNDO);
		expect(tool("Redo")).toHaveAccessibleDescription(NOTHING_TO_REDO);

		useCanvasStore.getState().addNode("bucket");
		expect(await screen.findByRole("button", { name: "Undo" })).toBeEnabled();
		await user.click(tool("Undo"));
		expect(spies.onUndo).toHaveBeenCalledTimes(1);
	});

	it("Tidy and Fit are off on a board that draws nothing, with the reason every fit control gives", () => {
		flow.drawn = 0;
		renderToolbar();
		expect(tool("Tidy layout")).toHaveAccessibleDescription(NOTHING_TO_TIDY);
		expect(tool("Fit view")).toBeDisabled();
		expect(tool("Fit view")).toHaveAccessibleDescription(NOTHING_TO_FIT);
		// The toolbar's copy of that sentence and the one the other fit controls read are the same.
		expect(NOTHING_TO_FIT_REASON).toBe(NOTHING_TO_FIT);
	});

	it("Run is off, with the reason, when the page has no environment", () => {
		renderToolbar({ environmentId: undefined });
		expect(tool("Run")).toBeDisabled();
		expect(tool("Run")).toHaveAccessibleDescription(NO_ENVIRONMENT);
	});

	it("Connect needs exactly one selected service, and then opens that service's connections", async () => {
		const user = userEvent.setup();
		renderToolbar();
		expect(tool("Connect the selected service")).toBeDisabled();
		expect(tool("Connect the selected service")).toHaveAccessibleDescription(CONNECT_NEEDS_SERVICE);

		// A bucket is selected: still not a service.
		useCanvasStore.getState().addNode("bucket");
		expect(tool("Connect the selected service")).toBeDisabled();

		// Adding a card selects it.
		const service = useCanvasStore.getState().addNode("service");
		const connect = await screen.findByRole("button", { name: "Connect the selected service" });
		expect(connect).toBeEnabled();
		board.view.getState().setSubject(null);

		await user.click(connect);
		expect(board.view.getState().subject).toEqual({ kind: "node", id: service });
		expect(board.view.getState().tab).toBe("connections");
	});
});

describe("the toolbar by keyboard", () => {
	it("moves along the row with the arrow keys, onto disabled tools too, and wraps", async () => {
		const user = userEvent.setup();
		renderToolbar();
		tool("Select").focus();

		await user.keyboard("{ArrowRight}");
		expect(tool("Hand tool (pan)")).toHaveFocus();
		await user.keyboard("{ArrowRight}");
		expect(tool("Add")).toHaveFocus();
		// Connect is off (nothing is selected): the focus lands on what holds its reason.
		await user.keyboard("{ArrowRight}");
		expect(document.activeElement).toContainElement(tool("Connect the selected service"));
		expect(document.activeElement).toHaveAttribute("data-slot", "disabled-reason");

		await user.keyboard("{End}");
		expect(tool("More")).toHaveFocus();
		await user.keyboard("{ArrowRight}");
		expect(tool("Environment")).toHaveFocus();
		await user.keyboard("{ArrowLeft}");
		expect(tool("More")).toHaveFocus();
		await user.keyboard("{Home}");
		expect(tool("Environment")).toHaveFocus();
	});

	it("leaves a key pressed outside the row alone", async () => {
		const user = userEvent.setup();
		render(
			<>
				<button type="button">Outside</button>
				<CanvasToolbar
					projectId="proj-1"
					environmentId="env-1"
					governed={false}
					addOpen={false}
					paletteOpen={false}
					shortcutsOpen={false}
					hasSources={false}
					sourcesOpen={false}
					{...handlers()}
				/>
			</>,
		);
		screen.getByRole("button", { name: "Outside" }).focus();
		await user.keyboard("{ArrowRight}");
		expect(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
	});
});
