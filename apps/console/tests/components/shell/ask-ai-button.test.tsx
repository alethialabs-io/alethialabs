// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Ask AI resolves the project it is pressed in from the org's project list — a GET read the `[org]`
// layout prefetched — and never through a server action (#6114, ADR 0005 D1). It used to call the
// `resolveProjectId` action on every press: a read travelling as a POST that queues behind every
// other action on the page. The action module is mocked to FAIL if anything calls it.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { pathname, togglePanel, resolveProjectId, readProjects } = vi.hoisted(() => ({
	pathname: { current: "/acme/shop" },
	togglePanel: vi.fn(),
	resolveProjectId: vi.fn(async () => {
		throw new Error("Ask AI must not resolve a project through a server action");
	}),
	readProjects: vi.fn(),
}));
vi.mock("next/navigation", () => ({
	usePathname: () => pathname.current,
	useSearchParams: () => new URLSearchParams("environment_id=env_2"),
}));
vi.mock("@/app/server/actions/resolve", () => ({ resolveProjectId }));
vi.mock("@/components/agent/elench/elench-surface-loader", () => ({ preloadElenchSurface: vi.fn() }));
vi.mock("@/lib/stores/use-elench-store", () => ({
	useElenchStore: (select: (s: { togglePanel: typeof togglePanel }) => unknown) =>
		select({ togglePanel }),
}));
// The query utils are built over a client whose `workspace.projects` is the spy, so the GET read the
// button issues on a cache miss is observable.
vi.mock("@/lib/rpc/client", async (importOriginal) => {
	const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
	const rpcClient = { workspace: { projects: readProjects } };
	return {
		...(await importOriginal<typeof import("@/lib/rpc/client")>()),
		rpcClient,
		orpc: createTanstackQueryUtils(rpcClient),
	};
});

import type { ProjectWithProvider } from "@/app/server/actions/projects";
import { AskAiButton } from "@/components/shell/ask-ai-button";
import { orpc } from "@/lib/rpc/client";

/** The one project in the org's list, in the read router's full shape. */
const SHOP: ProjectWithProvider = {
	id: "proj_shop",
	slug: "shop",
	project_name: "Shop",
	org_id: "org_acme",
	user_id: "user_1",
	created_at: new Date(0),
	updated_at: new Date(0),
	cloud_identity_id: null,
	region: "eu-central-1",
	iac_version: "1",
	estimated_monthly_cost: null,
	webhook_ca_consumers: [],
	cloud_provider: null,
	environment_stage: "dev",
	status: "active",
	default_environment_id: null,
};

/** Renders the button under a client that holds `projects` (the layout's prefetch), or nothing. */
function renderWith(projects: ProjectWithProvider[] | undefined): void {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
	if (projects) client.setQueryData(orpc.workspace.projects.queryKey(), projects);
	render(
		<QueryClientProvider client={client}>
			<AskAiButton />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	pathname.current = "/acme/shop";
	togglePanel.mockReset();
	resolveProjectId.mockClear();
	readProjects.mockReset();
});

describe("AskAiButton", () => {
	it("in a project, opens the project panel from the cached project list — no request at all", async () => {
		renderWith([SHOP]);
		await userEvent.click(screen.getByRole("button", { name: "Ask AI" }));
		await waitFor(() =>
			expect(togglePanel).toHaveBeenCalledWith({
				kind: "project",
				projectId: "proj_shop",
				projectSlug: "shop",
				environmentId: "env_2",
			}),
		);
		expect(readProjects).not.toHaveBeenCalled();
		expect(resolveProjectId).not.toHaveBeenCalled();
	});

	it("with nothing cached, reads the list over the GET procedure", async () => {
		readProjects.mockResolvedValue([SHOP]);
		renderWith(undefined);
		await userEvent.click(screen.getByRole("button", { name: "Ask AI" }));
		await waitFor(() => expect(togglePanel).toHaveBeenCalledWith(expect.objectContaining({ projectId: "proj_shop" })));
		expect(readProjects).toHaveBeenCalledTimes(1);
		expect(resolveProjectId).not.toHaveBeenCalled();
	});

	it("a slug the org's list does not hold falls back to the org panel", async () => {
		pathname.current = "/acme/gone";
		renderWith([SHOP]);
		await userEvent.click(screen.getByRole("button", { name: "Ask AI" }));
		await waitFor(() => expect(togglePanel).toHaveBeenCalledWith({ kind: "org" }));
	});

	it("a failed list read falls back to the org panel", async () => {
		readProjects.mockRejectedValue(new Error("boom"));
		renderWith(undefined);
		await userEvent.click(screen.getByRole("button", { name: "Ask AI" }));
		await waitFor(() => expect(togglePanel).toHaveBeenCalledWith({ kind: "org" }));
	});

	it("outside a project, opens the org panel", async () => {
		pathname.current = "/acme/~/jobs";
		renderWith([SHOP]);
		await userEvent.click(screen.getByRole("button", { name: "Ask AI" }));
		await waitFor(() => expect(togglePanel).toHaveBeenCalledWith({ kind: "org" }));
	});
});
