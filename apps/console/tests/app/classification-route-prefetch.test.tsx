// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6334 — the two project routes that render `ClassificationControl` prefetch what it reads, so its
// "Classify" picker is in the FIRST PAINT (RUBRIC B1) rather than arriving after a client read:
//
//   · `[project]/settings/general` — the edit decision, the taxonomy and the PROJECT's chips;
//   · `[project]/environments`     — the edit decision, the taxonomy and every environment's chips
//                                     in the one batched read the view hydrates its cards from.
//
// Each under exactly the key the client asks for (`lib/query/use-classification-query.ts`). A read
// that FAILED is not handed down, so the client reads again and the control renders its error.
//
// The routes are called as plain async functions and their `HydrationBoundary` state read off the
// returned element; the read router is faked at `serverOrpc()`.

import { type DehydratedState, QueryClient } from "@tanstack/react-query";
import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";

const h = vi.hoisted(() => ({
	handlers: {} as Record<string, FakeHandler>,
	calls: [] as FakeCall[],
	client: undefined as unknown,
}));
vi.mock("@/lib/rpc/server", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	const { orpc } = fakeOrpc(h.handlers, h.calls);
	return { serverOrpc: () => orpc };
});
vi.mock("@/lib/query/client", () => ({ getQueryClient: () => h.client }));
vi.mock("@/app/server/actions/resolve", () => ({ resolveProjectId: async () => "p1" }));
vi.mock("next/navigation", () => ({
	notFound: () => {
		throw new Error("NEXT_NOT_FOUND");
	},
}));
vi.mock("@/components/settings/general/project-general", () => ({ ProjectGeneral: () => null }));
vi.mock("@/components/environments/environments-view", () => ({ EnvironmentsView: () => null }));

import EnvironmentsRoute from "@/app/(private)/[org]/[project]/environments/page";
import GeneralRoute from "@/app/(private)/[org]/[project]/settings/general/page";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ENV_A = "22222222-2222-4222-8222-222222222222";
const ENV_B = "33333333-3333-4333-8333-333333333333";

const params = Promise.resolve({ org: "acme", project: "payments" });

/** The boundary state a route element hands down. */
function stateOf(el: ReactNode): DehydratedState {
	if (!isValidElement<{ state: DehydratedState }>(el)) throw new Error("the route returned no element");
	return el.props.state;
}

/** Every handed-down key, as `path → input` (an oRPC key is `[path, { input, type }]`). */
function handedDown(state: DehydratedState): Record<string, unknown> {
	return Object.fromEntries(
		state.queries.map((q) => {
			const [path, opts] = q.queryKey;
			if (!Array.isArray(path) || typeof opts !== "object" || opts === null || !("input" in opts)) {
				throw new Error(`not an oRPC key: ${JSON.stringify(q.queryKey)}`);
			}
			return [path.join("."), opts.input];
		}),
	);
}

beforeEach(() => {
	h.calls.length = 0;
	for (const k of Object.keys(h.handlers)) delete h.handlers[k];
	h.client = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } });
	h.handlers["settings.project"] = async () => ({ id: PROJECT_ID, project_name: "Payments", slug: "payments" });
	h.handlers["environments.overview"] = async () => ({ projectId: PROJECT_ID, envs: [{ id: ENV_A }, { id: ENV_B }] });
	h.handlers["classification.canEdit"] = async () => true;
	h.handlers["classification.dimensions"] = async () => [];
	h.handlers["classification.assignments"] = async () => [];
	h.handlers["classification.assignmentsForKind"] = async () => ({});
});

describe("[project]/settings/general — the Classification field is in the first paint", () => {
	it("hands down the edit decision, the taxonomy and the project's chips under the client's keys", async () => {
		const keys = handedDown(stateOf(await GeneralRoute({ params })));
		expect(keys).toStrictEqual({
			"settings.project": { project: "payments" },
			"classification.canEdit": undefined,
			"classification.dimensions": {},
			"classification.assignments": { kind: "project", resourceId: PROJECT_ID },
		});
	});

	it("a failed edit decision is not handed down, and is not retried before the first byte", async () => {
		h.handlers["classification.canEdit"] = async () => {
			throw new Error("boom");
		};
		const keys = handedDown(stateOf(await GeneralRoute({ params })));
		expect(keys).not.toHaveProperty("classification.canEdit");
		expect(h.calls.filter((c) => c.path === "classification.canEdit")).toHaveLength(1);
	});

	it("a project that is not there is the 404, with no classification read", async () => {
		h.handlers["settings.project"] = async () => null;
		await expect(GeneralRoute({ params })).rejects.toThrow("NEXT_NOT_FOUND");
		expect(h.calls.map((c) => c.path)).toEqual(["settings.project"]);
	});
});

describe("[project]/environments — every card's Classification control is in the first paint", () => {
	it("hands down the edit decision, the taxonomy and the batched chips in the view's order", async () => {
		const keys = handedDown(stateOf(await EnvironmentsRoute({ params })));
		expect(keys).toStrictEqual({
			"environments.overview": { project: "payments" },
			"classification.canEdit": undefined,
			"classification.dimensions": {},
			"classification.assignmentsForKind": { kind: "project_environment", resourceIds: [ENV_A, ENV_B] },
		});
	});

	it("a failed overview prefetches no classification — the view renders its own error first", async () => {
		h.handlers["environments.overview"] = async () => {
			throw new Error("boom");
		};
		const keys = handedDown(stateOf(await EnvironmentsRoute({ params })));
		expect(Object.keys(keys).filter((k) => k.startsWith("classification."))).toEqual([]);
	});
});
