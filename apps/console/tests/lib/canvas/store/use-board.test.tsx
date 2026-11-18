// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The board's read hooks (#6764), rendered: what each returns, and — the reason the store was
// split — which of them a drag leaves alone.

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import { board } from "@/lib/canvas/store/board";
import {
	CanvasStoreProvider,
	useBoard,
	useBoardScope,
	useIdentities,
} from "@/lib/canvas/store/canvas-store-provider";
import {
	nodeIndex,
	useBoardEdges,
	useBoardNodes,
	useCanRedo,
	useCanUndo,
	useDesignNodes,
	useFieldChanges,
	useFieldFocus,
	useInspectorTab,
	useIsDirty,
	useNode,
	useOperations,
	usePendingChanges,
	usePlanReview,
	usePositions,
	useSeedSlot,
	useSelection,
	useSubject,
} from "@/lib/canvas/store/use-board";
import {
	addonNode,
	databaseNode,
	projectNode,
	serviceNode,
} from "@/tests/fixtures/canvas/nodes";

const SCOPE = "proj-1:env-a";
const DATABASE = "database-orders";
const IDENTITIES = [{ id: "ident-aws", name: "prod", displayId: "1111", provider: "aws" }];
const OTHERS: CanvasNode[] = [addonNode("grafana")];
const NO_OTHERS: CanvasNode[] = [];

/** Everything under the provider the workbench mounts. */
function wrapper({ children }: { children: ReactNode }) {
	return (
		<CanvasStoreProvider scope={SCOPE} identities={IDENTITIES}>
			{children}
		</CanvasStoreProvider>
	);
}

/** One finished move of the seeded database. */
function moveDatabase() {
	board.onNodesChange(
		[{ id: DATABASE, type: "position", position: { x: 500, y: 500 }, dragging: false }],
		NO_OTHERS,
	);
}

beforeEach(() => {
	sessionStorage.clear();
	board.reset();
	board.reseed(
		{
			nodes: [
				projectNode(),
				databaseNode("orders"),
				serviceNode("api", [{ target: { kind: "database", name: "orders" }, inject: [] }]),
			],
		},
		{ scope: SCOPE, revision: "r1" },
	);
});

describe("the provider", () => {
	it("publishes the board, its scope and the identity list the page read", () => {
		const { result } = renderHook(
			() => ({ board: useBoard(), scope: useBoardScope(), identities: useIdentities() }),
			{ wrapper },
		);
		expect(result.current.board).toBe(board);
		expect(result.current.scope).toBe(SCOPE);
		expect(result.current.identities).toBe(IDENTITIES);
	});

	it("outside a workbench there is a board, no scope and no identities", () => {
		const { result } = renderHook(() => ({
			board: useBoard(),
			scope: useBoardScope(),
			identities: useIdentities(),
		}));
		expect(result.current.board).toBe(board);
		expect(result.current.scope).toBeNull();
		expect(result.current.identities).toEqual([]);
	});
});

describe("what a drag leaves alone", () => {
	it("the design nodes, the edges and the pending changes are the same objects after a move", () => {
		const { result } = renderHook(
			() => ({
				design: useDesignNodes(),
				edges: useBoardEdges(NO_OTHERS),
				pending: usePendingChanges(),
				fields: useFieldChanges(),
				node: useNode(DATABASE),
			}),
			{ wrapper },
		);
		const before = result.current;

		act(() => moveDatabase());

		expect(result.current.design).toBe(before.design);
		expect(result.current.edges).toBe(before.edges);
		expect(result.current.pending).toBe(before.pending);
		expect(result.current.fields).toBe(before.fields);
		expect(result.current.node).toBe(before.node);
	});

	it("the positions and the board's nodes do move", () => {
		const { result } = renderHook(
			() => ({ positions: usePositions(), nodes: useBoardNodes(NO_OTHERS) }),
			{ wrapper },
		);
		act(() => moveDatabase());
		expect(result.current.positions[DATABASE]).toEqual({ x: 500, y: 500 });
		expect(result.current.nodes.find((n) => n.id === DATABASE)?.position).toEqual({ x: 500, y: 500 });
	});
});

describe("the board as a component reads it", () => {
	it("joins the design with the cards beside it, and derives the binding edge", () => {
		const { result } = renderHook(
			() => ({ nodes: useBoardNodes(OTHERS), edges: useBoardEdges(OTHERS) }),
			{ wrapper },
		);
		expect(result.current.nodes.map((n) => n.id)).toEqual([
			"project-root",
			DATABASE,
			"service-api",
			"addon-grafana",
		]);
		expect(result.current.edges.map((e) => e.id)).toEqual(["bind:service-api->database-orders"]);
	});

	it("reports what is pending, field by field, and that the draft is dirty", () => {
		const { result } = renderHook(
			() => ({ pending: usePendingChanges(), fields: useFieldChanges(), dirty: useIsDirty() }),
			{ wrapper },
		);
		expect(result.current.dirty).toBe(false);

		act(() => board.document.getState().updateNodeConfig(DATABASE, { port: 6543 }));

		expect(result.current.pending.map((c) => `${c.op}:${c.id}`)).toEqual([`modified:${DATABASE}`]);
		expect(result.current.fields.map((f) => [f.field, f.before, f.after])).toEqual([["port", 5432, 6543]]);
		expect(result.current.dirty).toBe(true);
	});

	it("a staged operation makes the draft dirty with no design change", () => {
		const { result } = renderHook(() => ({ dirty: useIsDirty(), operations: useOperations() }), {
			wrapper,
		});
		act(() =>
			board.document.getState().stageOperation({
				id: "addon:grafana",
				target: "addon",
				verb: "install",
				targetId: "grafana",
				summary: "install 8.1.2",
				input: {},
			}),
		);
		expect(result.current.operations).toHaveLength(1);
		expect(result.current.dirty).toBe(true);
	});

	it("says whether there is a step to undo or redo", () => {
		const { result } = renderHook(() => ({ undo: useCanUndo(), redo: useCanRedo() }), { wrapper });
		expect(result.current).toEqual({ undo: false, redo: false });
		act(() => board.document.getState().updateNodeConfig(DATABASE, { port: 6543 }));
		expect(result.current).toEqual({ undo: true, redo: false });
		act(() => board.undo(NO_OTHERS));
		expect(result.current).toEqual({ undo: false, redo: true });
	});

	it("reads the inspector's subject, tab and focus, and the selection", () => {
		const { result } = renderHook(
			() => ({
				subject: useSubject(),
				tab: useInspectorTab(),
				focus: useFieldFocus(),
				selection: useSelection(),
			}),
			{ wrapper },
		);
		expect(result.current.subject).toBeNull();

		act(() => {
			board.view.getState().focusField(DATABASE, "port");
			board.view.getState().setSelection([DATABASE]);
		});

		expect(result.current).toEqual({
			subject: { kind: "node", id: DATABASE },
			tab: "configure",
			focus: { nodeId: DATABASE, path: "port" },
			selection: [DATABASE],
		});
	});

	it("shows a wizard hand-off while it waits in the slot", () => {
		const { result } = renderHook(() => useSeedSlot(), { wrapper });
		expect(result.current).toBeNull();
		act(() => {
			board.document.getState().offerSeed("v1.blank", { kind: "blank" });
		});
		expect(result.current).toEqual({ kind: "blank" });
		act(() => {
			board.document.getState().consumeSeed(() => undefined);
		});
		expect(result.current).toBeNull();
	});
});

describe("the plan in front of a deploy", () => {
	it("offers Deploy only for a plan that is current, and withdraws it on an edit", () => {
		const { result } = renderHook(() => usePlanReview(), { wrapper });
		expect(result.current.state).toBe("none");
		expect(result.current.gate.allowed).toBe(false);

		act(() => board.document.getState().recordReviewedPlan("plan-1"));
		expect(result.current.state).toBe("current");
		expect(result.current.gate).toEqual({ allowed: true, reason: "ok", planJobId: "plan-1" });

		act(() => board.document.getState().updateNodeConfig(DATABASE, { port: 6543 }));
		expect(result.current.state).toBe("stale");
		expect(result.current.gate.allowed).toBe(false);
	});

	it("takes the server's word that a plan is no longer current", () => {
		act(() => board.document.getState().recordReviewedPlan("plan-1"));
		const { result } = renderHook(() => usePlanReview(false), { wrapper });
		expect(result.current.gate).toEqual({ allowed: false, reason: "stale-plan", planJobId: null });
	});
});

describe("nodeIndex", () => {
	it("indexes a list once", () => {
		const list = [projectNode(), databaseNode("orders")];
		expect(nodeIndex(list)).toBe(nodeIndex(list));
		expect(nodeIndex(list).get(DATABASE)?.id).toBe(DATABASE);
	});
});
