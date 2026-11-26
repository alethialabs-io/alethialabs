// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #7736: a `[project]` request resolves its project slug ONCE. The `[project]` layout, the page
// below it and the topbar switcher's environments read (`getEnvironmentsForSlug`) each turned the
// same slug into an id with its own query; `resolveProjectOr404` and the lookup under
// `resolveProjectId` are now memoised per request with React `cache()`.
//
// HOW A "REQUEST" IS MADE HERE. The `react` vitest resolves is the CLIENT build, whose `cache()` is
// a pass-through that memoises nothing, so a test on it would pass whether or not anything is
// cached. This file swaps in `cache` from React's OWN server build (`react.react-server`), the one
// Next's RSC renderer runs, and gives it what the renderer gives it for the length of one request:
// a dispatcher whose `getCacheForType` hands back one cache per request. That is React's real
// memoisation code (argument-by-argument, `Object.is` on primitives, rejections cached too); only
// the request boundary is ours. With no dispatcher installed, server `cache()` memoises nothing —
// the server-action and route-handler case — and the last test pins that.
//
// What is counted is the database transaction the lookup opens (`withActorScope`): the query the
// memo exists to share.

import { beforeEach, describe, expect, it, vi } from "vitest";

/** React's server-build internals, captured when the `react` mock below is first evaluated. */
const server = vi.hoisted(() => ({
	internals: undefined as undefined | { A: unknown },
}));
vi.mock("react", async (importOriginal) => {
	const actual = await importOriginal<typeof import("react")>();
	const { createRequire } = await import("node:module");
	const path = await import("node:path");
	const require = createRequire(import.meta.url);
	const dir = path.dirname(require.resolve("react/package.json"));
	// The deep path is not in react's `exports`, so it is required by file name.
	const serverReact: {
		cache: typeof actual.cache;
		__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { A: unknown };
	} = require(path.join(dir, "cjs/react.react-server.development.js"));
	server.internals = serverReact.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
	return { ...actual, default: actual, cache: serverReact.cache };
});

/** The actor `currentActor()` answers with; a test may switch it mid-request. */
const scope = vi.hoisted(() => ({ actor: { userId: "u1", orgId: "o1" } }));
/** The project rows the lookup's query returns, and the environments rows the switcher's returns. */
const rows = vi.hoisted(() => ({
	projects: [{ id: "proj-1" }] as { id: string }[],
	envs: [{ id: "env-1", project_id: "proj-1", name: "dev", stage: "development", is_default: true }],
}));

vi.mock("@/lib/authz/guard", () => ({ currentActor: vi.fn(async () => scope.actor) }));
vi.mock("@/lib/db", () => {
	/** A drizzle-shaped chain: `limit` ends the project lookup, `orderBy` the environments read. */
	const chain = {
		select: () => chain,
		from: () => chain,
		innerJoin: () => chain,
		where: () => chain,
		limit: async () => rows.projects,
		orderBy: async () => rows.envs,
	};
	return {
		withActorScope: vi.fn(async (_actor: unknown, fn: (tx: typeof chain) => Promise<unknown>) => fn(chain)),
		getServiceDb: () => chain,
	};
});
vi.mock("@/lib/auth/owner", () => ({ getOwnerScope: vi.fn() }));
vi.mock("@/app/server/actions/workspace", () => ({ setActiveOrganization: vi.fn() }));
vi.mock("next/headers", () => ({
	headers: async () => new Headers({ "x-alethia-path": "/acme/payments/clusters" }),
}));
// The layout's and the page's own work is not under test, and their real modules pull in the
// database and the whole client graph (as in resolve-project-or-404.test.ts).
vi.mock("@/app/server/actions/aws/identities", () => ({
	getVerifiedCloudIdentities: vi.fn(async () => []),
}));
vi.mock("@/components/design-project/project-shell", () => ({ ProjectShell: () => null }));
vi.mock("@/lib/rpc/server", () => ({
	serverOrpc: () => ({
		workspace: {
			environments: {
				queryOptions: () => ({ queryKey: [["workspace", "environments"]], queryFn: async () => [] }),
			},
		},
		clusters: {
			page: {
				infiniteOptions: () => ({
					queryKey: [["clusters", "page"], { type: "infinite" }],
					queryFn: async () => ({ rows: [], nextCursor: null }),
					initialPageParam: null,
					getNextPageParam: () => null,
				}),
			},
			detail: { queryOptions: () => ({ queryKey: [["clusters", "detail"]], queryFn: async () => null }) },
		},
	}),
}));
vi.mock("@/app/(private)/[org]/~/clusters/clusters-client", () => ({ ClustersClient: () => null }));

import ProjectClustersPage from "@/app/(private)/[org]/[project]/clusters/page";
import ProjectLayout from "@/app/(private)/[org]/[project]/layout";
import { getEnvironmentsForSlug, resolveProjectId } from "@/app/server/actions/resolve";
import { withActorScope } from "@/lib/db";
import { resolveProjectOr404 } from "@/lib/projects/resolve-project-or-404";

/**
 * Runs `fn` as one server request: installs a dispatcher holding a fresh per-request cache, as
 * React's RSC renderer does, and removes it afterwards.
 */
async function inRequest<T>(fn: () => Promise<T>): Promise<T> {
	const internals = server.internals;
	if (!internals) throw new Error("react's server build was not loaded");
	const caches = new Map<() => unknown, unknown>();
	internals.A = {
		getCacheForType: (create: () => unknown) => {
			if (!caches.has(create)) caches.set(create, create());
			return caches.get(create);
		},
		cacheSignal: () => null,
	};
	try {
		return await fn();
	} finally {
		internals.A = null;
	}
}

/** How many project lookups (actor-scoped transactions) have run. */
function lookups(): number {
	return vi.mocked(withActorScope).mock.calls.length;
}

const params = Promise.resolve({ org: "acme", project: "payments" });
const searchParams = Promise.resolve({});

beforeEach(() => {
	vi.mocked(withActorScope).mockClear();
	scope.actor = { userId: "u1", orgId: "o1" };
	rows.projects = [{ id: "proj-1" }];
});

describe("a [project] request resolves its project once", () => {
	it("the layout and the page below it share one lookup", async () => {
		await inRequest(async () => {
			const tree = await ProjectLayout({ children: "the page", params });
			expect(tree).toMatchObject({ props: { children: { props: { projectId: "proj-1" } } } });
			await ProjectClustersPage({ params, searchParams });
		});
		expect(lookups()).toBe(1);
	});

	it("the same slug asked three ways in one request is one query", async () => {
		await inRequest(async () => {
			await expect(resolveProjectOr404("payments")).resolves.toBe("proj-1");
			await expect(resolveProjectOr404("payments")).resolves.toBe("proj-1");
			await expect(resolveProjectId("payments")).resolves.toBe("proj-1");
		});
		expect(lookups()).toBe(1);
	});

	it("the switcher's environments read reuses the lookup and adds only its own query", async () => {
		await inRequest(async () => {
			await resolveProjectOr404("payments");
			await expect(getEnvironmentsForSlug("payments")).resolves.toEqual(rows.envs);
		});
		// One lookup, shared, plus the environments read itself.
		expect(lookups()).toBe(2);
	});

	it("an unknown slug is looked up once and answers 404 to every caller", async () => {
		rows.projects = [];
		await inRequest(async () => {
			await expect(resolveProjectOr404("nope")).resolves.toBeNull();
			await expect(resolveProjectOr404("nope")).resolves.toBeNull();
			await expect(getEnvironmentsForSlug("nope")).resolves.toEqual([]);
		});
		expect(lookups()).toBe(1);
	});

	it("a different slug is its own lookup", async () => {
		await inRequest(async () => {
			await resolveProjectId("payments");
			await resolveProjectId("billing");
		});
		expect(lookups()).toBe(2);
	});

	it("the memo is keyed on the scope: a different actor in the same request is a fresh, scoped query", async () => {
		await inRequest(async () => {
			await resolveProjectId("payments");
			scope.actor = { userId: "u1", orgId: "o2" };
			await resolveProjectId("payments");
		});
		expect(lookups()).toBe(2);
		expect(vi.mocked(withActorScope).mock.calls.map(([actor]) => actor)).toEqual([
			{ userId: "u1", orgId: "o1" },
			{ userId: "u1", orgId: "o2" },
		]);
	});

	it("nothing is shared across requests", async () => {
		await inRequest(() => resolveProjectOr404("payments"));
		await inRequest(() => resolveProjectOr404("payments"));
		expect(lookups()).toBe(2);
	});

	it("outside a render (a server action's POST) every call queries, as before", async () => {
		await resolveProjectId("payments");
		await resolveProjectId("payments");
		expect(lookups()).toBe(2);
	});
});
