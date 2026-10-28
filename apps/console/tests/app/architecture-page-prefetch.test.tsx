// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6119 (F009, RUBRIC B1) — the Architecture page's first paint carries the board's reads. The page
// prefetches them on the server under EXACTLY the keys the canvas asks for, and hands the dehydrated
// cache to the client. A key that differs by one field (an `undefined` where the client sends
// `null`) is a cache miss, and the board fetches after hydration — the jobs slice found exactly that
// drift once. So this compares the page's keys with the client hooks' keys, not with a literal.

import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";

/** The test's mutable world, shared with the hoisted mocks. */
interface World {
	handlers: Record<string, FakeHandler>;
	calls: FakeCall[];
	client: QueryClient | null;
	flags: { helm: boolean; describe: boolean; iac: boolean };
	environmentId: string | null;
}

const h = vi.hoisted(() => {
	const world: World = {
		handlers: {},
		calls: [],
		client: null,
		flags: { helm: false, describe: false, iac: false },
		environmentId: "env-1",
	};
	return world;
});

// The server caller, as a fake whose keys have the browser client's shape (`[path, {input, type}]`).
vi.mock("@/lib/rpc/server", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { serverOrpc: () => fakeOrpc(h.handlers, h.calls).orpc };
});
vi.mock("@/lib/query/client", () => ({
	getQueryClient: () => {
		if (!h.client) throw new Error("no client");
		return h.client;
	},
}));
vi.mock("@/app/server/actions/resolve", () => ({
	resolveProjectId: vi.fn(async () => "proj-1"),
	resolveActiveEnvironmentId: vi.fn(async () => {
		if (h.environmentId === null) throw new Error("Project has no default environment");
		return h.environmentId;
	}),
}));
vi.mock("@/app/server/actions/aws/identities", () => ({ getVerifiedCloudIdentities: vi.fn(async () => []) }));
vi.mock("@/lib/rpc/procedures/connectors", () => ({ readConnectorsWithStatus: vi.fn(async () => []) }));
vi.mock("@/app/server/actions/projects", () => ({ getProjectAsFormData: vi.fn(async () => undefined) }));
vi.mock("@/lib/addons/byo-flag", () => ({ isByoHelmEnabled: () => h.flags.helm }));
vi.mock("@/lib/addons/describe-flag", () => ({ isByoDescribeEnabled: () => h.flags.describe }));
vi.mock("@/lib/addons/byo-iac-flag", () => ({ isByoIacEnabled: () => h.flags.iac }));
vi.mock("@/components/design-project/design-project-workbench", () => ({
	DesignProjectWorkbench: () => null,
}));
// The browser client the hooks read through: the same fake, so its keys can be compared.
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc({}).orpc };
});

const { default: ProjectArchitecturePage } = await import(
	"@/app/(private)/[org]/[project]/architecture/page"
);
const { environmentStatusInput } = await import("@/lib/query/use-environment-status-query");
const { orpc } = await import("@/lib/rpc/client");

/** The browser's key for a canvas read of the page's environment, built the way the hooks build it. */
function clientKey(procedure: string, environmentId: string | undefined): unknown {
	const node: unknown = Reflect.get(Reflect.get(Object(orpc), "canvas"), procedure);
	const queryKey: unknown = Reflect.get(Object(node), "queryKey");
	if (typeof queryKey !== "function") throw new Error(`no ${procedure}`);
	return queryKey({ input: environmentStatusInput("proj-1", environmentId) });
}

/** Renders the page (an async server component) for `?environment_id=`. */
async function renderPage(environmentIdParam?: string) {
	await ProjectArchitecturePage({
		params: Promise.resolve({ org: "acme", project: "shop" }),
		searchParams: Promise.resolve(environmentIdParam ? { environment_id: environmentIdParam } : {}),
	});
}

/** The keys the page left in its server query client, as JSON for comparison. */
function prefetched(): string[] {
	return (h.client?.getQueryCache().getAll() ?? []).map((q) => JSON.stringify(q.queryKey)).sort();
}

beforeEach(() => {
	h.client = new QueryClient();
	h.calls.length = 0;
	h.flags = { helm: false, describe: false, iac: false };
	h.environmentId = "env-1";
	for (const name of ["environmentStatus", "addons", "byoCharts", "chartWorkloads", "iacSource"]) {
		h.handlers[`canvas.${name}`] = async () => ({});
	}
});

describe("the Architecture page prefetch", () => {
	it("prefetches the status and the add-ons under the keys the canvas reads (the resolved environment)", async () => {
		await renderPage("env-1");
		// The workbench is handed `environmentId ?? undefined`; the hooks turn that back into null.
		expect(prefetched()).toEqual(
			[clientKey("addons", "env-1"), clientKey("environmentStatus", "env-1")].map((k) => JSON.stringify(k)).sort(),
		);
	});

	it("keys an unresolvable environment as the client does — null, not undefined", async () => {
		h.environmentId = null;
		await renderPage("garbage");
		expect(prefetched()).toEqual(
			[clientKey("addons", undefined), clientKey("environmentStatus", undefined)].map((k) => JSON.stringify(k)).sort(),
		);
	});

	it("prefetches the BYO layers only where their feature is on", async () => {
		h.flags = { helm: true, describe: true, iac: true };
		await renderPage("env-1");
		expect(prefetched()).toEqual(
			["addons", "byoCharts", "chartWorkloads", "environmentStatus", "iacSource"]
				.map((p) => JSON.stringify(clientKey(p, "env-1")))
				.sort(),
		);
	});
});
