// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5412: `/start` — the public "Start free trial" CTA — caught EVERY error from
// `createCheckoutSession` and redirected to billing. A visitor the paid-conversion gate refused
// was dropped on the billing page with no word about why, and the release gate's /start test could
// only ever see "fell back to billing".
//
// These tests call the page itself. Next's real `redirect()` runs, and each answer is read off the
// thrown value's `digest`, which is how Next tells a redirect from a render.

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/server/actions/billing", () => ({ createCheckoutSession: vi.fn() }));
vi.mock("@/app/server/actions/resolve", () => ({
	getActiveOrgSlug: vi.fn(async () => "acme"),
}));
vi.mock("@/lib/billing/config", () => ({ isStripeConfigured: vi.fn(() => true) }));
vi.mock("@/lib/auth/owner", () => ({ getOwner: vi.fn(async () => "user-1") }));
// The shell's chrome is irrelevant here, and the real one pulls in the privacy client graph.
vi.mock("@/components/auth/auth-shell", () => ({
	AuthShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
// The gate is real; only its database is stubbed. The one query it makes is the Terms-acceptance
// lookup, answered with one row (= accepted), so a real gate run reaches the market check.
vi.mock("@/lib/db", () => {
	const chain = {
		select: () => chain,
		from: () => chain,
		where: () => chain,
		limit: () => Promise.resolve([{ id: "accepted-1" }]),
	};
	return { getServiceDb: () => chain };
});

import StartPage from "@/app/start/page";
import { createCheckoutSession } from "@/app/server/actions/billing";
import {
	assertPaidConversionAllowed,
	PaidConversionNotAllowedError,
	TEST_MODE_MARKET_FLAG,
} from "@/lib/billing/eligibility";

/** Renders /start; returns the markup it rendered, or the redirect target it threw. */
async function visit(): Promise<{ html: string } | { redirect: string }> {
	try {
		const element = await StartPage({
			searchParams: Promise.resolve({ plan: "team", trial: "1" }),
		});
		return { html: renderToStaticMarkup(element) };
	} catch (e) {
		const digest =
			typeof e === "object" && e !== null && "digest" in e && typeof e.digest === "string"
				? e.digest
				: "";
		if (!digest.startsWith("NEXT_REDIRECT;")) throw e;
		// NEXT_REDIRECT;<type>;<url>;<status>;
		return { redirect: digest.split(";")[2] ?? "" };
	}
}

beforeEach(() => {
	vi.mocked(createCheckoutSession).mockReset();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

/**
 * The refusal the REAL gate throws for a declared German organization with the Terms accepted —
 * `PAID_MARKETS` is empty, so that is `market_closed`, the refusal every real visitor gets today.
 * Only the acceptance lookup is stubbed (see the `@/lib/db` mock); the sentence is the gate's own.
 */
async function realMarketClosedRefusal(): Promise<PaidConversionNotAllowedError> {
	vi.stubEnv(TEST_MODE_MARKET_FLAG, undefined);
	try {
		await assertPaidConversionAllowed({
			userId: "user-1",
			organizationId: "org-1",
			capacity: "organization",
			billingCountry: "DE",
		});
	} catch (err) {
		if (err instanceof PaidConversionNotAllowedError && err.reason === "market_closed") return err;
		throw err;
	}
	throw new Error("the gate allowed a DE sale with no market open — the premise is gone");
}

describe("/start — what the trial CTA does", () => {
	it("redirects into the Checkout session when the gate allows it", async () => {
		vi.mocked(createCheckoutSession).mockResolvedValue({
			url: "https://checkout.stripe.com/c/pay/cs_test_123",
		});
		expect(await visit()).toEqual({
			redirect: "https://checkout.stripe.com/c/pay/cs_test_123",
		});
	});

	it("SHOWS the gate's refusal instead of silently redirecting to billing", async () => {
		const sentence =
			"Alethia is not yet able to sell to customers in this country in this capacity.";
		vi.mocked(createCheckoutSession).mockRejectedValue(
			new PaidConversionNotAllowedError("market_closed", sentence),
		);
		const result = await visit();
		if (!("html" in result)) {
			throw new Error(
				`/start redirected to ${result.redirect} — the refusal was swallowed and the visitor ` +
					"was never told why the trial did not start.",
			);
		}
		expect(result.html).toContain(sentence);
		// The way on is still there: billing is where a declaration or a plan is changed.
		expect(result.html).toContain('href="/acme/~/settings/billing"');
	});

	it("keeps the billing fallback for a failure that is not a refusal", async () => {
		vi.mocked(createCheckoutSession).mockRejectedValue(
			new Error("Create an organization before subscribing to a plan."),
		);
		expect(await visit()).toEqual({ redirect: "/acme/~/settings/billing" });
	});

	// #5443. The page heads every refusal "We can't start your trial checkout", and the trial CTA
	// is exactly what was refused: /start's Checkout IS the 30-day Pro trial. The market_closed
	// sentence used to go on to say "the Pro trial is unaffected" — directly under that heading,
	// with no way to any other trial from this page. Rendered from the gate's REAL sentence, not a
	// copy of it, so rewording the gate cannot quietly bring the contradiction back.
	it("does not tell a refused visitor that the trial it just refused is unaffected", async () => {
		const refusal = await realMarketClosedRefusal();
		vi.mocked(createCheckoutSession).mockRejectedValue(refusal);
		const result = await visit();
		if (!("html" in result)) throw new Error(`/start redirected to ${result.redirect}`);
		expect(result.html).toContain("We can&#x27;t start your trial checkout");
		expect(result.html).toContain("Alethia is not yet able to sell to customers");
		// The heading is the page's only word about a trial: the gate's sentence makes no claim
		// about one, because nothing this page links to can start one.
		expect(refusal.message).not.toMatch(/trial/i);
		expect(result.html.match(/trial/gi) ?? []).toHaveLength(1);
	});
});
