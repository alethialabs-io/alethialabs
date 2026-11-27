// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The consent screen's rules (AGT-L2, SPEC §5b): the starting org and ticks, what blocks Allow, the
// button's words, the re-consent diff, and the signed query handed back to Better Auth.

import { describe, expect, it } from "vitest";
import {
	allowBlockers,
	allowLabel,
	type ConsentOrgView,
	consentChanges,
	defaultOrgId,
	defaultProjects,
	defaultScopes,
	isAllowBlocked,
	joinWithAnd,
	offeredChoice,
	reconsentMark,
	signedOAuthQuery,
} from "@/components/auth/consent/consent-model";

/** One org as the screen sees it. */
function org(extra: Partial<ConsentOrgView> = {}): ConsentOrgView {
	return {
		id: "org-acme",
		name: "acme",
		role: "admin",
		roleLabel: "Admin",
		personal: false,
		refusal: null,
		agentsKeptOffProduction: false,
		roleAllows: ["read", "design", "plan", "apply", "destroy"],
		grantable: ["read", "design", "plan", "apply", "destroy"],
		projects: [
			{ id: "p1", name: "payments-api" },
			{ id: "p2", name: "web" },
		],
		existing: null,
		...extra,
	};
}

describe("starting choices", () => {
	it("ticks every grantable permission except Ask to destroy", () => {
		expect(defaultScopes(org())).toEqual(["read", "design", "plan", "apply"]);
	});

	it("ticks nothing the role cannot use, and nothing in an org that refuses the app", () => {
		expect(defaultScopes(org({ grantable: ["read"] }))).toEqual(["read"]);
		expect(defaultScopes(org({ refusal: "agent_access_disabled" }))).toEqual([]);
	});

	it("opens on the first org that does not refuse the app", () => {
		const orgs = [org({ id: "a", refusal: "client_not_allowed" }), org({ id: "b" })];
		expect(defaultOrgId(orgs)).toBe("b");
		expect(defaultOrgId([org({ id: "a", refusal: "client_not_allowed" })])).toBe("a");
		expect(defaultOrgId([])).toBeNull();
	});

	it("starts a first connection on all projects, and a re-consent on the projects it already has", () => {
		expect(defaultProjects(org())).toEqual({ mode: "all", ids: [] });
		const narrowed = org({ existing: { scopes: ["read"], projectIds: ["p2", "gone"], createdAt: "2026-11-03T00:00:00Z" } });
		expect(defaultProjects(narrowed)).toEqual({ mode: "some", ids: ["p2"] });
	});
});

describe("what may be sent", () => {
	it("drops ticks the chosen org does not offer", () => {
		expect(offeredChoice(org({ grantable: ["read"] }), ["read", "apply", "destroy"])).toEqual(["read"]);
	});
});

describe("what blocks Allow", () => {
	it("an org that refuses the app", () => {
		const b = allowBlockers(org({ refusal: "client_not_allowed" }), ["read"], { mode: "all", ids: [] });
		expect(b.refused).toBe(true);
		expect(isAllowBlocked(b)).toBe(true);
	});

	it("nothing ticked", () => {
		expect(allowBlockers(org(), [], { mode: "all", ids: [] }).noneTicked).toBe(true);
	});

	it("only-these-projects with none chosen, but not when the org has no projects", () => {
		expect(allowBlockers(org(), ["read"], { mode: "some", ids: [] }).noProject).toBe(true);
		expect(allowBlockers(org({ projects: [] }), ["read"], { mode: "some", ids: [] }).noProject).toBe(false);
	});

	it("nothing when a permission and the projects are chosen", () => {
		expect(isAllowBlocked(allowBlockers(org(), ["read"], { mode: "some", ids: ["p1"] }))).toBe(false);
	});
});

describe("the Allow button", () => {
	it("says what the person is about to do", () => {
		expect(allowLabel({ verified: true, reconsent: false, submitting: false })).toBe("Allow");
		expect(allowLabel({ verified: true, reconsent: true, submitting: false })).toBe("Update connection");
		expect(allowLabel({ verified: false, reconsent: true, submitting: false })).toBe("Allow unverified app");
		expect(allowLabel({ verified: true, reconsent: false, submitting: true })).toBe("Allowing…");
	});
});

describe("re-consent", () => {
	const existing = { scopes: ["read" as const, "design" as const, "plan" as const, "apply" as const], projectIds: null, createdAt: "2026-11-03T00:00:00Z" };

	it("marks new and removed permissions", () => {
		expect(reconsentMark(existing, true, "destroy")).toBe("new");
		expect(reconsentMark(existing, false, "design")).toBe("removing");
		expect(reconsentMark(existing, true, "read")).toBeNull();
		expect(reconsentMark(null, true, "destroy")).toBeNull();
	});

	it("sums up what changes against the existing connection", () => {
		const changes = consentChanges(org({ existing }), ["read", "plan", "apply", "destroy"], { mode: "all", ids: [] });
		expect(changes).toEqual({ adds: ["destroy"], removes: ["design"], projects: { same: true, label: "all projects" } });
		const narrowed = consentChanges(org({ existing }), ["read"], { mode: "some", ids: ["p2"] });
		expect(narrowed?.projects).toEqual({ same: false, label: "web" });
	});

	it("has no diff for a first connection", () => {
		expect(consentChanges(org(), ["read"], { mode: "all", ids: [] })).toBeNull();
	});
});

describe("joinWithAnd", () => {
	it("joins a list as a sentence does", () => {
		expect(joinWithAnd(["a"])).toBe("a");
		expect(joinWithAnd(["a", "b"])).toBe("a and b");
		expect(joinWithAnd(["a", "b", "c"])).toBe("a, b and c");
	});
});

describe("signedOAuthQuery", () => {
	it("keeps only the signed parameters and the signature, as Better Auth's client does", () => {
		const q = signedOAuthQuery({
			client_id: "https://cursor.com/c.json",
			scope: "openid read",
			exp: "100",
			sig: "s",
			ba_param: ["client_id", "exp", "scope"],
			utm_source: "tracker",
		});
		const params = new URLSearchParams(q);
		expect(params.get("utm_source")).toBeNull();
		expect(params.get("client_id")).toBe("https://cursor.com/c.json");
		expect(params.get("sig")).toBe("s");
		expect(params.getAll("ba_param")).toEqual(["client_id", "exp", "scope"]);
	});

	it("passes a query that names no signed parameters whole", () => {
		expect(new URLSearchParams(signedOAuthQuery({ client_id: "c", sig: "s", exp: "1" })).get("client_id")).toBe("c");
		expect(signedOAuthQuery({})).toBe("");
	});
});
