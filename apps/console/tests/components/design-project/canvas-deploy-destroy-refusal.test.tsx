// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5445 — the canvas's Deploy and Destroy show the server's refusal sentence.
//
// Deploy (the pending-changes bar) and Destroy (the environment settings card on the workspace rail)
// called `provisionProject` / `destroyProject`, which refused by THROWING out of a `"use server"`
// export — and a production build reduced the sentence to a digest. Canvas Deploy is the commonest
// place a user meets the no-cloud-account gate. Both now call the `try*` forms, which RETURN
// `{ ok: false, error }`.
//
// The board is other files' subject (React Flow, every card, the palettes), so each of its pieces is
// a stub. What is real is `DesignProjectCanvas`'s own `handleDeploy` / `handleDestroyEnvironment` and
// the canvas store, which is where "the baseline is NOT committed when nothing deployed" is read.

import { render, screen } from "@testing-library/react";
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
vi.mock("@/app/server/actions/byo-charts", () => ({
	getProjectByoCharts: vi.fn(async () => ({ charts: [] })),
	getProjectChartWorkloads: vi.fn(async () => ({ workloads: [] })),
}));
vi.mock("@/app/server/actions/byo-iac", () => ({ getIacSource: vi.fn(async () => null) }));
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
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
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
vi.mock("@/components/design-project/canvas/node-palette", () => ({ NodePalette: () => null }));
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

const NO_ACCOUNT = "Connect a cloud account for this project before deploying.";
const TENANTS = "This cluster still hosts 2 environments — destroy them first, or cascade.";

/** The canvas in edit mode, on one project's environment. */
function renderCanvas() {
	return render(
		<DesignProjectCanvas
			cloudIdentities={[]}
			projectId="proj-1"
			environmentId="env-1"
			projectName="shop"
		/>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	useCanvasStore.getState().reset();
	applyStagedChanges.mockResolvedValue(undefined);
});

describe("Canvas Deploy", () => {
	it("shows the refusal's own sentence and leaves the changes pending — nothing deployed", async () => {
		tryProvisionProject.mockResolvedValue({ ok: false, error: NO_ACCOUNT });
		useCanvasStore.setState({ dirty: true });
		const user = userEvent.setup();
		renderCanvas();

		await user.click(screen.getByRole("button", { name: "Deploy" }));

		await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith(NO_ACCOUNT));
		expect(tryProvisionProject).toHaveBeenCalledWith("proj-1", undefined, undefined, "env-1");
		// The design was saved before the deploy was asked for; only the deploy was refused.
		expect(applyStagedChanges).toHaveBeenCalledTimes(1);
		expect(useCanvasStore.getState().dirty).toBe(true);
		expect(toastSuccess).not.toHaveBeenCalled();
		expect(track).not.toHaveBeenCalled();
		// The button is usable again: `deploying` was released by the `finally`.
		expect(screen.getByRole("button", { name: "Deploy" })).toBeEnabled();
	});

	it("commits the baseline and says so when the deploy is queued", async () => {
		tryProvisionProject.mockResolvedValue({ ok: true, jobId: "job-1" });
		useCanvasStore.setState({ dirty: true });
		const user = userEvent.setup();
		renderCanvas();

		await user.click(screen.getByRole("button", { name: "Deploy" }));

		await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Deploy queued"));
		expect(useCanvasStore.getState().dirty).toBe(false);
		expect(track).toHaveBeenCalledWith("deploy_queued", { environmentId: "env-1" });
		expect(toastError).not.toHaveBeenCalled();
	});
});

describe("Canvas Destroy", () => {
	it("shows the refusal's own sentence and reports nothing queued", async () => {
		tryDestroyProject.mockResolvedValue({ ok: false, error: TENANTS });
		const user = userEvent.setup();
		renderCanvas();

		await user.click(screen.getByRole("button", { name: "Destroy environment" }));

		await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith(TENANTS));
		expect(tryDestroyProject).toHaveBeenCalledWith("proj-1", "env-1", null, { cascade: false });
		expect(toastSuccess).not.toHaveBeenCalled();
	});

	it("says how many environments were queued when it is accepted", async () => {
		tryDestroyProject.mockResolvedValue({ ok: true, jobs: [{ jobId: "a" }, { jobId: "b" }] });
		const user = userEvent.setup();
		renderCanvas();

		await user.click(screen.getByRole("button", { name: "Destroy environment" }));

		await vi.waitFor(() =>
			expect(toastSuccess).toHaveBeenCalledWith("Destroy queued for 2 environments"),
		);
		expect(toastError).not.toHaveBeenCalled();
	});
});
