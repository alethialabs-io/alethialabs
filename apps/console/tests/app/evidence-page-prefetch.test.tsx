// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Evidence route prefetches EXACTLY what the client reads on first paint (#6126, RUBRIC B1): the
// `evidence.page` read for the LINK's filters, normalized the way the client normalizes them, and the
// first page of the `evidence.waivers` log under its one stable query `{}`, through the in-process
// read router — and hands down only those reads. The shell's reads, which share the
// per-request QueryClient, travel through the `[org]` layout's own boundary, not this one. A
// prefetch that FAILED is not handed down at all, so the client reads again and renders the error or
// the refusal it gets, instead of hydrating a failure.
//
// The route is called as a plain async function and its `HydrationBoundary` state read off the
// returned element. The read router is faked at `serverOrpc()`, answering with the input it was
// asked, so the dehydrated data names the query that ran.

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
vi.mock("@/components/evidence/evidence-client", () => ({ EvidenceClient: () => null }));

import EvidenceRoute from "@/app/(private)/[org]/~/evidence/page";

/** Calls the route for a link and returns the dehydrated state its boundary hands down. */
async function dehydratedFor(search: Record<string, string>): Promise<DehydratedState> {
	const el: ReactNode = await EvidenceRoute({
		params: Promise.resolve({ org: "acme" }),
		searchParams: Promise.resolve(search),
	});
	if (!isValidElement<{ state: DehydratedState }>(el)) throw new Error("the route returned no element");
	return el.props.state;
}

beforeEach(() => {
	h.calls.length = 0;
	// The console's default `retry: 1` (lib/query/client.ts), with no delay, so a retry would show.
	const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } });
	// A shell read the [org] layout prefetched into the same per-request client.
	qc.setQueryData([["workspace", "projects"], { type: "query" }], [{ id: "p1" }]);
	h.client = qc;
	h.handlers["evidence.page"] = async (input) => ({ asked: input });
	h.handlers["evidence.waivers"] = async (input) => ({ items: [], nextCursor: null, asked: input });
});

/** The waivers log's first-page key, as `useKeysetList` builds it for `EvidenceWaivers`' query `{}`. */
const WAIVERS_KEY = [["evidence", "waivers"], { input: {}, type: "infinite" }];

describe("EvidenceRoute — first-paint prefetch", () => {
	it("prefetches the link's filtered read and the waivers' first page under the client's keys, and hands down only those", async () => {
		const state = await dehydratedFor({ search: " pay ", stages: "staging,production,staging" });
		const input = { search: "pay", stages: ["production", "staging"] };
		expect(h.calls).toHaveLength(2);
		expect(h.calls).toEqual(
			expect.arrayContaining([
				{ path: "evidence.page", input },
				{ path: "evidence.waivers", input: {} },
			]),
		);
		const keys = state.queries.map((q) => q.queryKey);
		expect(keys).toHaveLength(2);
		expect(keys).toEqual(
			expect.arrayContaining([[["evidence", "page"], { input, type: "query" }], WAIVERS_KEY]),
		);
		const page = state.queries.find((q) => String(q.queryKey[0]) === "evidence,page");
		expect(page?.state.data).toEqual({ asked: input });
	});

	it("a pristine link prefetches the unfiltered read — the key the client asks for first", async () => {
		const state = await dehydratedFor({});
		expect(state.queries.map((q) => q.queryKey)).toEqual(
			expect.arrayContaining([[["evidence", "page"], { input: {}, type: "query" }]]),
		);
	});

	it("a failed prefetch is not handed down — the client reads again rather than hydrating a failure", async () => {
		h.handlers["evidence.page"] = async () => {
			throw new Error("boom");
		};
		const state = await dehydratedFor({});
		expect(state.queries.map((q) => q.queryKey)).toEqual([WAIVERS_KEY]);
		expect(h.calls, "no retry holds the first byte").toHaveLength(2);
	});

	it("a failed waivers read is not handed down either, and does not cost the roll-up its hydration", async () => {
		h.handlers["evidence.waivers"] = async () => {
			throw new Error("boom");
		};
		const state = await dehydratedFor({});
		expect(state.queries.map((q) => q.queryKey)).toEqual([[["evidence", "page"], { input: {}, type: "query" }]]);
		expect(h.calls, "no retry holds the first byte").toHaveLength(2);
	});
});
