// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The board's keyboard handler and a text field (#6762).
//
// The board binds single keys (`A`, `?`, Backspace) and chords (⌘Z) on `window`. A key pressed while
// the caret is in a text field belongs to that field. Each case below presses a key twice over: once
// on the board, where it must act, and once inside an input, where it must not — the board half is
// the control that proves the handler is mounted and listening, so "nothing happened" in the input
// half means something.
//
// One case is `it.fails`: ⌘Z inside an input runs the board's undo today.
//
// The board is other files' subject (React Flow, every card, the palettes), so each of its pieces is
// a stub, the same set `canvas-deploy-destroy-refusal.test.tsx` uses. What is real is
// `DesignProjectCanvas`'s own key handling, the shortcut sheet it owns, and the canvas store.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { createContext, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/server/actions/canvas-writes", () => ({
	createProjectFromDesignAction: vi.fn(),
	deployDesignAction: vi.fn(),
	destroyEnvironmentAction: vi.fn(),
	discardStagedDesignAction: vi.fn(),
	saveDesignAction: vi.fn(),
}));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc({}).orpc };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
}));
// The board's out-of-band reads (charts, workloads, IaC source, environment status) are queries;
// none is this test's subject, so each answers "no data yet".
vi.mock("@tanstack/react-query", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-query")>()),
	useQuery: () => ({ data: undefined, error: null, refetch: vi.fn() }),
}));
vi.mock("@xyflow/react", () => ({
	ReactFlowProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
	useReactFlow: () => ({ fitView: vi.fn() }),
}));
vi.mock("@/lib/canvas/environment-status-context", () => ({
	useEnvironmentStatus: () => ({ iac: null }),
	EnvironmentStatusProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/lib/query/use-addons-query", () => ({ useAddonsQuery: () => ({ data: undefined }) }));
vi.mock("@/lib/canvas/arrange", () => ({ arrangeBoard: vi.fn() }));
vi.mock("@/lib/stores/use-elench-store", () => ({
	useElenchStore: (pick: (s: { openPanel: () => void }) => unknown) => pick({ openPanel: vi.fn() }),
}));
vi.mock("@/lib/stores/use-workspace-store", () => ({ useActiveOrgSlug: () => "acme" }));

// The Add palette, reduced to whether the board has it open: `A` is the key that opens it.
vi.mock("@/components/design-project/canvas/node-palette", () => ({
	NodePalette: ({ open }: { open: boolean }) => (
		<div data-testid="add-palette">{open ? "open" : "closed"}</div>
	),
}));
vi.mock("@/components/design-project/canvas/pending-changes-bar", () => ({
	PendingChangesBar: () => null,
}));
vi.mock("@/components/design-project/canvas/cards/workspace-rail", () => ({
	isRailOpen: () => false,
	WorkspaceRail: () => null,
}));
vi.mock("@/components/design-project/canvas/canvas-flow", () => ({
	CanvasFlow: () => null,
	CanvasInteractionContext: createContext(null),
}));
vi.mock("@/components/design-project/canvas/canvas-context-menu", () => ({
	CanvasContextMenu: () => null,
	useCanvasContextMenu: () => ({
		state: null,
		close: vi.fn(),
		onPaneContextMenu: vi.fn(),
		onNodeContextMenu: vi.fn(),
		onSelectionContextMenu: vi.fn(),
	}),
}));
vi.mock("@/components/design-project/canvas/cards/card-param", () => ({
	useCardDeepLink: vi.fn(),
}));
vi.mock("@/components/design-project/canvas/use-drop-position", () => ({
	useDropPosition: () => null,
}));
vi.mock("@/components/design-project/canvas/use-has-drawn-nodes", () => ({
	useHasDrawnNodes: () => false,
}));
vi.mock("@/components/design-project/canvas/shortcuts", () => ({ buildShortcuts: () => [] }));
vi.mock("@/components/design-project/canvas/cards/activity-status-line", () => ({
	ActivityStatusLine: () => null,
}));
vi.mock("@/components/design-project/canvas/canvas-more-menu", () => ({ CanvasMoreMenu: () => null }));
vi.mock("@/components/design-project/canvas/cost-chip", () => ({ CostChip: () => null }));
vi.mock("@/components/design-project/canvas/run-menu", () => ({ RunMenu: () => null }));
vi.mock("@/components/design-project/canvas/canvas-command-palette", () => ({
	CanvasCommandPalette: () => null,
}));
vi.mock("@/components/design-project/canvas/canvas-controls", () => ({ CanvasControls: () => null }));
vi.mock("@/components/design-project/source-repos-card", () => ({ SourceReposCard: () => null }));
vi.mock("@/components/design-project/byo/byo-chart-dialog", () => ({ ByoChartDialog: () => null }));
vi.mock("@/components/design-project/byo/byo-iac-dialog", () => ({ ByoIacDialog: () => null }));
vi.mock("@/components/design-project/byo/iac-node", () => ({ IacNode: () => null }));
vi.mock("@/components/design-project/byo/byo-chart-canvas-context", () => ({
	ByoChartCanvasProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/design-project/byo/iac-source-canvas-context", () => ({
	IacSourceCanvasProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { DesignProjectCanvas } from "@/components/design-project/canvas/design-project-canvas";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

const SHORTCUT_SHEET = "Keyboard shortcuts";

/** The canvas in edit mode beside a text field that is not part of it. */
function renderBoardWithField() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<input aria-label="A text field" />
			<DesignProjectCanvas
				cloudIdentities={[]}
				projectId="proj-1"
				environmentId="env-1"
				projectName="shop"
			/>
		</QueryClientProvider>,
	);
	return screen.getByLabelText("A text field");
}

/** Every node id on the board. */
function ids(): string[] {
	return useCanvasStore.getState().nodes.map((n) => n.id);
}

/**
 * Put one card on the board through the store: it is selected, and adding it is one undo step.
 * Returns its id.
 */
function addSelectedCard(): string {
	return useCanvasStore.getState().addNode("bucket");
}

beforeEach(() => {
	vi.clearAllMocks();
	sessionStorage.clear();
	useCanvasStore.getState().reset();
});

describe("undo (⌘Z)", () => {
	it("on the board, undoes the last step", () => {
		const card = addSelectedCard();
		renderBoardWithField();
		expect(ids()).toContain(card);

		fireEvent.keyDown(document.body, { key: "z", metaKey: true });

		expect(ids()).not.toContain(card);
	});

	it.fails("in a text field, does not run the board's undo", () => {
		const card = addSelectedCard();
		const field = renderBoardWithField();

		fireEvent.keyDown(field, { key: "z", metaKey: true });

		expect(ids()).toContain(card);
	});
});

describe("add (A)", () => {
	it("on the board, opens the Add palette", () => {
		renderBoardWithField();
		expect(screen.getByTestId("add-palette")).toHaveTextContent("closed");

		fireEvent.keyDown(document.body, { key: "a" });

		expect(screen.getByTestId("add-palette")).toHaveTextContent("open");
	});

	it("in a text field, does nothing", () => {
		const field = renderBoardWithField();

		fireEvent.keyDown(field, { key: "a" });

		expect(screen.getByTestId("add-palette")).toHaveTextContent("closed");
	});
});

describe("remove (Backspace)", () => {
	it("on the board, removes the selected card", () => {
		const card = addSelectedCard();
		renderBoardWithField();
		expect(useCanvasStore.getState().selectedIds).toEqual([card]);

		fireEvent.keyDown(document.body, { key: "Backspace" });

		expect(ids()).not.toContain(card);
	});

	it("in a text field, does nothing", () => {
		const card = addSelectedCard();
		const field = renderBoardWithField();
		expect(useCanvasStore.getState().selectedIds).toEqual([card]);

		fireEvent.keyDown(field, { key: "Backspace" });

		expect(ids()).toContain(card);
	});
});

describe("the shortcut sheet (?)", () => {
	it("on the board, opens", async () => {
		renderBoardWithField();
		expect(screen.queryByText(SHORTCUT_SHEET)).toBeNull();

		fireEvent.keyDown(document.body, { key: "?" });

		expect(await screen.findByText(SHORTCUT_SHEET)).toBeInTheDocument();
	});

	it("in a text field, does nothing", () => {
		const field = renderBoardWithField();

		fireEvent.keyDown(field, { key: "?" });

		expect(screen.queryByText(SHORTCUT_SHEET)).toBeNull();
	});
});
