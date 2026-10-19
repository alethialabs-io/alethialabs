// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6113 (ADR 0005 D1): the read router's route handler. Driven through the REAL oRPC client and
// handler (only the actor resolver and the jobs reader are stubbed), so the wire format, the GET
// method and the prefix matching are the shipped ones.
//
// Pins: the tenant is decided before oRPC runs and a non-member gets a 404 (not oRPC's 500 for
// `notFound()`, stress test R4); the resolved actor is bound for the reader (`runWithActor`); a
// preset range is resolved on the server; and every procedure in the router is a GET read (R12).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { currentActor, getJobsPage, hasAcceptedCurrentDocuments } = vi.hoisted(() => ({
	currentActor: vi.fn(),
	getJobsPage: vi.fn(),
	hasAcceptedCurrentDocuments: vi.fn(),
}));
vi.mock("@/lib/billing/eligibility", () => ({ hasAcceptedCurrentDocuments }));
vi.mock("@/lib/authz/guard", () => ({ currentActor }));
vi.mock("@/app/server/actions/jobs", () => ({ getJobsPage }));

import { createORPCClient, isDefinedError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { GET, POST } from "@/app/(private)/[org]/~/rpc/[[...rest]]/route";
import { getInjectedActor } from "@/lib/authz/actor-context";
import { ForbiddenError } from "@/lib/authz/types";
import { ActionRefusal } from "@/lib/actions/result";
import { UnauthorizedError } from "@/lib/auth/errors";
import { router, type AppRouter } from "@/lib/rpc/router";

const ACME = { userId: "user-1", orgId: "org-acme" };
const PAGE = { rows: [], facets: {}, total: 0 };

/** A browser-shaped client whose transport is the route handler itself. */
function clientFor(base: string): RouterClient<AppRouter> {
	return createORPCClient(
		new RPCLink({
			url: base,
			method: () => "GET",
			fetch: (request) => (request.method === "GET" ? GET(request) : POST(request)),
		}),
	);
}

/** Node's `notFound()` signal, as `urlScopedOrgId` throws it for a non-member. */
function notFoundSignal(): Error {
	return Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), {
		digest: "NEXT_HTTP_ERROR_FALLBACK;404",
	});
}

beforeEach(() => {
	currentActor.mockReset();
	getJobsPage.mockReset();
	getJobsPage.mockResolvedValue(PAGE);
	hasAcceptedCurrentDocuments.mockReset();
	hasAcceptedCurrentDocuments.mockResolvedValue(true);
});

describe("the tenant is decided before the procedure runs", () => {
	it("serves a member and binds the resolved actor for the reader", async () => {
		currentActor.mockResolvedValue(ACME);
		let seen: unknown;
		getJobsPage.mockImplementation(async () => {
			seen = getInjectedActor();
			return PAGE;
		});
		const result = await clientFor("http://console.test/acme/~/rpc").jobs.page({
			range: { preset: "7d" },
		});
		expect(result).toEqual(PAGE);
		expect(seen).toEqual(ACME);
	});

	it("answers a non-member with 404, never oRPC's 500", async () => {
		currentActor.mockRejectedValue(notFoundSignal());
		const res = await GET(new Request("http://console.test/other/~/rpc/jobs/page"));
		expect(res.status).toBe(404);
		expect(getJobsPage).not.toHaveBeenCalled();
	});

	it.each([
		["no session", new UnauthorizedError(), 401],
		["a PDP refusal", new ForbiddenError("view", { type: "org", id: "x" }), 403],
	])("answers %s with %i and runs nothing", async (_label, error, status) => {
		currentActor.mockRejectedValue(error);
		const res = await GET(new Request("http://console.test/acme/~/rpc/jobs/page"));
		expect(res.status).toBe(status);
		expect(getJobsPage).not.toHaveBeenCalled();
	});

	it("404s an address whose first segment names no org, instead of falling back to the session", async () => {
		currentActor.mockResolvedValue(ACME);
		const res = await GET(new Request("http://console.test/docs/~/rpc/jobs/page"));
		expect(res.status).toBe(404);
		expect(currentActor).not.toHaveBeenCalled();
	});

	it("refuses a user who has not accepted the current Terms, before running anything (R14a)", async () => {
		currentActor.mockResolvedValue(ACME);
		hasAcceptedCurrentDocuments.mockResolvedValue(false);
		const res = await GET(new Request("http://console.test/acme/~/rpc/jobs/page"));
		expect(res.status).toBe(403);
		expect(getJobsPage).not.toHaveBeenCalled();
	});

	it("404s a procedure that does not exist", async () => {
		currentActor.mockResolvedValue(ACME);
		const res = await GET(new Request("http://console.test/acme/~/rpc/nope/missing"));
		expect(res.status).toBe(404);
	});

	it("serves the personal scope at /~/~/rpc through the same handler", async () => {
		currentActor.mockResolvedValue({ userId: "user-1", orgId: "user-1" });
		const result = await clientFor("http://console.test/~/~/rpc").jobs.page({
			range: { preset: "7d" },
		});
		expect(result).toEqual(PAGE);
	});

	it("marks every response private", async () => {
		currentActor.mockResolvedValue(ACME);
		const res = await GET(new Request("http://console.test/acme/~/rpc/nope/missing"));
		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
	});
});

describe("jobs.page", () => {
	it("resolves a preset to concrete bounds on the server, at read time", async () => {
		currentActor.mockResolvedValue(ACME);
		await clientFor("http://console.test/acme/~/rpc").jobs.page({
			range: { preset: "12mo" },
			statuses: ["FAILED"],
		});
		const query = getJobsPage.mock.calls[0]?.[0];
		expect(query.statuses).toEqual(["FAILED"]);
		expect(Date.parse(query.to) - Date.parse(query.from)).toBeGreaterThan(300 * 86_400_000);
		expect(Math.abs(Date.parse(query.to) - Date.now())).toBeLessThan(60_000);
	});

	it("rejects input outside the schema instead of passing it to the reader", async () => {
		currentActor.mockResolvedValue(ACME);
		await expect(
			clientFor("http://console.test/acme/~/rpc").jobs.page({
				// @ts-expect-error — an unknown preset is exactly what the schema must refuse
				range: { preset: "forever" },
			}),
		).rejects.toThrow();
		expect(getJobsPage).not.toHaveBeenCalled();
	});
});

describe("a reader's refusal reaches the browser as a TYPED error, not an empty page or a 500 (R11)", () => {
	/** The error a call rejects with. */
	async function refusalOf(thrown: unknown): Promise<unknown> {
		currentActor.mockResolvedValue(ACME);
		getJobsPage.mockRejectedValue(thrown);
		return clientFor("http://console.test/acme/~/rpc")
			.jobs.page({ range: { preset: "7d" } })
			.then(() => "resolved", (e: unknown) => e);
	}

	it.each([
		["a PDP refusal", new ForbiddenError("view", { type: "job" }), "FORBIDDEN"],
		["no session", new UnauthorizedError(), "UNAUTHORIZED"],
		["notFound()", Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" }), "NOT_FOUND"],
		["a deliberate not-found", new ActionRefusal("not-found", "That job is gone."), "NOT_FOUND"],
		["a plan gate", new ActionRefusal("entitlement", "Runners are a Pro feature.", "runners"), "ENTITLEMENT_REQUIRED"],
	])("%s → %s", async (_label, thrown, code) => {
		const error = await refusalOf(thrown);
		expect(isDefinedError(error)).toBe(true);
		expect(error).toMatchObject({ code });
	});

	it("keeps an unexpected error's text out of the response", async () => {
		const error = await refusalOf(new Error("relation \"jobs\" does not exist"));
		expect(isDefinedError(error)).toBe(false);
		expect(JSON.stringify(error)).not.toContain("relation");
	});
});

/** Every procedure in a router, depth-first, with its dotted path. */
function procedures(node: object, path: string[] = []): Array<{ path: string; method: unknown }> {
	const out: Array<{ path: string; method: unknown }> = [];
	for (const [key, value] of Object.entries(node)) {
		if (value && typeof value === "object" && "~orpc" in value) {
			const def = value["~orpc"];
			const method = def && typeof def === "object" && "route" in def && def.route && typeof def.route === "object" && "method" in def.route ? def.route.method : undefined;
			out.push({ path: [...path, key].join("."), method });
		} else if (value && typeof value === "object") {
			out.push(...procedures(value, [...path, key]));
		}
	}
	return out;
}

describe("the router carries reads only (stress test R12: no CSRF plugin in oRPC 1.x)", () => {
	it("every procedure is declared GET", () => {
		const all = procedures(router);
		expect(all.length).toBeGreaterThan(0);
		// Asserting on the whole list names any non-GET procedure by its path in the failure diff.
		expect(all.filter((p) => p.method !== "GET")).toEqual([]);
	});
});
