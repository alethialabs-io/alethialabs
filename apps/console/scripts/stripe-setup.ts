// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Idempotent Stripe catalog setup — creates the products/prices/meter the app needs,
// in whichever MODE the secret key targets (test vs live). Re-runnable: it finds
// existing objects by lookup_key / event_name and reuses them, so it never duplicates.
//
// The per-seat price is derived from the SINGLE SOURCE OF TRUTH — @repo/plan-catalog
// (`planUnitAmountCents("team")`) — so the created Stripe price can never drift from the
// advertised pricing-page/catalog amount. Run via tsx (see the `stripe:setup` script).
//
// What it ensures:
//   • Product "Alethia Pro" + per-seat Price (planUnitAmountCents)  → STRIPE_PRICE_TEAM
//   • Billing Meter "alethia_runner_minutes" (sum, by stripe_customer_id)
//   • Pro runner-minutes graduated Price (free ≤500 min, then $0.012/min)
//                                                                  → STRIPE_PRICE_METER_TEAM
//   (Enterprise is invoiced off-Stripe — no Stripe objects.)
//
// Usage:
//   pnpm -F console stripe:setup                 # print the env block
//   pnpm -F console stripe:setup -- --write-env  # also patch the root .env
//   STRIPE_SECRET_KEY=sk_live_… pnpm -F console stripe:setup -- --webhook-url=https://alethialabs.io/api/webhooks/stripe
//
// TEST → LIVE: re-run with the live secret key (and --webhook-url) to mirror the catalog
// into live mode; it prints the live price IDs + the new webhook signing secret to set as
// prod env. Stripe test/live are separate datasets — only the catalog is recreated;
// customers/subscriptions do not migrate.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatMoney, planUnitAmountCents } from "@repo/plan-catalog";
import Stripe from "stripe";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT_ENV = join(here, "../../../.env"); // apps/console/scripts → repo root

// ── Pricing — the per-seat amount is the SSOT (@repo/plan-catalog); the runner-minutes
// free tier + overage mirror lib/billing/{plan,meter}.ts. ──
const PRO_UNIT_AMOUNT = planUnitAmountCents("team"); // $ / seat / month (from the catalog)
const RUNNER_INCLUDED_PRO = 500; // free runner-minutes/month on Pro (plan.ts includedRunnerMinutes)
const RUNNER_OVERAGE_CENTS = "1.2"; // $0.012 / minute beyond included (meter.ts)
const METER_EVENT = "alethia_runner_minutes"; // RUNNER_MINUTES_METER_EVENT
const LK_PRO = "alethia_pro_monthly";
const LK_METER_PRO = "alethia_runner_minutes_pro";
const PRO_SEAT_LABEL = `${formatMoney(PRO_UNIT_AMOUNT, "usd")} / seat / mo`;

const WEBHOOK_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
	"customer.subscription.created",
	"customer.subscription.updated",
	"customer.subscription.deleted",
	"customer.subscription.trial_will_end",
	"checkout.session.completed",
	"invoice.payment_succeeded",
	"invoice.payment_failed",
];

/** Loads root .env into process.env without overriding values already set (so an
 *  explicit `STRIPE_SECRET_KEY=sk_live_… …` wins over the file's test key). */
function loadRootEnv(): void {
	if (!existsSync(ROOT_ENV)) return;
	for (const raw of readFileSync(ROOT_ENV, "utf8").split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		if (process.env[key] !== undefined) continue;
		let val = line.slice(eq + 1).trim();
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		process.env[key] = val;
	}
}

/** Upserts KEY=value lines into the root .env (replace existing, else append). */
function patchRootEnv(pairs: Record<string, string>): void {
	let text = existsSync(ROOT_ENV) ? readFileSync(ROOT_ENV, "utf8") : "";
	for (const [key, value] of Object.entries(pairs)) {
		const line = `${key}=${value}`;
		const re = new RegExp(`^#?\\s*${key}=.*$`, "m");
		text = re.test(text) ? text.replace(re, line) : `${text.replace(/\n?$/, "\n")}${line}\n`;
	}
	writeFileSync(ROOT_ENV, text);
}

/** Finds a Product by our `alethia` metadata tag, creating it on first run. */
async function ensureProduct(
	stripe: Stripe,
	tag: string,
	name: string,
): Promise<Stripe.Product> {
	const found = await stripe.products.search({
		query: `metadata['alethia']:'${tag}' AND active:'true'`,
		limit: 1,
	});
	if (found.data[0]) return found.data[0];
	return stripe.products.create({ name, metadata: { alethia: tag } });
}

/** Finds an active Price by lookup_key, creating it (with that key) on first run. */
async function ensurePrice(
	stripe: Stripe,
	lookupKey: string,
	create: Stripe.PriceCreateParams,
): Promise<Stripe.Price> {
	const found = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
	if (found.data[0]) return found.data[0];
	return stripe.prices.create({ ...create, lookup_key: lookupKey });
}

/**
 * Ensures the flat per-seat Price matches the catalog amount. Stripe prices are
 * immutable, so when a stale price under the lookup_key has a different `unit_amount`
 * we mint a new price, transfer the lookup_key onto it, and archive the old one — so
 * re-running reconciles Stripe to the SSOT catalog instead of silently keeping the old
 * amount. Existing subscriptions on the archived price keep their price; new signups
 * use the new one.
 */
async function ensureSeatPrice(
	stripe: Stripe,
	lookupKey: string,
	product: string,
	unitAmount: number,
): Promise<Stripe.Price> {
	const found = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
	const existing = found.data[0];
	if (existing && existing.unit_amount === unitAmount) return existing;

	const created = await stripe.prices.create({
		product,
		currency: "usd",
		unit_amount: unitAmount,
		recurring: { interval: "month", usage_type: "licensed" },
		nickname: `Alethia Pro — ${PRO_SEAT_LABEL}`,
		lookup_key: lookupKey,
		transfer_lookup_key: Boolean(existing),
	});
	if (existing) {
		await stripe.prices.update(existing.id, { active: false });
		console.log(
			`  ↻ reconciled Pro price to the catalog: archived ${existing.id} ` +
				`(${formatMoney(existing.unit_amount ?? 0, "usd")}) → ${created.id} (${formatMoney(unitAmount, "usd")})`,
		);
	}
	return created;
}

/** Finds the runner-minutes Billing Meter by event_name, creating it on first run. */
async function ensureMeter(stripe: Stripe): Promise<Stripe.Billing.Meter> {
	const meters = await stripe.billing.meters.list({ status: "active", limit: 100 });
	const existing = meters.data.find((m) => m.event_name === METER_EVENT);
	if (existing) return existing;
	return stripe.billing.meters.create({
		display_name: "Alethia runner minutes",
		event_name: METER_EVENT,
		default_aggregation: { formula: "sum" },
		customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
		value_settings: { event_payload_key: "value" },
	});
}

async function main(): Promise<void> {
	loadRootEnv();
	const secret = process.env.STRIPE_SECRET_KEY;
	if (!secret) {
		console.error("✗ STRIPE_SECRET_KEY is not set (root .env or the environment).");
		process.exit(1);
	}
	const mode = secret.startsWith("sk_live_") ? "LIVE" : "TEST";
	const args = process.argv.slice(2);
	const writeEnv = args.includes("--write-env");
	const webhookUrl = args.find((a) => a.startsWith("--webhook-url="))?.split("=")[1];

	const stripe = new Stripe(secret, { appInfo: { name: "Alethia stripe-setup" } });
	console.log(`→ Stripe ${mode} mode — ensuring catalog (Pro = ${PRO_SEAT_LABEL})…\n`);

	// 1) Pro product + per-seat price (amount from the catalog SSOT; reconciles if stale).
	const proProduct = await ensureProduct(stripe, "pro", "Alethia Pro");
	const proPrice = await ensureSeatPrice(stripe, LK_PRO, proProduct.id, PRO_UNIT_AMOUNT);
	console.log(`✓ Pro product ${proProduct.id}`);
	console.log(`✓ Pro price   ${proPrice.id}  (${LK_PRO}, ${formatMoney(proPrice.unit_amount ?? PRO_UNIT_AMOUNT, "usd")})`);

	// 2) Runner-minutes meter.
	const meter = await ensureMeter(stripe);
	console.log(`✓ Meter       ${meter.id}  (${METER_EVENT})`);

	// 3) Pro runner-minutes graduated metered price (free ≤ included, then overage).
	const runnerProduct = await ensureProduct(stripe, "runner_minutes", "Alethia runner minutes");
	const meterPrice = await ensurePrice(stripe, LK_METER_PRO, {
		product: runnerProduct.id,
		currency: "usd",
		billing_scheme: "tiered",
		tiers_mode: "graduated",
		tiers: [
			{ up_to: RUNNER_INCLUDED_PRO, unit_amount: 0 },
			// Sub-cent per-minute overage → the branded Decimal (serializes to "1.2").
			{ up_to: "inf", unit_amount_decimal: Stripe.Decimal.from(RUNNER_OVERAGE_CENTS) },
		],
		recurring: { interval: "month", usage_type: "metered", meter: meter.id },
		nickname: "Alethia runner minutes — Pro overage ($0.012/min)",
	});
	console.log(`✓ Meter price ${meterPrice.id}  (${LK_METER_PRO})`);

	// 4) Optional webhook endpoint (for the live runbook).
	let webhookSecret: string | undefined;
	if (webhookUrl) {
		const existing = await stripe.webhookEndpoints.list({ limit: 100 });
		const match = existing.data.find((w) => w.url === webhookUrl);
		if (match) {
			// Keep an existing endpoint's subscribed events in sync with the handler
			// (adds any new events like trial_will_end). The signing secret can't be
			// re-read — roll it in the dashboard if a fresh one is needed.
			await stripe.webhookEndpoints.update(match.id, { enabled_events: WEBHOOK_EVENTS });
			console.log(
				`\n✓ Webhook endpoint ${match.id} already exists — synced enabled_events` +
					` (${WEBHOOK_EVENTS.length}). Its signing secret is only shown at creation;` +
					` roll it in the dashboard if you need a fresh STRIPE_WEBHOOK_SECRET.`,
			);
		} else {
			const wh = await stripe.webhookEndpoints.create({
				url: webhookUrl,
				enabled_events: WEBHOOK_EVENTS,
			});
			webhookSecret = wh.secret;
			console.log(`✓ Webhook     ${wh.id}  → ${webhookUrl}`);
		}
	}

	// Output env block.
	const envPairs: Record<string, string> = {
		STRIPE_PRICE_TEAM: proPrice.id,
		STRIPE_PRICE_METER_TEAM: meterPrice.id,
	};
	console.log(`\n── ${mode} env ${"─".repeat(40)}`);
	for (const [k, v] of Object.entries(envPairs)) console.log(`${k}=${v}`);
	if (webhookSecret) console.log(`STRIPE_WEBHOOK_SECRET=${webhookSecret}`);
	console.log("# Enterprise is invoiced off-Stripe — STRIPE_PRICE_ENTERPRISE intentionally unset.");
	console.log("─".repeat(52));

	if (writeEnv) {
		patchRootEnv(envPairs);
		console.log(`\n✓ Patched ${ROOT_ENV} (STRIPE_PRICE_TEAM, STRIPE_PRICE_METER_TEAM).`);
	} else {
		console.log("\n(Use --write-env to patch the root .env, or copy the block above.)");
	}
	process.exit(0);
}

main().catch((err) => {
	console.error("\n✗ stripe-setup failed:\n");
	console.error(err);
	process.exit(1);
});
