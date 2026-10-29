// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6336: the support case route puts the WHOLE case view in its first paint. The case itself was
// already prefetched (#6130); the classification row under the subject was not, so the server HTML
// had no "Classify" and the browser read three procedures on mount to draw it (RUBRIC B1), and a
// failure of those reads made the button vanish with no error in its place (B4). The route now
// prefetches them beside the case, under the keys `ClassificationControl` asks for — and a failure
// of one of them is the browser's to ask again: it never fails the case, and is never shipped as a
// cached error.

import { type DehydratedState, QueryClient } from "@tanstack/react-query";
import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const CASE_ID = "7f1f2c1e-5b0a-4c4e-9d5e-2a6b8f0c1d23";

/** The classification reads the case view's row makes. */
type Side = "canEdit" | "assignments" | "dimensions";
const SIDE: Side[] = ["canEdit", "assignments", "dimensions"];

/** What the stubbed read router does on the next render. */
interface RouteState {
	/** What `support.case` does: answer, refuse as not found, or fail. */
	caseRead: "ok" | "not-found" | "fail";
	/** The classification read that fails, if any. */
	failing: Side | null;
	/** Every procedure the route called, in order. */
	calls: string[];
}

const h = vi.hoisted((): RouteState => ({ caseRead: "ok", failing: null, calls: [] }));

vi.mock("@/lib/rpc/server", async () => {
	const { os, createRouterClient } = await import("@orpc/server");
	const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
	const { z } = await import("zod");
	const base = os.errors({ NOT_FOUND: { status: 404, message: "Not found." } });
	/** Throws when `name` is the classification read the test fails. */
	const maybeFail = (name: string) => {
		h.calls.push(`classification.${name}`);
		if (h.failing === name) throw new Error("classification read failed");
	};
	const router = {
		support: {
			case: base.input(z.object({ id: z.string() })).handler(async ({ input, errors }) => {
				h.calls.push("support.case");
				if (h.caseRead === "not-found") throw errors.NOT_FOUND();
				if (h.caseRead === "fail") throw new Error("database unavailable");
				return { case: { id: input.id }, messages: [], attachments: [] };
			}),
		},
		classification: {
			canEdit: base.handler(async () => {
				maybeFail("canEdit");
				return true;
			}),
			assignments: base
				.input(z.object({ kind: z.string(), resourceId: z.string() }))
				.handler(async () => {
					maybeFail("assignments");
					return [];
				}),
			dimensions: base.input(z.object({ search: z.string().optional() })).handler(async () => {
				maybeFail("dimensions");
				return [];
			}),
		},
	};
	const utils = createTanstackQueryUtils(createRouterClient(router));
	return { serverOrpc: () => utils };
});
// The real client's retry (`retry: 1`), without its delay — so a side read that DOES retry shows up
// as a second call rather than as a slower test.
vi.mock("@/lib/query/client", () => ({
	getQueryClient: () => new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } }),
}));
vi.mock("@/components/support/cases/case-detail", () => ({ CaseDetail: () => null }));

import CaseDetailRoute from "@/app/(private)/[org]/~/support/cases/[id]/page";

/** Renders the route for org `acme` and case `id`. */
function route(id: string = CASE_ID): Promise<ReactNode> {
	return CaseDetailRoute({ params: Promise.resolve({ org: "acme", id }) });
}

/** Every query key the route handed the browser. */
function dehydratedKeys(node: ReactNode): unknown[] {
	if (!isValidElement<{ state?: DehydratedState }>(node) || node.props.state === undefined) {
		throw new Error("the route did not render a HydrationBoundary with a state");
	}
	return node.props.state.queries.map((q) => q.queryKey);
}

/** The browser's keys (`orpc.<path>.queryKey`): `[path, { input?, type: "query" }]`. */
const KEYS: Record<"case" | Side, unknown> = {
	case: [["support", "case"], { input: { id: CASE_ID }, type: "query" }],
	canEdit: [["classification", "canEdit"], { type: "query" }],
	assignments: [
		["classification", "assignments"],
		{ input: { kind: "support_case", resourceId: CASE_ID }, type: "query" },
	],
	dimensions: [["classification", "dimensions"], { input: {}, type: "query" }],
};

/** The `digest` Next puts on its control-flow throws, or undefined for an ordinary error. */
function digestOf(e: unknown): string | undefined {
	return typeof e === "object" && e !== null && "digest" in e && typeof e.digest === "string"
		? e.digest
		: undefined;
}

/** The digest `notFound()` throws: the segment's `not-found.tsx` renders "Case not found". */
const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";

beforeEach(() => {
	h.caseRead = "ok";
	h.failing = null;
	h.calls = [];
});

describe("the support case route's first paint (#6336)", () => {
	it("hands the browser the case AND the classification row's three reads, under the browser's keys", async () => {
		const keys = dehydratedKeys(await route());
		expect(keys).toContainEqual(KEYS.case);
		expect(keys).toContainEqual(KEYS.canEdit);
		expect(keys).toContainEqual(KEYS.assignments);
		expect(keys).toContainEqual(KEYS.dimensions);
	});

	it.each(SIDE)(
		"a failed %s read leaves the case rendering, and is not shipped as a cached answer",
		async (name) => {
			h.failing = name;
			const keys = dehydratedKeys(await route());
			expect(keys).toContainEqual(KEYS.case);
			expect(keys).not.toContainEqual(KEYS[name]);
			// Its siblings still made it: one failed read takes down only itself.
			for (const other of SIDE.filter((n) => n !== name)) {
				expect(keys).toContainEqual(KEYS[other]);
			}
		},
	);

	it("asks each side read once — no server-side retry delays the case for a button", async () => {
		h.failing = "canEdit";
		await route();
		expect(h.calls.filter((c) => c === "classification.canEdit")).toHaveLength(1);
	});

	it("a case the caller cannot see is the segment's not-found", async () => {
		h.caseRead = "not-found";
		const thrown = await route().then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(digestOf(thrown)).toBe(NOT_FOUND);
	});

	it("any other failed case read propagates to the route's error boundary — never a not-found", async () => {
		h.caseRead = "fail";
		const thrown = await route().then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(thrown).toBeInstanceOf(Error);
		expect(digestOf(thrown)).toBeUndefined();
	});

	it("an id that is not a case id is a not-found, and reads nothing", async () => {
		const thrown = await route("not-a-uuid").then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(digestOf(thrown)).toBe(NOT_FOUND);
		expect(h.calls).toEqual([]);
	});
});
