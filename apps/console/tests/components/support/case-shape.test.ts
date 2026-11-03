// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6354 (B2): the case-detail route's loading form is drawn in the shape of the case the request
// addresses, read on the server before it draws. These pin the three halves:
//
// - `caseShapeOf`: what of a case the layout varies by — closed or not, how many attachments, and
//   each message's side and paragraphs (the newest SHAPED_MESSAGES of them);
// - `caseIdFromPath`: the id comes from the address the proxy publishes (a `loading.tsx` gets no
//   params), and only the case route's own address yields one;
// - `readCaseShape`: it reads the page's own key through the request's query client — so the page's
//   read in the same request is answered from it, not made twice — and any failure is the opening
//   shape, never a throw (the page owns not-found and errors).

import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const CASE_ID = "7f1f2c1e-5b0a-4c4e-9d5e-2a6b8f0c1d23";

/** What the stubbed read router and request do on the next call. */
interface State {
	/** The path the proxy published for the request. */
	path: string | null;
	/** What `support.case` does: answer, refuse as not found, or fail. */
	caseRead: "ok" | "not-found" | "fail";
	/** Every `support.case` read, by input id. */
	reads: string[];
	/** The request's query client — ONE per test, as `cache()` makes it one per request. */
	client: QueryClient | null;
}

const h = vi.hoisted((): State => ({ path: null, caseRead: "ok", reads: [], client: null }));

/** The test's request client. */
function client(): QueryClient {
	if (h.client === null) throw new Error("no request client");
	return h.client;
}

vi.mock("next/headers", () => ({
	headers: async () => new Headers(h.path === null ? {} : { "x-alethia-path": h.path }),
}));
vi.mock("@/lib/query/client", () => ({ getQueryClient: () => client() }));
vi.mock("@/lib/rpc/server", async () => {
	const { os, createRouterClient } = await import("@orpc/server");
	const { createTanstackQueryUtils } = await import("@orpc/tanstack-query");
	const { z } = await import("zod");
	const base = os.errors({ NOT_FOUND: { status: 404, message: "Not found." } });
	const at = new Date("2026-10-19T08:00:00.000Z");
	const router = {
		support: {
			case: base.input(z.object({ id: z.string() })).handler(async ({ input, errors }) => {
				h.reads.push(input.id);
				if (h.caseRead === "not-found") throw errors.NOT_FOUND();
				if (h.caseRead === "fail") throw new Error("database unavailable");
				return {
					case: { id: input.id, status: "closed" },
					messages: [
						{ id: "m1", author_type: "customer", body: "First line\nsame paragraph.\n\nSecond paragraph.", created_at: at },
						{ id: "m2", author_type: "staff", body: "A reply.", created_at: at },
					],
					attachments: [{ id: "a1" }, { id: "a2" }],
				};
			}),
		},
	};
	const utils = createTanstackQueryUtils(createRouterClient(router));
	return { serverOrpc: () => utils };
});

import { OPENING_CASE_SHAPE, SHAPED_MESSAGES, bodyParagraphs, caseShapeOf } from "@/components/support/cases/case-shape";
import { caseIdFromPath, readCaseShape } from "@/components/support/cases/read-case-shape";

/** A message of `author_type` with `body`. */
function msg(author_type: string, body: string) {
	return { author_type, body };
}

beforeEach(() => {
	h.path = `/acme/~/support/cases/${CASE_ID}`;
	h.caseRead = "ok";
	h.reads = [];
	h.client = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0, staleTime: 30_000 } } });
});

describe("caseShapeOf: what the case view's layout varies by", () => {
	it("is the opening shape when there is no read: open, no attachments, one requester message of unknown text", () => {
		expect(caseShapeOf(undefined)).toEqual({
			closed: false,
			attachments: 0,
			messages: [{ fromCustomer: true, paragraphs: null }],
		});
	});

	it("reads closed from the status, and only from `closed`", () => {
		const of = (status: string) => caseShapeOf({ case: { status }, attachments: [], messages: [] }).closed;
		expect(of("closed")).toBe(true);
		for (const status of ["open", "pending_support", "pending_customer", "resolved"]) expect(of(status)).toBe(false);
	});

	it("counts the attachments and keeps each message's side and paragraphs, oldest first", () => {
		const shape = caseShapeOf({
			case: { status: "open" },
			attachments: [{}, {}, {}],
			messages: [msg("customer", "Hello"), msg("staff", "Hi"), msg("ai", "Note"), msg("customer", "Thanks")],
		});
		expect(shape.attachments).toBe(3);
		expect(shape.messages).toEqual([
			{ fromCustomer: true, paragraphs: ["Hello"] },
			{ fromCustomer: false, paragraphs: ["Hi"] },
			{ fromCustomer: false, paragraphs: ["Note"] },
			{ fromCustomer: true, paragraphs: ["Thanks"] },
		]);
	});

	it("keeps only the NEWEST messages past the cap — the thread opens at the end", () => {
		const messages = Array.from({ length: SHAPED_MESSAGES + 5 }, (_, i) => msg("customer", `m${i}`));
		const shape = caseShapeOf({ case: { status: "open" }, attachments: [], messages });
		expect(shape.messages).toHaveLength(SHAPED_MESSAGES);
		expect(shape.messages[0]?.paragraphs).toEqual(["m5"]);
		expect(shape.messages.at(-1)?.paragraphs).toEqual([`m${SHAPED_MESSAGES + 4}`]);
	});
});

describe("bodyParagraphs: a body in the blocks its markdown renders as", () => {
	it("splits on a blank line, joins a single newline as a soft break, and drops empty paragraphs", () => {
		expect(bodyParagraphs("one\ntwo\n\n  \n\nthree  four\n\n")).toEqual(["one two", "three four"]);
		expect(bodyParagraphs("a\n \nb")).toEqual(["a", "b"]);
		expect(bodyParagraphs("")).toEqual([]);
	});
});

describe("caseIdFromPath: only the case route's own address names a case", () => {
	it("reads the id from an org's and the personal scope's case address", () => {
		expect(caseIdFromPath(`/acme/~/support/cases/${CASE_ID}`)).toBe(CASE_ID);
		expect(caseIdFromPath(`/~/~/support/cases/${CASE_ID}/`)).toBe(CASE_ID);
	});

	it("is null for no path, another route, a deeper path, or a last segment that is not a case id", () => {
		expect(caseIdFromPath(null)).toBeNull();
		expect(caseIdFromPath("/acme/~/support/my-cases")).toBeNull();
		expect(caseIdFromPath(`/acme/~/support/cases/${CASE_ID}/extra`)).toBeNull();
		expect(caseIdFromPath(`/acme/proj/support/cases/${CASE_ID}`)).toBeNull();
		expect(caseIdFromPath("/acme/~/support/cases/not-a-uuid")).toBeNull();
	});
});

describe("readCaseShape: the page's own read, before the loading form draws", () => {
	it("is the shape of the case the address names", async () => {
		expect(await readCaseShape()).toEqual({
			closed: true,
			attachments: 2,
			messages: [
				{ fromCustomer: true, paragraphs: ["First line same paragraph.", "Second paragraph."] },
				{ fromCustomer: false, paragraphs: ["A reply."] },
			],
		});
		expect(h.reads).toEqual([CASE_ID]);
	});

	it("reads under the page's key, so the page's read in the same request is answered from it", async () => {
		await readCaseShape();
		const { serverOrpc } = await import("@/lib/rpc/server");
		await client().fetchQuery(serverOrpc().support.case.queryOptions({ input: { id: CASE_ID } }));
		expect(h.reads).toEqual([CASE_ID]);
	});

	it("reads nothing when the address is not a case's", async () => {
		for (const path of [null, "/acme/~/support/my-cases", "/acme/~/support/cases/nope"]) {
			h.path = path;
			expect(await readCaseShape()).toEqual(OPENING_CASE_SHAPE);
		}
		expect(h.reads).toEqual([]);
	});

	const FAILURES: State["caseRead"][] = ["not-found", "fail"];
	it.each(FAILURES)(
		"a %s read is the opening shape, asked once, and leaves the page a read of its own",
		async (outcome) => {
			h.caseRead = outcome;
			expect(await readCaseShape()).toEqual(OPENING_CASE_SHAPE);
			expect(h.reads).toEqual([CASE_ID]);
			// No data was cached, so the page's own read asks again rather than inheriting a guess.
			const { serverOrpc } = await import("@/lib/rpc/server");
			await client().fetchQuery(serverOrpc().support.case.queryOptions({ input: { id: CASE_ID } })).catch(() => {});
			expect(h.reads.length).toBeGreaterThan(1);
		},
	);
});
