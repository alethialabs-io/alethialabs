// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Stripe setup as code (EA-6, #7322): a plan/apply tool for the Stripe objects the console needs.
//
//   pnpm creds stripe-test -- pnpm -C apps/console run stripe:setup -- --plan
//   pnpm creds stripe-test -- pnpm -C apps/console run stripe:setup -- --apply [--webhook-url=<url>]
//   pnpm creds stripe-live -- pnpm -C apps/console run stripe:setup -- --live --plan
//   pnpm creds stripe-live -- pnpm -C apps/console run stripe:setup -- --live --apply \
//     --webhook-url=https://alethialabs.io/api/webhooks/stripe
//
// `--plan` only reads. It prints the difference between the account and the desired state below.
// `--apply` makes exactly that difference, then reads the account again and fails unless the second
// plan is empty, so a second `--apply` changes nothing.
//
// Desired state:
//   • Products "Alethia Pro", "Alethia runner minutes", "Alethia AI Plus", "Alethia AI Max", found by
//     their `metadata.alethia` tag, each with the hosted-software tax code SAAS_TAX_CODE.
//   • Prices, found by lookup key, at the catalog's planned amounts (@repo/plan-catalog, USD + EUR,
//     no discounts), each `tax_behavior: exclusive`. A price is immutable, so a price that differs is
//     REPLACED: a new one takes the lookup key and the old one is archived. Existing subscriptions
//     keep the old price.
//   • The runner-minutes Billing Meter (`alethia_runner_minutes`).
//   • Tax settings: head office from LEGAL_ENTITY, default tax code and `exclusive` behaviour. This
//     does not turn Stripe Tax on; that stays `STRIPE_TAX_ENABLED` and a dashboard decision.
//   • The DEFAULT Customer Portal configuration: no tax-ID edit, no address (so no country) change,
//     no plan change, no Stripe invoice history (Stripe's PDF is not the invoice of record), and its
//     business profile: a headline and the privacy and terms links.
//   • The DEFAULT payment method configuration: exactly DESIRED_PAYMENT_METHODS on (card, Apple Pay,
//     Google Pay, Link) and every other method the account offers off.
//   • With `--webhook-url`: one endpoint at that URL subscribed to exactly WEBHOOK_EVENTS.
//
// What this does NOT manage, because Stripe's API cannot set it on your OWN account ("To update your
// own account, use the Dashboard": POST /v1/accounts/:id is for connected accounts): branding, public
// business details, the statement descriptor, customer emails, Smart Retries, Radar rules, and the
// account's default invoice footer and memo. Those are a checklist in
// apps/console/docs/stripe-prod-runbook.md §3. The invoice footer is set per customer instead, where
// the console creates the customer (STRIPE_INVOICE_FOOTER in lib/billing/receipt-footer.ts).
//
// Secrets: the key is read from the environment (STRIPE_API_KEY, which `pnpm creds` sets, or
// STRIPE_SECRET_KEY) and never printed. A new endpoint's signing secret is written to a 0600 file
// under ~/.alethia/stripe/ and only that path is printed.
//
// A live key is refused unless `--live` is given. The target account is printed before anything else.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LEGAL_ENTITY } from "@repo/legal";
import {
	aiPlanMeta,
	aiPlanUnitAmountCents,
	formatPriceLabel,
	planUnitAmountCents,
} from "@repo/plan-catalog";
import Stripe from "stripe";

// ── Desired state ─────────────────────────────────────────────────────────────────────────────

/**
 * Stripe's product tax code for "Software as a service (SaaS) - business use". Alethia is a hosted
 * service sold to businesses. Checked against Stripe's tax-code list (docs.stripe.com/tax/tax-codes):
 * `txcd_10103000` is the personal-use variant, `txcd_10103001` the business-use one.
 */
export const SAAS_TAX_CODE = "txcd_10103001";

/** The tax behaviour every price carries: amounts exclude any tax. */
export const TAX_BEHAVIOR = "exclusive";

/**
 * The events `lib/billing/webhook-handler.ts` handles, and only those (ADR 0002 Q6). The endpoint is
 * set to exactly this list, so an event subscribed by hand and handled nowhere is dropped.
 * `tests/scripts/stripe-setup.test.ts` fails when this list and the handler's `case` labels differ.
 */
export const WEBHOOK_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
	"customer.subscription.created",
	"customer.subscription.updated",
	"customer.subscription.deleted",
	"customer.subscription.trial_will_end",
	"checkout.session.completed",
	"invoice.payment_succeeded",
	"invoice.payment_failed",
	"invoice.voided",
	"charge.refunded",
	"charge.refund.updated",
];

/** The runner-minutes meter's event name (RUNNER_MINUTES_METER_EVENT in lib/billing/meter.ts). */
export const METER_EVENT = "alethia_runner_minutes";

/** A product the catalog needs, found by its `metadata.alethia` tag. */
export interface DesiredProduct {
	tag: string;
	name: string;
	taxCode: string;
}

/** A flat monthly per-unit price (Pro per seat, the AI tiers). */
export interface DesiredFlatPrice {
	kind: "flat";
	lookupKey: string;
	envVar: string;
	productTag: string;
	usd: number;
	eur: number;
	nickname: string;
}

/** The graduated runner-minutes price: free up to `included`, then a per-minute overage. */
export interface DesiredMeterPrice {
	kind: "meter";
	lookupKey: string;
	envVar: string;
	productTag: string;
	included: number;
	overageUsd: string;
	overageEur: string;
	nickname: string;
}

/** Either kind of desired price. */
export type DesiredPrice = DesiredFlatPrice | DesiredMeterPrice;

export const DESIRED_PRODUCTS: DesiredProduct[] = [
	{ tag: "pro", name: "Alethia Pro", taxCode: SAAS_TAX_CODE },
	{ tag: "runner_minutes", name: "Alethia runner minutes", taxCode: SAAS_TAX_CODE },
	{ tag: "ai_plus", name: "Alethia AI Plus", taxCode: SAAS_TAX_CODE },
	{ tag: "ai_max", name: "Alethia AI Max", taxCode: SAAS_TAX_CODE },
];

// The runner-minutes free tier and overage mirror lib/billing/{plan,meter}.ts.
const RUNNER_INCLUDED_PRO = 500;
const RUNNER_OVERAGE_USD = "1.2"; // $0.012 / minute, in cents
const RUNNER_OVERAGE_EUR = "1.1"; // €0.011 / minute, in cents

export const DESIRED_PRICES: DesiredPrice[] = [
	{
		kind: "flat",
		lookupKey: "alethia_pro_monthly",
		envVar: "STRIPE_PRICE_TEAM",
		productTag: "pro",
		usd: planUnitAmountCents("team"),
		eur: planUnitAmountCents("team", "eur"),
		nickname: `Alethia Pro — ${formatPriceLabel(planUnitAmountCents("team"), "usd")} / seat / mo`,
	},
	{
		kind: "meter",
		lookupKey: "alethia_runner_minutes_pro",
		envVar: "STRIPE_PRICE_METER_TEAM",
		productTag: "runner_minutes",
		included: RUNNER_INCLUDED_PRO,
		overageUsd: RUNNER_OVERAGE_USD,
		overageEur: RUNNER_OVERAGE_EUR,
		nickname: "Alethia runner minutes — Pro overage ($0.012 / €0.011 per min)",
	},
	{
		kind: "flat",
		lookupKey: "alethia_ai_plus_monthly",
		envVar: "STRIPE_PRICE_AI_PLUS",
		productTag: "ai_plus",
		usd: aiPlanUnitAmountCents("ai_plus"),
		eur: aiPlanUnitAmountCents("ai_plus", "eur"),
		nickname: `Alethia AI Plus — ${aiPlanMeta("ai_plus").priceLabel}`,
	},
	{
		kind: "flat",
		lookupKey: "alethia_ai_max_monthly",
		envVar: "STRIPE_PRICE_AI_MAX",
		productTag: "ai_max",
		usd: aiPlanUnitAmountCents("ai_max"),
		eur: aiPlanUnitAmountCents("ai_max", "eur"),
		nickname: `Alethia AI Max — ${aiPlanMeta("ai_max").priceLabel}`,
	},
];

/** A postal address in Stripe's shape. */
export interface PostalAddress {
	line1: string;
	line2: string;
	city: string;
	postal_code: string;
	country: string;
}

const COUNTRY_CODES: Record<string, string> = { Bulgaria: "BG" };

/**
 * Splits LEGAL_ENTITY's one-line address ("<street>, <unit parts…>, <postcode> <city>, <country>")
 * into Stripe's fields. Throws when the shape is different, so a changed address fails loudly here
 * rather than writing a wrong head office.
 */
export function parseHeadOffice(address: string): PostalAddress {
	const parts = address.split(",").map((p) => p.trim());
	const country = COUNTRY_CODES[parts.at(-1) ?? ""];
	const cityPart = /^(\d{4,5}) (.+)$/.exec(parts.at(-2) ?? "");
	if (parts.length < 3 || !country || !cityPart) {
		throw new Error(`LEGAL_ENTITY.registeredAddress has an unexpected shape: "${address}"`);
	}
	return {
		line1: parts[0] ?? "",
		line2: parts.slice(1, -2).join(", "),
		city: cityPart[2] ?? "",
		postal_code: cityPart[1] ?? "",
		country,
	};
}

/** The head office the tax settings must carry. */
export const HEAD_OFFICE: PostalAddress = parseHeadOffice(LEGAL_ENTITY.registeredAddress);

/** The Customer Portal settings this script enforces on the account's default configuration. */
export const DESIRED_PORTAL = {
	/** Email only: no address (so no country change) and no tax ID. */
	customerUpdates: ["email"],
	/** Stripe's invoice PDF is not the invoice of record (the console issues the фактура). */
	invoiceHistory: false,
	paymentMethodUpdate: true,
	/** A plan change in the portal would skip the console's purchase gate. */
	subscriptionUpdate: false,
	subscriptionCancel: true,
	cancelMode: "at_period_end",
	/** Shown at the top of the portal. Stripe caps it at 60 characters. */
	headline: "Alethia: manage your subscription and payment method",
	/** The marketing site's routes apps/marketing/app/privacy and apps/marketing/app/terms. */
	privacyPolicyUrl: "https://alethialabs.io/privacy",
	termsOfServiceUrl: "https://alethialabs.io/terms",
} as const;

/**
 * Every payment method field of a payment method configuration in the pinned stripe-node. Derived
 * from the SDK's own type, so it ranges over exactly what the API version this SDK pins can return.
 */
export type PaymentMethodKey = {
	[K in keyof Stripe.PaymentMethodConfiguration]-?: NonNullable<Stripe.PaymentMethodConfiguration[K]> extends {
		display_preference: unknown;
	}
		? K
		: never;
}[keyof Stripe.PaymentMethodConfiguration];

/**
 * The same set as a value, so it can be iterated. A `Record` over the derived type: upgrading
 * stripe-node to one that adds or drops a method fails type-checking here until this list matches,
 * so a newly typed method becomes a decision at upgrade time. A method the pinned SDK does not type
 * at all is invisible to this tool; `stripe:check` reports only what it can name.
 */
const PAYMENT_METHOD_KEYS: Record<PaymentMethodKey, true> = {
	acss_debit: true,
	affirm: true,
	afterpay_clearpay: true,
	alipay: true,
	alma: true,
	amazon_pay: true,
	apple_pay: true,
	au_becs_debit: true,
	bacs_debit: true,
	bancontact: true,
	billie: true,
	bizum: true,
	blik: true,
	boleto: true,
	card: true,
	cartes_bancaires: true,
	cashapp: true,
	crypto: true,
	customer_balance: true,
	eps: true,
	fpx: true,
	giropay: true,
	google_pay: true,
	grabpay: true,
	ideal: true,
	jcb: true,
	kakao_pay: true,
	klarna: true,
	konbini: true,
	kr_card: true,
	link: true,
	mb_way: true,
	mobilepay: true,
	multibanco: true,
	naver_pay: true,
	nz_bank_account: true,
	oxxo: true,
	p24: true,
	pay_by_bank: true,
	payco: true,
	paynow: true,
	paypal: true,
	payto: true,
	pix: true,
	promptpay: true,
	revolut_pay: true,
	samsung_pay: true,
	satispay: true,
	scalapay: true,
	sepa_debit: true,
	sofort: true,
	sunbit: true,
	swish: true,
	twint: true,
	upi: true,
	us_bank_account: true,
	wechat_pay: true,
	zip: true,
};

/** True when `key` names a payment method field of the pinned SDK's configuration type. */
export function isPaymentMethodKey(key: string): key is PaymentMethodKey {
	return Object.hasOwn(PAYMENT_METHOD_KEYS, key);
}

/** Every payment method field of the pinned SDK's configuration type, in a stable order. */
export const ALL_PAYMENT_METHODS: readonly PaymentMethodKey[] = Object.keys(PAYMENT_METHOD_KEYS)
	.filter(isPaymentMethodKey)
	.sort();

/**
 * The payment methods the default configuration turns on; every other method the account offers is
 * turned off. Proposed to the maintainer as a DECISION in the PR that introduced it (#7407), not a
 * settled fact: cards, the two wallets that pay with a card (Apple Pay, Google Pay), and Link. The
 * cost of the narrow list is that a customer who would pay by SEPA Direct Debit, iDEAL or Bancontact
 * cannot; widening it is one entry here.
 */
export const DESIRED_PAYMENT_METHODS: readonly PaymentMethodKey[] = ["card", "apple_pay", "google_pay", "link"];

/** A display preference this tool sets. */
export type PaymentMethodPreference = "on" | "off";

/** The preference DESIRED_PAYMENT_METHODS gives `key`. */
export function desiredPreference(key: PaymentMethodKey): PaymentMethodPreference {
	return DESIRED_PAYMENT_METHODS.includes(key) ? "on" : "off";
}

// ── The Stripe surface this tool uses ─────────────────────────────────────────────────────────
// Narrow views of Stripe's objects: the real SDK satisfies them structurally, and a test fake can
// implement them without building whole Stripe objects.

/** One page of a Stripe list. */
export interface ListPage<T> {
	data: T[];
	has_more: boolean;
}

/** The account fields printed and checked. */
export interface AccountView {
	id: string;
	country?: string;
	charges_enabled: boolean;
	payouts_enabled: boolean;
	details_submitted: boolean;
	business_profile?: { name?: string | null } | null;
	settings?: { dashboard: { display_name: string | null } } | null;
	company?: { name?: string | null } | null;
}

/** The product fields compared. */
export interface ProductView {
	id: string;
	name: string;
	active: boolean;
	tax_code?: string | { id: string } | null;
	metadata: Record<string, string>;
}

/** One tier of a tiered price. */
export interface TierView {
	up_to: number | null;
	unit_amount: number | null;
	unit_amount_decimal: unknown;
}

/** The price fields compared. */
export interface PriceView {
	id: string;
	active: boolean;
	product: string | { id: string };
	currency: string;
	unit_amount: number | null;
	tax_behavior: string | null;
	billing_scheme: string;
	tiers_mode: string | null;
	recurring: { interval: string; usage_type: string; meter: string | null } | null;
	tiers?: TierView[];
	currency_options?: { [currency: string]: { unit_amount: number | null; tax_behavior: string | null } };
	metadata: Record<string, string>;
}

/** The meter fields compared. */
export interface MeterView {
	id: string;
	event_name: string;
	default_aggregation: { formula: string };
	customer_mapping: { event_payload_key: string };
	value_settings: { event_payload_key: string };
}

/** A Stripe address as returned (every field nullable). */
export interface AddressView {
	line1: string | null;
	line2: string | null;
	city: string | null;
	postal_code: string | null;
	country: string | null;
}

/** The tax settings fields compared. */
export interface TaxSettingsView {
	status: string;
	defaults: { tax_code: string | null; tax_behavior: string | null };
	head_office: { address: AddressView } | null;
	status_details: { pending?: { missing_fields: string[] | null } };
}

/** The portal configuration fields compared. */
export interface PortalView {
	id: string;
	is_default: boolean;
	active: boolean;
	business_profile: {
		headline: string | null;
		privacy_policy_url: string | null;
		terms_of_service_url: string | null;
	};
	features: {
		customer_update: { enabled: boolean; allowed_updates: string[] };
		invoice_history: { enabled: boolean };
		payment_method_update: { enabled: boolean };
		subscription_cancel: { enabled: boolean; mode: string };
		subscription_update: { enabled: boolean };
	};
}

/** The webhook endpoint fields compared. */
export interface WebhookView {
	id: string;
	url: string;
	status: string;
	enabled_events: string[];
}

/** A newly created endpoint: the only time Stripe returns its signing secret. */
export interface WebhookCreatedView extends WebhookView {
	secret?: string;
}

/**
 * The payment method configuration fields compared and reported. The SDK types every method's field
 * as optional; this tool treats an absent field as a method the account does not offer.
 * `display_preference.preference` is what it sets.
 */
export type PaymentMethodConfigView = Pick<
	Stripe.PaymentMethodConfiguration,
	"id" | "is_default" | "active" | PaymentMethodKey
>;

/** The Stripe methods this tool and stripe-check.ts call. `new Stripe(key)` satisfies it. */
export interface StripeClient {
	accounts: { retrieveCurrent(): Promise<AccountView> };
	products: {
		list(params: Stripe.ProductListParams): Promise<ListPage<ProductView>>;
		create(params: Stripe.ProductCreateParams): Promise<ProductView>;
		update(id: string, params: Stripe.ProductUpdateParams): Promise<ProductView>;
	};
	prices: {
		list(params: Stripe.PriceListParams): Promise<ListPage<PriceView>>;
		create(params: Stripe.PriceCreateParams): Promise<PriceView>;
		update(id: string, params: Stripe.PriceUpdateParams): Promise<PriceView>;
	};
	billing: {
		meters: {
			list(params: Stripe.Billing.MeterListParams): Promise<ListPage<MeterView>>;
			create(params: Stripe.Billing.MeterCreateParams): Promise<MeterView>;
		};
	};
	tax: {
		settings: {
			retrieve(): Promise<TaxSettingsView>;
			update(params: Stripe.Tax.SettingsUpdateParams): Promise<TaxSettingsView>;
		};
	};
	billingPortal: {
		configurations: {
			list(params: Stripe.BillingPortal.ConfigurationListParams): Promise<ListPage<PortalView>>;
			update(id: string, params: Stripe.BillingPortal.ConfigurationUpdateParams): Promise<PortalView>;
		};
	};
	webhookEndpoints: {
		list(params: Stripe.WebhookEndpointListParams): Promise<ListPage<WebhookView>>;
		create(params: Stripe.WebhookEndpointCreateParams): Promise<WebhookCreatedView>;
		update(id: string, params: Stripe.WebhookEndpointUpdateParams): Promise<WebhookView>;
	};
	paymentMethodConfigurations: {
		list(params: Stripe.PaymentMethodConfigurationListParams): Promise<ListPage<PaymentMethodConfigView>>;
		update(id: string, params: Stripe.PaymentMethodConfigurationUpdateParams): Promise<PaymentMethodConfigView>;
	};
}

// ── Keys and modes ────────────────────────────────────────────────────────────────────────────

/** Which Stripe dataset a key targets. */
export type Mode = "test" | "live";

/** The environment variables a key is read from; `process.env` satisfies it. */
export interface StripeKeyEnv {
	[name: string]: string | undefined;
	STRIPE_API_KEY?: string;
	STRIPE_SECRET_KEY?: string;
}

/** A usable key and its mode, or why none is usable. */
export type KeyChoice = { ok: true; key: string; mode: Mode } | { ok: false; error: string };

/**
 * Picks the secret key from the environment: STRIPE_API_KEY (set by `pnpm creds`) or
 * STRIPE_SECRET_KEY. Refuses when both are set to different values, so the account is never a
 * guess. The returned error never contains the key.
 */
export function resolveKey(env: StripeKeyEnv): KeyChoice {
	const api = env.STRIPE_API_KEY?.trim() || undefined;
	const secret = env.STRIPE_SECRET_KEY?.trim() || undefined;
	if (api && secret && api !== secret) {
		return { ok: false, error: "STRIPE_API_KEY and STRIPE_SECRET_KEY are both set and differ; unset one." };
	}
	const key = api ?? secret;
	if (!key) {
		return {
			ok: false,
			error: "No Stripe key. Run through the broker: pnpm creds stripe-test -- <command> (STRIPE_API_KEY).",
		};
	}
	if (/^(sk|rk)_live_/.test(key)) return { ok: true, key, mode: "live" };
	if (/^(sk|rk)_test_/.test(key)) return { ok: true, key, mode: "test" };
	return { ok: false, error: "The Stripe key is not a secret or restricted key (sk_/rk_ test or live)." };
}

/** Returns why this mode may not run with these flags, or null when it may. */
export function modeRefusal(mode: Mode, liveFlag: boolean): string | null {
	if (mode === "live" && !liveFlag) {
		return "This is a LIVE key. Re-run with --live if you mean to touch the live account.";
	}
	if (mode === "test" && liveFlag) {
		return "--live was given but the key is a TEST key. Drop --live or use the stripe-live profile.";
	}
	return null;
}

/** One line naming the account a run targets. */
export function describeAccount(account: AccountView, mode: Mode): string {
	const name =
		account.settings?.dashboard.display_name ?? account.business_profile?.name ?? account.company?.name ?? "(no name)";
	return `Stripe ${mode.toUpperCase()} mode · account ${account.id} · ${name} · country ${account.country ?? "?"}`;
}

// ── Reading the account ───────────────────────────────────────────────────────────────────────

/** Reads every page of a Stripe list. */
export async function listAll<T extends { id: string }>(
	page: (startingAfter: string | undefined) => Promise<ListPage<T>>,
): Promise<T[]> {
	const all: T[] = [];
	let after: string | undefined;
	for (;;) {
		const res = await page(after);
		all.push(...res.data);
		const last = res.data.at(-1);
		if (!res.has_more || !last) return all;
		after = last.id;
	}
}

/** What the account holds, for every object this tool manages. */
export interface Observed {
	/** Active products by tag; more than one per tag is reported as an error. */
	products: Map<string, ProductView[]>;
	meter: MeterView | null;
	/** The price holding each lookup key (active or not), or null. */
	prices: Map<string, PriceView | null>;
	tax: TaxSettingsView;
	portal: PortalView | null;
	/** The account's default payment method configuration, or null. */
	paymentMethods: PaymentMethodConfigView | null;
	/** Endpoints at `webhookUrl`, when one was given. */
	webhooks: WebhookView[];
	webhookUrl: string | undefined;
}

/** Reads the current state of everything in the desired state. Makes no change. */
export async function readState(client: StripeClient, webhookUrl: string | undefined): Promise<Observed> {
	const products = new Map<string, ProductView[]>();
	const allProducts = await listAll((after) =>
		client.products.list({ active: true, limit: 100, ...(after ? { starting_after: after } : {}) }),
	);
	for (const p of allProducts) {
		const tag = p.metadata.alethia;
		if (!tag) continue;
		products.set(tag, [...(products.get(tag) ?? []), p]);
	}

	const meters = await listAll((after) =>
		client.billing.meters.list({ status: "active", limit: 100, ...(after ? { starting_after: after } : {}) }),
	);
	const meter = meters.find((m) => m.event_name === METER_EVENT) ?? null;

	const prices = new Map<string, PriceView | null>();
	for (const desired of DESIRED_PRICES) {
		const found = await client.prices.list({
			lookup_keys: [desired.lookupKey],
			limit: 1,
			expand: ["data.tiers", "data.currency_options"],
		});
		prices.set(desired.lookupKey, found.data[0] ?? null);
	}

	const tax = await client.tax.settings.retrieve();
	const portals = await client.billingPortal.configurations.list({ is_default: true, limit: 1 });
	const portal = portals.data.find((c) => c.is_default) ?? null;

	// The list endpoint has no `is_default` filter, so read every page and pick the default.
	const pmcs = await listAll((after) =>
		client.paymentMethodConfigurations.list({ limit: 100, ...(after ? { starting_after: after } : {}) }),
	);
	const paymentMethods = pmcs.find((c) => c.is_default) ?? null;

	let webhooks: WebhookView[] = [];
	if (webhookUrl) {
		const all = await listAll((after) =>
			client.webhookEndpoints.list({ limit: 100, ...(after ? { starting_after: after } : {}) }),
		);
		webhooks = all.filter((w) => w.url === webhookUrl);
	}
	return { products, meter, prices, tax, portal, paymentMethods, webhooks, webhookUrl };
}

// ── The plan ──────────────────────────────────────────────────────────────────────────────────

/** One change the plan makes. `summary` is what `--plan` prints. */
export type Action =
	| { kind: "product.create"; tag: string; summary: string }
	| { kind: "product.update"; tag: string; id: string; summary: string }
	| { kind: "meter.create"; summary: string }
	| { kind: "price.create"; lookupKey: string; replaces: PriceView | null; summary: string }
	| { kind: "tax.update"; summary: string }
	| { kind: "portal.update"; id: string; summary: string }
	| {
			kind: "payment_methods.update";
			id: string;
			changes: { method: PaymentMethodKey; preference: PaymentMethodPreference }[];
			summary: string;
	  }
	| { kind: "webhook.create"; url: string; summary: string }
	| { kind: "webhook.update"; id: string; summary: string };

/** The full difference: what changes, what already matches, and what blocks an apply. */
export interface Plan {
	actions: Action[];
	ok: string[];
	errors: string[];
}

/** The id of a field Stripe returns as either an id or an expanded object. */
function idOf(ref: string | { id: string } | null | undefined): string | null {
	if (ref === null || ref === undefined) return null;
	return typeof ref === "string" ? ref : ref.id;
}

/** Renders a value for a "before → after" line. */
function show(v: unknown): string {
	return v === null || v === undefined || v === "" ? "(none)" : JSON.stringify(v);
}

/** A decimal string or Stripe Decimal as a number, or null. */
function decimal(v: unknown): number | null {
	if (v === null || v === undefined) return null;
	const n = Number(String(v));
	return Number.isFinite(n) ? n : null;
}

/** The EUR tier fingerprint stored on the meter price (list responses do not return EUR tiers). */
export function eurTierFingerprint(desired: DesiredMeterPrice): string {
	return `${desired.included}:0|inf:${desired.overageEur}`;
}

/** Why an existing flat price differs from the desired one (empty when it matches). */
function flatPriceDrift(p: PriceView, d: DesiredFlatPrice, productId: string | null): string[] {
	const out: string[] = [];
	const eur = p.currency_options?.eur;
	if (!p.active) out.push("archived");
	if (idOf(p.product) !== productId) out.push(`product ${show(idOf(p.product))} → ${show(productId)}`);
	if (p.currency !== "usd") out.push(`currency ${p.currency} → usd`);
	if (p.unit_amount !== d.usd) out.push(`USD ${show(p.unit_amount)} → ${d.usd}`);
	if (eur?.unit_amount !== d.eur) out.push(`EUR ${show(eur?.unit_amount)} → ${d.eur}`);
	if (p.recurring?.interval !== "month" || p.recurring.usage_type !== "licensed") {
		out.push("recurring → monthly licensed");
	}
	if (p.tax_behavior !== TAX_BEHAVIOR) out.push(`tax_behavior ${show(p.tax_behavior)} → ${TAX_BEHAVIOR}`);
	if (eur && eur.tax_behavior !== TAX_BEHAVIOR) {
		out.push(`EUR tax_behavior ${show(eur.tax_behavior)} → ${TAX_BEHAVIOR}`);
	}
	return out;
}

/** Why an existing meter price differs from the desired one (empty when it matches). */
function meterPriceDrift(
	p: PriceView,
	d: DesiredMeterPrice,
	productId: string | null,
	meterId: string | null,
): string[] {
	const out: string[] = [];
	const eur = p.currency_options?.eur;
	if (!p.active) out.push("archived");
	if (idOf(p.product) !== productId) out.push(`product ${show(idOf(p.product))} → ${show(productId)}`);
	if (p.recurring?.meter !== meterId) out.push(`meter ${show(p.recurring?.meter)} → ${show(meterId)}`);
	if (p.recurring?.usage_type !== "metered" || p.recurring.interval !== "month") {
		out.push("recurring → monthly metered");
	}
	if (p.billing_scheme !== "tiered" || p.tiers_mode !== "graduated") out.push("scheme → tiered graduated");
	const tiers = p.tiers ?? [];
	const first = tiers[0];
	const second = tiers[1];
	const tiersOk =
		tiers.length === 2 &&
		first?.up_to === d.included &&
		(first.unit_amount ?? decimal(first.unit_amount_decimal)) === 0 &&
		second?.up_to === null &&
		decimal(second.unit_amount_decimal) === Number(d.overageUsd);
	if (!tiersOk) out.push(`USD tiers → free ≤${d.included}, then ${d.overageUsd}¢/min`);
	if (!eur) out.push("EUR option missing");
	if (p.metadata.alethia_eur_tiers !== eurTierFingerprint(d)) {
		out.push(`EUR tiers ${show(p.metadata.alethia_eur_tiers)} → ${eurTierFingerprint(d)}`);
	}
	if (p.tax_behavior !== TAX_BEHAVIOR) out.push(`tax_behavior ${show(p.tax_behavior)} → ${TAX_BEHAVIOR}`);
	if (eur && eur.tax_behavior !== TAX_BEHAVIOR) {
		out.push(`EUR tax_behavior ${show(eur.tax_behavior)} → ${TAX_BEHAVIOR}`);
	}
	return out;
}

/** The fields of a Stripe address that differ from the desired head office. */
function addressDrift(actual: AddressView | undefined): string[] {
	const out: string[] = [];
	for (const field of ["line1", "line2", "city", "postal_code", "country"] as const) {
		const have = actual?.[field] ?? "";
		if (have !== HEAD_OFFICE[field]) out.push(`head_office.${field} ${show(have)} → ${show(HEAD_OFFICE[field])}`);
	}
	return out;
}

/** The portal settings that differ from DESIRED_PORTAL. */
export function portalDrift(p: PortalView): string[] {
	const out: string[] = [];
	const f = p.features;
	const have = [...f.customer_update.allowed_updates].sort();
	const want = [...DESIRED_PORTAL.customerUpdates].sort();
	if (!f.customer_update.enabled || have.join(",") !== want.join(",")) {
		out.push(`customer_update ${show(f.customer_update.enabled ? have : "off")} → ${show(want)}`);
	}
	if (f.invoice_history.enabled !== DESIRED_PORTAL.invoiceHistory) {
		out.push(`invoice_history ${f.invoice_history.enabled} → ${DESIRED_PORTAL.invoiceHistory}`);
	}
	if (f.payment_method_update.enabled !== DESIRED_PORTAL.paymentMethodUpdate) {
		out.push(`payment_method_update ${f.payment_method_update.enabled} → ${DESIRED_PORTAL.paymentMethodUpdate}`);
	}
	if (f.subscription_update.enabled !== DESIRED_PORTAL.subscriptionUpdate) {
		out.push(`subscription_update ${f.subscription_update.enabled} → ${DESIRED_PORTAL.subscriptionUpdate}`);
	}
	if (
		f.subscription_cancel.enabled !== DESIRED_PORTAL.subscriptionCancel ||
		f.subscription_cancel.mode !== DESIRED_PORTAL.cancelMode
	) {
		out.push(`subscription_cancel ${show(f.subscription_cancel.mode)} → ${DESIRED_PORTAL.cancelMode}`);
	}
	if (p.business_profile.headline !== DESIRED_PORTAL.headline) {
		out.push(`headline ${show(p.business_profile.headline)} → ${show(DESIRED_PORTAL.headline)}`);
	}
	if (p.business_profile.privacy_policy_url !== DESIRED_PORTAL.privacyPolicyUrl) {
		out.push(`privacy_policy_url ${show(p.business_profile.privacy_policy_url)} → ${DESIRED_PORTAL.privacyPolicyUrl}`);
	}
	if (p.business_profile.terms_of_service_url !== DESIRED_PORTAL.termsOfServiceUrl) {
		out.push(
			`terms_of_service_url ${show(p.business_profile.terms_of_service_url)} → ${DESIRED_PORTAL.termsOfServiceUrl}`,
		);
	}
	return out;
}

/** The difference between a payment method configuration and DESIRED_PAYMENT_METHODS. */
export interface PaymentMethodDrift {
	/** Methods whose display preference must change, and to what. */
	changes: { method: PaymentMethodKey; preference: PaymentMethodPreference }[];
	/** Desired methods the account does not offer at all, which no API call can turn on. */
	missing: PaymentMethodKey[];
}

/**
 * Compares each method the configuration carries (an absent field is read as "not offered") with its
 * desired preference. The account's own preference is what is compared, not the
 * effective `value` and not `available`: `available` also needs the capability to be active (Apple Pay
 * needs a verified domain), which a preference cannot fix, and a `none` preference follows Stripe's
 * default, which can change under us, so it is set explicitly.
 */
export function paymentMethodDrift(cfg: PaymentMethodConfigView): PaymentMethodDrift {
	const changes: PaymentMethodDrift["changes"] = [];
	const missing: PaymentMethodKey[] = [];
	for (const method of ALL_PAYMENT_METHODS) {
		const setting = cfg[method];
		const preference = desiredPreference(method);
		if (!setting) {
			if (preference === "on") missing.push(method);
			continue;
		}
		if (setting.display_preference.preference !== preference) changes.push({ method, preference });
	}
	return { changes, missing };
}

/** The update params that set each change's display preference, and nothing else. */
export function paymentMethodUpdateParams(
	changes: PaymentMethodDrift["changes"],
): Stripe.PaymentMethodConfigurationUpdateParams {
	const params: Stripe.PaymentMethodConfigurationUpdateParams = {};
	for (const { method, preference } of changes) {
		params[method] = { display_preference: { preference } };
	}
	return params;
}

/** The difference between the observed account and the desired state. Pure: reads nothing. */
export function computePlan(obs: Observed): Plan {
	const plan: Plan = { actions: [], ok: [], errors: [] };
	const productIds = new Map<string, string | null>();

	for (const d of DESIRED_PRODUCTS) {
		const found = obs.products.get(d.tag) ?? [];
		if (found.length > 1) {
			plan.errors.push(
				`product ${d.tag}: ${found.length} active products carry metadata.alethia=${d.tag} (${found
					.map((p) => p.id)
					.join(", ")}); archive all but one in the dashboard.`,
			);
			productIds.set(d.tag, found[0]?.id ?? null);
			continue;
		}
		const p = found[0];
		if (!p) {
			productIds.set(d.tag, null);
			plan.actions.push({
				kind: "product.create",
				tag: d.tag,
				summary: `+ product ${d.tag} "${d.name}" (tax_code ${d.taxCode})`,
			});
			continue;
		}
		productIds.set(d.tag, p.id);
		const changes: string[] = [];
		if (p.name !== d.name) changes.push(`name ${show(p.name)} → ${show(d.name)}`);
		if (idOf(p.tax_code) !== d.taxCode) changes.push(`tax_code ${show(idOf(p.tax_code))} → ${d.taxCode}`);
		if (changes.length) {
			plan.actions.push({
				kind: "product.update",
				tag: d.tag,
				id: p.id,
				summary: `~ product ${d.tag} ${p.id}: ${changes.join("; ")}`,
			});
		} else {
			plan.ok.push(`product ${d.tag} ${p.id} (tax_code ${d.taxCode})`);
		}
	}

	let meterId: string | null = null;
	if (obs.meter) {
		meterId = obs.meter.id;
		const m = obs.meter;
		if (
			m.default_aggregation.formula !== "sum" ||
			m.customer_mapping.event_payload_key !== "stripe_customer_id" ||
			m.value_settings.event_payload_key !== "value"
		) {
			plan.errors.push(
				`meter ${m.id} (${METER_EVENT}) is not sum / stripe_customer_id / value; meters cannot be changed, deactivate it in the dashboard.`,
			);
		} else {
			plan.ok.push(`meter ${m.id} (${METER_EVENT})`);
		}
	} else {
		plan.actions.push({ kind: "meter.create", summary: `+ meter ${METER_EVENT} (sum, by stripe_customer_id)` });
	}

	for (const d of DESIRED_PRICES) {
		const existing = obs.prices.get(d.lookupKey) ?? null;
		const productId = productIds.get(d.productTag) ?? null;
		const label =
			d.kind === "flat"
				? `${formatPriceLabel(d.usd, "usd")} / ${formatPriceLabel(d.eur, "eur")}`
				: `free ≤${d.included} min, then ${d.overageUsd}¢ / ${d.overageEur}c per min`;
		if (!existing) {
			plan.actions.push({
				kind: "price.create",
				lookupKey: d.lookupKey,
				replaces: null,
				summary: `+ price ${d.lookupKey} (${label}, tax_behavior ${TAX_BEHAVIOR})`,
			});
			continue;
		}
		const drift =
			d.kind === "flat"
				? flatPriceDrift(existing, d, productId)
				: meterPriceDrift(existing, d, productId, meterId);
		if (drift.length) {
			plan.actions.push({
				kind: "price.create",
				lookupKey: d.lookupKey,
				replaces: existing,
				summary: `± price ${d.lookupKey}: replace ${existing.id} (${drift.join("; ")}); the new price takes the lookup key, the old one is archived, existing subscriptions keep it`,
			});
		} else {
			plan.ok.push(`price ${d.lookupKey} ${existing.id} (${label})`);
		}
	}

	const taxChanges: string[] = [];
	if (obs.tax.defaults.tax_code !== SAAS_TAX_CODE) {
		taxChanges.push(`defaults.tax_code ${show(obs.tax.defaults.tax_code)} → ${SAAS_TAX_CODE}`);
	}
	if (obs.tax.defaults.tax_behavior !== TAX_BEHAVIOR) {
		taxChanges.push(`defaults.tax_behavior ${show(obs.tax.defaults.tax_behavior)} → ${TAX_BEHAVIOR}`);
	}
	taxChanges.push(...addressDrift(obs.tax.head_office?.address));
	if (taxChanges.length) {
		plan.actions.push({ kind: "tax.update", summary: `~ tax settings: ${taxChanges.join("; ")}` });
	} else {
		plan.ok.push(`tax settings (head office ${HEAD_OFFICE.city} ${HEAD_OFFICE.country}, ${SAAS_TAX_CODE})`);
	}

	if (!obs.portal) {
		plan.errors.push(
			"No default Customer Portal configuration. Open Settings → Billing → Customer portal in this mode, press Save once, then run this again.",
		);
	} else {
		const drift = portalDrift(obs.portal);
		if (drift.length) {
			plan.actions.push({
				kind: "portal.update",
				id: obs.portal.id,
				summary: `~ portal ${obs.portal.id}: ${drift.join("; ")}`,
			});
		} else {
			plan.ok.push(
				`portal ${obs.portal.id} (email-only customer updates, no plan change, no invoice history, headline and legal links)`,
			);
		}
	}

	const desiredLabel = DESIRED_PAYMENT_METHODS.join(", ");
	if (!obs.paymentMethods) {
		plan.errors.push(
			"No default payment method configuration. Open Settings → Payments → Payment methods in this mode once, then run this again.",
		);
	} else {
		const pmc = obs.paymentMethods;
		const drift = paymentMethodDrift(pmc);
		if (drift.missing.length) {
			plan.errors.push(
				`payment methods: the account does not offer ${drift.missing.join(", ")}, so the default configuration ${pmc.id} cannot turn ${drift.missing.length === 1 ? "it" : "them"} on. Activate ${drift.missing.length === 1 ? "it" : "them"} under Settings → Payments → Payment methods.`,
			);
		} else if (drift.changes.length) {
			const on = drift.changes.filter((c) => c.preference === "on").map((c) => c.method);
			const off = drift.changes.filter((c) => c.preference === "off").map((c) => c.method);
			const parts = [...(on.length ? [`on ${on.join(" ")}`] : []), ...(off.length ? [`off ${off.join(" ")}`] : [])];
			plan.actions.push({
				kind: "payment_methods.update",
				id: pmc.id,
				changes: drift.changes,
				summary: `~ payment methods ${pmc.id}: ${parts.join("; ")}`,
			});
		} else {
			plan.ok.push(`payment methods ${pmc.id} (only ${desiredLabel})`);
		}
	}

	if (obs.webhookUrl) {
		const url = obs.webhookUrl;
		if (obs.webhooks.length > 1) {
			plan.errors.push(
				`${obs.webhooks.length} webhook endpoints have the URL ${url} (${obs.webhooks
					.map((w) => w.id)
					.join(", ")}); delete all but one in the dashboard.`,
			);
		}
		const w = obs.webhooks[0];
		if (!w) {
			plan.actions.push({
				kind: "webhook.create",
				url,
				summary: `+ webhook ${url} (${WEBHOOK_EVENTS.length} events); its signing secret goes to a 0600 file`,
			});
		} else if (obs.webhooks.length === 1) {
			const have = new Set(w.enabled_events);
			const want = new Set<string>(WEBHOOK_EVENTS);
			const added = [...want].filter((e) => !have.has(e));
			const removed = [...have].filter((e) => !want.has(e));
			const changes: string[] = [];
			if (added.length) changes.push(`+${added.join(" +")}`);
			if (removed.length) changes.push(`-${removed.join(" -")}`);
			if (w.status !== "enabled") changes.push(`status ${w.status} → enabled`);
			if (changes.length) {
				plan.actions.push({ kind: "webhook.update", id: w.id, summary: `~ webhook ${w.id}: ${changes.join("; ")}` });
			} else {
				plan.ok.push(`webhook ${w.id} (${url}, ${WEBHOOK_EVENTS.length} events)`);
			}
		}
	}
	return plan;
}

/** The lines `--plan` prints for a plan. */
export function formatPlan(plan: Plan): string[] {
	const lines: string[] = [];
	const n = (k: string) => plan.actions.filter((a) => a.summary.startsWith(k)).length;
	lines.push(
		`Plan: ${n("+")} to create, ${n("~")} to update, ${n("±")} to replace, ${plan.ok.length} unchanged, ${plan.errors.length} blocking.`,
	);
	for (const a of plan.actions) lines.push(`  ${a.summary}`);
	for (const ok of plan.ok) lines.push(`  ✓ ${ok}`);
	for (const e of plan.errors) lines.push(`  ✗ ${e}`);
	return lines;
}

// ── Apply ─────────────────────────────────────────────────────────────────────────────────────

// The SDK types `unit_amount_decimal` as its branded `Decimal`, but a `Stripe.Decimal` instance
// serializes wrong on the wire: request bodies are form-encoded, and the encoder walks an object's
// own keys without calling `toString`, so Stripe rejects it as "Invalid decimal". The REST API
// accepts a plain string, so we pass the string and shim it to the SDK's type here, in one helper.
// @ts-expect-error Stripe's SDK brands unit_amount_decimal as Decimal but the REST API accepts a plain string
const decimalString = (value: string): Stripe.Decimal => value;

/** The create params for a desired price. */
export function priceCreateParams(
	d: DesiredPrice,
	productId: string,
	meterId: string | null,
	transfer: boolean,
): Stripe.PriceCreateParams {
	if (d.kind === "flat") {
		return {
			product: productId,
			currency: "usd",
			unit_amount: d.usd,
			tax_behavior: TAX_BEHAVIOR,
			currency_options: { eur: { unit_amount: d.eur, tax_behavior: TAX_BEHAVIOR } },
			recurring: { interval: "month", usage_type: "licensed" },
			nickname: d.nickname,
			lookup_key: d.lookupKey,
			transfer_lookup_key: transfer,
		};
	}
	if (!meterId) throw new Error(`price ${d.lookupKey} needs the meter, which does not exist.`);
	const tiers = (overage: string): Stripe.PriceCreateParams.Tier[] => [
		{ up_to: d.included, unit_amount: 0 },
		{ up_to: "inf", unit_amount_decimal: decimalString(overage) },
	];
	return {
		product: productId,
		currency: "usd",
		billing_scheme: "tiered",
		tiers_mode: "graduated",
		tiers: tiers(d.overageUsd),
		tax_behavior: TAX_BEHAVIOR,
		currency_options: { eur: { tiers: tiers(d.overageEur), tax_behavior: TAX_BEHAVIOR } },
		recurring: { interval: "month", usage_type: "metered", meter: meterId },
		nickname: d.nickname,
		lookup_key: d.lookupKey,
		transfer_lookup_key: transfer,
		metadata: { alethia_eur_tiers: eurTierFingerprint(d) },
	};
}

/** Writes a webhook signing secret to a 0600 file in `dir` (0700) and returns the path. */
export function writeWebhookSecret(dir: string, mode: Mode, accountId: string, secret: string): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, `webhook-secret.${mode}.${accountId}`);
	writeFileSync(path, `${secret}\n`, { mode: 0o600 });
	// writeFileSync's mode applies only when it creates the file; an existing file keeps its own.
	chmodSync(path, 0o600);
	return path;
}

/** Where apply writes a new signing secret: ~/.alethia/stripe. */
export const DEFAULT_SECRET_DIR = join(homedir(), ".alethia", "stripe");

/** What apply needs besides the client and the plan. */
export interface ApplyContext {
	mode: Mode;
	accountId: string;
	secretDir: string;
	log: (line: string) => void;
}

/** What apply did that the operator must act on. */
export interface ApplyResult {
	/** Path of the 0600 file holding a new endpoint's signing secret, when one was created. */
	webhookSecretPath: string | null;
}

/**
 * Makes exactly the plan's changes, in dependency order (products, meter, prices, tax, portal, payment methods,
 * webhook). Refuses a plan with blocking errors. Never prints a secret.
 */
export async function applyPlan(
	client: StripeClient,
	obs: Observed,
	plan: Plan,
	ctx: ApplyContext,
): Promise<ApplyResult> {
	if (plan.errors.length) throw new Error("The plan has blocking errors; nothing was changed.");
	const result: ApplyResult = { webhookSecretPath: null };

	const productIds = new Map<string, string>();
	for (const [tag, list] of obs.products) {
		const first = list[0];
		if (first) productIds.set(tag, first.id);
	}
	for (const a of plan.actions) {
		const d = DESIRED_PRODUCTS.find((p) => (a.kind === "product.create" || a.kind === "product.update") && p.tag === a.tag);
		if (!d) continue;
		if (a.kind === "product.create") {
			const p = await client.products.create({ name: d.name, tax_code: d.taxCode, metadata: { alethia: d.tag } });
			productIds.set(d.tag, p.id);
			ctx.log(`  + product ${d.tag} ${p.id}`);
		} else if (a.kind === "product.update") {
			await client.products.update(a.id, { name: d.name, tax_code: d.taxCode });
			ctx.log(`  ~ product ${d.tag} ${a.id}`);
		}
	}

	let meterId = obs.meter?.id ?? null;
	if (plan.actions.some((a) => a.kind === "meter.create")) {
		const m = await client.billing.meters.create({
			display_name: "Alethia runner minutes",
			event_name: METER_EVENT,
			default_aggregation: { formula: "sum" },
			customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
			value_settings: { event_payload_key: "value" },
		});
		meterId = m.id;
		ctx.log(`  + meter ${m.id}`);
	}

	for (const a of plan.actions) {
		if (a.kind !== "price.create") continue;
		const d = DESIRED_PRICES.find((p) => p.lookupKey === a.lookupKey);
		if (!d) continue;
		const productId = productIds.get(d.productTag);
		if (!productId) throw new Error(`price ${d.lookupKey}: product ${d.productTag} was not found or created.`);
		const created = await client.prices.create(priceCreateParams(d, productId, meterId, a.replaces !== null));
		ctx.log(`  + price ${d.lookupKey} ${created.id}`);
		if (a.replaces?.active) {
			await client.prices.update(a.replaces.id, { active: false });
			ctx.log(`  - archived price ${a.replaces.id}`);
		}
	}

	if (plan.actions.some((a) => a.kind === "tax.update")) {
		await client.tax.settings.update({
			defaults: { tax_code: SAAS_TAX_CODE, tax_behavior: TAX_BEHAVIOR },
			head_office: { address: { ...HEAD_OFFICE } },
		});
		ctx.log("  ~ tax settings");
	}

	for (const a of plan.actions) {
		if (a.kind === "portal.update") {
			await client.billingPortal.configurations.update(a.id, {
				business_profile: {
					headline: DESIRED_PORTAL.headline,
					privacy_policy_url: DESIRED_PORTAL.privacyPolicyUrl,
					terms_of_service_url: DESIRED_PORTAL.termsOfServiceUrl,
				},
				features: {
					customer_update: { enabled: true, allowed_updates: [...DESIRED_PORTAL.customerUpdates] },
					invoice_history: { enabled: DESIRED_PORTAL.invoiceHistory },
					payment_method_update: { enabled: DESIRED_PORTAL.paymentMethodUpdate },
					subscription_cancel: { enabled: DESIRED_PORTAL.subscriptionCancel, mode: DESIRED_PORTAL.cancelMode },
					subscription_update: { enabled: DESIRED_PORTAL.subscriptionUpdate },
				},
			});
			ctx.log(`  ~ portal ${a.id}`);
		} else if (a.kind === "payment_methods.update") {
			await client.paymentMethodConfigurations.update(a.id, paymentMethodUpdateParams(a.changes));
			ctx.log(`  ~ payment methods ${a.id}`);
		} else if (a.kind === "webhook.update") {
			await client.webhookEndpoints.update(a.id, { enabled_events: WEBHOOK_EVENTS, disabled: false });
			ctx.log(`  ~ webhook ${a.id}`);
		} else if (a.kind === "webhook.create") {
			const w = await client.webhookEndpoints.create({ url: a.url, enabled_events: WEBHOOK_EVENTS });
			if (!w.secret) throw new Error(`webhook ${w.id} was created but Stripe returned no signing secret.`);
			result.webhookSecretPath = writeWebhookSecret(ctx.secretDir, ctx.mode, ctx.accountId, w.secret);
			ctx.log(`  + webhook ${w.id} → ${a.url}`);
		}
	}
	return result;
}

/** The env block of price ids (not secrets) for the prod vault or a local .env. */
export function priceEnvLines(obs: Observed): string[] {
	return DESIRED_PRICES.map((d) => `${d.envVar}=${obs.prices.get(d.lookupKey)?.id ?? "(missing)"}`);
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────

/** Parsed command-line flags. */
export interface SetupArgs {
	plan: boolean;
	apply: boolean;
	live: boolean;
	webhookUrl: string | undefined;
}

/** Parses the flags; throws on an unknown flag or on neither/both of --plan and --apply. */
export function parseSetupArgs(argv: string[]): SetupArgs {
	const args: SetupArgs = { plan: false, apply: false, live: false, webhookUrl: undefined };
	for (const a of argv) {
		if (a === "--") continue;
		else if (a === "--plan") args.plan = true;
		else if (a === "--apply") args.apply = true;
		else if (a === "--live") args.live = true;
		else if (a.startsWith("--webhook-url=")) args.webhookUrl = a.slice("--webhook-url=".length);
		else throw new Error(`Unknown argument: ${a}`);
	}
	if (args.plan === args.apply) throw new Error("Give exactly one of --plan or --apply.");
	if (args.webhookUrl !== undefined && !/^https:\/\/\S+$/.test(args.webhookUrl)) {
		throw new Error("--webhook-url must be an https:// URL.");
	}
	return args;
}

/** Runs the tool; returns the process exit code. */
export async function runSetup(
	argv: string[],
	env: StripeKeyEnv,
	makeClient: (key: string) => StripeClient,
	log: (line: string) => void,
	secretDir: string = DEFAULT_SECRET_DIR,
): Promise<number> {
	let args: SetupArgs;
	try {
		args = parseSetupArgs(argv);
	} catch (err) {
		log(`✗ ${err instanceof Error ? err.message : String(err)}`);
		return 2;
	}
	const key = resolveKey(env);
	if (!key.ok) {
		log(`✗ ${key.error}`);
		return 2;
	}
	const refusal = modeRefusal(key.mode, args.live);
	if (refusal) {
		log(`✗ ${refusal}`);
		return 2;
	}
	const client = makeClient(key.key);
	const account = await client.accounts.retrieveCurrent();
	log(`→ ${describeAccount(account, key.mode)}`);
	if (!args.webhookUrl) log("  (no --webhook-url: the webhook endpoint is not planned)");

	const obs = await readState(client, args.webhookUrl);
	const plan = computePlan(obs);
	for (const line of formatPlan(plan)) log(line);
	if (plan.errors.length) return 1;
	if (args.plan) return 0;
	if (!plan.actions.length) {
		log("No changes.");
		return 0;
	}

	log(`Applying ${plan.actions.length} change(s) to ${account.id} (${key.mode})…`);
	const result = await applyPlan(client, obs, plan, {
		mode: key.mode,
		accountId: account.id,
		secretDir,
		log,
	});

	const after = await readState(client, args.webhookUrl);
	const again = computePlan(after);
	if (again.actions.length || again.errors.length) {
		log("✗ The account did not converge; a second plan still has changes:");
		for (const line of formatPlan(again)) log(line);
		return 1;
	}
	log("✓ Converged: a second plan is empty.");
	log(`── ${key.mode} price ids (not secrets) ──`);
	for (const line of priceEnvLines(after)) log(line);
	if (result.webhookSecretPath) {
		log(`Webhook signing secret written to ${result.webhookSecretPath} (0600). It is not printed.`);
		log("  Store it as STRIPE_WEBHOOK_SECRET in the target env without printing it, then delete the file.");
		log(`  For a GitHub secret: gh secret set <NAME> < ${result.webhookSecretPath}`);
	}
	return 0;
}

/** True when this file is the entry point (not imported by a test or by stripe-check.ts). */
function isEntryPoint(): boolean {
	const entry = process.argv[1];
	return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntryPoint()) {
	runSetup(
		process.argv.slice(2),
		process.env,
		(key) => new Stripe(key, { appInfo: { name: "Alethia stripe-setup" } }),
		(line) => console.log(line),
	)
		.then((code) => process.exit(code))
		.catch((err: unknown) => {
			// A Stripe error carries its message and type, never the key.
			console.error(`✗ stripe-setup failed: ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		});
}
