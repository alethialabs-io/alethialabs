// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Paddle catalog as code (Paddle Billing plan, lane L2): a plan/apply tool for the Paddle objects
// the console sells through. Modelled on stripe-setup.ts.
//
//   pnpm creds paddle-sandbox -- pnpm -C apps/console run paddle:setup -- --plan
//   pnpm creds paddle-sandbox -- pnpm -C apps/console run paddle:setup -- --apply [--webhook-url=<url>]
//   pnpm creds paddle-live -- pnpm -C apps/console run paddle:setup -- --live --plan
//   pnpm creds paddle-live -- pnpm -C apps/console run paddle:setup -- --live --apply \
//     --webhook-url=https://alethialabs.io/api/webhooks/paddle --client-token
//
// `--plan` only reads. It prints the difference between the account and the desired state below.
// `--apply` makes exactly that difference, then reads the account again and fails unless the second
// plan is empty, so a second `--apply` changes nothing.
//
// Desired state:
//   • Products "Alethia Pro", "Alethia AI Plus", "Alethia AI Max", "Alethia AI credits" and
//     "Alethia runner minutes", found by `custom_data.alethia`, each `tax_category: saas`. The
//     runner-minutes and AI-credits products carry no catalog price: runner overage (lane L5) and
//     credit packs (lib/billing/paddle/checkout.ts) are charged with non-catalog prices against them.
//   • Prices for the plans, found by `custom_data.alethia_key`, at @repo/plan-catalog's amounts: a
//     USD `unit_price` with an EUR `unit_price_overrides` entry for EUROZONE_COUNTRIES,
//     `tax_mode: account_setting`, monthly. A price whose amount, override, cycle, quantity, tax
//     mode or product differs is REPLACED: a new price is created with the same key and the old one
//     is archived. The unit price is never PATCHed, so existing subscriptions keep their price. An
//     active price carrying an `alethia_key` the catalog no longer has is reported as a note.
//   • With `--webhook-url`: one `url` notification destination at that URL subscribed to exactly
//     PADDLE_WEBHOOK_EVENTS.
//   • With `--client-token`: one active client-side token named CLIENT_TOKEN_NAME, for Paddle.js.
//
// The env lines it prints are named by lib/billing/paddle/env-names.ts, the same definition the
// console's config reads, so a printed name cannot drift from the read one.
//
// What this does NOT manage, because Paddle's API has no endpoint for it: domain approval, the
// default payment link, checkout branding, customer portal settings, tax display, payout details and
// the self-billing toggle. Those are a checklist in apps/console/docs/paddle-prod-runbook.md.
//
// Secrets: the key is read from PADDLE_API_KEY (set by `pnpm creds`) and never printed. The
// environment (sandbox or live) follows the key's prefix and is printed first. A new destination's
// `endpoint_secret_key` is written to a 0600 file under ~/.alethia/paddle/ and only the path is
// printed. The client-side token is PUBLIC by design (it ships in the browser bundle as
// NEXT_PUBLIC_PADDLE_CLIENT_TOKEN), so it is printed among the env lines. A live key is refused
// unless `--live` is given.
//
// The HTTP client below is self-contained on purpose, so this script lands independently of the
// console's Paddle adapter (lane L1, lib/billing/paddle/). It can switch to that client once it is
// on dev; the PaddleClient port is the seam.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { aiPlanMeta, aiPlanUnitAmountCents, formatPriceLabel, planUnitAmountCents } from "@repo/plan-catalog";
import { z } from "zod";
import {
	PADDLE_CLIENT_TOKEN_ENV,
	PADDLE_PRICE_ENV,
	PADDLE_PRODUCT_ENV,
	PADDLE_WEBHOOK_SECRET_ENV,
	type PaddlePriceSlot,
	type PaddleProductSlot,
} from "../lib/billing/paddle/env-names";

// ── Desired state ─────────────────────────────────────────────────────────────────────────────

/** Paddle's tax category for software as a service. */
export const TAX_CATEGORY = "saas";

/**
 * Every price's tax mode: follow the account's tax setting. Paddle RESOLVES this when the price is
 * created and returns the resolved mode on every read (measured on the sandbox 2026-11-24: a price
 * created with `account_setting` reads back `location`). So the stored `tax_mode` cannot tell this
 * tool what it asked for; the request is recorded in `custom_data.alethia_tax_mode` and compared
 * there, and the resolved mode is reported. Consequence for the operator: set the account's tax
 * default in the dashboard BEFORE the first apply, because a price keeps the mode it resolved to.
 */
export const TAX_MODE = "account_setting";

/** The `custom_data` field that records the tax mode a price was created with. */
export const TAX_MODE_FIELD = "alethia_tax_mode";

/**
 * The euro-area member states as of 2026 (ISO 3166-1 alpha-2): the twenty members of 2025 plus
 * Bulgaria, which adopted the euro on 2026-01-01. A buyer in one of these countries is charged the
 * EUR amount; everyone else is charged USD. @repo/legal holds no euro-area list, so it lives here.
 * Note it is narrower than @repo/plan-catalog's EU_COUNTRIES (EU + EEA), which drives the console's
 * own currency toggle.
 */
export const EUROZONE_COUNTRIES: readonly string[] = [
	"AT",
	"BE",
	"BG",
	"CY",
	"DE",
	"EE",
	"ES",
	"FI",
	"FR",
	"GR",
	"HR",
	"IE",
	"IT",
	"LT",
	"LU",
	"LV",
	"MT",
	"NL",
	"PT",
	"SI",
	"SK",
];

/**
 * The notification events the Paddle webhook handler (lane L3) handles, and only those. The
 * destination is set to exactly this list, so an event subscribed by hand and handled nowhere is
 * dropped.
 */
export const PADDLE_WEBHOOK_EVENTS: readonly string[] = [
	"subscription.created",
	"subscription.activated",
	"subscription.updated",
	"subscription.trialing",
	"subscription.past_due",
	"subscription.paused",
	"subscription.resumed",
	"subscription.canceled",
	"transaction.billed",
	"transaction.paid",
	"transaction.past_due",
	"transaction.completed",
	"transaction.payment_failed",
	"adjustment.created",
	"adjustment.updated",
];

/**
 * The most seats one Pro subscription may carry. @repo/plan-catalog states no seat cap, so this is
 * Paddle's own default maximum quantity, stated explicitly so it is compared like any other field.
 */
export const PRO_MAX_SEATS = 100;

/** A product the catalog needs, found by its `custom_data.alethia` tag. */
export interface DesiredProduct {
	tag: string;
	name: string;
	taxCategory: string;
	/** The console config slot that carries this product's id, for products it references directly. */
	slot?: PaddleProductSlot;
}

/**
 * The name of the client-side token `--client-token` keeps. Paddle does not require names to be
 * unique; this tool treats the name as the token's identity, like a product's tag.
 */
export const CLIENT_TOKEN_NAME = "Alethia console (Paddle.js)";

/** A billing cycle in Paddle's shape. */
export interface BillingCycle {
	interval: "day" | "week" | "month" | "year";
	frequency: number;
}

/** A price the catalog needs, found by its `custom_data.alethia_key`. */
export interface DesiredPrice {
	key: string;
	/** The console config slot that reads this price's id; its env var is PADDLE_PRICE_ENV[slot]. */
	slot: PaddlePriceSlot;
	productTag: string;
	/** Shown to the buyer at checkout and on invoices. */
	name: string;
	/** Internal; Paddle requires it. */
	description: string;
	/** The USD unit price in cents. */
	usd: number;
	/** The EUR unit price in cents for EUROZONE_COUNTRIES, or null when the catalog has none. */
	eur: number | null;
	/** Monthly for the plans; null for a one-time price. */
	billingCycle: BillingCycle | null;
	quantity: { minimum: number; maximum: number };
}

export const DESIRED_PRODUCTS: DesiredProduct[] = [
	{ tag: "pro", name: "Alethia Pro", taxCategory: TAX_CATEGORY },
	{ tag: "ai_plus", name: "Alethia AI Plus", taxCategory: TAX_CATEGORY },
	{ tag: "ai_max", name: "Alethia AI Max", taxCategory: TAX_CATEGORY },
	{ tag: "ai_credits", name: "Alethia AI credits", taxCategory: TAX_CATEGORY, slot: "aiCredits" },
	{ tag: "runner_minutes", name: "Alethia runner minutes", taxCategory: TAX_CATEGORY, slot: "runnerMinutes" },
];

const MONTHLY: BillingCycle = { interval: "month", frequency: 1 };

/** Both amounts of a plan price as one label, e.g. "$20.00 / €18.00". */
function amountsLabel(usd: number, eur: number | null): string {
	return eur === null ? formatPriceLabel(usd, "usd") : `${formatPriceLabel(usd, "usd")} / ${formatPriceLabel(eur, "eur")}`;
}

const PRO_USD = planUnitAmountCents("team");
const PRO_EUR = planUnitAmountCents("team", "eur");
const AI_PLUS_USD = aiPlanUnitAmountCents("ai_plus");
const AI_PLUS_EUR = aiPlanUnitAmountCents("ai_plus", "eur");
const AI_MAX_USD = aiPlanUnitAmountCents("ai_max");
const AI_MAX_EUR = aiPlanUnitAmountCents("ai_max", "eur");

export const DESIRED_PRICES: DesiredPrice[] = [
	{
		key: "alethia_pro_monthly",
		slot: "team",
		productTag: "pro",
		name: "Alethia Pro (per seat, monthly)",
		description: `Alethia Pro, ${amountsLabel(PRO_USD, PRO_EUR)} per seat per month`,
		usd: PRO_USD,
		eur: PRO_EUR,
		billingCycle: MONTHLY,
		quantity: { minimum: 1, maximum: PRO_MAX_SEATS },
	},
	{
		key: "alethia_ai_plus_monthly",
		slot: "aiPlus",
		productTag: "ai_plus",
		name: `Alethia ${aiPlanMeta("ai_plus").name} (monthly)`,
		description: `Alethia AI Plus, ${amountsLabel(AI_PLUS_USD, AI_PLUS_EUR)} per month`,
		usd: AI_PLUS_USD,
		eur: AI_PLUS_EUR,
		billingCycle: MONTHLY,
		quantity: { minimum: 1, maximum: 1 },
	},
	{
		key: "alethia_ai_max_monthly",
		slot: "aiMax",
		productTag: "ai_max",
		name: `Alethia ${aiPlanMeta("ai_max").name} (monthly)`,
		description: `Alethia AI Max, ${amountsLabel(AI_MAX_USD, AI_MAX_EUR)} per month`,
		usd: AI_MAX_USD,
		eur: AI_MAX_EUR,
		billingCycle: MONTHLY,
		quantity: { minimum: 1, maximum: 1 },
	},
];

/** The env var a desired price's id is printed under: the one the console's config reads. */
export function priceEnvVar(d: DesiredPrice): string {
	return PADDLE_PRICE_ENV[d.slot];
}

// ── The Paddle surface this tool uses ─────────────────────────────────────────────────────────

const customDataSchema = z.record(z.string(), z.unknown()).nullable().optional();

const moneySchema = z.object({ amount: z.string(), currency_code: z.string() });

/** The product fields read. */
export const productSchema = z.object({
	id: z.string(),
	name: z.string(),
	tax_category: z.string(),
	status: z.string(),
	custom_data: customDataSchema,
});

/** The price fields read. */
export const priceSchema = z.object({
	id: z.string(),
	product_id: z.string(),
	name: z.string().nullable().optional(),
	description: z.string(),
	status: z.string(),
	tax_mode: z.string(),
	billing_cycle: z.object({ interval: z.string(), frequency: z.number() }).nullable(),
	unit_price: moneySchema,
	unit_price_overrides: z.array(z.object({ country_codes: z.array(z.string()), unit_price: moneySchema })),
	quantity: z.object({ minimum: z.number(), maximum: z.number() }),
	custom_data: customDataSchema,
});

/** The notification destination fields read. The endpoint secret is deliberately NOT parsed here. */
export const notificationSettingSchema = z.object({
	id: z.string(),
	description: z.string().nullable().optional(),
	type: z.string(),
	destination: z.string(),
	active: z.boolean(),
	subscribed_events: z.array(z.object({ name: z.string() })),
});

/** A newly created destination: the only response this tool reads the endpoint secret from. */
export const createdNotificationSettingSchema = notificationSettingSchema.extend({
	endpoint_secret_key: z.string().min(1),
});

/** The client-side token fields read. The token is public by design (Paddle.js ships it). */
export const clientTokenSchema = z.object({
	id: z.string(),
	token: z.string(),
	name: z.string(),
	description: z.string().nullable().optional(),
	status: z.string(),
});

/** A Paddle product as this tool sees it. */
export type PaddleProduct = z.infer<typeof productSchema>;
/** A Paddle price as this tool sees it. */
export type PaddlePrice = z.infer<typeof priceSchema>;
/** A Paddle notification destination as this tool sees it. */
export type PaddleNotificationSetting = z.infer<typeof notificationSettingSchema>;
/** A newly created destination, carrying its endpoint secret. */
export type PaddleCreatedNotificationSetting = z.infer<typeof createdNotificationSettingSchema>;
/** A Paddle client-side token as this tool sees it. */
export type PaddleClientToken = z.infer<typeof clientTokenSchema>;

/** A money amount in Paddle's request shape. */
export interface Money {
	amount: string;
	currency_code: "USD" | "EUR";
}

/** The body of POST /products. */
export interface ProductCreateBody {
	name: string;
	tax_category: string;
	custom_data: { alethia: string };
}

/** The body of PATCH /products/{id}. */
export interface ProductUpdateBody {
	name: string;
	tax_category: string;
}

/** The body of POST /prices. */
export interface PriceCreateBody {
	product_id: string;
	name: string;
	description: string;
	tax_mode: string;
	billing_cycle: BillingCycle | null;
	unit_price: Money;
	unit_price_overrides: { country_codes: string[]; unit_price: Money }[];
	quantity: { minimum: number; maximum: number };
	custom_data: { alethia_key: string; alethia_tax_mode: string };
}

/** The body of PATCH /prices/{id} this tool sends: the descriptive fields, or an archive. */
export type PriceUpdateBody = { name: string; description: string } | { status: "archived" };

/** The body of POST /notification-settings. */
export interface NotificationCreateBody {
	description: string;
	type: "url";
	destination: string;
	subscribed_events: string[];
	include_sensitive_fields: false;
}

/** The body of PATCH /notification-settings/{id}. */
export interface NotificationUpdateBody {
	subscribed_events: string[];
	active: true;
}

/** The body of POST /client-tokens. */
export interface ClientTokenCreateBody {
	name: string;
	description: string;
}

/** The Paddle calls this tool and paddle-check.ts make. createPaddleClient implements it over fetch. */
export interface PaddleClient {
	/** Every active product, all pages. */
	listProducts(): Promise<PaddleProduct[]>;
	createProduct(body: ProductCreateBody): Promise<PaddleProduct>;
	updateProduct(id: string, body: ProductUpdateBody): Promise<PaddleProduct>;
	/** Every active price, all pages. */
	listPrices(): Promise<PaddlePrice[]>;
	createPrice(body: PriceCreateBody): Promise<PaddlePrice>;
	updatePrice(id: string, body: PriceUpdateBody): Promise<PaddlePrice>;
	/** Every notification destination. */
	listNotificationSettings(): Promise<PaddleNotificationSetting[]>;
	createNotificationSetting(body: NotificationCreateBody): Promise<PaddleCreatedNotificationSetting>;
	updateNotificationSetting(id: string, body: NotificationUpdateBody): Promise<PaddleNotificationSetting>;
	/** Every ACTIVE client-side token, all pages (needs the key's client_token.read). */
	listClientTokens(): Promise<PaddleClientToken[]>;
	/** Needs the key's client_token.write. */
	createClientToken(body: ClientTokenCreateBody): Promise<PaddleClientToken>;
}

// ── Keys and environments ─────────────────────────────────────────────────────────────────────

/** Which Paddle environment a key targets. */
export type PaddleEnvironment = "sandbox" | "live";

/** The API base URL of each environment. */
export const PADDLE_API_BASE: Record<PaddleEnvironment, string> = {
	sandbox: "https://sandbox-api.paddle.com",
	live: "https://api.paddle.com",
};

/** The environment variables a key is read from; `process.env` satisfies it. */
export interface PaddleKeyEnv {
	[name: string]: string | undefined;
	PADDLE_API_KEY?: string;
}

/** A usable key and its environment, or why none is usable. */
export type KeyChoice = { ok: true; key: string; environment: PaddleEnvironment } | { ok: false; error: string };

/**
 * Picks the API key from PADDLE_API_KEY (set by `pnpm creds`) and reads its environment from the
 * prefix. A key with any other prefix is refused, so the environment is never a guess. The returned
 * error never contains the key.
 */
export function resolveKey(env: PaddleKeyEnv): KeyChoice {
	const key = env.PADDLE_API_KEY?.trim() || undefined;
	if (!key) {
		return { ok: false, error: "No Paddle key. Run through the broker: pnpm creds paddle-sandbox -- <command> (PADDLE_API_KEY)." };
	}
	if (key.startsWith("pdl_sdbx_apikey_")) return { ok: true, key, environment: "sandbox" };
	if (key.startsWith("pdl_live_apikey_")) return { ok: true, key, environment: "live" };
	return {
		ok: false,
		error: "PADDLE_API_KEY has an unknown prefix (expected pdl_sdbx_apikey_ for sandbox or pdl_live_apikey_ for live).",
	};
}

/** Returns why this environment may not run with these flags, or null when it may. */
export function environmentRefusal(environment: PaddleEnvironment, liveFlag: boolean): string | null {
	if (environment === "live" && !liveFlag) {
		return "This is a LIVE Paddle key. Re-run with --live if you mean to touch the live account.";
	}
	if (environment === "sandbox" && liveFlag) {
		return "--live was given but the key is a SANDBOX key. Drop --live or use the paddle-live profile.";
	}
	return null;
}

/** One line naming the environment a run targets. Never contains the key. */
export function describeTarget(environment: PaddleEnvironment): string {
	return `Paddle ${environment.toUpperCase()} · ${PADDLE_API_BASE[environment]}`;
}

// ── The fetch client ──────────────────────────────────────────────────────────────────────────

const paddleErrorSchema = z.object({
	error: z.object({
		code: z.string().optional(),
		detail: z.string().optional(),
		errors: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
	}),
});

const paginationSchema = z
	.object({
		pagination: z
			.object({ next: z.string().nullable().optional(), has_more: z.boolean() })
			.optional(),
	})
	.optional();

/** A minimal fetch signature, so a test can supply its own. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}>;

/**
 * A PaddleClient over Paddle's REST API: bearer auth, zod-parsed responses, list endpoints followed
 * through `meta.pagination.next`. An error carries the HTTP status and Paddle's code and detail,
 * never the key.
 */
export function createPaddleClient(key: string, environment: PaddleEnvironment, fetchImpl: FetchLike = fetch): PaddleClient {
	const base = PADDLE_API_BASE[environment];

	/** Sends one request and returns the parsed JSON body; throws on a non-2xx response. */
	async function request(method: string, url: string, body?: unknown): Promise<unknown> {
		const res = await fetchImpl(url, {
			method,
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
				"Paddle-Version": "1",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const json: unknown = await res.json().catch(() => null);
		if (!res.ok) {
			const parsed = paddleErrorSchema.safeParse(json);
			const e = parsed.success ? parsed.data.error : undefined;
			const fields = e?.errors?.map((f) => `${f.field}: ${f.message}`).join("; ");
			const path = url.slice(base.length).split("?")[0];
			throw new Error(
				`Paddle ${method} ${path} → ${res.status} ${e?.code ?? "error"}: ${e?.detail ?? "(no detail)"}${fields ? ` (${fields})` : ""}`,
			);
		}
		return json;
	}

	/** Sends one request and parses `data` with `schema`. */
	async function one<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
		const json = await request(method, `${base}${path}`, body);
		return z.object({ data: schema }).parse(json).data;
	}

	/** Reads every page of a list endpoint. A `next` link off the API's own origin is refused. */
	async function all<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
		const out: T[] = [];
		let url: string | null = `${base}${path}`;
		while (url) {
			const page = z.object({ data: z.array(schema), meta: paginationSchema }).parse(await request("GET", url));
			out.push(...page.data);
			const next = page.meta?.pagination?.has_more ? page.meta.pagination.next : null;
			if (next && !next.startsWith(`${base}/`)) throw new Error("Paddle returned a pagination link off its own origin.");
			url = next ?? null;
		}
		return out;
	}

	return {
		listProducts: () => all("/products?status=active&per_page=200", productSchema),
		createProduct: (body) => one("POST", "/products", productSchema, body),
		updateProduct: (id, body) => one("PATCH", `/products/${encodeURIComponent(id)}`, productSchema, body),
		listPrices: () => all("/prices?status=active&per_page=200", priceSchema),
		createPrice: (body) => one("POST", "/prices", priceSchema, body),
		updatePrice: (id, body) => one("PATCH", `/prices/${encodeURIComponent(id)}`, priceSchema, body),
		listNotificationSettings: () => all("/notification-settings", notificationSettingSchema),
		createNotificationSetting: (body) => one("POST", "/notification-settings", createdNotificationSettingSchema, body),
		updateNotificationSetting: (id, body) =>
			one("PATCH", `/notification-settings/${encodeURIComponent(id)}`, notificationSettingSchema, body),
		listClientTokens: () => all("/client-tokens?status=active&per_page=200", clientTokenSchema),
		createClientToken: (body) => one("POST", "/client-tokens", clientTokenSchema, body),
	};
}

// ── Reading the account ───────────────────────────────────────────────────────────────────────

/** A string field of a `custom_data` object, or undefined. */
function customField(data: Record<string, unknown> | null | undefined, field: string): string | undefined {
	const value = data?.[field];
	return typeof value === "string" ? value : undefined;
}

/** What the account holds, for every object this tool manages. */
export interface Observed {
	/** Active products by `custom_data.alethia` tag; more than one per tag is blocking. */
	products: Map<string, PaddleProduct[]>;
	/** Active prices by `custom_data.alethia_key`. */
	prices: Map<string, PaddlePrice[]>;
	/** URL destinations at `webhookUrl`, when one was given. */
	notifications: PaddleNotificationSetting[];
	webhookUrl: string | undefined;
	/** Whether the client-side token is managed this run (`--client-token`). */
	manageClientToken: boolean;
	/** Active client-side tokens named CLIENT_TOKEN_NAME, when managed. */
	clientTokens: PaddleClientToken[];
}

/** Reads the current state of everything in the desired state. Makes no change. */
export async function readState(
	client: PaddleClient,
	webhookUrl: string | undefined,
	manageClientToken = false,
): Promise<Observed> {
	const products = new Map<string, PaddleProduct[]>();
	for (const p of await client.listProducts()) {
		const tag = customField(p.custom_data, "alethia");
		if (!tag || p.status !== "active") continue;
		products.set(tag, [...(products.get(tag) ?? []), p]);
	}
	const prices = new Map<string, PaddlePrice[]>();
	for (const p of await client.listPrices()) {
		const key = customField(p.custom_data, "alethia_key");
		if (!key || p.status !== "active") continue;
		prices.set(key, [...(prices.get(key) ?? []), p]);
	}
	const notifications = webhookUrl
		? (await client.listNotificationSettings()).filter((n) => n.type === "url" && n.destination === webhookUrl)
		: [];
	const clientTokens = manageClientToken
		? (await client.listClientTokens()).filter((t) => t.status === "active" && t.name === CLIENT_TOKEN_NAME)
		: [];
	return { products, prices, notifications, webhookUrl, manageClientToken, clientTokens };
}

// ── The plan ──────────────────────────────────────────────────────────────────────────────────

/** One change the plan makes. `summary` is what `--plan` prints. */
export type Action =
	| { kind: "product.create"; tag: string; summary: string }
	| { kind: "product.update"; tag: string; id: string; summary: string }
	| { kind: "price.create"; key: string; replaces: string[]; summary: string }
	| { kind: "price.update"; key: string; id: string; summary: string }
	| { kind: "price.archive"; key: string; id: string; summary: string }
	| { kind: "notification.create"; url: string; summary: string }
	| { kind: "notification.update"; id: string; summary: string }
	| { kind: "client_token.create"; summary: string };

/** The full difference: what changes, what already matches, what blocks, and what to know. */
export interface Plan {
	actions: Action[];
	ok: string[];
	errors: string[];
	/** Not blocking: catalog gaps the operator should know about. */
	notes: string[];
}

/** Renders a value for a "before → after" line. */
function show(v: unknown): string {
	return v === null || v === undefined || v === "" ? "(none)" : JSON.stringify(v);
}

/** The EUR override a desired price carries (empty when the catalog has no EUR amount). */
export function desiredOverrides(d: DesiredPrice): PriceCreateBody["unit_price_overrides"] {
	if (d.eur === null) return [];
	return [{ country_codes: [...EUROZONE_COUNTRIES], unit_price: { amount: String(d.eur), currency_code: "EUR" } }];
}

/** A canonical string for a set of overrides, independent of their order and country order. */
function overridesFingerprint(overrides: { country_codes: string[]; unit_price: { amount: string; currency_code: string } }[]): string {
	return overrides
		.map((o) => `${o.unit_price.currency_code}:${o.unit_price.amount}@${[...o.country_codes].sort().join(",")}`)
		.sort()
		.join("|");
}

/**
 * Why an existing price differs economically from the desired one (empty when it matches). Any of
 * these means a replacement: Paddle can PATCH a price, but changing what an existing subscription
 * pays is exactly what this tool must never do.
 */
export function priceDrift(p: PaddlePrice, d: DesiredPrice, productId: string | null): string[] {
	const out: string[] = [];
	if (p.product_id !== productId) out.push(`product ${show(p.product_id)} → ${show(productId)}`);
	if (p.unit_price.currency_code !== "USD" || p.unit_price.amount !== String(d.usd)) {
		out.push(`unit_price ${p.unit_price.amount} ${p.unit_price.currency_code} → ${d.usd} USD`);
	}
	const have = overridesFingerprint(p.unit_price_overrides);
	const want = overridesFingerprint(desiredOverrides(d));
	if (have !== want) {
		const eurNow = p.unit_price_overrides.find((o) => o.unit_price.currency_code === "EUR");
		out.push(
			`EUR override ${eurNow ? `${eurNow.unit_price.amount} for ${eurNow.country_codes.length} countries` : "(none)"} → ${
				d.eur === null ? "(none)" : `${d.eur} for ${EUROZONE_COUNTRIES.length} eurozone countries`
			}${p.unit_price_overrides.length > 1 ? ` (${p.unit_price_overrides.length} overrides)` : ""}`,
		);
	}
	const cycle = p.billing_cycle;
	const wantCycle = d.billingCycle;
	if (
		(cycle === null) !== (wantCycle === null) ||
		(cycle && wantCycle && (cycle.interval !== wantCycle.interval || cycle.frequency !== wantCycle.frequency))
	) {
		out.push(
			`billing_cycle ${cycle ? `${cycle.frequency} ${cycle.interval}` : "one-time"} → ${wantCycle ? `${wantCycle.frequency} ${wantCycle.interval}` : "one-time"}`,
		);
	}
	const askedTaxMode = p.tax_mode === TAX_MODE ? TAX_MODE : customField(p.custom_data, TAX_MODE_FIELD);
	if (askedTaxMode !== TAX_MODE) out.push(`tax_mode ${show(p.tax_mode)} (not created as ${TAX_MODE}) → ${TAX_MODE}`);
	if (p.quantity.minimum !== d.quantity.minimum || p.quantity.maximum !== d.quantity.maximum) {
		out.push(`quantity ${p.quantity.minimum}..${p.quantity.maximum} → ${d.quantity.minimum}..${d.quantity.maximum}`);
	}
	return out;
}

/** The difference between the observed account and the desired state. Pure: reads nothing. */
export function computePlan(obs: Observed): Plan {
	const plan: Plan = { actions: [], ok: [], errors: [], notes: [] };
	const productIds = new Map<string, string | null>();

	for (const d of DESIRED_PRODUCTS) {
		const found = obs.products.get(d.tag) ?? [];
		if (found.length > 1) {
			plan.errors.push(
				`product ${d.tag}: ${found.length} active products carry custom_data.alethia=${d.tag} (${found
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
				summary: `+ product ${d.tag} "${d.name}" (tax_category ${d.taxCategory})`,
			});
			continue;
		}
		productIds.set(d.tag, p.id);
		const changes: string[] = [];
		if (p.name !== d.name) changes.push(`name ${show(p.name)} → ${show(d.name)}`);
		if (p.tax_category !== d.taxCategory) changes.push(`tax_category ${show(p.tax_category)} → ${d.taxCategory}`);
		if (changes.length) {
			plan.actions.push({ kind: "product.update", tag: d.tag, id: p.id, summary: `~ product ${d.tag} ${p.id}: ${changes.join("; ")}` });
		} else {
			plan.ok.push(`product ${d.tag} ${p.id} (tax_category ${d.taxCategory})`);
		}
	}

	for (const d of DESIRED_PRICES) {
		const found = obs.prices.get(d.key) ?? [];
		const productId = productIds.get(d.productTag) ?? null;
		const label = `${amountsLabel(d.usd, d.eur)}, ${d.billingCycle ? "monthly" : "one-time"}, qty ${d.quantity.minimum}..${d.quantity.maximum}`;
		const match = found.find((p) => priceDrift(p, d, productId).length === 0);
		if (!match) {
			const first = found[0];
			const why = first ? ` (${priceDrift(first, d, productId).join("; ")})` : "";
			plan.actions.push({
				kind: "price.create",
				key: d.key,
				replaces: found.map((p) => p.id),
				summary: found.length
					? `± price ${d.key}: replace ${found.map((p) => p.id).join(", ")}${why}; a new price takes the key, the old one is archived, existing subscriptions keep it`
					: `+ price ${d.key} (${label}, tax_mode ${TAX_MODE})`,
			});
			continue;
		}
		for (const extra of found) {
			if (extra.id === match.id) continue;
			plan.actions.push({
				kind: "price.archive",
				key: d.key,
				id: extra.id,
				summary: `- price ${d.key}: archive ${extra.id} (a second active price with this key; ${match.id} matches the catalog)`,
			});
		}
		const descriptive: string[] = [];
		if ((match.name ?? "") !== d.name) descriptive.push(`name ${show(match.name)} → ${show(d.name)}`);
		if (match.description !== d.description) descriptive.push(`description ${show(match.description)} → ${show(d.description)}`);
		if (descriptive.length) {
			plan.actions.push({
				kind: "price.update",
				key: d.key,
				id: match.id,
				summary: `~ price ${d.key} ${match.id}: ${descriptive.join("; ")}`,
			});
		} else {
			plan.ok.push(`price ${d.key} ${match.id} (${label}, tax_mode resolved to ${match.tax_mode})`);
		}
	}

	const known = new Set(DESIRED_PRICES.map((d) => d.key));
	for (const [key, found] of obs.prices) {
		if (known.has(key)) continue;
		plan.notes.push(
			`price key ${key} is active (${found.map((p) => p.id).join(", ")}) but is not in the catalog and nothing reads it; archive it in the dashboard if no subscription uses it`,
		);
	}

	if (obs.webhookUrl) {
		const url = obs.webhookUrl;
		if (obs.notifications.length > 1) {
			plan.errors.push(
				`${obs.notifications.length} notification destinations have the URL ${url} (${obs.notifications
					.map((n) => n.id)
					.join(", ")}); delete all but one in the dashboard.`,
			);
		}
		const n = obs.notifications[0];
		if (!n) {
			plan.actions.push({
				kind: "notification.create",
				url,
				summary: `+ notification destination ${url} (${PADDLE_WEBHOOK_EVENTS.length} events); its secret key goes to a 0600 file`,
			});
		} else if (obs.notifications.length === 1) {
			const have = new Set(n.subscribed_events.map((e) => e.name));
			const want = new Set(PADDLE_WEBHOOK_EVENTS);
			const added = [...want].filter((e) => !have.has(e));
			const removed = [...have].filter((e) => !want.has(e));
			const changes: string[] = [];
			if (added.length) changes.push(`+${added.join(" +")}`);
			if (removed.length) changes.push(`-${removed.join(" -")}`);
			if (!n.active) changes.push("active false → true");
			if (changes.length) {
				plan.actions.push({ kind: "notification.update", id: n.id, summary: `~ notification destination ${n.id}: ${changes.join("; ")}` });
			} else {
				plan.ok.push(`notification destination ${n.id} (${url}, ${PADDLE_WEBHOOK_EVENTS.length} events)`);
			}
		}
	}

	if (obs.manageClientToken) {
		const tokens = obs.clientTokens;
		if (tokens.length > 1) {
			plan.errors.push(
				`${tokens.length} active client-side tokens are named "${CLIENT_TOKEN_NAME}" (${tokens
					.map((t) => t.id)
					.join(", ")}); revoke all but one in the dashboard.`,
			);
		} else if (tokens.length === 1) {
			plan.ok.push(`client-side token ${tokens.map((t) => t.id).join("")} ("${CLIENT_TOKEN_NAME}")`);
		} else {
			plan.actions.push({ kind: "client_token.create", summary: `+ client-side token "${CLIENT_TOKEN_NAME}" for Paddle.js` });
		}
	}
	return plan;
}

/** The lines `--plan` prints for a plan. */
export function formatPlan(plan: Plan): string[] {
	const n = (prefix: string) => plan.actions.filter((a) => a.summary.startsWith(prefix)).length;
	const lines = [
		`Plan: ${n("+")} to create, ${n("~")} to update, ${n("±")} to replace, ${n("-")} to archive, ${plan.ok.length} unchanged, ${plan.errors.length} blocking.`,
	];
	for (const a of plan.actions) lines.push(`  ${a.summary}`);
	for (const ok of plan.ok) lines.push(`  ✓ ${ok}`);
	for (const e of plan.errors) lines.push(`  ✗ ${e}`);
	for (const note of plan.notes) lines.push(`  ! ${note}`);
	return lines;
}

// ── Apply ─────────────────────────────────────────────────────────────────────────────────────

/** The create body for a desired price under `productId`. */
export function priceCreateBody(d: DesiredPrice, productId: string): PriceCreateBody {
	return {
		product_id: productId,
		name: d.name,
		description: d.description,
		tax_mode: TAX_MODE,
		billing_cycle: d.billingCycle ? { ...d.billingCycle } : null,
		unit_price: { amount: String(d.usd), currency_code: "USD" },
		unit_price_overrides: desiredOverrides(d),
		quantity: { ...d.quantity },
		custom_data: { alethia_key: d.key, [TAX_MODE_FIELD]: TAX_MODE },
	};
}

/** Writes a destination's endpoint secret to `<dir>/<env>-<id>.secret` (0600, dir 0700); returns the path. */
export function writeEndpointSecret(dir: string, environment: PaddleEnvironment, destinationId: string, secret: string): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const path = join(dir, `${environment}-${destinationId}.secret`);
	writeFileSync(path, `${secret}\n`, { mode: 0o600 });
	// writeFileSync's mode applies only when it creates the file; an existing file keeps its own.
	chmodSync(path, 0o600);
	return path;
}

/** Where apply writes a new endpoint secret: ~/.alethia/paddle. */
export const DEFAULT_SECRET_DIR = join(homedir(), ".alethia", "paddle");

/** What apply needs besides the client and the plan. */
export interface ApplyContext {
	environment: PaddleEnvironment;
	secretDir: string;
	log: (line: string) => void;
}

/** What apply did that the operator must act on. */
export interface ApplyResult {
	/** Path of the 0600 file holding a new destination's endpoint secret, when one was created. */
	endpointSecretPath: string | null;
}

/**
 * Makes exactly the plan's changes, in dependency order (products, prices, archives, notification
 * destination). A replacement creates the new price BEFORE archiving the old one, so a key is never
 * without an active price. Refuses a plan with blocking errors. Never prints a secret.
 */
export async function applyPlan(client: PaddleClient, obs: Observed, plan: Plan, ctx: ApplyContext): Promise<ApplyResult> {
	if (plan.errors.length) throw new Error("The plan has blocking errors; nothing was changed.");
	const result: ApplyResult = { endpointSecretPath: null };

	const productIds = new Map<string, string>();
	for (const [tag, list] of obs.products) {
		const first = list[0];
		if (first) productIds.set(tag, first.id);
	}
	for (const a of plan.actions) {
		if (a.kind !== "product.create" && a.kind !== "product.update") continue;
		const d = DESIRED_PRODUCTS.find((p) => p.tag === a.tag);
		if (!d) continue;
		if (a.kind === "product.create") {
			const p = await client.createProduct({ name: d.name, tax_category: d.taxCategory, custom_data: { alethia: d.tag } });
			productIds.set(d.tag, p.id);
			ctx.log(`  + product ${d.tag} ${p.id}`);
		} else {
			await client.updateProduct(a.id, { name: d.name, tax_category: d.taxCategory });
			ctx.log(`  ~ product ${d.tag} ${a.id}`);
		}
	}

	for (const a of plan.actions) {
		if (a.kind === "price.create") {
			const d = DESIRED_PRICES.find((p) => p.key === a.key);
			if (!d) continue;
			const productId = productIds.get(d.productTag);
			if (!productId) throw new Error(`price ${d.key}: product ${d.productTag} was not found or created.`);
			const created = await client.createPrice(priceCreateBody(d, productId));
			ctx.log(`  + price ${d.key} ${created.id}`);
			for (const old of a.replaces) {
				await client.updatePrice(old, { status: "archived" });
				ctx.log(`  - archived price ${old}`);
			}
		} else if (a.kind === "price.update") {
			const d = DESIRED_PRICES.find((p) => p.key === a.key);
			if (!d) continue;
			await client.updatePrice(a.id, { name: d.name, description: d.description });
			ctx.log(`  ~ price ${d.key} ${a.id}`);
		} else if (a.kind === "price.archive") {
			await client.updatePrice(a.id, { status: "archived" });
			ctx.log(`  - archived price ${a.id}`);
		}
	}

	for (const a of plan.actions) {
		if (a.kind === "notification.update") {
			await client.updateNotificationSetting(a.id, { subscribed_events: [...PADDLE_WEBHOOK_EVENTS], active: true });
			ctx.log(`  ~ notification destination ${a.id}`);
		} else if (a.kind === "notification.create") {
			const n = await client.createNotificationSetting({
				description: "Alethia console webhooks",
				type: "url",
				destination: a.url,
				subscribed_events: [...PADDLE_WEBHOOK_EVENTS],
				include_sensitive_fields: false,
			});
			result.endpointSecretPath = writeEndpointSecret(ctx.secretDir, ctx.environment, n.id, n.endpoint_secret_key);
			ctx.log(`  + notification destination ${n.id} → ${a.url}`);
		}
	}

	for (const a of plan.actions) {
		if (a.kind !== "client_token.create") continue;
		const t = await client.createClientToken({
			name: CLIENT_TOKEN_NAME,
			description: "Initialises Paddle.js in the Alethia console. Public by design; kept by scripts/paddle-setup.ts.",
		});
		ctx.log(`  + client-side token ${t.id}`);
	}
	return result;
}

/** The env block of catalog ids (not secrets) for the deploy vault or a local .env. */
export function catalogEnvLines(obs: Observed): string[] {
	const productId = (tag: string) => obs.products.get(tag)?.[0]?.id ?? null;
	const lines = DESIRED_PRICES.map((d) => {
		const pid = productId(d.productTag);
		const match = (obs.prices.get(d.key) ?? []).find((p) => priceDrift(p, d, pid).length === 0);
		return `${priceEnvVar(d)}=${match?.id ?? "(missing)"}`;
	});
	for (const d of DESIRED_PRODUCTS) {
		if (d.slot) lines.push(`${PADDLE_PRODUCT_ENV[d.slot]}=${productId(d.tag) ?? "(missing)"}`);
	}
	if (obs.manageClientToken) {
		// Public by design: Paddle.js is initialised with it in the browser.
		const [only, ...rest] = obs.clientTokens;
		lines.push(`${PADDLE_CLIENT_TOKEN_ENV}=${only && rest.length === 0 ? only.token : "(missing)"}`);
	}
	return lines;
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────

/** Parsed command-line flags. */
export interface SetupArgs {
	plan: boolean;
	apply: boolean;
	live: boolean;
	webhookUrl: string | undefined;
	/** Keep one active client-side token named CLIENT_TOKEN_NAME. */
	clientToken: boolean;
}

/** Parses the flags; throws on an unknown flag, on neither/both of --plan and --apply, or a non-https URL. */
export function parseSetupArgs(argv: string[]): SetupArgs {
	const args: SetupArgs = { plan: false, apply: false, live: false, webhookUrl: undefined, clientToken: false };
	for (const a of argv) {
		if (a === "--") continue;
		else if (a === "--plan") args.plan = true;
		else if (a === "--apply") args.apply = true;
		else if (a === "--live") args.live = true;
		else if (a === "--client-token") args.clientToken = true;
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
	env: PaddleKeyEnv,
	makeClient: (key: string, environment: PaddleEnvironment) => PaddleClient,
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
	const refusal = environmentRefusal(key.environment, args.live);
	if (refusal) {
		log(`✗ ${refusal}`);
		return 2;
	}
	log(`→ ${describeTarget(key.environment)}`);
	if (!args.webhookUrl) log("  (no --webhook-url: the notification destination is not planned)");
	if (!args.clientToken) log("  (no --client-token: the Paddle.js client-side token is not planned)");
	const client = makeClient(key.key, key.environment);

	const obs = await readState(client, args.webhookUrl, args.clientToken);
	const plan = computePlan(obs);
	for (const line of formatPlan(plan)) log(line);
	if (plan.errors.length) return 1;
	if (args.plan) return 0;
	if (!plan.actions.length) {
		log("No changes.");
		log(`── ${key.environment} catalog ids (not secrets) ──`);
		for (const line of catalogEnvLines(obs)) log(line);
		return 0;
	}

	log(`Applying ${plan.actions.length} change(s) to Paddle ${key.environment}…`);
	const result = await applyPlan(client, obs, plan, { environment: key.environment, secretDir, log });

	const after = await readState(client, args.webhookUrl, args.clientToken);
	const again = computePlan(after);
	if (again.actions.length || again.errors.length) {
		log("✗ The account did not converge; a second plan still has changes:");
		for (const line of formatPlan(again)) log(line);
		return 1;
	}
	log("✓ Converged: a second plan is empty.");
	log(`── ${key.environment} catalog ids (not secrets) ──`);
	for (const line of catalogEnvLines(after)) log(line);
	if (result.endpointSecretPath) {
		log(`Notification endpoint secret written to ${result.endpointSecretPath} (0600). It is not printed.`);
		log(`  Store it as ${PADDLE_WEBHOOK_SECRET_ENV} in the target env without printing it, then delete the file.`);
	}
	return 0;
}

/** True when this file is the entry point (not imported by a test or by paddle-check.ts). */
function isEntryPoint(): boolean {
	const entry = process.argv[1];
	return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntryPoint()) {
	runSetup(
		process.argv.slice(2),
		process.env,
		(key, environment) => createPaddleClient(key, environment),
		(line) => console.log(line),
	)
		.then((code) => process.exit(code))
		.catch((err: unknown) => {
			// A Paddle error carries its status, code and detail, never the key.
			console.error(`✗ paddle-setup failed: ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		});
}
