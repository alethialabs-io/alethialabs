// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The canvas right-click menu. What matters is that the menu tells the truth about what the store
// will actually do: Remove is off for a card the store refuses (`deletable: false`), Duplicate is
// not offered for a singleton kind that cannot have a second, and Add is off while a BYO-IaC source
// governs the environment. Plus the two behaviours that make the gesture honest — a removal goes
// through `removeNodes`, so it grows `past` and ⌘Z brings the node back, and opening a node's menu
// SELECTS that node, so the board agrees with the menu about what is being acted on.

import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The pane menu's Auto-arrange and Fit view need React Flow's viewport API, which only exists
// inside a provider. Mock the one hook rather than mounting a board (canvas-more-menu.test.tsx
// does the same).
vi.mock("@xyflow/react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@xyflow/react")>();
	return { ...actual, useReactFlow: () => ({ fitView: vi.fn() }) };
});

import {
	CanvasContextMenu,
	useCanvasContextMenu,
	type CanvasContextMenuState,
	type CanvasPointerEvent,
} from "@/components/design-project/canvas/canvas-context-menu";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import type {
	CanvasNode,
	NodeKind,
} from "@/components/design-project/canvas/graph/types";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";

/** A store node of `kind` on AWS. `deletable` is left off unless a test pins it. */
function makeNode<K extends NodeKind>(
	id: string,
	kind: K,
	deletable?: boolean,
): CanvasNode {
	return {
		id,
		type: kind,
		position: { x: 0, y: 0 },
		...(deletable === undefined ? {} : { deletable }),
		data: {
			kind,
			config: NODE_REGISTRY[kind].defaultData("aws"),
			cloud_identity_id: null,
			provider: "aws",
		},
	} as CanvasNode;
}

/** The project root every graph carries — never removable, and never drawn. */
function makeRoot(): CanvasNode {
	return makeNode(PROJECT_NODE_ID, "project", false);
}

/** Put a graph in the store with a clean history, so `past` growing means THIS action grew it. */
function seed(nodes: CanvasNode[]): void {
	useCanvasStore.setState({
		nodes,
		edges: [],
		past: [],
		future: [],
		selectedIds: [],
		card: null,
		baseline: [],
	});
}

/** Render the menu already open on `target`, at an arbitrary point. */
function renderMenu(
	target: CanvasContextMenuState["target"],
	opts?: { iacGoverned?: boolean; onAddService?: () => void },
) {
	return render(
		<CanvasContextMenu
			state={{ target, point: { x: 120, y: 80 } }}
			onClose={vi.fn()}
			iacGoverned={opts?.iacGoverned ?? false}
			onAddService={opts?.onAddService ?? vi.fn()}
		/>,
	);
}

/** A right-click event carrying only what the handlers read. */
function pointerEvent(
	overrides?: Partial<CanvasPointerEvent>,
): CanvasPointerEvent {
	return {
		clientX: 40,
		clientY: 60,
		target: null,
		preventDefault: vi.fn(),
		...overrides,
	};
}

beforeEach(() => {
	// `reset()` leaves the view prefs alone (they are not design state), so clear the two this
	// file writes — otherwise one test's Hide is the next test's starting condition.
	useCanvasStore.getState().reset();
	useCanvasStore.setState({ hiddenKinds: [], showConnections: true });
});

describe("CanvasContextMenu — node", () => {
	it("disables Remove for a node the store refuses to delete", async () => {
		const user = userEvent.setup();
		seed([makeRoot(), makeNode("chart-1", "chart", false)]);
		renderMenu({ kind: "node", nodeId: "chart-1" });

		const remove = await screen.findByRole("menuitem", { name: /remove/i });
		expect(remove).toHaveAttribute("data-disabled");

		await user.click(remove);
		expect(useCanvasStore.getState().nodes).toHaveLength(2);
	});

	it("Remove shrinks the node set and grows the undo stack", async () => {
		const user = userEvent.setup();
		seed([makeRoot(), makeNode("db-1", "database")]);
		renderMenu({ kind: "node", nodeId: "db-1" });

		await user.click(await screen.findByRole("menuitem", { name: /remove/i }));

		const state = useCanvasStore.getState();
		expect(state.nodes.map((n) => n.id)).toEqual([PROJECT_NODE_ID]);
		// The undo step is the point: React Flow's own delete path left no history, so ⌘Z after a
		// right-click Remove used to do nothing.
		expect(state.past).toHaveLength(1);
		expect(state.past[0].map((n) => n.id)).toEqual([PROJECT_NODE_ID, "db-1"]);
	});

	it("offers Duplicate only for an array kind", async () => {
		seed([makeRoot(), makeNode("dns-1", "dns")]);
		const singleton = renderMenu({ kind: "node", nodeId: "dns-1" });
		await screen.findByRole("menu");
		expect(
			screen.queryByRole("menuitem", { name: /duplicate/i }),
		).not.toBeInTheDocument();
		singleton.unmount();

		seed([makeRoot(), makeNode("db-1", "database")]);
		renderMenu({ kind: "node", nodeId: "db-1" });
		expect(
			await screen.findByRole("menuitem", { name: /duplicate/i }),
		).toBeInTheDocument();
	});

	it("Configure opens the node's inspector card", async () => {
		const user = userEvent.setup();
		seed([makeRoot(), makeNode("db-1", "database")]);
		renderMenu({ kind: "node", nodeId: "db-1" });

		await user.click(await screen.findByRole("menuitem", { name: /configure/i }));
		expect(useCanvasStore.getState().card).toEqual({
			kind: "inspector",
			nodeId: "db-1",
		});
	});

	it("Hide names the kind and hides it", async () => {
		const user = userEvent.setup();
		seed([makeRoot(), makeNode("db-1", "database")]);
		renderMenu({ kind: "node", nodeId: "db-1" });

		await user.click(await screen.findByRole("menuitem", { name: /hide database/i }));
		expect(useCanvasStore.getState().hiddenKinds).toContain("database");
	});
});

describe("CanvasContextMenu — pane", () => {
	it("disables Add service while a BYO-IaC source governs the environment", async () => {
		const user = userEvent.setup();
		const onAddService = vi.fn();
		renderMenu({ kind: "pane" }, { iacGoverned: true, onAddService });

		const add = await screen.findByRole("menuitem", { name: /add service/i });
		expect(add).toHaveAttribute("data-disabled");
		await user.click(add);
		expect(onAddService).not.toHaveBeenCalled();
	});

	it("opens the Add palette when the design is the source of truth", async () => {
		const user = userEvent.setup();
		const onAddService = vi.fn();
		renderMenu({ kind: "pane" }, { iacGoverned: false, onAddService });

		const add = await screen.findByRole("menuitem", { name: /add service/i });
		expect(add).not.toHaveAttribute("data-disabled");
		await user.click(add);
		expect(onAddService).toHaveBeenCalledTimes(1);
	});

	it("offers no Paste — there is no clipboard model to back one", async () => {
		renderMenu({ kind: "pane" });
		await screen.findByRole("menu");
		expect(
			screen.queryByRole("menuitem", { name: /paste/i }),
		).not.toBeInTheDocument();
	});

	it("Show connections toggles the board's view state", async () => {
		const user = userEvent.setup();
		useCanvasStore.setState({ showConnections: true });
		renderMenu({ kind: "pane" });

		await user.click(
			await screen.findByRole("menuitemcheckbox", { name: /show connections/i }),
		);
		expect(useCanvasStore.getState().showConnections).toBe(false);
	});
});

describe("useCanvasContextMenu", () => {
	it("opening a node's menu selects that node", () => {
		seed([makeRoot(), makeNode("db-1", "database"), makeNode("db-2", "database")]);
		const { result } = renderHook(() => useCanvasContextMenu());
		const preventDefault = vi.fn();

		act(() => {
			result.current.onNodeContextMenu(pointerEvent({ preventDefault }), {
				id: "db-2",
			});
		});

		expect(useCanvasStore.getState().selectedIds).toEqual(["db-2"]);
		expect(result.current.state).toEqual({
			target: { kind: "node", nodeId: "db-2" },
			point: { x: 40, y: 60 },
		});
		// The browser's own menu would otherwise open over ours: React Flow suppresses the native
		// contextmenu on the pane only, never on a card.
		expect(preventDefault).toHaveBeenCalledTimes(1);
	});

	it("a second right-click replaces the open menu rather than stacking one", () => {
		seed([makeRoot(), makeNode("db-1", "database")]);
		const { result } = renderHook(() => useCanvasContextMenu());

		act(() => {
			result.current.onNodeContextMenu(pointerEvent(), { id: "db-1" });
		});
		act(() => {
			result.current.onPaneContextMenu(
				pointerEvent({ clientX: 10, clientY: 12 }),
			);
		});

		expect(result.current.state).toEqual({
			target: { kind: "pane" },
			point: { x: 10, y: 12 },
		});

		act(() => result.current.close());
		expect(result.current.state).toBeNull();
	});

	it("ignores a pane right-click that landed on a card", () => {
		// React Flow's pane handler fires from d3-zoom's pan-END for a right-press anywhere over the
		// renderer, and a non-draggable node carries no `nopan` to stop it — so the pane menu would
		// otherwise open on top of the node menu.
		const card = document.createElement("div");
		card.className = "react-flow__node";
		document.body.appendChild(card);

		const { result } = renderHook(() => useCanvasContextMenu());
		act(() => {
			result.current.onPaneContextMenu(pointerEvent({ target: card }));
		});
		expect(result.current.state).toBeNull();

		card.remove();
	});

	it("a selection right-click carries the whole set", () => {
		const { result } = renderHook(() => useCanvasContextMenu());
		act(() => {
			result.current.onSelectionContextMenu(pointerEvent(), [
				{ id: "db-1" },
				{ id: "db-2" },
			]);
		});
		expect(result.current.state?.target).toEqual({
			kind: "selection",
			ids: ["db-1", "db-2"],
		});
	});
});

describe("CanvasContextMenu — selection", () => {
	it("Remove takes the whole selection through the store", async () => {
		const user = userEvent.setup();
		seed([
			makeRoot(),
			makeNode("db-1", "database"),
			makeNode("db-2", "database"),
		]);
		renderMenu({ kind: "selection", ids: ["db-1", "db-2"] });

		await user.click(await screen.findByRole("menuitem", { name: /remove/i }));
		expect(useCanvasStore.getState().nodes.map((n) => n.id)).toEqual([
			PROJECT_NODE_ID,
		]);
		expect(useCanvasStore.getState().past).toHaveLength(1);
	});

	it("disables Duplicate when nothing in the set can be cloned", async () => {
		seed([makeRoot(), makeNode("dns-1", "dns")]);
		renderMenu({ kind: "selection", ids: ["dns-1"] });

		expect(
			await screen.findByRole("menuitem", { name: /duplicate/i }),
		).toHaveAttribute("data-disabled");
	});
});
