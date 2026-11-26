// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Where the environment switcher is, and what choosing an environment does to the address (#6924,
// R6 D-30).
//
// The switcher rendered on every project view, and only Architecture shows one environment. On
// Jobs, Environments, Clusters, Usage and Settings, choosing an environment changed the address and
// nothing on the page. Its link also replaced the whole query string with `?environment_id=…`, and
// a failed read of the environments made the control disappear with nothing in its place.
//
// The REAL switcher is rendered. Navigation and the read behind it are the stubs.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { push, pathname, search, readEnvironments } = vi.hoisted(() => ({
	push: vi.fn(),
	pathname: { current: "/acme/shop/architecture" },
	search: { current: "" },
	readEnvironments: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }),
	usePathname: () => pathname.current,
	useSearchParams: () => new URLSearchParams(search.current),
	useParams: () => ({ org: "acme", project: "shop" }),
}));
vi.mock("@/components/environments/new-environment-dialog", () => ({
	NewEnvironmentDialog: () => null,
}));
vi.mock("@/lib/stores/use-elench-store", () => ({
	useElenchStore: { getState: () => ({ syncEnvironment: vi.fn() }) },
}));
vi.mock("@/lib/query/use-projects-query", () => ({
	useProjectsQuery: () => ({
		data: [{ id: "proj_1", slug: "shop", project_name: "Shop", cloud_provider: null }],
	}),
}));
// The query utils are built over a client whose `workspace.environments` is the spy, so a read
// that fails, and the retry after it, are both observable.
vi.mock("@/lib/rpc/client", async (importOriginal) => {
	const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
	const rpcClient = { workspace: { environments: readEnvironments } };
	return {
		...(await importOriginal<typeof import("@/lib/rpc/client")>()),
		rpcClient,
		orpc: createTanstackQueryUtils(rpcClient),
	};
});

const { EnvSwitcher, environmentHref, isEnvironmentView } = await import("@/components/env-switcher");

const ENVS = [
	{ id: "env_1", project_id: "proj_1", name: "production", stage: "production", is_default: true },
	{ id: "env_2", project_id: "proj_1", name: "staging", stage: "staging", is_default: false },
];

/** The ⌥E / Alt+E press. macOS reports a dead key for it, so the physical key identifies it. */
const NEXT_ENV = { key: "Dead", code: "KeyE", altKey: true };

/** Renders the switcher with a page button beside it, under a client that does not retry by itself. */
function renderSwitcher() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<EnvSwitcher />
			<button type="button">a page button</button>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	pathname.current = "/acme/shop/architecture";
	search.current = "";
	readEnvironments.mockResolvedValue(ENVS);
});

describe("isEnvironmentView", () => {
	it("is true for the Architecture view and what is under it", () => {
		expect(isEnvironmentView("/acme/shop/architecture")).toBe(true);
		expect(isEnvironmentView("/acme/shop/architecture/anything")).toBe(true);
	});

	it("is false for every project view that is about the whole project", () => {
		const views = ["jobs", "environments", "clusters", "usage", "settings", "settings/general"];
		expect(views.filter((view) => isEnvironmentView(`/acme/shop/${view}`))).toEqual([]);
	});

	it("is false outside a project: the org overview, the org-wide pages, a project's bare address", () => {
		expect(isEnvironmentView("/acme")).toBe(false);
		expect(isEnvironmentView("/acme/~/jobs")).toBe(false);
		// `~` is never a project, even with a third segment that names an environment view.
		expect(isEnvironmentView("/acme/~/architecture")).toBe(false);
		expect(isEnvironmentView("/acme/shop")).toBe(false);
	});
});

describe("environmentHref", () => {
	it("sets the environment and keeps the view's other parameters, in their order", () => {
		expect(environmentHref("/acme/shop/architecture", "", "env_2")).toBe(
			"/acme/shop/architecture?environment_id=env_2",
		);
		expect(environmentHref("/acme/shop/architecture", "view=list&environment_id=env_1&tab=cost", "env_2")).toBe(
			"/acme/shop/architecture?view=list&environment_id=env_2&tab=cost",
		);
	});

	it("drops what names something inside the environment being left: the selection", () => {
		expect(
			environmentHref("/acme/shop/architecture", "selected=node_9&view=list", "env_2"),
		).toBe("/acme/shop/architecture?view=list&environment_id=env_2");
	});
});

describe("the environment switcher", () => {
	it("is on the Architecture view", async () => {
		renderSwitcher();
		expect(await screen.findByRole("button", { name: "Switch environment: production" })).toBeInTheDocument();
	});

	it.each(["jobs", "environments", "clusters", "usage", "settings/general"])(
		"is not on the project's %s view, does not read the environments there, and its shortcut is not bound",
		async (view) => {
			pathname.current = `/acme/shop/${view}`;
			renderSwitcher();
			// Let anything that was going to read, read.
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(screen.queryByRole("button", { name: /Switch environment/ })).toBeNull();
			expect(readEnvironments).not.toHaveBeenCalled();
			const pageButton = screen.getByRole("button", { name: "a page button" });
			// `true`: nothing called preventDefault, so the key is the browser's.
			expect(fireEvent.keyDown(pageButton, NEXT_ENV)).toBe(true);
			expect(push).not.toHaveBeenCalled();
		},
	);

	it("choosing an environment keeps the view's other parameters", async () => {
		search.current = "view=list&environment_id=env_1";
		const user = userEvent.setup({ delay: null });
		renderSwitcher();
		await user.click(await screen.findByRole("button", { name: "Switch environment: production" }));
		await user.click(await screen.findByRole("option", { name: "staging" }));
		expect(push).toHaveBeenCalledWith("/acme/shop/architecture?view=list&environment_id=env_2");
	});

	it("a read that failed is a retry in the switcher's place, and the retry brings the switcher back", async () => {
		readEnvironments.mockRejectedValueOnce(new Error("network"));
		const user = userEvent.setup({ delay: null });
		renderSwitcher();
		const retry = await screen.findByRole("button", { name: "Retry environments" });
		expect(retry).toHaveAttribute("data-state", "error");
		expect(screen.queryByRole("button", { name: /Switch environment/ })).toBeNull();
		await user.click(retry);
		expect(await screen.findByRole("button", { name: "Switch environment: production" })).toBeInTheDocument();
		expect(readEnvironments).toHaveBeenCalledTimes(2);
	});
});
