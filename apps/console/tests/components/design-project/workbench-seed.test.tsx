// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// "They don't hold their state." The workbench's seed effect was keyed on the IDENTITY of its
// `sourceProject` prop, and a server component hands it a new object on every re-render — so a
// revalidate, a sibling mutation or an env poll re-ran `setGraph`, closed the open card and
// discarded every unsaved edit. It is now keyed on [project, environment, content revision], and
// each project:environment persists its draft in its own sessionStorage slot. These drive the
// component the way the page does — re-render with new props — and read the board of the
// environment on screen (`boardFor(scope)`: each project:environment has its own board).

import { act, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import type { SourceProjectData } from "@/components/design-project/source-project";
import { buildDefaultFormValues } from "@/components/design-project/source-project";
import { draftScope } from "@/lib/canvas/design-revision";
import { boardFor } from "@/lib/canvas/store/board";
import { draftStorageKey } from "@/lib/canvas/store/draft-persist";
import { boardCard, boardNodes, isBoardDirty } from "@/tests/fixtures/canvas/board";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";

// The board itself is another lane's concern and drags in xyflow + every card; the seed effect
// lives in the workbench, so a stub is all the board needs to be.
vi.mock("@/components/design-project/canvas/design-project-canvas", () => ({
	DesignProjectCanvas: () => <div data-testid="canvas" />,
}));
// The board's stand-in while it loads (#6348) reads the page's prefetched queries; this file renders
// no query client and is not about it (board-preview.test.tsx is), so it is a stub here.
vi.mock("@/components/design-project/canvas/board-preview", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/design-project/canvas/board-preview")>()),
	BoardPreview: () => null,
}));
// RepositoryProvider calls server actions on mount (git providers + repos); not under test.
vi.mock("@/components/design-project/repository-context", () => ({
	RepositoryProvider: ({ children }: { children: ReactNode }) => children,
	useRepositoryContext: () => null,
}));

const { DesignProjectWorkbench } = await import(
	"@/components/design-project/design-project-workbench"
);

const IDENTITIES: CloudIdentityOption[] = [];
const ORDERS: ProjectFormData["databases"][number] = {
	name: "orders",
	engine_family: "postgres",
	min_capacity: 0.5,
	max_capacity: 4,
	port: 5432,
	iam_auth: false,
};

/** A server design as `getProjectAsFormData` returns it — a NEW object every call. */
function serverDesign(databases: ProjectFormData["databases"] = [ORDERS]): SourceProjectData {
	const base = buildDefaultFormValues();
	return {
		formData: {
			...base,
			project: { ...base.project, project_name: "shop", region: "eu-west-1" },
			databases,
		},
		provider: "aws",
	};
}

/** The environment on screen: the scope the last `seeded` waited for. */
let onScreen = "proj-1:env-a";

/** The board of the environment on screen. */
function current() {
	return boardFor(onScreen);
}

/** The document of the environment on screen. */
function doc() {
	return current().document.getState();
}

/** The port the `database-orders` node currently holds on the board on screen. */
function ordersPort(): unknown {
	const node = boardNodes(current()).find((n) => n.id === "database-orders");
	return node && "port" in node.data.config ? node.data.config.port : undefined;
}

/** Ids of the nodes on the board on screen, in order. */
function nodeIds(): string[] {
	return boardNodes(current()).map((n) => n.id);
}

/** Wait for the async seed (open the scope's draft slot → reseed) to land for `scope`. */
async function seeded(scope: string) {
	onScreen = scope;
	await waitFor(() => expect(boardFor(scope).document.getState().seed?.scope).toBe(scope));
}

function Workbench({
	source,
	environmentId = "env-a",
	projectId = "proj-1",
}: {
	source?: SourceProjectData;
	environmentId?: string;
	projectId?: string;
}) {
	return (
		<DesignProjectWorkbench
			cloudIdentities={IDENTITIES}
			sourceProject={source}
			projectId={projectId}
			environmentId={environmentId}
		/>
	);
}

beforeEach(() => {
	// Reset first: a board writes every change to its draft slot, so the slots are cleared after.
	for (const scope of ["proj-1:env-a", "proj-1:env-b"]) boardFor(scope).reset();
	sessionStorage.clear();
	onScreen = "proj-1:env-a";
});

describe("DesignProjectWorkbench seeding", () => {
	it("seeds the graph from the server design under the project:environment scope", async () => {
		render(<Workbench source={serverDesign()} />);
		await seeded("proj-1:env-a");
		expect(nodeIds()).toContain("database-orders");
		expect(isBoardDirty(current())).toBe(false);
		expect(sessionStorage.getItem(draftStorageKey("proj-1:env-a"))).not.toBeNull();
	});

	it("the board it seeds is that environment's own, not the board outside a workbench", async () => {
		render(<Workbench source={serverDesign()} environmentId="env-a" />);
		await seeded("proj-1:env-a");
		expect(boardFor("proj-1:env-b").document.getState().seed).toBeNull();
		expect(boardNodes(boardFor("proj-1:env-b")).map((n) => n.id)).not.toContain(
			"database-orders",
		);
	});

	it("an identical-content re-render is not a re-seed: the open card and the edit survive", async () => {
		const { rerender } = render(<Workbench source={serverDesign()} />);
		await seeded("proj-1:env-a");

		act(() => {
			current().view.getState().openInspector("database-orders");
			doc().updateNodeConfig("database-orders", { port: 6543 });
		});
		const draft = doc().designNodes;

		// The page re-rendered: same design, NEW object (and a new identities array too).
		await act(async () => {
			rerender(<Workbench source={serverDesign()} />);
		});
		await act(async () => {
			rerender(<Workbench source={serverDesign()} />);
		});

		expect(doc().designNodes).toBe(draft);
		expect(ordersPort()).toBe(6543);
		expect(boardCard(current())).toEqual({ kind: "inspector", nodeId: "database-orders" });
		expect(isBoardDirty(current())).toBe(true);
	});

	it("a changed design while the draft is dirty moves the baseline only and keeps the draft", async () => {
		const { rerender } = render(<Workbench source={serverDesign()} />);
		await seeded("proj-1:env-a");
		const firstRevision = doc().seed?.revision;

		act(() => {
			current().view.getState().openInspector("database-orders");
			doc().updateNodeConfig("database-orders", { port: 6543 });
		});
		const draft = doc().designNodes;

		// The server design moved: someone added a table.
		await act(async () => {
			rerender(<Workbench source={serverDesign([ORDERS, { ...ORDERS, name: "audit" }])} />);
		});
		await waitFor(() =>
			expect(doc().seed?.revision).not.toBe(firstRevision),
		);

		expect(doc().designNodes).toBe(draft);
		expect(ordersPort()).toBe(6543);
		expect(boardCard(current())).toEqual({ kind: "inspector", nodeId: "database-orders" });
		expect(doc().baseline.map((n) => n.id)).toContain("database-audit");
		expect(nodeIds()).not.toContain("database-audit");
	});

	it("a changed design on a clean draft replaces the graph and keeps the card on a surviving node", async () => {
		const { rerender } = render(<Workbench source={serverDesign()} />);
		await seeded("proj-1:env-a");
		act(() => current().view.getState().openInspector("database-orders"));

		await act(async () => {
			rerender(<Workbench source={serverDesign([ORDERS, { ...ORDERS, name: "audit" }])} />);
		});
		await waitFor(() => expect(nodeIds()).toContain("database-audit"));

		expect(boardCard(current())).toEqual({ kind: "inspector", nodeId: "database-orders" });
		expect(isBoardDirty(current())).toBe(false);
	});

	it("each environment has its own draft slot, and switching back restores the edit", async () => {
		const { rerender } = render(<Workbench source={serverDesign()} environmentId="env-a" />);
		await seeded("proj-1:env-a");
		act(() => doc().updateNodeConfig("database-orders", { port: 6543 }));

		// The topbar env switcher: the page re-renders with env-b's design.
		const envB = serverDesign([{ ...ORDERS, name: "reports" }]);
		await act(async () => {
			rerender(<Workbench source={envB} environmentId="env-b" />);
		});
		await seeded("proj-1:env-b");
		expect(nodeIds()).toContain("database-reports");
		expect(nodeIds()).not.toContain("database-orders");
		expect(isBoardDirty(current())).toBe(false);

		expect(sessionStorage.getItem(draftStorageKey(draftScope("proj-1", "env-a")))).not.toBeNull();
		expect(sessionStorage.getItem(draftStorageKey(draftScope("proj-1", "env-b")))).not.toBeNull();

		// …and back: env-a's slot still holds the unsaved port change.
		await act(async () => {
			rerender(<Workbench source={serverDesign()} environmentId="env-a" />);
		});
		await seeded("proj-1:env-a");
		expect(ordersPort()).toBe(6543);
		expect(isBoardDirty(current())).toBe(true);
	});

	it("a switch that overtakes an in-flight switch settles on the environment the user is on", async () => {
		const { rerender } = render(<Workbench source={serverDesign()} environmentId="env-a" />);
		await seeded("proj-1:env-a");
		act(() => doc().updateNodeConfig("database-orders", { port: 6543 }));

		const envB = serverDesign([{ ...ORDERS, name: "reports" }]);
		// Two renders before either switch resolves: b, then straight back to a.
		await act(async () => {
			rerender(<Workbench source={envB} environmentId="env-b" />);
			rerender(<Workbench source={serverDesign()} environmentId="env-a" />);
		});
		await waitFor(() => expect(nodeIds()).toContain("database-orders"));
		expect(doc().seed?.scope).toBe("proj-1:env-a");
		expect(nodeIds()).not.toContain("database-reports");
		// The stale b-switch never seeded, and a's own slot came back with the edit.
		expect(ordersPort()).toBe(6543);
		expect(isBoardDirty(current())).toBe(true);
	});

	it("a project's draft survives a remount", async () => {
		const first = render(<Workbench source={serverDesign()} />);
		await seeded("proj-1:env-a");

		act(() => doc().updateNodeConfig("database-orders", { port: 6543 }));
		first.unmount();

		// A reload: the in-memory board is gone but the sessionStorage slot is not. Reset the board
		// under a throwaway key so the reset itself does not overwrite the slot being tested.
		const blob = sessionStorage.getItem(draftStorageKey("proj-1:env-a"));
		expect(blob).not.toBeNull();
		current().setDraftKey("throwaway");
		current().reset();
		expect(sessionStorage.getItem(draftStorageKey("proj-1:env-a"))).toBe(blob);
		render(<Workbench source={serverDesign()} />);
		await seeded("proj-1:env-a");
		expect(ordersPort()).toBe(6543);
		expect(isBoardDirty(current())).toBe(true);
	});
});
