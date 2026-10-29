// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6348 (RUBRIC B1) — the Architecture route's FIRST PAINT is the board, not a skeleton.
//
// The page prefetches the design and every read the board draws from, but the board itself is React
// Flow, which is client-only and loaded at the point of use (`next/dynamic`, `ssr: false`). Its
// loading state was the skeleton, so with every client read held the release gate saw seven
// skeleton blocks and none of the data the server already had: no blank-board guide, no last job.
// The loading state is now `BoardPreview` — the board drawn from the page's data without React Flow.
//
// The SERVER render is read with `renderToString`, where no effect runs and nothing is fetched: what
// it prints is what the first paint carries.

import { QueryClient } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceProjectData } from "@/components/design-project/source-project";
import type { EnvironmentStatus, IacEnvironment } from "@/lib/canvas/component-status";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";

// The live board is not this file's subject: the workbench test below must see what the page
// sends WHILE it loads, so its module never resolves.
vi.mock("@/components/design-project/canvas/design-project-canvas", () => ({
	DesignProjectCanvas: () => <div data-testid="live-board" />,
}));
// RepositoryProvider calls server actions on mount (git providers + repos); not under test.
vi.mock("@/components/design-project/repository-context", () => ({
	RepositoryProvider: ({ children }: { children: ReactNode }) => children,
	useRepositoryContext: () => null,
}));

const { orpc } = await import("@/lib/rpc/client");
const { EMPTY_ENVIRONMENT_STATUS } = await import("@/lib/canvas/component-status");
const { buildDefaultFormValues } = await import("@/components/design-project/source-project");
const { BoardPreview, BoardPreviewProvider, previewLayout } = await import(
	"@/components/design-project/canvas/board-preview"
);
const { DesignProjectWorkbench } = await import(
	"@/components/design-project/design-project-workbench"
);
const { seededClient, withQueryClient } = await import("@/tests/support/general-settings");

const INPUT = { projectId: "proj-1", environmentId: "env-1" };

const ORDERS: ProjectFormData["databases"][number] = {
	name: "orders",
	engine_family: "postgres",
	min_capacity: 0.5,
	max_capacity: 4,
	port: 5432,
	iam_auth: false,
};

/** A server design as `getProjectAsFormData` returns it. */
function serverDesign(databases: ProjectFormData["databases"] = []): SourceProjectData {
	const base = buildDefaultFormValues();
	return {
		formData: { ...base, project: { ...base.project, project_name: "shop" }, databases },
		provider: "aws",
	};
}

/** The environment's last job failed: a DESTROY, a minute ago. */
const LAST_DESTROY_FAILED: EnvironmentStatus = {
	...EMPTY_ENVIRONMENT_STATUS,
	recentJobs: [
		{ id: "job-1", type: "DESTROY", status: "FAILED", createdAt: new Date(Date.now() - 60_000).toISOString() },
	],
};

/** A BYO IaC module governing the environment, scanned, with no cards yet. */
const IAC: IacEnvironment = {
	source: {
		repoUrl: "https://github.com/acme/infra",
		ref: "main",
		path: ".",
		commitSha: null,
		deployedCommitSha: null,
		scanStatus: "done",
		scanOk: true,
		status: "PENDING",
		statusMessage: null,
	},
	groups: [],
	costByAddress: {},
	outputs: [],
};

/** A client holding what the Architecture page dehydrates for the board. */
function pageCache(status: EnvironmentStatus): QueryClient {
	const client = seededClient();
	client.setQueryData(orpc.canvas.environmentStatus.queryKey({ input: INPUT }), status);
	client.setQueryData(orpc.canvas.addons.queryKey({ input: INPUT }), {
		environmentId: "env-1",
		items: [],
		hasAppsRepo: false,
	});
	return client;
}

/** The preview over the page's data, as the workbench provides it. */
function preview(source: SourceProjectData, status: EnvironmentStatus = LAST_DESTROY_FAILED) {
	return withQueryClient(
		<BoardPreviewProvider
			value={{ sourceProject: source, cloudIdentities: [], projectId: "proj-1", environmentId: "env-1" }}
		>
			<BoardPreview />
		</BoardPreviewProvider>,
		pageCache(status),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("previewLayout — the board's cards, laid out as the store lays them out", () => {
	it("a design with nothing on it draws no card (the project, cluster and network never do)", () => {
		expect(previewLayout(serverDesign(), [])).toEqual({ cards: [], width: 0, height: 0 });
	});

	it("draws one card per component, named as the board names it, on the layout's grid", () => {
		const layout = previewLayout(serverDesign([ORDERS, { ...ORDERS, name: "billing" }]), []);
		expect(layout.cards.map((c) => [c.kind, c.eyebrow, c.title])).toEqual([
			["database", "Database", "orders"],
			["database", "Database", "billing"],
		]);
		// Two managed databases sit side by side, one card and one gap apart.
		expect(layout.cards.map((c) => [c.x, c.y])).toEqual([
			[0, 0],
			[276, 0],
		]);
		expect(layout).toMatchObject({ width: 276 + 248, height: 132 });
	});
});

describe("BoardPreview — the server render is the board (B1)", () => {
	it("a blank design: the guide and the last job, and not one skeleton block", () => {
		const html = renderToString(preview(serverDesign()));
		expect(html).toContain('data-slot="board-preview"');
		expect(html).toContain("Nothing designed yet");
		expect(html).toContain('data-slot="empty"');
		expect(html).toContain("Destroy");
		expect(html).toContain("Failed");
		expect(html).not.toContain('data-slot="skeleton"');
	});

	it("leaves the job's age to the browser — the server's clock is not the viewer's", () => {
		const html = renderToString(preview(serverDesign()));
		// `ago` would print "1 m"; the slot is reserved (its sizer) but empty on the server.
		expect(html).not.toMatch(/>\s*1 m\s*</);
	});

	it("a designed board: the design's cards, and no blank-board guide", () => {
		const html = renderToString(preview(serverDesign([ORDERS])));
		expect(html).toContain("orders");
		expect(html).toContain("Database");
		expect(html).not.toContain("Nothing designed yet");
		expect(html).not.toContain('data-slot="skeleton"');
	});

	it("an environment an IaC module governs: nothing to add, so no guide and no Add", () => {
		const governed: EnvironmentStatus = {
			...LAST_DESTROY_FAILED,
			iac: IAC,
		};
		render(preview(serverDesign([ORDERS]), governed));
		expect(screen.queryByText("Nothing designed yet")).toBeNull();
		expect(screen.queryByText("orders")).toBeNull();
		expect(screen.queryByText("Add")).toBeNull();
	});

	it("is a picture: inert and hidden from the accessibility tree, so no dead control can be found", () => {
		const { container } = render(preview(serverDesign()));
		const board = container.querySelector('[data-slot="board-preview"]');
		expect(board).toHaveAttribute("inert");
		expect(board).toHaveAttribute("aria-hidden", "true");
		expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
	});

	it("without the page's data it is the skeleton, as before", () => {
		render(withQueryClient(<BoardPreview />));
		expect(screen.getByRole("status", { name: /loading the board/i })).toBeInTheDocument();
	});
});

describe("DesignProjectWorkbench — what the page sends while the board loads", () => {
	it("is the board drawn from the page's data, not the skeleton", () => {
		const html = renderToString(
			withQueryClient(
				<DesignProjectWorkbench
					cloudIdentities={[]}
					sourceProject={serverDesign()}
					projectId="proj-1"
					environmentId="env-1"
					dockInShell
				/>,
				pageCache(LAST_DESTROY_FAILED),
			),
		);
		expect(html).toContain('data-slot="board-preview"');
		expect(html).toContain("Nothing designed yet");
		expect(html).toContain("Destroy");
		expect(html).not.toContain('data-slot="skeleton"');
		expect(html).not.toContain("live-board");
	});
});
