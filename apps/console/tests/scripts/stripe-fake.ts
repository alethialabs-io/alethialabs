// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// An in-memory Stripe account implementing the narrow `StripeClient` surface of
// scripts/stripe-setup.ts, for tests/scripts/stripe-setup.test.ts and stripe-check.test.ts. It keeps
// the rules the tool relies on: a lookup key belongs to one price, and moving it needs
// `transfer_lookup_key`; a webhook secret is returned only by create.

import type Stripe from "stripe";
import {
	ALL_PAYMENT_METHODS,
	type AccountView,
	type MeterView,
	type PaymentMethodConfigView,
	type PortalView,
	type PriceView,
	type ProductView,
	type StripeClient,
	type TaxSettingsView,
	type WebhookCreatedView,
	type WebhookView,
} from "../../scripts/stripe-setup";

/** A price as the fake stores it: the view plus its lookup key. */
export interface FakePrice extends PriceView {
	lookup_key: string | null;
}

/** The fake account's contents and the write calls made against it. */
export interface FakeAccount {
	account: AccountView;
	products: ProductView[];
	prices: FakePrice[];
	meters: MeterView[];
	tax: TaxSettingsView;
	portals: PortalView[];
	webhooks: (WebhookView & { secret: string })[];
	pmcs: PaymentMethodConfigView[];
	/** Every write, as "<resource>.<method> <id?>". */
	writes: string[];
}

/** The signing secret the fake returns for a new endpoint; tests assert it is never logged. */
export const FAKE_WEBHOOK_SECRET = "whsec_FAKE_do_not_print_0123456789";

/** A default portal configuration with Stripe's permissive dashboard defaults. */
export function permissivePortal(id = "bpc_default"): PortalView {
	return {
		id,
		is_default: true,
		active: true,
		business_profile: { headline: null, privacy_policy_url: null, terms_of_service_url: null },
		features: {
			customer_update: { enabled: true, allowed_updates: ["email", "address", "tax_id"] },
			invoice_history: { enabled: true },
			payment_method_update: { enabled: true },
			subscription_cancel: { enabled: true, mode: "at_period_end" },
			subscription_update: { enabled: false },
		},
	};
}

/** True for a display preference Stripe accepts. */
function isPreference(p: string): p is "on" | "off" | "none" {
	return p === "on" || p === "off" || p === "none";
}

/** One method's entry in a payment method configuration, as Stripe returns it. */
export function pmSetting(preference: "on" | "off" | "none", available = preference === "on") {
	const value: "on" | "off" = preference === "on" ? "on" : "off";
	return { available, display_preference: { overridable: null, preference, value } };
}

/**
 * A default payment method configuration shaped like a new EU account's: cards and the common local
 * methods on, a wallet left at Stripe's default (`none`), Klarna off.
 */
export function defaultPaymentMethods(id = "pmc_default"): PaymentMethodConfigView {
	return {
		id,
		is_default: true,
		active: true,
		card: pmSetting("on"),
		link: pmSetting("on"),
		apple_pay: pmSetting("none"),
		google_pay: pmSetting("on"),
		sepa_debit: pmSetting("on"),
		bancontact: pmSetting("on"),
		ideal: pmSetting("on"),
		klarna: pmSetting("off"),
	};
}

/** A fresh, empty account with a default (permissive) portal configuration. */
export function emptyAccount(): FakeAccount {
	return {
		account: {
			id: "acct_test123",
			country: "BG",
			charges_enabled: false,
			payouts_enabled: false,
			details_submitted: true,
			settings: { dashboard: { display_name: "Alethia Labs sandbox" } },
		},
		products: [],
		prices: [],
		meters: [],
		tax: {
			status: "pending",
			defaults: { tax_code: null, tax_behavior: null },
			head_office: null,
			status_details: { pending: { missing_fields: ["head_office"] } },
		},
		portals: [permissivePortal()],
		webhooks: [],
		pmcs: [{ ...defaultPaymentMethods("pmc_other"), is_default: false }, defaultPaymentMethods()],
		writes: [],
	};
}

/** Metadata params as plain strings. */
function meta(m: Stripe.MetadataParam | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(m ?? {})) if (v !== null && v !== undefined && v !== "") out[k] = String(v);
	return out;
}

/** Pages a list the way Stripe does (`starting_after`, `has_more`). */
function page<T extends { id: string }>(all: T[], limit: number | undefined, after: string | undefined) {
	const start = after ? all.findIndex((x) => x.id === after) + 1 : 0;
	const size = limit ?? 10;
	const data = all.slice(start, start + size);
	return Promise.resolve({ data, has_more: start + size < all.length });
}

/** Tiers from create params, as Stripe returns them. */
function tiersOf(tiers: Stripe.PriceCreateParams.Tier[] | undefined) {
	return (tiers ?? []).map((t) => ({
		up_to: t.up_to === "inf" ? null : t.up_to,
		unit_amount: t.unit_amount ?? null,
		unit_amount_decimal: t.unit_amount_decimal ?? (t.unit_amount !== undefined ? String(t.unit_amount) : null),
	}));
}

/** A `StripeClient` over `acct`. */
export function fakeClient(acct: FakeAccount): StripeClient {
	let seq = 0;
	const id = (prefix: string) => `${prefix}_${++seq}`;
	return {
		accounts: { retrieveCurrent: () => Promise.resolve(acct.account) },
		products: {
			list: (p) => page(acct.products.filter((x) => p.active === undefined || x.active === p.active), p.limit, p.starting_after),
			create: (p) => {
				const product: ProductView = {
					id: id("prod"),
					name: p.name,
					active: true,
					tax_code: p.tax_code ?? null,
					metadata: meta(p.metadata),
				};
				acct.products.push(product);
				acct.writes.push(`products.create ${product.id}`);
				return Promise.resolve(product);
			},
			update: (pid, p) => {
				const product = acct.products.find((x) => x.id === pid);
				if (!product) return Promise.reject(new Error(`no product ${pid}`));
				if (p.name !== undefined) product.name = p.name;
				if (typeof p.tax_code === "string") product.tax_code = p.tax_code;
				acct.writes.push(`products.update ${pid}`);
				return Promise.resolve(product);
			},
		},
		prices: {
			list: (p) => {
				const keys = p.lookup_keys ?? [];
				return page(acct.prices.filter((x) => x.lookup_key !== null && keys.includes(x.lookup_key)), p.limit, undefined);
			},
			create: (p) => {
				const holder = acct.prices.find((x) => p.lookup_key && x.lookup_key === p.lookup_key);
				if (holder && !p.transfer_lookup_key) {
					return Promise.reject(new Error(`lookup_key ${p.lookup_key} is already used by ${holder.id}`));
				}
				if (holder) holder.lookup_key = null;
				const eur = p.currency_options?.eur;
				const price: FakePrice = {
					id: id("price"),
					active: true,
					product: p.product ?? "",
					currency: p.currency,
					unit_amount: p.unit_amount ?? null,
					tax_behavior: p.tax_behavior ?? "unspecified",
					billing_scheme: p.billing_scheme ?? "per_unit",
					tiers_mode: p.tiers_mode ?? null,
					recurring: p.recurring
						? {
								interval: p.recurring.interval,
								usage_type: p.recurring.usage_type ?? "licensed",
								meter: p.recurring.meter ?? null,
							}
						: null,
					tiers: tiersOf(p.tiers),
					currency_options: eur
						? { eur: { unit_amount: eur.unit_amount ?? null, tax_behavior: eur.tax_behavior ?? "unspecified" } }
						: {},
					metadata: meta(p.metadata),
					lookup_key: p.lookup_key ?? null,
				};
				acct.prices.push(price);
				acct.writes.push(`prices.create ${price.id}`);
				return Promise.resolve(price);
			},
			update: (pid, p) => {
				const price = acct.prices.find((x) => x.id === pid);
				if (!price) return Promise.reject(new Error(`no price ${pid}`));
				if (p.active !== undefined) price.active = p.active;
				acct.writes.push(`prices.update ${pid}`);
				return Promise.resolve(price);
			},
		},
		billing: {
			meters: {
				list: (p) => page(acct.meters, p.limit, p.starting_after),
				create: (p) => {
					const meter: MeterView = {
						id: id("mtr"),
						event_name: p.event_name,
						default_aggregation: { formula: p.default_aggregation.formula },
						customer_mapping: { event_payload_key: p.customer_mapping?.event_payload_key ?? "stripe_customer_id" },
						value_settings: { event_payload_key: p.value_settings?.event_payload_key ?? "value" },
					};
					acct.meters.push(meter);
					acct.writes.push(`meters.create ${meter.id}`);
					return Promise.resolve(meter);
				},
			},
		},
		tax: {
			settings: {
				retrieve: () => Promise.resolve(acct.tax),
				update: (p) => {
					const a = p.head_office?.address;
					acct.tax = {
						...acct.tax,
						defaults: {
							tax_code: p.defaults?.tax_code ?? acct.tax.defaults.tax_code,
							tax_behavior: p.defaults?.tax_behavior ?? acct.tax.defaults.tax_behavior,
						},
						head_office: a
							? {
									address: {
										line1: a.line1 ?? null,
										line2: a.line2 ?? null,
										city: a.city ?? null,
										postal_code: a.postal_code ?? null,
										country: a.country ?? null,
									},
								}
							: acct.tax.head_office,
					};
					acct.writes.push("tax.settings.update");
					return Promise.resolve(acct.tax);
				},
			},
		},
		billingPortal: {
			configurations: {
				list: (p) => page(acct.portals.filter((c) => p.is_default === undefined || c.is_default === p.is_default), p.limit, undefined),
				update: (cid, p) => {
					const c = acct.portals.find((x) => x.id === cid);
					if (!c) return Promise.reject(new Error(`no portal ${cid}`));
					const f = p.features;
					if (f?.customer_update) {
						const allowed = f.customer_update.allowed_updates;
						c.features.customer_update = {
							enabled: f.customer_update.enabled ?? c.features.customer_update.enabled,
							allowed_updates: Array.isArray(allowed) ? [...allowed] : [],
						};
					}
					if (f?.invoice_history) c.features.invoice_history = { enabled: f.invoice_history.enabled };
					if (f?.payment_method_update?.enabled !== undefined) {
						c.features.payment_method_update = { enabled: f.payment_method_update.enabled };
					}
					if (f?.subscription_update?.enabled !== undefined) {
						c.features.subscription_update = { enabled: f.subscription_update.enabled };
					}
					if (f?.subscription_cancel) {
						c.features.subscription_cancel = {
							enabled: f.subscription_cancel.enabled ?? c.features.subscription_cancel.enabled,
							mode: f.subscription_cancel.mode ?? c.features.subscription_cancel.mode,
						};
					}
					const bp = p.business_profile;
					if (bp) {
						c.business_profile = {
							headline: bp.headline === undefined ? c.business_profile.headline : bp.headline || null,
							privacy_policy_url: bp.privacy_policy_url ?? c.business_profile.privacy_policy_url,
							terms_of_service_url: bp.terms_of_service_url ?? c.business_profile.terms_of_service_url,
						};
					}
					acct.writes.push(`portal.update ${cid}`);
					return Promise.resolve(c);
				},
			},
		},
		webhookEndpoints: {
			list: (p) => page(acct.webhooks, p.limit, p.starting_after),
			create: (p) => {
				const w = {
					id: id("we"),
					url: p.url,
					status: "enabled",
					enabled_events: [...p.enabled_events],
					secret: FAKE_WEBHOOK_SECRET,
				};
				acct.webhooks.push(w);
				acct.writes.push(`webhooks.create ${w.id}`);
				const created: WebhookCreatedView = { ...w };
				return Promise.resolve(created);
			},
			update: (wid, p) => {
				const w = acct.webhooks.find((x) => x.id === wid);
				if (!w) return Promise.reject(new Error(`no webhook ${wid}`));
				if (p.enabled_events) w.enabled_events = [...p.enabled_events];
				if (p.disabled !== undefined) w.status = p.disabled ? "disabled" : "enabled";
				acct.writes.push(`webhooks.update ${wid}`);
				// An update never returns the secret.
				return Promise.resolve({ id: w.id, url: w.url, status: w.status, enabled_events: w.enabled_events });
			},
		},
		paymentMethodConfigurations: {
			list: (p) => page(acct.pmcs, p.limit, p.starting_after),
			update: (cid, p) => {
				const c = acct.pmcs.find((x) => x.id === cid);
				if (!c) return Promise.reject(new Error(`no payment method configuration ${cid}`));
				for (const method of ALL_PAYMENT_METHODS) {
					const preference = p[method]?.display_preference?.preference;
					const setting = c[method];
					if (preference === undefined) continue;
					// Stripe refuses a preference for a method the account does not offer.
					if (!setting) return Promise.reject(new Error(`${method} is not offered by this account`));
					if (!isPreference(preference)) return Promise.reject(new Error(`bad preference ${preference}`));
					setting.display_preference = pmSetting(preference).display_preference;
					setting.available = preference === "on";
				}
				acct.writes.push(`payment_methods.update ${cid}`);
				return Promise.resolve(c);
			},
		},
	};
}
