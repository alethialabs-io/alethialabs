// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// scripts/stripe-setup.ts as a plan/apply tool (EA-6, #7322), against an in-memory Stripe account
// (tests/scripts/stripe-fake.ts). Pinned: `--plan` writes nothing; `--apply` converges and a second
// apply writes nothing; prices are the catalog's amounts with `tax_behavior: exclusive`; every
// product carries the SaaS tax code; a drifted price is replaced, never edited; the portal allows no
// tax-ID or address edit and carries the headline and legal links; the default payment method
// configuration offers exactly card, Apple Pay, Google Pay and Link; the webhook has exactly the
// handler's events; its signing secret reaches a 0600 file and never the output; a live key needs
// `--live`; every customer the console creates carries the "not a tax invoice" footer.

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aiPlanUnitAmountCents, planUnitAmountCents } from "@repo/plan-catalog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ALL_PAYMENT_METHODS,
	computePlan,
	DESIRED_PAYMENT_METHODS,
	DESIRED_PORTAL,
	HEAD_OFFICE,
	modeRefusal,
	parseHeadOffice,
	paymentMethodUpdateParams,
	readState,
	resolveKey,
	runSetup,
	SAAS_TAX_CODE,
	type StripeKeyEnv,
	WEBHOOK_EVENTS,
} from "../../scripts/stripe-setup";
import { STRIPE_INVOICE_FOOTER } from "../../lib/billing/receipt-footer";
import { emptyAccount, FAKE_WEBHOOK_SECRET, type FakeAccount, fakeClient, pmSetting } from "./stripe-fake";

const TEST_KEY = "sk_test_unit_000";
const LIVE_KEY = "sk_live_unit_000";
const URL = "https://alethialabs.io/api/webhooks/stripe";

let dir: string;
let lines: string[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "stripe-setup-"));
	lines = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Runs the CLI against `acct` with a test key, collecting output. */
function run(acct: FakeAccount, argv: string[], env: StripeKeyEnv = { STRIPE_API_KEY: TEST_KEY }) {
	return runSetup(argv, env, () => fakeClient(acct), (l) => lines.push(l), join(dir, "secrets"));
}

describe("keys and modes", () => {
	it("prefers STRIPE_API_KEY (the creds profile) and falls back to STRIPE_SECRET_KEY", () => {
		expect(resolveKey({ STRIPE_API_KEY: TEST_KEY })).toEqual({ ok: true, key: TEST_KEY, mode: "test" });
		expect(resolveKey({ STRIPE_SECRET_KEY: LIVE_KEY })).toEqual({ ok: true, key: LIVE_KEY, mode: "live" });
		expect(resolveKey({ STRIPE_API_KEY: "rk_test_x" })).toMatchObject({ ok: true, mode: "test" });
	});

	it("refuses two different keys, no key, and a publishable key, without echoing the key", () => {
		const both = resolveKey({ STRIPE_API_KEY: TEST_KEY, STRIPE_SECRET_KEY: LIVE_KEY });
		expect(both.ok).toBe(false);
		expect(JSON.stringify(both)).not.toContain("unit_000");
		expect(resolveKey({}).ok).toBe(false);
		const pk = resolveKey({ STRIPE_API_KEY: "pk_live_abc" });
		expect(pk.ok).toBe(false);
		expect(JSON.stringify(pk)).not.toContain("pk_live_abc");
	});

	it("refuses a live key without --live, and --live with a test key", () => {
		expect(modeRefusal("live", false)).toMatch(/--live/);
		expect(modeRefusal("test", true)).toMatch(/TEST key/);
		expect(modeRefusal("live", true)).toBeNull();
		expect(modeRefusal("test", false)).toBeNull();
	});

	it("a live key without --live exits 2 before any Stripe call", async () => {
		const make = vi.fn(() => fakeClient(emptyAccount()));
		const code = await runSetup(["--plan"], { STRIPE_API_KEY: LIVE_KEY }, make, (l) => lines.push(l), dir);
		expect(code).toBe(2);
		expect(make).not.toHaveBeenCalled();
		expect(lines.join("\n")).not.toContain(LIVE_KEY);
	});

	it("with --live, prints the target account first", async () => {
		const acct = emptyAccount();
		const code = await run(acct, ["--live", "--plan"], { STRIPE_API_KEY: LIVE_KEY });
		expect(code).toBe(0);
		expect(lines[0]).toBe("→ Stripe LIVE mode · account acct_test123 · Alethia Labs sandbox · country BG");
	});

	it("needs exactly one of --plan or --apply and refuses unknown flags", async () => {
		expect(await run(emptyAccount(), [])).toBe(2);
		expect(await run(emptyAccount(), ["--plan", "--apply"])).toBe(2);
		expect(await run(emptyAccount(), ["--plan", "--write-env"])).toBe(2);
		expect(await run(emptyAccount(), ["--plan", "--webhook-url=http://insecure"])).toBe(2);
	});
});

describe("head office", () => {
	it("splits LEGAL_ENTITY's address into Stripe fields", () => {
		expect(HEAD_OFFICE).toEqual({
			line1: "9 Sirak Skitnik Street",
			line2: "entrance A, floor 4, apartment 7, Slatina District",
			city: "Sofia",
			postal_code: "1111",
			country: "BG",
		});
	});

	it("throws on an address it cannot read rather than guessing", () => {
		expect(() => parseHeadOffice("Somewhere, Atlantis")).toThrow(/unexpected shape/);
	});
});

describe("--plan", () => {
	it("on an empty account lists every object to create and writes nothing", async () => {
		const acct = emptyAccount();
		const code = await run(acct, ["--plan", `--webhook-url=${URL}`]);
		expect(code).toBe(0);
		expect(acct.writes).toEqual([]);
		const out = lines.join("\n");
		expect(out).toContain("Plan: 10 to create, 3 to update, 0 to replace");
		expect(out).toContain(`+ product pro "Alethia Pro" (tax_code ${SAAS_TAX_CODE})`);
		expect(out).toContain("+ price alethia_pro_monthly");
		expect(out).toContain("+ meter alethia_runner_minutes");
		expect(out).toContain(`+ webhook ${URL} (${WEBHOOK_EVENTS.length} events)`);
		expect(out).toMatch(/~ portal bpc_default: customer_update \["address","email","tax_id"\] → \["email"\]/);
		expect(out).toContain('~ tax settings: defaults.tax_code (none) → txcd_10103001');
		expect(out).toContain(`headline (none) → "${DESIRED_PORTAL.headline}"`);
		expect(out).toContain("~ payment methods pmc_default: on apple_pay; off bancontact ideal sepa_debit");
	});

	it("blocks (exit 1) when the account has no default payment method configuration", async () => {
		const acct = emptyAccount();
		acct.pmcs = acct.pmcs.filter((c) => !c.is_default);
		expect(await run(acct, ["--apply"])).toBe(1);
		expect(acct.writes).toEqual([]);
		expect(lines.join("\n")).toContain("No default payment method configuration");
	});

	it("blocks (exit 1) when the account does not offer a desired method, rather than half-applying", async () => {
		const acct = emptyAccount();
		const pmc = acct.pmcs.find((c) => c.is_default);
		if (!pmc) throw new Error("no default pmc");
		delete pmc.link;
		expect(await run(acct, ["--apply"])).toBe(1);
		expect(acct.writes).toEqual([]);
		expect(lines.join("\n")).toContain("the account does not offer link");
	});

	it("blocks (exit 1) when the account has no default portal configuration", async () => {
		const acct = emptyAccount();
		acct.portals = [];
		expect(await run(acct, ["--plan"])).toBe(1);
		expect(lines.join("\n")).toContain("No default Customer Portal configuration");
	});
});

describe("--apply", () => {
	it("creates the catalog at the plan-catalog amounts, exclusive of tax, with the SaaS tax code", async () => {
		const acct = emptyAccount();
		expect(await run(acct, ["--apply"])).toBe(0);

		expect(acct.products.map((p) => [p.metadata.alethia, p.tax_code])).toEqual([
			["pro", SAAS_TAX_CODE],
			["runner_minutes", SAAS_TAX_CODE],
			["ai_plus", SAAS_TAX_CODE],
			["ai_max", SAAS_TAX_CODE],
		]);
		const byKey = new Map(acct.prices.map((p) => [p.lookup_key, p]));
		const expectFlat = (key: string, usd: number, eur: number) => {
			const p = byKey.get(key);
			expect(p).toMatchObject({
				unit_amount: usd,
				tax_behavior: "exclusive",
				currency_options: { eur: { unit_amount: eur, tax_behavior: "exclusive" } },
				recurring: { interval: "month", usage_type: "licensed" },
			});
		};
		expectFlat("alethia_pro_monthly", planUnitAmountCents("team"), planUnitAmountCents("team", "eur"));
		expectFlat("alethia_ai_plus_monthly", aiPlanUnitAmountCents("ai_plus"), aiPlanUnitAmountCents("ai_plus", "eur"));
		expectFlat("alethia_ai_max_monthly", aiPlanUnitAmountCents("ai_max"), aiPlanUnitAmountCents("ai_max", "eur"));
		expect(byKey.get("alethia_runner_minutes_pro")).toMatchObject({
			tax_behavior: "exclusive",
			billing_scheme: "tiered",
			recurring: { usage_type: "metered", meter: acct.meters[0]?.id },
			tiers: [
				{ up_to: 500, unit_amount: 0 },
				{ up_to: null, unit_amount_decimal: "1.2" },
			],
		});

		expect(acct.tax.defaults).toEqual({ tax_code: SAAS_TAX_CODE, tax_behavior: "exclusive" });
		expect(acct.tax.head_office?.address).toEqual(HEAD_OFFICE);
		const portal = acct.portals[0]?.features;
		expect(portal?.customer_update.allowed_updates).toEqual(["email"]);
		expect(portal?.invoice_history.enabled).toBe(false);
		expect(portal?.subscription_update.enabled).toBe(false);
		expect(acct.portals[0]?.business_profile).toEqual({
			headline: DESIRED_PORTAL.headline,
			privacy_policy_url: "https://alethialabs.io/privacy",
			terms_of_service_url: "https://alethialabs.io/terms",
		});
		expect(lines).toContain("✓ Converged: a second plan is empty.");
		expect(lines.some((l) => /^STRIPE_PRICE_TEAM=price_\d+$/.test(l))).toBe(true);
	});

	it("is idempotent: a second apply writes nothing and a plan after it is empty", async () => {
		const acct = emptyAccount();
		expect(await run(acct, ["--apply", `--webhook-url=${URL}`])).toBe(0);
		const writes = acct.writes.length;
		lines = [];
		expect(await run(acct, ["--apply", `--webhook-url=${URL}`])).toBe(0);
		expect(acct.writes.length).toBe(writes);
		expect(lines).toContain("No changes.");
		const plan = computePlan(await readState(fakeClient(acct), URL));
		expect(plan.actions).toEqual([]);
		expect(plan.errors).toEqual([]);
	});

	it("replaces a price whose tax behaviour is unspecified: new price takes the lookup key, old one archived", async () => {
		const acct = emptyAccount();
		await run(acct, ["--apply"]);
		const old = acct.prices.find((p) => p.lookup_key === "alethia_pro_monthly");
		if (!old) throw new Error("no pro price");
		old.tax_behavior = "unspecified";
		lines = [];
		expect(await run(acct, ["--plan"])).toBe(0);
		expect(lines.join("\n")).toContain(`± price alethia_pro_monthly: replace ${old.id} (tax_behavior "unspecified" → exclusive)`);

		expect(await run(acct, ["--apply"])).toBe(0);
		const current = acct.prices.find((p) => p.lookup_key === "alethia_pro_monthly");
		expect(current?.id).not.toBe(old.id);
		expect(current?.tax_behavior).toBe("exclusive");
		expect(old.active).toBe(false);
	});

	it("replaces a price that drifted from the catalog amount (no discounts survive)", async () => {
		const acct = emptyAccount();
		await run(acct, ["--apply"]);
		const old = acct.prices.find((p) => p.lookup_key === "alethia_ai_plus_monthly");
		if (!old) throw new Error("no ai plus price");
		old.unit_amount = 1;
		lines = [];
		await run(acct, ["--apply"]);
		expect(acct.prices.find((p) => p.lookup_key === "alethia_ai_plus_monthly")?.unit_amount).toBe(
			aiPlanUnitAmountCents("ai_plus"),
		);
	});

	it("updates a product's tax code in place", async () => {
		const acct = emptyAccount();
		await run(acct, ["--apply"]);
		const pro = acct.products[0];
		if (!pro) throw new Error("no product");
		pro.tax_code = "txcd_10000000";
		lines = [];
		await run(acct, ["--apply"]);
		expect(acct.writes.filter((w) => w === `products.update ${pro.id}`)).toHaveLength(1);
		expect(pro.tax_code).toBe(SAAS_TAX_CODE);
	});

	it("writes a new webhook signing secret to a 0600 file and never prints it", async () => {
		const acct = emptyAccount();
		expect(await run(acct, ["--apply", `--webhook-url=${URL}`])).toBe(0);
		const out = lines.join("\n");
		expect(out).not.toContain(FAKE_WEBHOOK_SECRET);
		expect(out).not.toContain("whsec_");
		const path = join(dir, "secrets", "webhook-secret.test.acct_test123");
		expect(out).toContain(`Webhook signing secret written to ${path} (0600)`);
		expect(readFileSync(path, "utf8")).toBe(`${FAKE_WEBHOOK_SECRET}\n`);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(acct.webhooks[0]?.enabled_events).toEqual(WEBHOOK_EVENTS);
	});

	it("sets an existing endpoint's events to exactly the handler's, dropping strays", async () => {
		const acct = emptyAccount();
		acct.webhooks.push({
			id: "we_old",
			url: URL,
			status: "disabled",
			enabled_events: ["payment_intent.succeeded", "invoice.payment_failed"],
			secret: "whsec_existing",
		});
		await run(acct, ["--plan", `--webhook-url=${URL}`]);
		expect(lines.join("\n")).toMatch(/~ webhook we_old: .*-payment_intent\.succeeded; status disabled → enabled/);
		lines = [];
		expect(await run(acct, ["--apply", `--webhook-url=${URL}`])).toBe(0);
		expect([...(acct.webhooks[0]?.enabled_events ?? [])].sort()).toEqual([...WEBHOOK_EVENTS].sort());
		expect(acct.webhooks[0]?.status).toBe("enabled");
		expect(lines.join("\n")).not.toContain("whsec_");
	});

	it("sets the portal headline back when it was edited in the dashboard", async () => {
		const acct = emptyAccount();
		await run(acct, ["--apply"]);
		const portal = acct.portals[0];
		if (!portal) throw new Error("no portal");
		portal.business_profile.headline = "Manage billing";
		lines = [];
		expect(await run(acct, ["--apply"])).toBe(0);
		expect(portal.business_profile.headline).toBe(DESIRED_PORTAL.headline);
		expect(lines.join("\n")).toContain(`~ portal bpc_default: headline "Manage billing" → "${DESIRED_PORTAL.headline}"`);
	});

	it("leaves exactly card, Apple Pay, Google Pay and Link on, in the default configuration only", async () => {
		const acct = emptyAccount();
		expect(await run(acct, ["--apply"])).toBe(0);
		const pmc = acct.pmcs.find((c) => c.is_default);
		if (!pmc) throw new Error("no default pmc");
		const on = ALL_PAYMENT_METHODS.filter((m) => pmc[m]?.display_preference.preference === "on");
		expect(on).toEqual([...DESIRED_PAYMENT_METHODS].sort());
		// Every method the account offers has an explicit preference: none is left at Stripe's default.
		const offered = ALL_PAYMENT_METHODS.filter((m) => pmc[m] !== undefined);
		expect(offered.filter((m) => pmc[m]?.display_preference.preference === "none")).toEqual([]);
		expect(pmc.klarna?.display_preference.preference).toBe("off");
		// The non-default configuration is not touched.
		expect(acct.pmcs.find((c) => !c.is_default)?.sepa_debit?.display_preference.preference).toBe("on");
		expect(acct.writes.filter((w) => w.startsWith("payment_methods.update"))).toEqual([
			"payment_methods.update pmc_default",
		]);
	});

	it("turns a method switched on in the dashboard back off, and sends only what drifted", async () => {
		const acct = emptyAccount();
		await run(acct, ["--apply"]);
		const pmc = acct.pmcs.find((c) => c.is_default);
		if (!pmc) throw new Error("no default pmc");
		pmc.ideal = pmSetting("on");
		pmc.card = pmSetting("none", true);
		lines = [];
		expect(await run(acct, ["--plan"])).toBe(0);
		expect(lines.join("\n")).toContain("~ payment methods pmc_default: on card; off ideal");
		expect(await run(acct, ["--apply"])).toBe(0);
		expect(pmc.ideal?.display_preference.preference).toBe("off");
		expect(pmc.card?.display_preference.preference).toBe("on");
		expect(lines).toContain("✓ Converged: a second plan is empty.");
	});

	it("refuses to apply when two endpoints share the URL", async () => {
		const acct = emptyAccount();
		for (const id of ["we_a", "we_b"]) {
			acct.webhooks.push({ id, url: URL, status: "enabled", enabled_events: [...WEBHOOK_EVENTS], secret: "x" });
		}
		expect(await run(acct, ["--apply", `--webhook-url=${URL}`])).toBe(1);
		expect(acct.writes).toEqual([]);
	});
});

describe("payment method keys", () => {
	it("are the pinned SDK's method fields, and include every desired method", () => {
		expect(ALL_PAYMENT_METHODS.length).toBeGreaterThan(50);
		for (const m of DESIRED_PAYMENT_METHODS) expect(ALL_PAYMENT_METHODS).toContain(m);
		expect(ALL_PAYMENT_METHODS).not.toContain("id");
		expect(ALL_PAYMENT_METHODS).not.toContain("is_default");
	});

	it("update params carry only the methods that drifted, as display preferences", () => {
		expect(
			paymentMethodUpdateParams([
				{ method: "card", preference: "on" },
				{ method: "sepa_debit", preference: "off" },
			]),
		).toEqual({
			card: { display_preference: { preference: "on" } },
			sepa_debit: { display_preference: { preference: "off" } },
		});
	});
});

describe("customer invoice footer", () => {
	it("reads as a payment receipt, not a tax invoice", () => {
		expect(STRIPE_INVOICE_FOOTER).toBe(
			"This is a payment receipt, not a tax invoice. Your фактура is issued by Alethia Labs and is available in your billing settings.",
		);
	});

	it("is set on every Stripe customer the console creates", () => {
		// Every .ts/.tsx under app/ and lib/, not a hand-picked file list: a new creation site is caught.
		const root = join(__dirname, "../..");
		const files = ["app", "lib"].flatMap((dir) =>
			readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
				.filter((f) => /\.tsx?$/.test(f))
				.map((f) => join(root, dir, f)),
		);
		let calls = 0;
		for (const file of files) {
			const src = readFileSync(file, "utf8");
			for (const m of src.matchAll(/customers\.create\(\{/g)) {
				calls++;
				const body = src.slice(m.index, src.indexOf("});", m.index));
				expect(body).toContain("invoice_settings: { footer: STRIPE_INVOICE_FOOTER }");
			}
		}
		expect(calls).toBe(2);
	});
});

describe("WEBHOOK_EVENTS", () => {
	it("is exactly the set of events lib/billing/webhook-handler.ts handles", () => {
		const src = readFileSync(join(__dirname, "../../lib/billing/webhook-handler.ts"), "utf8");
		const handled = [...src.matchAll(/case "([a-z_.]+)":/g)].map((m) => m[1]);
		expect(handled.length).toBeGreaterThan(0);
		expect([...new Set(handled)].sort()).toEqual([...WEBHOOK_EVENTS].sort());
	});
});
