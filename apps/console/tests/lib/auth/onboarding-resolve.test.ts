// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `resolveOnboarding` — one test per row of the spec's table (wizards-and-state.md §4.6) — and the
// deductions onboarding shows instead of asking (the maintainer's ruling of 2026-11-21: "as little
// input from the user as possible, as much as we can deduce").

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/authz/grants", () => ({ ensureMemberGrant: vi.fn() }));
vi.mock("@/lib/observability/log", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import {
	countryFromAcceptLanguage,
	countryFromEmail,
	deduceBillingCountry,
	isPersonalMailDomain,
	resolveOnboarding,
	suggestedPayerCapacity,
} from "@/lib/auth/onboarding";
import { getServiceDb } from "@/lib/db";

const ORG_ROW = { id: "org-1", name: "Acme's Org", slug: "acme", logo: null, role: "owner" };

/**
 * A drizzle-ish db whose every awaited query takes the next answer off `answers`. An `Error` in the
 * queue is thrown by that query instead.
 */
function queueDb(answers: unknown[]) {
	const queue = [...answers];
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		select: () => chain,
		from: () => chain,
		innerJoin: () => chain,
		where: () => chain,
		orderBy: () => chain,
		limit: () => chain,
		then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
			const next = queue.shift();
			if (next instanceof Error) reject(next);
			else resolve(next);
		},
	});
	vi.mocked(getServiceDb).mockReturnValue(chain as never);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("resolveOnboarding — one result per server state", () => {
	it("complete: setup was finished before", async () => {
		queueDb([[{ at: new Date() }]]);
		expect(await resolveOnboarding("user-1")).toEqual({ kind: "complete" });
	});

	it("not-started: no plan and no open payment → the form", async () => {
		queueDb([[{ at: null }], [ORG_ROW], []]);
		expect(await resolveOnboarding("user-1")).toEqual({ kind: "not-started", org: ORG_ROW });
	});

	it("not-started: a billing row with no subscription is still the form", async () => {
		queueDb([[{ at: null }], [ORG_ROW], [{ status: "none", stripeSubscriptionId: null }]]);
		expect(await resolveOnboarding("user-1")).toEqual({ kind: "not-started", org: ORG_ROW });
	});

	it("settled: the org is trialing → finish, never show the form again", async () => {
		queueDb([[{ at: null }], [ORG_ROW], [{ status: "trialing", stripeSubscriptionId: "sub_1" }]]);
		expect(await resolveOnboarding("user-1")).toEqual({ kind: "settled", org: ORG_ROW });
	});

	it("settled: the org is active", async () => {
		queueDb([[{ at: null }], [ORG_ROW], [{ status: "active", stripeSubscriptionId: "sub_1" }]]);
		expect(await resolveOnboarding("user-1")).toEqual({ kind: "settled", org: ORG_ROW });
	});

	it("in-flight: a subscription Stripe has not confirmed (stored as `none`)", async () => {
		queueDb([[{ at: null }], [ORG_ROW], [{ status: "none", stripeSubscriptionId: "sub_1" }]]);
		expect(await resolveOnboarding("user-1")).toEqual({ kind: "in-flight", org: ORG_ROW });
	});

	it("no-org: the primary org is missing and cannot be repaired", async () => {
		// Not complete; no membership; no user row to provision against.
		queueDb([[{ at: null }], [], []]);
		expect(await resolveOnboarding("user-1")).toEqual({ kind: "no-org" });
	});

	it("unknown: a failed read is never read as not-started", async () => {
		queueDb([[{ at: null }], [ORG_ROW], new Error("connection refused")]);
		expect(await resolveOnboarding("user-1")).toEqual({ kind: "unknown" });
	});
});

describe("deduceBillingCountry — shown as a default, never a blank field when anything says", () => {
	it("prefers the org's own earlier declaration", () => {
		expect(
			deduceBillingCountry({ declared: "pt", geoCountry: "DE", email: "a@acme.fr", acceptLanguage: "en-US" }),
		).toEqual({ code: "PT", source: "declared" });
	});

	it("then the request's geolocation", () => {
		expect(deduceBillingCountry({ geoCountry: "de", email: "a@acme.fr" })).toEqual({
			code: "DE",
			source: "location",
		});
	});

	it("skips geolocation values that are not countries (Cloudflare's XX and T1)", () => {
		expect(deduceBillingCountry({ geoCountry: "XX", email: "a@acme.fr" })).toEqual({
			code: "FR",
			source: "email",
		});
		expect(deduceBillingCountry({ geoCountry: "T1", acceptLanguage: "en-GB" })).toEqual({
			code: "GB",
			source: "language",
		});
	});

	it("then the email domain's country code, then the browser's language region", () => {
		expect(deduceBillingCountry({ email: "a@acme.bg" })).toEqual({ code: "BG", source: "email" });
		expect(deduceBillingCountry({ email: "a@gmail.com", acceptLanguage: "de-AT,de;q=0.9" })).toEqual({
			code: "AT",
			source: "language",
		});
	});

	it("is null only when nothing says anything", () => {
		expect(deduceBillingCountry({ email: "a@acme.io", acceptLanguage: "en" })).toBeNull();
		expect(deduceBillingCountry({})).toBeNull();
	});
});

describe("countryFromEmail", () => {
	it("reads a ccTLD, maps .uk to GB, and ignores generic ccTLDs and gTLDs", () => {
		expect(countryFromEmail("a@acme.de")).toBe("DE");
		expect(countryFromEmail("a@acme.co.uk")).toBe("GB");
		expect(countryFromEmail("a@acme.io")).toBeNull();
		expect(countryFromEmail("a@acme.ai")).toBeNull();
		expect(countryFromEmail("a@acme.com")).toBeNull();
		expect(countryFromEmail("e2e@alethia.test")).toBeNull();
		expect(countryFromEmail("not-an-address")).toBeNull();
		expect(countryFromEmail(null)).toBeNull();
	});
});

describe("countryFromAcceptLanguage", () => {
	it("takes the first tag with a region", () => {
		expect(countryFromAcceptLanguage("en-US,en;q=0.9")).toBe("US");
		expect(countryFromAcceptLanguage("fr;q=0.9, pt-BR;q=0.8")).toBe("BR");
		expect(countryFromAcceptLanguage("es-419")).toBeNull();
		expect(countryFromAcceptLanguage("zh-Hant-TW")).toBe("TW");
		expect(countryFromAcceptLanguage(undefined)).toBeNull();
	});
});

describe("suggestedPayerCapacity — one switch, defaulted from what is known", () => {
	it("suggests a business purchase for a company-domain email", () => {
		expect(suggestedPayerCapacity("ana@acme.de")).toBe("organization");
		expect(isPersonalMailDomain("ana@acme.de")).toBe(false);
	});

	it("suggests a personal purchase for a personal mail provider, or no address", () => {
		expect(suggestedPayerCapacity("ana@gmail.com")).toBe("consumer");
		expect(suggestedPayerCapacity("ANA@Proton.Me")).toBe("consumer");
		expect(suggestedPayerCapacity(null)).toBe("consumer");
	});
});
