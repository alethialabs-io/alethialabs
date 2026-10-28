// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6119 — the board never paints an empty canvas while its data is on the way (F009), and a board
// with nothing designed on it says what to do next (F037).
//
// F009: the store is seeded asynchronously (`switchDraftScope` restores a draft before the seed), so
// the board's first frames held no nodes — an empty dotted plane for seconds. Until the store holds
// THIS environment's design, the board shows the route's own skeleton over itself.
// F037: a blank project ("Cluster" preselected) draws nothing — the project, cluster and network are
// never cards — so it read as broken. It now shows the one next step: add a component.
//
// The board's pieces are stubs (as in canvas-deploy-destroy-refusal.test.tsx); what is real is
// `DesignProjectCanvas` and the canvas store, which is where "seeded" and "empty" are read.

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createContext, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tryProvisionProject = vi.fn();
const tryDestroyProject = vi.fn();
const applyStagedChanges = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();
const track = vi.fn();

vi.mock("@/app/server/actions/projects", () => ({
	createProject: vi.fn(),
	getDestroyTree: vi.fn(async () => ({ tree: [] })),
	tryDestroyProject: (...a: unknown[]) => tryDestroyProject(...a),
	tryProvisionProject: (...a: unknown[]) => tryProvisionProject(...a),
}));
vi.mock("@/app/server/actions/staged-changes", () => ({
	applyStagedChanges: (...a: unknown[]) => applyStagedChanges(...a),
	discardStagedChanges: vi.fn(),
}));
vi.mock("@/app/server/actions/resolve", () => ({
	resolveActiveEnvironmentId: vi.fn(async () => "env-1"),
}));
vi.mock("sonner", () => ({
	toast: {
		error: (...a: unknown[]) => toastError(...a),
		success: (...a: unknown[]) => toastSuccess(...a),
	},
}));
vi.mock("@/lib/analytics/track", () => ({ track: (...a: unknown[]) => track(...a) }));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
}));
// The board's out-of-band reads (charts, workloads, IaC source, environment status) are queries;
// none is this test's subject, so each answers "no data yet".
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
	useQuery: () => ({ data: undefined, error: null, refetch: vi.fn() }),
}));
vi.mock("@xyflow/react", () => ({
	ReactFlowProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
	useReactFlow: () => ({ fitView: vi.fn() }),
}));
vi.mock("motion/react", () => ({
	motion: { div: ({ children }: { children: ReactNode }) => <div>{children}</div> },
}));
// The graph → form step is graph-to-form's subject; a valid form is all Deploy needs to reach the
// server call under test.
vi.mock("@/lib/validations/project-form.schema", () => ({
	projectFormSchema: { safeParse: () => ({ success: true, data: {} }) },
}));
vi.mock("@/components/design-project/canvas/graph/graph-to-form", () => ({
	graphToForm: () => ({}),
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

// The board's pieces. The two that carry the handlers under test are buttons that call them the
// way the real components do: the bar's Deploy, and the settings card's Destroy (non-cascading).
vi.mock("@/components/design-project/canvas/pending-changes-bar", () => ({
	PendingChangesBar: ({ onDeploy }: { onDeploy: () => void }) => (
		<button type="button" onClick={onDeploy}>
			Deploy
		</button>
	),
}));
vi.mock("@/components/design-project/canvas/cards/workspace-rail", () => ({
	isRailOpen: () => false,
	WorkspaceRail: ({
		destroyEnvironment,
	}: {
		destroyEnvironment?: { destroy: (o: { cascade: boolean }) => Promise<void> };
	}) => (
		<button type="button" onClick={() => void destroyEnvironment?.destroy({ cascade: false })}>
			Destroy environment
		</button>
	),
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
vi.mock("@/components/design-project/canvas/node-palette", () => ({
	NodePalette: ({ open }: { open: boolean }) => (open ? <div data-testid="node-palette" /> : null),
}));
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
import { formToGraph } from "@/components/design-project/canvas/graph/form-to-graph";
import { buildDefaultFormValues } from "@/components/design-project/source-project";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";

/** The nodes `formToGraph` seeds for a design (the project, its cluster and network, and `databases`). */
function design(databases: ProjectFormData["databases"] = []) {
	const base = buildDefaultFormValues();
	return formToGraph({ ...base, databases }, []).nodes;
}

const ORDERS: ProjectFormData["databases"][number] = {
	name: "orders",
	engine_family: "postgres",
	min_capacity: 0.5,
	max_capacity: 4,
	port: 5432,
	iam_auth: false,
};

/** The canvas in edit mode, on one project's environment. */
function renderCanvas() {
	return render(
		<DesignProjectCanvas cloudIdentities={[]} projectId="proj-1" environmentId="env-1" projectName="shop" />,
	);
}

/** Seeds the store as the workbench does once THIS environment's design is in. */
function seed(nodes: ReturnType<typeof design>, scope = "proj-1:env-1") {
	useCanvasStore.getState().setGraph({ nodes });
	useCanvasStore.setState({ seed: { scope, revision: "r1" } });
}

beforeEach(() => {
	vi.clearAllMocks();
	useCanvasStore.getState().reset();
});

describe("the board before its design is in (F009)", () => {
	it("shows the skeleton, not an empty canvas, while the store holds no seed", () => {
		renderCanvas();
		expect(screen.getByRole("status", { name: /loading the board/i })).toBeInTheDocument();
		// And not the blank-board guide: an unseeded store is not an empty design.
		expect(screen.queryByText(/nothing designed yet/i)).not.toBeInTheDocument();
	});

	it("keeps the skeleton while the store holds ANOTHER environment's design", () => {
		seed(design([ORDERS]), "proj-1:env-other");
		renderCanvas();
		expect(screen.getByRole("status", { name: /loading the board/i })).toBeInTheDocument();
	});

	it("drops the skeleton the moment this environment's design is seeded", async () => {
		renderCanvas();
		act(() => seed(design([ORDERS])));
		expect(screen.queryByRole("status", { name: /loading the board/i })).not.toBeInTheDocument();
	});
});

describe("a blank board (F037)", () => {
	it("says nothing is designed yet, and its action opens the Add palette", async () => {
		seed(design());
		const user = userEvent.setup();
		renderCanvas();
		expect(screen.getByText(/nothing designed yet/i)).toBeInTheDocument();
		expect(screen.queryByTestId("node-palette")).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /add a component/i }));
		expect(screen.getByTestId("node-palette")).toBeInTheDocument();
	});

	it("does not show the guide once something is designed", () => {
		seed(design([ORDERS]));
		renderCanvas();
		expect(screen.queryByText(/nothing designed yet/i)).not.toBeInTheDocument();
	});
});
