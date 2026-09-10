// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E — Billing settings + Usage, MEASURED AGAINST STRIPE TEST MODE (#4276).
//
// Two org-scoped surfaces:
//   • /${org}/~/settings/billing — components/settings/billing/* (BillingPanel + Payment methods /
//     Plan history / Transactions / Invoices) and the shared Hobby→Pro upgrade sheet
//     (components/org/upgrade-org-sheet.tsx, opened via useUpgradeSheet).
//   • /${org}/~/usage — components/settings/usage/usage-panel.tsx (plan & limits, seats vs
//     members, resources, usage-over-time with the time-range filter, AI usage, hard-cap toggle).
//
// Personas: `team` = Pro card-less TRIAL (status trialing, plan team, stripe customer present →
// canManage), `owner` = Hobby (community, no live sub → the upgrade path).
//
// ── WHY EVERY TEST IN THIS FILE CARRIES `@needs:stripe` ────────────────────────────────────────
//
// Not one assertion below survives an unconfigured console: without Stripe the `team` persona is
// never built as a trial at all (global-setup throws when `stripe` is promised and the Pro tile is
// unavailable), and `BillingPanel` short-circuits to "Self-managed deployment" — a page on which
// "Trialing", "Plan history" and "Payment methods" are all absent and every `toBeVisible` here
// would fail for a reason that is not a defect.
//
// The tag is the ONLY guard. `test.skip(!process.env.STRIPE_SECRET_KEY)` is what this replaces:
// an unset variable turned 35 billing assertions into green skips, and a run reporting "35
// skipped" read like a run that had measured 35 things (e2e/helpers/capabilities.ts). On a leg
// that promises `stripe` the tag changes nothing; on a leg that does not, CI goes RED because the
// spec's need and the workflow's declaration disagree.
//
// ── WHAT "TEST MODE" IS ACTUALLY PROVEN BY ────────────────────────────────────────────────────
//
// A page that renders is not a page that reached Stripe. Four tests below carry that weight, and
// each waits for something ONLY a live test-mode API call produces:
//   · a card attached to the org's real Stripe customer appears in Payment methods by its brand
//     and last four — a row the console can only have got from `listPaymentMethods`;
//   · the `Remove` confirmation opens over that row, and the card survives a page reload;
//   · the /start CTA redirects to a URL containing a `cs_test_` Checkout Session id;
//   · the upgrade sheet mounts Stripe.js's own cross-origin card iframes, which exist only once
//     Elements has initialised against a real publishable key.
//
// THE LAST TWO ARE `test.fixme` ON #4633, and so is the currency toggle, because the product
// refuses the sale before Stripe is ever asked: `eligibility.ts` requires a declared payer
// capacity, `declarePayer` has NO caller anywhere in the repo, and neither purchase sheet passes
// the `payer` facts its own action accepts. The sheet then renders "Billing may not be configured
// on this deployment", which is why this read for a while as an unwired Stripe. It is not unwired
// — the first two tests above prove the same leg reaching the same account.
//
// We STOP before any payment: no confirmation is ever submitted, and the two destructive
// confirmations (`billing.card.remove`, `billing.subscription.cancel`) are opened and CANCELLED.

import Stripe from "stripe";
import { scanA11y } from "../helpers/a11y";
import { db } from "../helpers/db";
import { expect, test } from "../fixtures/qa";

const billingPath = (slug: string) => `/${slug}/~/settings/billing`;
const invoicesPath = (slug: string) => `/${slug}/~/settings/billing/invoices`;
const usagePath = (slug: string) => `/${slug}/~/usage`;

// The QA console at :3100 is shared across parallel agents — page GETs can spike to ~15s under
// load. Give each test plenty of headroom so a slow render never masquerades as a real failure.
test.beforeEach(() => {
	test.setTimeout(120_000);
});

/**
 * The org's Stripe customer id, straight from `organization_billing`.
 *
 * Read from the DATABASE rather than asserted from the page: global-setup already refuses to build
 * the `team` persona without one when `stripe` is promised, so a null here is a broken fixture and
 * throwing names it — a test that quietly returned "" would go on to seed rows against nothing.
 */
async function stripeCustomerId(orgId: string): Promise<string> {
	const rows = await db()<{ stripe_customer_id: string | null }[]>`
		select stripe_customer_id from organization_billing where organization_id = ${orgId}`;
	const id = rows[0]?.stripe_customer_id;
	if (!id) {
		throw new Error(
			`organization_billing for ${orgId} carries no stripe_customer_id — the team persona is ` +
				"not on a real Stripe subscription, so nothing below would be measuring Stripe.",
		);
	}
	return id;
}

/**
 * A Stripe client on the leg's TEST-mode secret key.
 *
 * Built per call rather than at module scope: the module is imported by Playwright's collection
 * pass on every leg, including the ones that promise no Stripe at all, and a missing key must be
 * the failure of the test that needs it — not of the file's import.
 */
function stripeApi(): Stripe {
	const key = process.env.STRIPE_SECRET_KEY;
	if (!key) throw new Error("STRIPE_SECRET_KEY is unset on a leg that promised `stripe`.");
	if (!key.startsWith("sk_test_")) {
		// A LIVE key here would attach a real card to a real customer. The suite must refuse to run
		// rather than discover that from the Stripe dashboard.
		throw new Error("STRIPE_SECRET_KEY is not a test-mode key (sk_test_…). Refusing to touch Stripe.");
	}
	return new Stripe(key);
}

/**
 * Attaches a fresh test card to the org's Stripe customer and returns its brand + last four.
 *
 * The TOKEN IS A PARAMETER, and that is the whole point: every `tok_visa` card ends in 4242, so
 * two tests that both attached one would each locate "•••• 4242" and neither could tell which row
 * it had. A per-test token gives every test a last four nothing else on the page can produce.
 *
 * A PaymentMethod is CREATED from the token each time rather than attaching a shared `pm_…` id, so
 * two parallel workers cannot contend for one Stripe object. The card is left attached: the
 * personas are per-run accounts on a throwaway test-mode customer, and detaching in an `afterAll`
 * is the shape e2e/AUTHORING.md refuses — it pulls the floor out from under every other spec still
 * driving the org.
 */
async function attachTestCard(
	customerId: string,
	token: string,
): Promise<{ brand: string; last4: string }> {
	const stripe = stripeApi();
	const pm = await stripe.paymentMethods.create({ type: "card", card: { token } });
	await stripe.paymentMethods.attach(pm.id, { customer: customerId });
	const last4 = pm.card?.last4;
	const brand = pm.card?.brand;
	if (!last4 || !brand) {
		throw new Error(`Stripe returned a payment method with no card details (${pm.id}).`);
	}
	// `formatBrand` in payment-methods-card.tsx title-cases Stripe's lowercase brand.
	return { brand: brand.charAt(0).toUpperCase() + brand.slice(1), last4 };
}

/**
 * The saved-card ROW for a given last four — the container that holds both the card's identity and
 * its row actions.
 *
 * Written as "the deepest `div` that contains BOTH the last four AND a Remove button" rather than
 * as a class selector: `payment-methods-card.tsx` splits each row into a left half (brand, last
 * four, badges) and a right half (the actions), so a locator anchored on the text alone lands in
 * the half that has no buttons in it. Every ancestor of the row satisfies both filters too, which
 * is what `.last()` is for — document order puts the innermost match last.
 */
function cardRow(page: import("@playwright/test").Page, last4: string) {
	return page
		.locator("div")
		.filter({ hasText: `•••• ${last4}` })
		.filter({ has: page.getByRole("button", { name: "Remove", exact: true }) })
		.last();
}

/** Mirrors one paid invoice row for the org, exactly as the `invoice.paid` webhook would. */
async function seedMirroredInvoice(
	orgId: string,
	customerId: string,
	number: string,
): Promise<void> {
	await db()`
		insert into invoice
			(organization_id, stripe_invoice_id, stripe_customer_id, number, status,
			 amount_total, currency, period_start, period_end, hosted_invoice_url, paid_at)
		values
			(${orgId}, ${`in_e2e_${number}`}, ${customerId}, ${number}, 'paid',
			 2000, 'usd', now() - interval '30 days', now(),
			 ${`https://stripe.test/hosted/${number}`}, now())
		on conflict (stripe_invoice_id) do update set number = excluded.number`;
}

// ── Billing page — Pro trial (team persona) ───────────────────────────────────────────────
test.describe("Billing settings — Pro trial (team)", () => {
	test("authed persona reaches billing (not bounced to /login)", { tag: "@needs:stripe" }, async ({ team }) => {
		await team.page.goto(billingPath(team.orgSlug));
		await expect(team.page).not.toHaveURL(/\/login/);
		await expect(team.page.getByRole("heading", { name: "Current plan" })).toBeVisible({ timeout: 30_000 });
	});

	test("current-plan card shows the Pro plan name and the Trialing status", { tag: "@needs:stripe" }, async ({ team }) => {
		await team.page.goto(billingPath(team.orgSlug));
		await expect(team.page.getByText("Trialing")).toBeVisible({ timeout: 30_000 });
		// meta.name for the `team` plan is "Pro" (plan-catalog).
		await expect(team.page.getByText("Pro", { exact: true }).first()).toBeVisible();
	});

	test("a live (trialing) sub exposes Cancel plan, never an Upgrade CTA", { tag: "@needs:stripe" }, async ({ team }) => {
		await team.page.goto(billingPath(team.orgSlug));
		await expect(team.page.getByRole("button", { name: "Cancel plan" })).toBeVisible({
			timeout: 30_000,
		});
		// Trialing is already "live" → no upgrade affordance on the billing panel.
		await expect(team.page.getByRole("button", { name: "Upgrade to Pro" })).toHaveCount(0);
	});

	test("plan card surfaces per-seat pricing (seats vs the $20 unit)", { tag: "@needs:stripe" }, async ({ team }) => {
		await team.page.goto(billingPath(team.orgSlug));
		await expect(team.page.getByRole("heading", { name: "Current plan" })).toBeVisible({ timeout: 30_000 });
		// meta.perSeat → "$20/seat · 1 seat" line beneath the monthly total. The UNIT is
		// Stripe-authoritative (summary.unitAmountUsd is the subscription's real price), so this
		// line existing at all means the trial's price came back from the test-mode API.
		await expect(team.page.getByText(/\/seat ·/)).toBeVisible();
	});

	test("a trialing sub renews rather than cancels, with a dated period label", { tag: "@needs:stripe" }, async ({ team }) => {
		await team.page.goto(billingPath(team.orgSlug));
		await expect(team.page.getByText("Trialing")).toBeVisible({ timeout: 30_000 });
		// `periodLabel` is "Renews <date>" for active/trialing and "Cancels <date>" only once the
		// subscription is set to cancel — one label, never both, from `currentPeriodEnd`, which is
		// populated from the live subscription.
		await expect(team.page.getByText(/^Renews /)).toBeVisible();
		await expect(team.page.getByText(/^Cancels /)).toHaveCount(0);
	});

	test("cloud-spend disclaimer is shown on the plan card", { tag: "@needs:stripe" }, async ({ team }) => {
		await team.page.goto(billingPath(team.orgSlug));
		await expect(
			team.page.getByText(/cloud-resource spend is billed separately/i),
		).toBeVisible({ timeout: 30_000 });
	});

	test("a Stripe customer (trial) gets the in-app Payment methods section", { tag: "@needs:stripe" }, async ({ team }) => {
		await team.page.goto(billingPath(team.orgSlug));
		// `PaymentMethodsCard` renders only behind `summary.canManage`, which needs a Stripe
		// customer. It is NATIVE management (#3529) — there is no "manage payment methods" portal
		// deep-link any more, and asserting one measured a control the page had stopped having.
		await expect(team.page.getByRole("heading", { name: "Payment methods" })).toBeVisible({
			timeout: 30_000,
		});
		await expect(team.page.getByRole("button", { name: /add payment method/i })).toBeVisible();
	});

	test("plan history, transactions and invoices sections render for a customer", { tag: "@needs:stripe" }, async ({
		team,
	}) => {
		await team.page.goto(billingPath(team.orgSlug));
		await expect(team.page.getByRole("heading", { name: "Plan history" })).toBeVisible({ timeout: 30_000 });
		await expect(team.page.getByRole("heading", { name: "Transaction history" })).toBeVisible();
		await expect(team.page.getByRole("heading", { name: "Invoices" })).toBeVisible();
	});
});

// ── Stripe TEST MODE — what proves the console actually reached the API ───────────────────
test.describe("Billing — Stripe test mode", () => {
	test("the /start trial CTA redirects into a TEST-mode Checkout session", { tag: "@needs:stripe" }, async ({
		team,
	}) => {
		test.fixme(
			true,
			"BUG: /start's createCheckoutSession is refused for an undeclared payer capacity and the page swallows it, redirecting to billing #4633",
		);
		// `app/start/page.tsx` calls `createCheckoutSession("team")` server-side and redirects to
		// the session URL, falling back to the org's billing page when Stripe is unconfigured or
		// the call throws. Intercept the external navigation so no browser ever reaches Stripe.
		//
		// THE `team` PERSONA, NOT `owner`, and the reason is a side effect rather than a
		// preference: `createCheckoutSession` calls `ensureCustomer`, which CREATES a Stripe
		// customer for the org it runs against and persists it. Run against the Hobby persona this
		// test would hand that org a customer, flipping `summary.canManage` true for every other
		// spec in the run — the suite is `fullyParallel`, so which ones is a coin toss. `team`
		// already has a customer, so the call changes nothing about the org's state.
		const attempts: string[] = [];
		// TWO recorders, because they answer different questions and the second is not a spare.
		// `page.on("request")` fires for every hop of a redirect chain and is what RECORDS the
		// evidence; `page.route` is what STOPS the browser from actually loading a Stripe page.
		// Route handlers and redirect hops have a history of disagreeing, and a test whose only
		// evidence came from the handler would report "no navigation was issued" for a navigation
		// that was issued and simply not intercepted.
		team.page.on("request", (req) => {
			if (req.url().includes("checkout.stripe.com")) attempts.push(req.url());
		});
		await team.page.route(/checkout\.stripe\.com/, async (route) => {
			await route.abort();
		});

		// The abort rejects the navigation — that rejection IS the success path here, so the
		// verdict is the recorded URL below, never `goto`'s outcome.
		await team.page.goto("/start?plan=team&trial=1").catch(() => undefined);

		await expect
			.poll(() => attempts.length, {
				timeout: 45_000,
				message:
					"no navigation to checkout.stripe.com was issued — /start fell back to the billing " +
					"page, which means createCheckoutSession threw or Stripe is not configured",
			})
			.toBeGreaterThan(0);
		// `cs_test_…` is the one thing a LIVE-mode account could not have produced, and a stub
		// could not have invented: it is the id Stripe minted for this run's session.
		expect(attempts[0]).toContain("cs_test_");
	});

	test("the upgrade sheet mounts Stripe.js's own card fields, not a look-alike", { tag: "@needs:stripe" }, async ({
		owner,
	}) => {
		test.fixme(
			true,
			"BUG: the upgrade sheet's createSubscriptionIntent is refused for an undeclared payer capacity, so Elements never mounts #4633",
		);
		await owner.page.goto(billingPath(owner.orgSlug));
		await owner.page.getByRole("button", { name: "Upgrade to Pro" }).click();

		const dialog = owner.page.getByRole("dialog");
		await expect(dialog.getByText("Card information")).toBeVisible({ timeout: 30_000 });
		// Number / expiry / CVC are three separate CardElements, each mounted by Stripe.js in its
		// own cross-origin iframe served from js.stripe.com. Those frames exist only once Elements
		// has initialised against a real publishable key, so counting them is a measurement of the
		// pk_test the leg was handed — a rendered <Label> is not.
		// Both shapes, because Stripe.js has shipped each: the frame is served from js.stripe.com
		// and is NAMED `__privateStripeFrame…`. Either one is unforgeable by the console's own
		// markup; requiring both would make the test fail on a Stripe release rather than on a
		// defect in this product.
		const stripeFrames = owner.page.locator(
			'iframe[src^="https://js.stripe.com/"], iframe[name^="__privateStripeFrame"]',
		);
		await expect
			.poll(() => stripeFrames.count(), {
				timeout: 30_000,
				message: "Stripe.js mounted no card iframes — Elements never initialised",
			})
			.toBeGreaterThanOrEqual(3);
	});

	test("a card attached to the org's real customer appears in Payment methods", { tag: "@needs:stripe" }, async ({
		team,
	}) => {
		const customerId = await stripeCustomerId(team.orgId!);
		// Mastercard (•••• 4444), so this row cannot be confused with the Amex the remove-confirm
		// test attaches — or with any `tok_visa` 4242 a future test adds.
		const { brand, last4 } = await attachTestCard(customerId, "tok_mastercard");

		await team.page.goto(billingPath(team.orgSlug));
		await expect(team.page.getByRole("heading", { name: "Payment methods" })).toBeVisible({
			timeout: 30_000,
		});
		// The row is rendered from `listPaymentMethods()`, which reads the customer back from
		// Stripe — so a visible "<brand> •••• <last4>" is a round trip through the test-mode API,
		// and not a local fixture the page could have drawn from anything else.
		const row = cardRow(team.page, last4);
		await expect(row).toBeVisible({ timeout: 30_000 });
		await expect(row.getByText(brand, { exact: true })).toBeVisible();
	});
});

// ── The two destructive confirmations — OPEN, then CANCEL ─────────────────────────────────
//
// Both are registry entries in apps/console/destructive-actions.yaml, and both are opened here
// against a REAL Stripe customer rather than in the audit leg's synthetic org, which cannot
// materialise either fixture. Neither destructive button is ever pressed.
test.describe("Billing — destructive controls ask first", () => {
	test("Cancel plan opens a confirmation, and Cancel leaves the subscription renewing", { tag: "@needs:stripe" }, async ({
		team,
	}) => {
		await team.page.goto(billingPath(team.orgSlug));
		const trigger = team.page.getByRole("button", { name: "Cancel plan" });
		await expect(trigger).toBeVisible({ timeout: 30_000 });
		await trigger.click();

		const dialog = team.page.locator('[data-slot="alert-dialog-content"]');
		await expect(dialog).toBeVisible({ timeout: 10_000 });
		await expect(dialog.getByRole("heading", { name: "Cancel this subscription?" })).toBeVisible();
		// Asserted, never pressed — this is the button that would end the subscription.
		await expect(dialog.getByRole("button", { name: "Confirm cancellation" })).toBeVisible();

		await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(dialog).toBeHidden();

		// Nothing moved. A RELOAD is what makes this a measurement rather than a re-read of the
		// same client state: `getBillingSummary` goes back to Stripe, and a subscription that had
		// been cancelled would come back as "Canceling" with a "Cancels <date>" label.
		await team.page.reload();
		await expect(team.page.getByText(/^Renews /)).toBeVisible({ timeout: 30_000 });
		await expect(team.page.getByRole("button", { name: "Cancel plan" })).toBeVisible();
	});

	test("Remove opens the card confirmation, and Cancel leaves the card attached", { tag: "@needs:stripe" }, async ({
		team,
	}) => {
		const customerId = await stripeCustomerId(team.orgId!);
		// Amex (•••• 0005) — a last four no other test in this file can attach.
		const { last4 } = await attachTestCard(customerId, "tok_amex");

		await team.page.goto(billingPath(team.orgSlug));
		const row = cardRow(team.page, last4);
		await expect(row).toBeVisible({ timeout: 30_000 });
		// `RowAction destructive` is labelled "Remove"; "Remove card" is the DIALOG's action. The
		// registry records the second as `confirm_action`, and reading it as the trigger is how an
		// entry ends up matching no control the page has ever had.
		await row.getByRole("button", { name: "Remove", exact: true }).click();

		const dialog = team.page.locator('[data-slot="alert-dialog-content"]');
		await expect(dialog).toBeVisible({ timeout: 10_000 });
		await expect(dialog.getByRole("heading", { name: "Remove this card?" })).toBeVisible();
		await expect(dialog.getByRole("button", { name: "Remove card" })).toBeVisible();

		await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(dialog).toBeHidden();

		// Still attached — re-read from Stripe, not from the closed dialog's memory.
		await team.page.reload();
		await expect(team.page.getByText(`•••• ${last4}`).first()).toBeVisible({ timeout: 30_000 });
	});
});

// ── Mirrored invoices ─────────────────────────────────────────────────────────────────────
test.describe("Billing — mirrored invoices (team)", () => {
	test("a mirrored invoice reaches the billing page's Invoices section", { tag: "@needs:stripe" }, async ({ team }) => {
		const customerId = await stripeCustomerId(team.orgId!);
		const number = `E2E-RECENT-${Date.now()}`;
		await seedMirroredInvoice(team.orgId!, customerId, number);

		await team.page.goto(billingPath(team.orgSlug));
		await expect(team.page.getByText(number)).toBeVisible({ timeout: 30_000 });
		// The "View all invoices →" link renders only when the section has rows, so it is a second
		// consequence of the seed rather than a restatement of the first.
		await expect(team.page.getByRole("link", { name: /view all invoices/i })).toBeVisible();
	});

	test("the dedicated invoices page lists mirrored rows with their amount and status", { tag: "@needs:stripe" }, async ({
		team,
	}) => {
		const customerId = await stripeCustomerId(team.orgId!);
		const number = `E2E-PAGE-${Date.now()}`;
		await seedMirroredInvoice(team.orgId!, customerId, number);

		await team.page.goto(invoicesPath(team.orgSlug));
		await expect(team.page).not.toHaveURL(/\/login/);
		const row = team.page.getByRole("row").filter({ hasText: number });
		await expect(row).toBeVisible({ timeout: 30_000 });
		// $20.00 is the seeded `amount_total` (2000 minor units) rendered through @repo/format, and
		// "Paid" is the StatusBadge for the seeded status — both are cells of THIS row, so neither
		// can pass on some other invoice that happens to be on the page.
		await expect(row.getByText("$20.00")).toBeVisible();
		await expect(row.getByText("Paid", { exact: true })).toBeVisible();
	});

	test("an invoice's PDF route resolves for its own org rather than 404ing", { tag: "@needs:stripe" }, async ({
		team,
	}) => {
		const customerId = await stripeCustomerId(team.orgId!);
		const number = `E2E-PDF-${Date.now()}`;
		await seedMirroredInvoice(team.orgId!, customerId, number);
		const rows = await db()<{ id: string }[]>`
			select id from invoice where stripe_invoice_id = ${`in_e2e_${number}`}`;
		const invoiceId = rows[0]?.id;
		expect(invoiceId, "the seeded invoice was not written").toBeTruthy();

		// No PDF was captured for a hand-mirrored row, so the authorized route redirects to the
		// hosted document. A 404 would mean the row is not resolvable as the org's own.
		const res = await team.page.request.get(
			`${invoicesPath(team.orgSlug)}/${invoiceId}/pdf`,
			{ maxRedirects: 0 },
		);
		expect([200, 302, 307]).toContain(res.status());
	});
});

// ── Billing page — Hobby (owner persona) + the upgrade sheet ───────────────────────────────
test.describe("Billing settings — Hobby → Pro upgrade (owner)", () => {
	test("the Hobby card offers an upgrade and no subscription lifecycle at all", { tag: "@needs:stripe" }, async ({ owner }) => {
		await owner.page.goto(billingPath(owner.orgSlug));
		await expect(owner.page.getByRole("heading", { name: "Current plan" })).toBeVisible({ timeout: 30_000 });
		// `isHobby` suppresses the state badge, the price figure and the period label entirely —
		// the free baseline shows a name, a tagline and one CTA. The old assertion here looked for
		// the "No subscription" badge, which this branch has never rendered.
		await expect(owner.page.getByText("Hobby", { exact: true }).first()).toBeVisible();
		await expect(owner.page.getByRole("button", { name: "Upgrade to Pro" })).toBeVisible();
		await expect(owner.page.getByRole("button", { name: "Cancel plan" })).toHaveCount(0);
	});

	test("Upgrade to Pro opens the shared upgrade sheet with the checkout form", { tag: "@needs:stripe" }, async ({
		owner,
	}) => {
		await owner.page.goto(billingPath(owner.orgSlug));
		await owner.page.getByRole("button", { name: "Upgrade to Pro" }).click();

		const dialog = owner.page.getByRole("dialog");
		await expect(dialog.getByRole("heading", { name: "Upgrade to Pro" })).toBeVisible({
			timeout: 30_000,
		});
		// The custom checkout form (BillingCheckoutForm) mounts once the subscription intent's
		// client secret loads — assert the card fields + the Upgrade submit; STOP before payment.
		await expect(dialog.getByText("Card information")).toBeVisible({ timeout: 30_000 });
		await expect(dialog.getByRole("button", { name: "Upgrade" })).toBeVisible();
	});

	test("the upgrade sheet's order summary reflects the Pro total (no charge)", { tag: "@needs:stripe" }, async ({
		owner,
	}) => {
		await owner.page.goto(billingPath(owner.orgSlug));
		await owner.page.getByRole("button", { name: "Upgrade to Pro" }).click();

		const dialog = owner.page.getByRole("dialog");
		await expect(dialog.getByText("Card information")).toBeVisible({ timeout: 30_000 });
		// Order summary: a Total row (the seat unit) — a stable, payment-free assertion.
		await expect(dialog.getByText("Total")).toBeVisible();
		await expect(dialog.getByText("Full name")).toBeVisible();
	});

	// THE PLAN SURFACE OF THE PURCHASE FLOW. `components/billing/plan-picker.tsx` exists but is
	// rendered by NOTHING (`apps/console/knip.json` ignores it as an unused file), so it cannot be
	// driven from a browser and a test naming it would assert about a component the product does
	// not mount. What a customer actually chooses from is this: the sheet's inclusions column, the
	// plan's summary, and the currency the subscription will be created in.
	//
	// THIS IS TWO TESTS, and the split is the finding rather than tidiness. The inclusions column
	// is `PurchaseLayout`'s aside, which renders whatever the intent does; the currency toggle is
	// ENABLED only once `createSubscriptionIntent` has returned a client secret (Stripe locks a
	// subscription's currency at creation). Measured on run 34488595945: the first three
	// assertions passed and the fourth found `<button disabled … aria-pressed="true">USD`. One
	// test would have reported the whole plan surface as broken; two say exactly which half is.
	test("the purchase sheet presents the plan's inclusions", { tag: "@needs:stripe" }, async ({
		owner,
	}) => {
		await owner.page.goto(billingPath(owner.orgSlug));
		await owner.page.getByRole("button", { name: "Upgrade to Pro" }).click();

		const dialog = owner.page.getByRole("dialog");
		await expect(dialog.getByText("What's included")).toBeVisible({ timeout: 30_000 });
		await expect(dialog.getByRole("link", { name: /learn more about pricing/i })).toBeVisible();
	});

	test("the purchase sheet offers a billing currency once the intent exists", { tag: "@needs:stripe" }, async ({
		owner,
	}) => {
		test.fixme(
			true,
			"BUG: the currency toggle stays disabled because createSubscriptionIntent is refused for an undeclared payer capacity #4633",
		);
		await owner.page.goto(billingPath(owner.orgSlug));
		await owner.page.getByRole("button", { name: "Upgrade to Pro" }).click();

		const dialog = owner.page.getByRole("dialog");
		const currency = dialog.getByRole("group", { name: "Billing currency" });
		await expect(currency).toBeVisible({ timeout: 30_000 });
		// ENABLED, not merely present: `disabled={!clientSecret}`, so an enabled option is
		// evidence the intent came back — which is the only thing here Stripe had to answer.
		await expect(currency.getByRole("button", { name: "USD" })).toBeEnabled({ timeout: 30_000 });
		await expect(currency.getByRole("button", { name: "EUR" })).toBeVisible();
	});

	test("the upgrade sheet can be dismissed via its Close control", { tag: "@needs:stripe" }, async ({
		owner,
	}) => {
		await owner.page.goto(billingPath(owner.orgSlug));
		await owner.page.getByRole("button", { name: "Upgrade to Pro" }).click();

		const dialog = owner.page.getByRole("dialog");
		await expect(dialog.getByRole("heading", { name: "Upgrade to Pro" })).toBeVisible({
			timeout: 30_000,
		});
		await dialog.getByRole("button", { name: "Close" }).click();
		await expect(dialog).toBeHidden();
	});
});

// ── Usage page — Pro trial (team persona) ─────────────────────────────────────────────────
test.describe("Usage — Pro trial (team)", () => {
	test("authed persona reaches usage (not bounced to /login)", { tag: "@needs:stripe" }, async ({ team }) => {
		await team.page.goto(usagePath(team.orgSlug));
		await expect(team.page).not.toHaveURL(/\/login/);
		await expect(team.page.getByText("Plan & limits")).toBeVisible({ timeout: 30_000 });
	});

	test("header shows the Pro plan standing and a Manage billing link", { tag: "@needs:stripe" }, async ({ team }) => {
		await team.page.goto(usagePath(team.orgSlug));
		await expect(team.page.getByText("Pro plan")).toBeVisible({ timeout: 30_000 });
		// Non-community → a Manage billing link (not an inline upgrade CTA).
		await expect(team.page.getByRole("link", { name: /manage billing/i })).toBeVisible();
	});

	test("plan & limits renders the seats / concurrency gauges", { tag: "@needs:stripe" }, async ({ team }) => {
		await team.page.goto(usagePath(team.orgSlug));
		await expect(team.page.getByText("Seats")).toBeVisible({ timeout: 30_000 });
		// seats vs members → "N seats available" sub-note.
		await expect(team.page.getByText(/seats available/)).toBeVisible();
		await expect(team.page.getByText("Concurrency")).toBeVisible();
	});

	test("the spend-control hard-cap toggle flips and can be restored", { tag: "@needs:stripe" }, async ({ team }) => {
		await team.page.goto(usagePath(team.orgSlug));
		const cap = team.page.getByRole("checkbox");
		await expect(cap).toBeVisible({ timeout: 30_000 });
		const before = await cap.isChecked();
		await cap.click();
		await expect(cap).toBeChecked({ checked: !before });
		// Be a good citizen — restore the org's prior hard-cap state.
		await cap.click();
		await expect(cap).toBeChecked({ checked: before });
	});

	test("resources section surfaces spend-under-management", { tag: "@needs:stripe" }, async ({ team }) => {
		await team.page.goto(usagePath(team.orgSlug));
		await expect(team.page.getByText("Resources")).toBeVisible({ timeout: 30_000 });
		await expect(
			team.page.getByText(/Estimated cloud spend under management/i),
		).toBeVisible();
	});

	test("usage-over-time metric tabs switch the summary metric", { tag: "@needs:stripe" }, async ({ team }) => {
		await team.page.goto(usagePath(team.orgSlug));
		await expect(team.page.getByText("Usage over time")).toBeVisible({ timeout: 30_000 });
		await team.page.getByRole("button", { name: "Jobs" }).click();
		await expect(team.page.getByText(/jobs · last 7 days/i)).toBeVisible();
	});

	test("the quick-range filter changes the active window", { tag: "@needs:stripe" }, async ({ team }) => {
		await team.page.goto(usagePath(team.orgSlug));
		await team.page.getByRole("button", { name: /last 7 days/i }).click();
		await team.page.getByRole("button", { name: "Last 30 days" }).click();
		await expect(
			team.page.getByRole("button", { name: /last 30 days/i }),
		).toBeVisible();
	});

	test("AI usage section shows the weekly window, balance and top-up link", { tag: "@needs:stripe" }, async ({ team }) => {
		await team.page.goto(usagePath(team.orgSlug));
		await expect(team.page.getByText("AI usage")).toBeVisible({ timeout: 30_000 });
		await expect(team.page.getByText("AI credits this week")).toBeVisible();
		await expect(team.page.getByText("Purchased balance")).toBeVisible();
		await expect(team.page.getByRole("link", { name: /buy credits/i })).toBeVisible();
	});

	test("usage page has no serious accessibility violations", { tag: "@needs:stripe" }, async ({ team }) => {
		await team.page.goto(usagePath(team.orgSlug));
		await expect(team.page.getByText("Plan & limits")).toBeVisible({ timeout: 30_000 });
		const violations = await scanA11y(team.page);
		// scanA11y no-ops until axe is installed — this simply records when it is.
		expect(violations.filter((v) => v.impact === "critical")).toEqual([]);
	});
});

// ── Usage page — Hobby (owner persona) ────────────────────────────────────────────────────
test.describe("Usage — Hobby (owner)", () => {
	test("community org shows the Hobby standing and an inline upgrade CTA", { tag: "@needs:stripe" }, async ({ owner }) => {
		await owner.page.goto(usagePath(owner.orgSlug));
		await expect(owner.page.getByText("Hobby plan")).toBeVisible({ timeout: 30_000 });
		await expect(owner.page.getByRole("button", { name: /Upgrade to Pro/ })).toBeVisible();
	});

	test("the inline usage upgrade CTA opens the Pro sheet (stop before payment)", { tag: "@needs:stripe" }, async ({
		owner,
	}) => {
		await owner.page.goto(usagePath(owner.orgSlug));
		await owner.page.getByRole("button", { name: /Upgrade to Pro/ }).click();
		const dialog = owner.page.getByRole("dialog");
		await expect(dialog.getByRole("heading", { name: "Upgrade to Pro" })).toBeVisible({
			timeout: 30_000,
		});
	});
});
