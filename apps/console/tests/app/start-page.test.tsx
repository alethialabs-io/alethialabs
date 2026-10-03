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
import { beforeEach, describe, expect, it, vi } from "vitest";

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
// The gate's error class is real; only its database is stubbed, and nothing here reaches it.
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import StartPage from "@/app/start/page";
import { createCheckoutSession } from "@/app/server/actions/billing";
import { PaidConversionNotAllowedError } from "@/lib/billing/eligibility";

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
});
