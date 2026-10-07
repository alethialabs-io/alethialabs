// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E for the reworked Billing surface (feat/billing-own-ux):
//   1. Plan-state coherence — a canceled org never shows "Renews / next charge"; an active
//      org shows "Renews" and never a "Canceled/Cancels" contradiction.
//   2. Owned invoices — locally-mirrored invoices render on the dedicated invoices page with
//      a working preview + an authorized PDF route that never 404s for a mirrored invoice.
//
// Auth is done via the API (email-OTP → session cookie → create + activate org) rather than
// the brittle multi-step signup UI: it's faster and deterministic. The one step the API cannot
// stand in for is the clickwrap: since #2447 every private route redirects to /accept-terms until
// the account has accepted the current Terms, so `apiAuthWithOrg` walks it in the browser. The OTP is scraped from
// the dev console log (SES-fail dev fallback logs "(sign-in code: NNNNNN)"). Billing +
// invoice rows are seeded directly in the dev Postgres for the freshly-created org.
//
// Requires `pnpm dev:up` running (console on :3000) and, in the env, ALETHIA_DATABASE_URL +
// BETTER_AUTH_URL (source .env before running: `set -a && . ./.env && set +a`).

import { readFile } from "node:fs/promises";
import { ACCEPTANCE_LABELS } from "@repo/legal/documents";
import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";

const DB_URL = process.env.ALETHIA_DATABASE_URL ?? "";
const LOG_PATH = process.env.DEV_CONSOLE_LOG ?? "/tmp/alethia-dev-console.log";
// better-auth trusts exactly this origin (lib/auth/index.ts trustedOrigins: [baseURL]).
const ORIGIN =
	process.env.BETTER_AUTH_URL ??
	process.env.NEXT_PUBLIC_APP_URL ??
	"http://localhost:3000";

const sql = DB_URL ? postgres(DB_URL, { max: 2 }) : null;

test.afterAll(async () => {
	await sql?.end({ timeout: 5 });
});

/** Polls the dev log for the 6-digit OTP logged for a specific email (unique per run). */
async function otpFor(email: string, timeoutMs = 25_000): Promise<string> {
	const re = new RegExp(
		`${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*sign-in code:\\s*(\\d{6})`,
	);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const text = await readFile(LOG_PATH, "utf8").catch(() => "");
		const m = text.match(re);
		if (m) return m[1];
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`No OTP logged for ${email} within ${timeoutMs}ms`);
}

/**
 * Signs a brand-new account in via the email-OTP API, then creates + activates an org — all
 * through page.request so the session cookie lands in the page's context. Returns the org.
 */
async function apiAuthWithOrg(
	page: Page,
): Promise<{ orgId: string; orgSlug: string }> {
	const stamp = `${Date.now()}${Math.floor(page.viewportSize()?.width ?? 0)}`;
	const email = `e2e-bill-${stamp}@alethia.test`;
	const headers = { Origin: ORIGIN, "Content-Type": "application/json" };

	await page.request.post("/api/auth/email-otp/send-verification-otp", {
		headers,
		data: { email, type: "sign-in" },
	});
	const otp = await otpFor(email);
	const signIn = await page.request.post("/api/auth/sign-in/email-otp", {
		headers,
		data: { email, otp },
	});
	expect(signIn.ok()).toBeTruthy();

	const orgSlug = `e2e-org-${stamp}`;
	const createRes = await page.request.post("/api/auth/organization/create", {
		headers,
		data: { name: "E2E Billing Org", slug: orgSlug },
	});
	expect(createRes.ok()).toBeTruthy();
	const created: unknown = await createRes.json();
	const orgId =
		typeof created === "object" && created !== null && "id" in created && typeof created.id === "string"
			? created.id
			: "";
	const activeRes = await page.request.post("/api/auth/organization/set-active", {
		headers,
		data: { organizationId: orgId },
	});
	expect(activeRes.ok()).toBeTruthy();
	await acceptCurrentTerms(page);
	return { orgId, orgSlug };
}

/**
 * Walks the post-auth clickwrap (#2372, gated in `(private)/layout.tsx` since #2447) for a
 * brand-new API-created account.
 *
 * Without it every billing route below renders "Accept our Terms" instead of billing — which is
 * what the gate recorded these three tests failing on. Walked as a person would, not seeded as an
 * acceptance row, so the gate itself stays exercised. Located by the exported labels, the way
 * `fixtures/auth.ts` locates them, so a relabel cannot silently break the walk. Kept inline: the
 * fixtures and helpers directories are release-gate seams.
 */
async function acceptCurrentTerms(page: Page): Promise<void> {
	await page.goto("/accept-terms");
	const accept = page.getByRole("button", { name: ACCEPTANCE_LABELS.submit });
	await expect(accept).toBeVisible({ timeout: 30_000 });
	await expect(accept).toBeDisabled();
	await page
		.getByText(new RegExp(ACCEPTANCE_LABELS.checkboxPrefix, "i"))
		.first()
		.click();
	await expect(accept).toBeEnabled();
	await accept.click();
	// Wait for the form to LEAVE the gate, not for the button to disappear. While the server action
	// runs, `AcceptTermsForm` relabels the button "Recording…", so a locator by the submit label goes
	// hidden the moment the click lands — before the acceptance is stored. The caller's next
	// `page.goto` then raced the POST: the billing route 307'd back to /accept-terms, which by then
	// saw the acceptance and sent the page on to /dashboard → /onboarding, so the test asserted
	// "Active" on the onboarding form (#5483). The form calls `router.replace(next)` only after
	// `acceptLegalDocuments` resolves, so the URL changing is the signal that the acceptance landed.
	await page.waitForURL((url) => url.pathname !== "/accept-terms", {
		timeout: 30_000,
		waitUntil: "commit",
	});
}

/** Upserts the org's billing row to a chosen state (a stripe_customer_id makes the invoices
 *  + payment sections render; a null subscription id keeps getBillingSummary on the DB
 *  fallback, so no live Stripe subscription is needed). */
async function seedBilling(
	orgId: string,
	fields: {
		plan: "community" | "team" | "enterprise";
		status: "none" | "trialing" | "active" | "past_due" | "canceled";
		currentPeriodEnd: Date | null;
	},
): Promise<void> {
	if (!sql) throw new Error("no db");
	await sql`
		INSERT INTO organization_billing
			(organization_id, plan, status, stripe_customer_id, current_period_end)
		VALUES
			(${orgId}, ${fields.plan}, ${fields.status}, ${`cus_e2e_${orgId.slice(0, 8)}`}, ${fields.currentPeriodEnd})
		ON CONFLICT (organization_id) DO UPDATE SET
			plan = EXCLUDED.plan, status = EXCLUDED.status,
			stripe_customer_id = EXCLUDED.stripe_customer_id,
			current_period_end = EXCLUDED.current_period_end, updated_at = now()`;
}

/** Inserts a mirrored invoice row for the org; returns its id. */
async function seedInvoice(
	orgId: string,
	inv: { stripeInvoiceId: string; number: string; amountTotal: number },
): Promise<string> {
	if (!sql) throw new Error("no db");
	const [row] = await sql<{ id: string }[]>`
		INSERT INTO invoice
			(organization_id, stripe_invoice_id, stripe_customer_id, number, status,
			 amount_total, currency, period_start, period_end, hosted_invoice_url, paid_at)
		VALUES
			(${orgId}, ${inv.stripeInvoiceId}, ${`cus_e2e_${orgId.slice(0, 8)}`}, ${inv.number},
			 ${"paid"}, ${inv.amountTotal}, ${"usd"}, now(), now(),
			 ${`https://stripe.test/hosted/${inv.stripeInvoiceId}`}, now())
		ON CONFLICT (stripe_invoice_id) DO UPDATE SET number = EXCLUDED.number
		RETURNING id`;
	return row.id;
}

test.describe("Billing — plan-state coherence", () => {
	test.skip(!DB_URL, "source .env (ALETHIA_DATABASE_URL) before running e2e");

	// RENAMED in #5412 from "a canceled org shows Canceled, no renew/next-charge, and an Upgrade
	// CTA". A lapsed subscription is written as plan `community` (lib/billing/sync.ts:
	// `plan: live && plan ? plan : "community"`), and `billing-panel.tsx`'s `isHobby` branch —
	// added in #114, the same PR as this test — gives a Hobby card no lifecycle badge at all. So
	// "Canceled" can never render for a real canceled org; the decided shape is the Hobby card with
	// an upgrade path, which `flows/billing.spec.ts` asserts for a never-subscribed org too.
	test("a canceled org reads as Hobby — no lifecycle badge, no renew/next-charge, and an Upgrade CTA", async ({
		page,
	}) => {
		const { orgId, orgSlug } = await apiAuthWithOrg(page);
		await seedBilling(orgId, {
			plan: "community",
			status: "canceled",
			currentPeriodEnd: null,
		});

		await page.goto(`/${orgSlug}/~/settings/billing`);

		await expect(page.getByRole("heading", { name: "Current plan" })).toBeVisible({ timeout: 30_000 });
		await expect(page.getByText("Hobby", { exact: true }).first()).toBeVisible();
		await expect(page.getByText("Canceled", { exact: true })).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: /upgrade to pro/i }),
		).toBeVisible();
		await expect(page.getByText(/next charge/i)).toHaveCount(0);
		await expect(page.getByText(/Renews/)).toHaveCount(0);
	});

	test("an active org shows Renews and never a Canceled/Cancels contradiction", async ({
		page,
	}) => {
		const { orgId, orgSlug } = await apiAuthWithOrg(page);
		await seedBilling(orgId, {
			plan: "team",
			status: "active",
			currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
		});

		await page.goto(`/${orgSlug}/~/settings/billing`);

		await expect(page.getByText("Active", { exact: true })).toBeVisible();
		await expect(page.getByText(/Renews/)).toBeVisible();
		await expect(page.getByText("Canceled", { exact: true })).toHaveCount(0);
		await expect(page.getByText(/Cancels/)).toHaveCount(0);
	});
});

test.describe("Billing — owned invoices", () => {
	test.skip(!DB_URL, "source .env (ALETHIA_DATABASE_URL) before running e2e");

	test("mirrored invoices render on the dedicated page with a working PDF route", async ({
		page,
	}) => {
		const { orgId, orgSlug } = await apiAuthWithOrg(page);
		await seedBilling(orgId, {
			plan: "team",
			status: "active",
			currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
		});
		const invId = await seedInvoice(orgId, {
			stripeInvoiceId: `in_e2e_${orgId.slice(0, 8)}_1`,
			number: "E2E-0001",
			amountTotal: 2000,
		});
		await seedInvoice(orgId, {
			stripeInvoiceId: `in_e2e_${orgId.slice(0, 8)}_2`,
			number: "E2E-0002",
			amountTotal: 2000,
		});

		// Main billing page: a recent-invoices list + a link to the full page.
		await page.goto(`/${orgSlug}/~/settings/billing`);
		await expect(page.getByText("E2E-0001")).toBeVisible();
		await expect(
			page.getByRole("link", { name: /view all invoices/i }),
		).toBeVisible();

		// Dedicated invoices page lists both mirrored invoices.
		await page.goto(`/${orgSlug}/~/settings/billing/invoices`);
		await expect(page.getByText("E2E-0001")).toBeVisible();
		await expect(page.getByText("E2E-0002")).toBeVisible();

		// The authorized PDF route never 404s for a mirrored invoice: with no captured PDF it
		// redirects (307) to the hosted document.
		const res = await page.request.get(
			`/${orgSlug}/~/settings/billing/invoices/${invId}/pdf`,
			{ maxRedirects: 0 },
		);
		expect([200, 302, 307]).toContain(res.status());
	});
});
