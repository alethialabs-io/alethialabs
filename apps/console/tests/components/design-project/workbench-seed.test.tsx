// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// "They don't hold their state." The workbench's seed effect was keyed on the IDENTITY of its
// `sourceProject` prop, and a server component hands it a new object on every re-render — so a
// revalidate, a sibling mutation or an env poll re-ran `setGraph`, closed the open card and
// discarded every unsaved edit. It is now keyed on [project, environment, content revision], and
// each project:environment persists its draft in its own sessionStorage slot. These drive the
// component the way the page does — re-render with new props — and read the store.

import { act, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import type { SourceProjectData } from "@/components/design-project/source-project";
import { buildDefaultFormValues } from "@/components/design-project/source-project";
import { draftScope } from "@/lib/canvas/design-revision";
import { draftStorageKey, useCanvasStore } from "@/lib/stores/use-canvas-store";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";

// The board itself is another lane's concern and drags in xyflow + every card; the seed effect
// lives in the workbench, so a stub is all the board needs to be.
vi.mock("@/components/design-project/canvas/design-project-canvas", () => ({
	DesignProjectCanvas: () => <div data-testid="canvas" />,
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

/** The port the `database-orders` node currently holds in the store. */
function ordersPort(): unknown {
	const node = useCanvasStore.getState().nodes.find((n) => n.id === "database-orders");
	return node && "port" in node.data.config ? node.data.config.port : undefined;
}

/** Ids of the nodes in the store, in order. */
function nodeIds(): string[] {
	return useCanvasStore.getState().nodes.map((n) => n.id);
}

/** Wait for the async seed (switch scope → rehydrate → reseed) to land for `scope`. */
async function seeded(scope: string) {
	await waitFor(() => expect(useCanvasStore.getState().seed?.scope).toBe(scope));
}

function Workbench({
	source,
	environmentId = "env-a",
	projectId = "proj-1",
	create,
}: {
	source?: SourceProjectData;
	environmentId?: string;
	projectId?: string;
	/** The create flow (`~/new`): no project, no environment. A default parameter cannot express
	 * this — passing `projectId={undefined}` is exactly what makes the default apply. */
	create?: boolean;
}) {
	if (create) {
		return (
			<DesignProjectWorkbench cloudIdentities={IDENTITIES} sourceProject={source} dockInShell />
		);
	}
	return (
		<DesignProjectWorkbench
			cloudIdentities={IDENTITIES}
			sourceProject={source}
			projectId={projectId}
			environmentId={environmentId}
			dockInShell
		/>
	);
}

beforeEach(() => {
	// Reset first: persist writes every `set` to whichever slot the previous test left it on.
	useCanvasStore.getState().reset();
	sessionStorage.clear();
});

describe("DesignProjectWorkbench seeding", () => {
	it("seeds the graph from the server design under the project:environment scope", async () => {
		render(<Workbench source={serverDesign()} />);
		await seeded("proj-1:env-a");
		expect(nodeIds()).toContain("database-orders");
		expect(useCanvasStore.getState().dirty).toBe(false);
		expect(sessionStorage.getItem(draftStorageKey("proj-1:env-a"))).not.toBeNull();
	});

	it("an identical-content re-render is not a re-seed: the open card and the edit survive", async () => {
		const { rerender } = render(<Workbench source={serverDesign()} />);
		await seeded("proj-1:env-a");

		act(() => {
			useCanvasStore.getState().openInspector("database-orders");
			useCanvasStore.getState().updateNodeConfig("database-orders", { port: 6543 });
		});
		const draft = useCanvasStore.getState().nodes;

		// The page re-rendered: same design, NEW object (and a new identities array too).
		await act(async () => {
			rerender(<Workbench source={serverDesign()} />);
		});
		await act(async () => {
			rerender(<Workbench source={serverDesign()} />);
		});

		const s = useCanvasStore.getState();
		expect(s.nodes).toBe(draft);
		expect(ordersPort()).toBe(6543);
		expect(s.card).toEqual({ kind: "inspector", nodeId: "database-orders" });
		expect(s.dirty).toBe(true);
	});

	it("a changed design while the draft is dirty moves the baseline only and keeps the draft", async () => {
		const { rerender } = render(<Workbench source={serverDesign()} />);
		await seeded("proj-1:env-a");
		const firstRevision = useCanvasStore.getState().seed?.revision;

		act(() => {
			useCanvasStore.getState().openInspector("database-orders");
			useCanvasStore.getState().updateNodeConfig("database-orders", { port: 6543 });
		});
		const draft = useCanvasStore.getState().nodes;

		// The server design moved: someone added a table.
		await act(async () => {
			rerender(<Workbench source={serverDesign([ORDERS, { ...ORDERS, name: "audit" }])} />);
		});
		await waitFor(() =>
			expect(useCanvasStore.getState().seed?.revision).not.toBe(firstRevision),
		);

		const s = useCanvasStore.getState();
		expect(s.nodes).toBe(draft);
		expect(ordersPort()).toBe(6543);
		expect(s.card).toEqual({ kind: "inspector", nodeId: "database-orders" });
		expect(s.baseline.map((n) => n.id)).toContain("database-audit");
		expect(s.nodes.map((n) => n.id)).not.toContain("database-audit");
	});

	it("a changed design on a clean draft replaces the graph and keeps the card on a surviving node", async () => {
		const { rerender } = render(<Workbench source={serverDesign()} />);
		await seeded("proj-1:env-a");
		act(() => useCanvasStore.getState().openInspector("database-orders"));

		await act(async () => {
			rerender(<Workbench source={serverDesign([ORDERS, { ...ORDERS, name: "audit" }])} />);
		});
		await waitFor(() => expect(nodeIds()).toContain("database-audit"));

		const s = useCanvasStore.getState();
		expect(s.card).toEqual({ kind: "inspector", nodeId: "database-orders" });
		expect(s.dirty).toBe(false);
	});

	it("each environment has its own draft slot, and switching back restores the edit", async () => {
		const { rerender } = render(<Workbench source={serverDesign()} environmentId="env-a" />);
		await seeded("proj-1:env-a");
		act(() => useCanvasStore.getState().updateNodeConfig("database-orders", { port: 6543 }));

		// The topbar env switcher: the page re-renders with env-b's design.
		const envB = serverDesign([{ ...ORDERS, name: "reports" }]);
		await act(async () => {
			rerender(<Workbench source={envB} environmentId="env-b" />);
		});
		await seeded("proj-1:env-b");
		expect(nodeIds()).toContain("database-reports");
		expect(nodeIds()).not.toContain("database-orders");
		expect(useCanvasStore.getState().dirty).toBe(false);

		expect(sessionStorage.getItem(draftStorageKey(draftScope("proj-1", "env-a")))).not.toBeNull();
		expect(sessionStorage.getItem(draftStorageKey(draftScope("proj-1", "env-b")))).not.toBeNull();

		// …and back: env-a's slot still holds the unsaved port change.
		await act(async () => {
			rerender(<Workbench source={serverDesign()} environmentId="env-a" />);
		});
		await seeded("proj-1:env-a");
		expect(ordersPort()).toBe(6543);
		expect(useCanvasStore.getState().dirty).toBe(true);
	});

	it("a switch that overtakes an in-flight switch settles on the environment the user is on", async () => {
		const { rerender } = render(<Workbench source={serverDesign()} environmentId="env-a" />);
		await seeded("proj-1:env-a");
		act(() => useCanvasStore.getState().updateNodeConfig("database-orders", { port: 6543 }));

		const envB = serverDesign([{ ...ORDERS, name: "reports" }]);
		// Two renders before either switch resolves: b, then straight back to a.
		await act(async () => {
			rerender(<Workbench source={envB} environmentId="env-b" />);
			rerender(<Workbench source={serverDesign()} environmentId="env-a" />);
		});
		await waitFor(() => expect(nodeIds()).toContain("database-orders"));
		const s = useCanvasStore.getState();
		expect(s.seed?.scope).toBe("proj-1:env-a");
		expect(nodeIds()).not.toContain("database-reports");
		// The stale b-switch never seeded, and a's own slot came back with the edit.
		expect(ordersPort()).toBe(6543);
		expect(s.dirty).toBe(true);
	});

	it("the create flow seeds under the 'new' scope and its draft survives a remount", async () => {
		const first = render(<Workbench create />);
		await seeded("new");
		expect(useCanvasStore.getState().seed).toEqual({ scope: "new", revision: "new" });

		act(() =>
			useCanvasStore.getState().updateNodeConfig("project-root", { project_name: "draft-app" }),
		);
		first.unmount();

		// A reload: the in-memory store is gone but the sessionStorage slot is not. Reset the store
		// under a throwaway key so the reset itself does not overwrite the slot being tested.
		const blob = sessionStorage.getItem(draftStorageKey("new"));
		expect(blob).not.toBeNull();
		useCanvasStore.persist.setOptions({ name: "throwaway" });
		useCanvasStore.getState().reset();
		expect(sessionStorage.getItem(draftStorageKey("new"))).toBe(blob);
		render(<Workbench create />);
		await seeded("new");
		const root = useCanvasStore.getState().nodes.find((n) => n.id === "project-root");
		expect(root && "project_name" in root.data.config ? root.data.config.project_name : null).toBe(
			"draft-app",
		);
	});
});
