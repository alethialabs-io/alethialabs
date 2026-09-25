// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #4133's silent half. `currentActor()` takes the tenant from the address, and it learns the
// address from a header `proxy.ts` publishes. If the proxy stops setting it — a refactor, a
// narrowed matcher, an early `return` added above it — there is no error and no red test
// elsewhere: `urlScopedOrgId` reads null, every reader falls back to `active_organization_id`, and
// the console is silently back on the session it used to trust. That is the defect wearing a pass.
//
// So the publication is asserted here, on its own, including on the branches that return early.

import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import {
	ACTION_FORWARDED_HEADER,
	ORG_PATH_HEADER,
	namesNoOrg,
} from "@/lib/authz/org-path";

const at = (url: string, headers?: HeadersInit) =>
	new NextRequest(new Request(`https://console.example.invalid${url}`, { headers }));

/**
 * What the proxy forwarded to the app. Next carries an overridden request header on the RESPONSE
 * as `x-middleware-request-<name>`, and names it in `x-middleware-override-headers` — the second is
 * what makes the first apply, so both are asserted.
 */
async function published(res: Promise<Response>): Promise<string | null> {
	const r = await res;
	const overridden = (r.headers.get("x-middleware-override-headers") ?? "").split(",");
	if (!overridden.includes(ORG_PATH_HEADER)) return null;
	return r.headers.get(`x-middleware-request-${ORG_PATH_HEADER}`);
}

describe("the proxy publishes the request path", () => {
	it("on an org-scoped route, which is the one that decides the tenant", async () => {
		await expect(published(proxy(at("/acme/hero-app/environments")))).resolves.toBe(
			"/acme/hero-app/environments",
		);
	});

	it("...on the personal segment too", async () => {
		await expect(published(proxy(at("/~/evidence")))).resolves.toBe("/~/evidence");
	});

	it("...and on a route with no org in it at all", async () => {
		await expect(published(proxy(at("/login")))).resolves.toBe("/login");
	});

	// THE TWO BRANCHES THAT PUBLISH NOTHING, pinned so they stay the only two. Both RETURN a
	// redirect, so no app code runs on them and no reader is left resolving a tenant from a
	// session — the header's absence there costs nothing. A third early return added above the
	// publication would be a silent regression, and it would land here as a change to this list.
	it("except on a redirect, where no reader runs — the sign-in bounce", async () => {
		await expect(published(proxy(at("/dashboard")))).resolves.toBeNull();
	});

	it("...and the /auth/signin → /login back-compat redirect", async () => {
		await expect(published(proxy(at("/auth/signin")))).resolves.toBeNull();
	});

	// THE ANTI-FORGERY PROPERTY. `currentActor()` trusts this header completely, so a client that
	// sends its own must not be believed. `Headers.set` replaces rather than appends; this pins it,
	// because the difference between `set` and `append` here is the difference between a header the
	// proxy owns and a tenancy selector any browser can type.
	it("...REPLACING a value the client tried to send, never merging with it", async () => {
		const res = proxy(at("/acme/hero-app", { [ORG_PATH_HEADER]: "/victim-org/secrets" }));
		await expect(published(res)).resolves.toBe("/acme/hero-app");
	});
});

// #5001. Next forwards a server action posted to a page whose bundle lacks it: it re-POSTs to the
// worker's ROUTE PATTERN (`/[org]`), copies the original headers — including the path this proxy
// published on the first pass — and adds `x-action-forwarded: 1`. Publishing the pattern overwrote
// the real address, `currentActor()` looked up an org slugged `[org]`, threw notFound(), and Next
// answered with the `/[org]` tree for an org named "[org]": "Organization not found" on the
// user's own org, in the qa gate on promotion #4959.
describe("a server action Next forwards to another worker", () => {
	const firstPass = "/acme/~/new";
	/** Any action id: the forwarded POST keeps `next-action`; Next's redirect render drops it. */
	const ACTION_ID = "00ab12cd34";

	it("keeps the address published on the first pass, not the worker's route pattern", async () => {
		const res = proxy(
			at("/[org]", { [ACTION_FORWARDED_HEADER]: "1", [ORG_PATH_HEADER]: firstPass, "next-action": ACTION_ID }),
		);
		await expect(published(res)).resolves.toBe(firstPass);
	});

	it("...whether the pattern arrives raw or percent-encoded", async () => {
		const res = proxy(
			at("/%5Borg%5D", { [ACTION_FORWARDED_HEADER]: "1", [ORG_PATH_HEADER]: firstPass, "next-action": ACTION_ID }),
		);
		await expect(published(res)).resolves.toBe(firstPass);
	});

	// The worker Next picks is the FIRST in its manifest that has the action, and that can be a
	// static page: `/start` imports billing.ts, `/` and `/dashboard` import resolve.ts, and `[org]`
	// pages import both. Publishing `/start` would make urlOrgSlug() read a reserved segment and fall
	// back to the session's org — the action run against a tenant the address did not name.
	it.each(["/start", "/", "/accept-terms"])(
		"keeps the first-pass address when the worker is the static page %s",
		async (target) => {
			const res = proxy(
				at(target, { [ACTION_FORWARDED_HEADER]: "1", [ORG_PATH_HEADER]: firstPass, "next-action": ACTION_ID }),
			);
			await expect(published(res)).resolves.toBe(firstPass);
		},
	);

	// THE SECURITY CASE. The `[org]` layout scopes from `params.org` — the FIRST segment — and the
	// readers under it from this header. A bracket in a LATER segment must not buy the carried value
	// a way past a concrete first segment, or one request could scope the layout to org-a and the
	// page to org-b.
	it.each(["/org-a/%5Bx%5D", "/org-a/[x]", "/~/[x]"])(
		"a concrete org first segment wins even with a bracket later: %s",
		async (target) => {
			const res = proxy(
				at(target, {
					[ACTION_FORWARDED_HEADER]: "1",
					[ORG_PATH_HEADER]: "/org-b",
					"next-action": ACTION_ID,
				}),
			);
			await expect(published(res)).resolves.toBe(target);
		},
	);

	// A forwarded action that calls redirect(): Next renders the TARGET page with a copy of the
	// forwarded headers minus `next-action`. That render must be scoped by its own address, or a
	// redirect to `/dashboard` after leaving `acme` renders the dashboard as `acme` (#5005 review).
	it.each(["/accept-terms", "/start", "/"])(
		"the redirect render of a forwarded action (no next-action) publishes its own path: %s",
		async (target) => {
			const res = proxy(at(target, { [ACTION_FORWARDED_HEADER]: "1", [ORG_PATH_HEADER]: firstPass }));
			await expect(published(res)).resolves.toBe(target);
		},
	);

	// The exception is as narrow as its four conditions. Each case below drops one of them, and
	// each is the anti-forgery replacement above, unchanged.
	it("a real address still wins over an inbound value, even with the forwarded header", async () => {
		const res = proxy(
			at("/acme/hero-app", {
				[ACTION_FORWARDED_HEADER]: "1",
				[ORG_PATH_HEADER]: "/victim-org/secrets",
			}),
		);
		await expect(published(res)).resolves.toBe("/acme/hero-app");
	});

	it("a route-pattern path WITHOUT the forwarded header publishes the path itself", async () => {
		const res = proxy(at("/[org]", { [ORG_PATH_HEADER]: "/victim-org/secrets" }));
		await expect(published(res)).resolves.toBe("/[org]");
	});

	it("a forwarded request with nothing carried publishes the path itself", async () => {
		const res = proxy(at("/[org]", { [ACTION_FORWARDED_HEADER]: "1" }));
		await expect(published(res)).resolves.toBe("/[org]");
	});
});

describe("namesNoOrg — the first segment decides, the only one urlOrgSlug() reads", () => {
	it.each([
		"/",
		"/[org]",
		"/[org]/~/new",
		"/%5Borg%5D",
		"/%5borg%5d/x",
		"/start",
		"/dashboard/[[...rest]]",
		"/cli/login",
		"/onboarding",
		"/accept-terms",
	])("%s names no org", (p) => expect(namesNoOrg(p)).toBe(true));
	it.each([
		"/acme",
		"/acme/~/new",
		"/e2e-hobby-e2e-ownerhobby-1/~/new",
		"/org-a/[x]",
		"/org-a/%5Bx%5D",
		"/~/evidence",
		"/~/[x]",
		"/[slug]",
		"/[ORG]",
		"/[org]x",
	])("%s names an org, or is not the [org] pattern", (p) => expect(namesNoOrg(p)).toBe(false));
});
