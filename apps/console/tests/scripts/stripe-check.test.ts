// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// scripts/stripe-check.ts (EA-6, #7322): read-only, reports what EA-8's evidence cites, and passes
// only on an account that stripe-setup has converged.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCheck, runCheckCli } from "../../scripts/stripe-check";
import { runSetup, WEBHOOK_EVENTS } from "../../scripts/stripe-setup";
import { emptyAccount, FAKE_WEBHOOK_SECRET, type FakeAccount, fakeClient } from "./stripe-fake";

const KEY = { STRIPE_API_KEY: "sk_test_unit_000" };
const URL = "https://alethialabs.io/api/webhooks/stripe";

/** An account stripe-setup has applied to (with the webhook). */
async function converged(): Promise<FakeAccount> {
	const acct = emptyAccount();
	const dir = mkdtempSync(join(tmpdir(), "stripe-check-"));
	try {
		const code = await runSetup(["--apply", `--webhook-url=${URL}`], KEY, () => fakeClient(acct), () => {}, dir);
		expect(code).toBe(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	acct.writes = [];
	return acct;
}

describe("stripe-check", () => {
	it("passes on a converged account, reports every evidence field, and writes nothing", async () => {
		const acct = await converged();
		const lines: string[] = [];
		const code = await runCheckCli([`--webhook-url=${URL}`], KEY, () => fakeClient(acct), (l) => lines.push(l));
		expect(code).toBe(0);
		expect(acct.writes).toEqual([]);
		const out = lines.join("\n");
		for (const expected of [
			"mode: test",
			"account.id: acct_test123",
			"account.country: BG",
			"account.charges_enabled: no",
			"tax.status: pending",
			"tax.default_tax_code: txcd_10103001",
			"tax.head_office: 9 Sirak Skitnik Street, entrance A, floor 4, apartment 7, Slatina District, 1111 Sofia, BG",
			"portal.customer_updates: email",
			"portal.invoice_history: no",
			"portal.subscription_update: no",
			"portal.headline: Alethia: manage your subscription and payment method",
			"payment_methods.id: pmc_default",
			"payment_methods.on: apple_pay,card,google_pay,link",
			"payment_methods.available: apple_pay,card,google_pay,link",
			"matches_catalog: yes",
		]) {
			expect(out).toContain(expected);
		}
		expect(out).toMatch(/product\.pro: prod_\d+ tax_code=txcd_10103001/);
		expect(out).toMatch(/price\.alethia_pro_monthly: price_\d+ tax_behavior=exclusive \(STRIPE_PRICE_TEAM\)/);
		expect(out).toMatch(new RegExp(`webhook\\.we_\\d+: ${URL} status=enabled events=${WEBHOOK_EVENTS.length} matches_handler=yes`));
		expect(out).not.toContain(FAKE_WEBHOOK_SECRET);
	});

	it("fails on drift and names it", async () => {
		const acct = await converged();
		const portal = acct.portals[0];
		if (!portal) throw new Error("no portal");
		portal.features.customer_update.allowed_updates = ["email", "tax_id"];
		const report = await runCheck(fakeClient(acct), "test", URL);
		expect(report.matches).toBe(false);
		expect(report.plan.join("\n")).toContain("~ portal");
		expect(report.portal?.customerUpdates).toEqual(["email", "tax_id"]);
	});

	it("fails when a payment method was turned back on in the dashboard", async () => {
		const acct = await converged();
		const sepa = acct.pmcs.find((c) => c.is_default)?.sepa_debit;
		if (!sepa) throw new Error("no sepa_debit");
		sepa.display_preference.preference = "on";
		const report = await runCheck(fakeClient(acct), "test", URL);
		expect(report.matches).toBe(false);
		expect(report.plan.join("\n")).toContain("~ payment methods pmc_default: off sepa_debit");
		expect(report.paymentMethods?.on).toContain("sepa_debit");
	});

	it("flags an endpoint whose events differ from the handler's", async () => {
		const acct = await converged();
		acct.webhooks.push({
			id: "we_stray",
			url: "https://example.test/hook",
			status: "enabled",
			enabled_events: ["payment_intent.succeeded"],
			secret: "x",
		});
		const report = await runCheck(fakeClient(acct), "test", undefined);
		expect(report.webhooks.find((w) => w.id === "we_stray")?.matchesHandler).toBe(false);
	});

	it("refuses a live key without --live before any Stripe call", async () => {
		const make = vi.fn(() => fakeClient(emptyAccount()));
		const lines: string[] = [];
		expect(await runCheckCli([], { STRIPE_API_KEY: "sk_live_x" }, make, (l) => lines.push(l))).toBe(2);
		expect(make).not.toHaveBeenCalled();
	});

	it("prints one parseable JSON object with --json", async () => {
		const acct = await converged();
		const lines: string[] = [];
		await runCheckCli(["--json"], KEY, () => fakeClient(acct), (l) => lines.push(l));
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "")).toMatchObject({ mode: "test", account: { id: "acct_test123" } });
	});
});
