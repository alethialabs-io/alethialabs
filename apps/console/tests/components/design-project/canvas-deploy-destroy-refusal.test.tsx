// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5445 — the canvas's Destroy and Save show the server's refusal sentence; #6833 — the board's host
// has no Deploy of its own.
//
// DEPLOY (#6833, decision M23). The host used to hand the changes bar a deploy handler that saved and
// provisioned in one press, with no plan in between. That path is gone: a deploy is offered only in
// the review view, behind `usePlanReview(serverCurrent).gate` (review-view.test.tsx pins that). What
// this file pins is the absence: the host passes the bar no deploy handler and never calls
// `deployDesignAction`, whatever is pressed. The history below is kept because the Destroy half of it
// still holds.
//
// Deploy (the pending-changes bar) and Destroy (the environment settings card on the workspace rail)
// called `provisionProject` / `destroyProject`, which refused by THROWING out of a `"use server"`
// export — and a production build reduced the sentence to a digest. Canvas Deploy is the commonest
// place a user meets the no-cloud-account gate. Both now call the `try*` forms, which RETURN
// `{ ok: false, error }`.
//
// #6119: both are on the mutation contract. The board calls `deployDesignAction` /
// `destroyEnvironmentAction` (app/server/actions/canvas-writes.ts) through `useActionMutation`; a
// refusal arrives as a `conflict` whose sentence is toasted verbatim. The server half — the design is
// saved BEFORE the deploy is asked for, so a refused deploy leaves it saved — is pinned in
// tests/actions/canvas-writes.test.ts.
//
// The board is other files' subject (React Flow, every card, the palettes), so each of its pieces is
// a stub. What is real is `DesignProjectCanvas`'s own `handleSaveDesign` / `handleDestroyEnvironment`,
// the mutation contract, and the canvas store, which is where "the baseline is NOT committed when
// nothing was saved" is read.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createContext, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deployDesign = vi.fn();
const saveDesign = vi.fn();
const destroyEnvironment = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();
const track = vi.fn();

vi.mock("@/app/server/actions/canvas-writes", () => ({
	createProjectFromDesignAction: vi.fn(),
	deployDesignAction: (...a: unknown[]) => deployDesign(...a),
	destroyEnvironmentAction: (...a: unknown[]) => destroyEnvironment(...a),
	discardStagedDesignAction: vi.fn(),
	saveDesignAction: (...a: unknown[]) => saveDesign(...a),
}));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc({}).orpc };
});
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
// none is this test's subject, so each answers "no data yet". The mutations are real.
vi.mock("@tanstack/react-query", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-query")>()),
	useQuery: () => ({ data: undefined, error: null, refetch: vi.fn() }),
}));
vi.mock("@xyflow/react", () => ({
	ReactFlowProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
	useReactFlow: () => ({ fitView: vi.fn() }),
}));
// The graph → form step is graph-to-form's subject; a valid form is all Deploy needs to reach the
// server call under test.
vi.mock("@/lib/validations/project-form.schema", () => ({
	projectFormSchema: { safeParse: () => ({ success: true, data: {} }) },
	designSaveSchema: { safeParse: () => ({ success: true, data: { project: {} } }) },
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
// way the real components do: the bar's Save, and the settings card's Destroy (non-cascading). The
// bar also records the names of the props it was given, so the absence of a deploy handler can be
// asserted rather than assumed.
const barProps: { names: string[] } = { names: [] };
vi.mock("@/components/design-project/canvas/pending-changes-bar", () => ({
	PendingChangesBar: (props: { onSave?: () => void }) => {
		barProps.names = Object.keys(props);
		return (
			<button type="button" onClick={props.onSave}>
				Save
			</button>
		);
	},
}));
vi.mock("@/components/design-project/canvas/cards/workspace-rail", () => ({
	isRailOpen: () => false,
	WorkspaceRail: ({
		destroyEnvironment,
	}: {
		destroyEnvironment?: {
			destroy: (o: { cascade: boolean; environmentId: string }) => Promise<void>;
		};
	}) => (
		// The real dialog hands over the environment its destroy tree named (TREE_ENV), which is NOT
		// necessarily the board's own environment id.
		<button
			type="button"
			onClick={() => void destroyEnvironment?.destroy({ cascade: false, environmentId: TREE_ENV })}
		>
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
import { DESTROY_HOLD_KEY } from "@/lib/query/topics";
import { board } from "@/lib/canvas/store/board";
import { isBoardDirty } from "@/tests/fixtures/canvas/board";

/** The environment the destroy tree named — what the dialog hands the destroy. */
const TREE_ENV = "env-from-tree";
const NO_ACCOUNT = "Connect a cloud account for this project before deploying.";
const TENANTS = "This cluster still hosts 2 environments — destroy them first, or cascade.";

/** The canvas in edit mode, on one project's environment. */
function renderCanvas(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
	return render(
		<QueryClientProvider client={client}>
			<DesignProjectCanvas
				cloudIdentities={[]}
				projectId="proj-1"
				environmentId="env-1"
				projectName="shop"
			/>
		</QueryClientProvider>,
	);
}

/** A refusal, as the action answers it. */
const refused = (message: string) => ({ ok: false, error: { kind: "conflict", message } });

beforeEach(() => {
	vi.clearAllMocks();
	board.reset();
});

describe("Canvas Deploy", () => {
	it("is not the host's: the bar is handed no deploy handler", () => {
		renderCanvas();
		expect(barProps.names.filter((name) => /deploy/i.test(name))).toEqual([]);
	});

	it("is never asked for from the host, whatever is pressed", async () => {
		saveDesign.mockResolvedValue({ ok: true, data: { environmentId: "env-1" } });
		const user = userEvent.setup();
		renderCanvas();

		for (const button of screen.getAllByRole("button")) await user.click(button);

		expect(deployDesign).not.toHaveBeenCalled();
		expect(track).not.toHaveBeenCalled();
	});
});

describe("Canvas Save", () => {
	it("shows the refusal's own sentence and leaves the changes pending — nothing saved", async () => {
		saveDesign.mockResolvedValue(refused(NO_ACCOUNT));
		// A change is pending: the save has something to save.
		board.addNode("bucket");
		const user = userEvent.setup();
		renderCanvas();

		await user.click(screen.getByRole("button", { name: "Save" }));

		await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith(NO_ACCOUNT));
		expect(saveDesign).toHaveBeenCalledWith({
			projectId: "proj-1",
			environmentId: "env-1",
			design: { project: {} },
		});
		expect(isBoardDirty()).toBe(true);
		expect(toastSuccess).not.toHaveBeenCalled();
		// The button is usable again: the mutation settled.
		expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
	});

	it("commits the baseline and says so when the design is saved", async () => {
		saveDesign.mockResolvedValue({ ok: true, data: { environmentId: "env-1" } });
		// A change is pending: the save has something to save.
		board.addNode("bucket");
		const user = userEvent.setup();
		renderCanvas();

		await user.click(screen.getByRole("button", { name: "Save" }));

		await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Design saved"));
		expect(isBoardDirty()).toBe(false);
		expect(toastError).not.toHaveBeenCalled();
	});
});

describe("Canvas Destroy", () => {
	it("shows the refusal's own sentence and reports nothing queued", async () => {
		destroyEnvironment.mockResolvedValue(refused(TENANTS));
		const user = userEvent.setup();
		renderCanvas();

		await user.click(screen.getByRole("button", { name: "Destroy environment" }));

		await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith(TENANTS));
		expect(destroyEnvironment).toHaveBeenCalledWith({
			projectId: "proj-1",
			environmentId: TREE_ENV,
			cascade: false,
		});
		expect(toastSuccess).not.toHaveBeenCalled();
	});

	it("says how many environments were queued when it is accepted", async () => {
		destroyEnvironment.mockResolvedValue({ ok: true, data: { environmentId: TREE_ENV, queued: 2 } });
		const user = userEvent.setup();
		renderCanvas();

		await user.click(screen.getByRole("button", { name: "Destroy environment" }));

		await vi.waitFor(() =>
			expect(toastSuccess).toHaveBeenCalledWith("Destroy queued for 2 environments"),
		);
		expect(toastError).not.toHaveBeenCalled();
	});

	it("invalidates every read that shows the destroyed environment, and nothing else", async () => {
		destroyEnvironment.mockResolvedValue({ ok: true, data: { environmentId: TREE_ENV, queued: 1 } });
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const shown = [
			[["canvas", "environmentStatus"], { input: {}, type: "query" }],
			[["canvas", "environmentJobs"], { input: {}, type: "query" }],
			[["environments", "overview"], { input: {}, type: "query" }],
			[["workspace", "environments"], { input: {}, type: "query" }],
			[...DESTROY_HOLD_KEY, "job-1"],
		];
		const unrelated = [["canvas", "addons"], { input: {}, type: "query" }];
		for (const key of [...shown, unrelated]) client.setQueryData(key, {});
		const user = userEvent.setup();
		renderCanvas(client);

		await user.click(screen.getByRole("button", { name: "Destroy environment" }));

		await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Destroy queued"));
		expect(shown.filter((key) => !client.getQueryState(key)?.isInvalidated)).toEqual([]);
		expect(client.getQueryState(unrelated)?.isInvalidated).toBe(false);
	});
});

describe("the double-submit guard", () => {
	it("asks for one save however often Save is pressed while it is in flight", async () => {
		let settle: (v: unknown) => void = () => {};
		saveDesign.mockReturnValue(new Promise((resolve) => (settle = resolve)));
		const user = userEvent.setup();
		renderCanvas();

		await user.click(screen.getByRole("button", { name: "Save" }));
		await user.click(screen.getByRole("button", { name: "Save" }));
		await user.click(screen.getByRole("button", { name: "Save" }));

		expect(saveDesign).toHaveBeenCalledTimes(1);
		settle({ ok: true, data: { environmentId: "env-1" } });
		await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Design saved"));
	});
});
