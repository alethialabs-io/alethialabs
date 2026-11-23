// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Read-only check that a Stripe account matches the catalog (EA-6, #7322). It makes no change.
//
//   pnpm creds stripe-test -- pnpm -C apps/console run stripe:check
//   pnpm creds stripe-live -- pnpm -C apps/console run stripe:check -- --live \
//     --webhook-url=https://alethialabs.io/api/webhooks/stripe [--json]
//
// It reports the mode, the account (id, name, country, charges_enabled, payouts_enabled), the tax
// settings status and head office, each product's tax code, each price, the default Customer Portal
// settings (with its headline), the default payment method configuration (which methods are set on,
// and which of those are available at checkout), and every webhook endpoint with its events. Each line is `key: value`, so EA-8's evidence strings can cite it; `--json` prints the
// same report as one JSON object. Exit 0 when the account matches stripe-setup's desired state
// (the setup plan is empty), 1 when it does not, 2 on a usage error.
//
// A live key is refused unless `--live` is given, the same rule as stripe-setup.

import { pathToFileURL } from "node:url";
import Stripe from "stripe";
import {
	ALL_PAYMENT_METHODS,
	type AccountView,
	computePlan,
	DESIRED_PRICES,
	DESIRED_PRODUCTS,
	describeAccount,
	formatPlan,
	listAll,
	type Mode,
	modeRefusal,
	type PaymentMethodConfigView,
	readState,
	resolveKey,
	type StripeClient,
	type StripeKeyEnv,
	WEBHOOK_EVENTS,
	type WebhookView,
} from "./stripe-setup";

/** One webhook endpoint as the report shows it. */
export interface WebhookReport {
	id: string;
	url: string;
	status: string;
	events: string[];
	/** True when its events are exactly WEBHOOK_EVENTS. */
	matchesHandler: boolean;
}

/** Everything the check found. */
export interface CheckReport {
	mode: Mode;
	account: {
		id: string;
		name: string;
		country: string | null;
		chargesEnabled: boolean;
		payoutsEnabled: boolean;
		detailsSubmitted: boolean;
	};
	tax: {
		status: string;
		missingFields: string[];
		defaultTaxCode: string | null;
		defaultTaxBehavior: string | null;
		headOffice: string | null;
	};
	products: { tag: string; id: string | null; taxCode: string | null }[];
	prices: { envVar: string; lookupKey: string; id: string | null; taxBehavior: string | null }[];
	portal: {
		id: string;
		customerUpdates: string[];
		invoiceHistory: boolean;
		paymentMethodUpdate: boolean;
		subscriptionUpdate: boolean;
		subscriptionCancel: string;
		headline: string | null;
	} | null;
	paymentMethods: {
		id: string;
		/** Methods whose account preference is `on`, sorted. */
		on: string[];
		/** Methods Stripe can offer at checkout now (preference on AND capability active), sorted. */
		available: string[];
	} | null;
	webhooks: WebhookReport[];
	/** stripe-setup's plan against this account; empty actions and errors means it matches. */
	plan: string[];
	matches: boolean;
}

/** The methods a configuration sets on, and those of them Stripe can offer at checkout now. */
function paymentMethodsOf(cfg: PaymentMethodConfigView): NonNullable<CheckReport["paymentMethods"]> {
	const on: string[] = [];
	const available: string[] = [];
	for (const method of ALL_PAYMENT_METHODS) {
		const setting = cfg[method];
		if (setting?.display_preference.preference === "on") on.push(method);
		if (setting?.available) available.push(method);
	}
	return { id: cfg.id, on, available };
}

/** The account's display name. */
function accountName(a: AccountView): string {
	return a.settings?.dashboard.display_name ?? a.business_profile?.name ?? a.company?.name ?? "(no name)";
}

/**
 * Reads the account and compares it to stripe-setup's desired state. Read-only. A webhook endpoint
 * counts toward `matches` when `webhookUrl` is given (that endpoint must exist with exactly the
 * handler's events); every endpoint is reported either way.
 */
export async function runCheck(
	client: StripeClient,
	mode: Mode,
	webhookUrl: string | undefined,
): Promise<CheckReport> {
	const account = await client.accounts.retrieveCurrent();
	const obs = await readState(client, webhookUrl);
	const plan = computePlan(obs);

	const endpoints: WebhookView[] = await listAll((after) =>
		client.webhookEndpoints.list({ limit: 100, ...(after ? { starting_after: after } : {}) }),
	);
	const want = [...WEBHOOK_EVENTS].sort().join(",");
	const webhooks = endpoints.map((w) => ({
		id: w.id,
		url: w.url,
		status: w.status,
		events: [...w.enabled_events].sort(),
		matchesHandler: [...w.enabled_events].sort().join(",") === want,
	}));

	const ho = obs.tax.head_office?.address;
	const portal = obs.portal;
	return {
		mode,
		account: {
			id: account.id,
			name: accountName(account),
			country: account.country ?? null,
			chargesEnabled: account.charges_enabled,
			payoutsEnabled: account.payouts_enabled,
			detailsSubmitted: account.details_submitted,
		},
		tax: {
			status: obs.tax.status,
			missingFields: obs.tax.status_details.pending?.missing_fields ?? [],
			defaultTaxCode: obs.tax.defaults.tax_code,
			defaultTaxBehavior: obs.tax.defaults.tax_behavior,
			headOffice: ho
				? [ho.line1, ho.line2, `${ho.postal_code ?? ""} ${ho.city ?? ""}`.trim(), ho.country].filter(Boolean).join(", ")
				: null,
		},
		products: DESIRED_PRODUCTS.map((d) => {
			const p = obs.products.get(d.tag)?.[0];
			const tc = p?.tax_code ?? null;
			return { tag: d.tag, id: p?.id ?? null, taxCode: typeof tc === "string" || tc === null ? tc : tc.id };
		}),
		prices: DESIRED_PRICES.map((d) => {
			const p = obs.prices.get(d.lookupKey) ?? null;
			return { envVar: d.envVar, lookupKey: d.lookupKey, id: p?.id ?? null, taxBehavior: p?.tax_behavior ?? null };
		}),
		portal: portal
			? {
					id: portal.id,
					customerUpdates: portal.features.customer_update.enabled
						? [...portal.features.customer_update.allowed_updates].sort()
						: [],
					invoiceHistory: portal.features.invoice_history.enabled,
					paymentMethodUpdate: portal.features.payment_method_update.enabled,
					subscriptionUpdate: portal.features.subscription_update.enabled,
					subscriptionCancel: portal.features.subscription_cancel.enabled
						? portal.features.subscription_cancel.mode
						: "off",
					headline: portal.business_profile.headline,
				}
			: null,
		paymentMethods: obs.paymentMethods ? paymentMethodsOf(obs.paymentMethods) : null,
		webhooks,
		plan: formatPlan(plan),
		matches: plan.actions.length === 0 && plan.errors.length === 0,
	};
}

/** The report as `key: value` lines. */
export function formatCheck(r: CheckReport): string[] {
	const yes = (b: boolean) => (b ? "yes" : "no");
	const lines = [
		`mode: ${r.mode}`,
		`account.id: ${r.account.id}`,
		`account.name: ${r.account.name}`,
		`account.country: ${r.account.country ?? "(unknown)"}`,
		`account.charges_enabled: ${yes(r.account.chargesEnabled)}`,
		`account.payouts_enabled: ${yes(r.account.payoutsEnabled)}`,
		`account.details_submitted: ${yes(r.account.detailsSubmitted)}`,
		`tax.status: ${r.tax.status}${r.tax.missingFields.length ? ` (missing: ${r.tax.missingFields.join(", ")})` : ""}`,
		`tax.default_tax_code: ${r.tax.defaultTaxCode ?? "(none)"}`,
		`tax.default_tax_behavior: ${r.tax.defaultTaxBehavior ?? "(none)"}`,
		`tax.head_office: ${r.tax.headOffice ?? "(none)"}`,
	];
	for (const p of r.products) lines.push(`product.${p.tag}: ${p.id ?? "(missing)"} tax_code=${p.taxCode ?? "(none)"}`);
	for (const p of r.prices) {
		lines.push(`price.${p.lookupKey}: ${p.id ?? "(missing)"} tax_behavior=${p.taxBehavior ?? "(none)"} (${p.envVar})`);
	}
	if (r.portal) {
		lines.push(
			`portal.id: ${r.portal.id}`,
			`portal.customer_updates: ${r.portal.customerUpdates.join(",") || "(none)"}`,
			`portal.invoice_history: ${yes(r.portal.invoiceHistory)}`,
			`portal.payment_method_update: ${yes(r.portal.paymentMethodUpdate)}`,
			`portal.subscription_update: ${yes(r.portal.subscriptionUpdate)}`,
			`portal.subscription_cancel: ${r.portal.subscriptionCancel}`,
			`portal.headline: ${r.portal.headline ?? "(none)"}`,
		);
	} else {
		lines.push("portal: (no default configuration)");
	}
	if (r.paymentMethods) {
		lines.push(
			`payment_methods.id: ${r.paymentMethods.id}`,
			`payment_methods.on: ${r.paymentMethods.on.join(",") || "(none)"}`,
			`payment_methods.available: ${r.paymentMethods.available.join(",") || "(none)"}`,
		);
	} else {
		lines.push("payment_methods: (no default configuration)");
	}
	if (!r.webhooks.length) lines.push("webhook: (none)");
	for (const w of r.webhooks) {
		lines.push(
			`webhook.${w.id}: ${w.url} status=${w.status} events=${w.events.length} matches_handler=${yes(w.matchesHandler)}`,
		);
	}
	lines.push(...r.plan, `matches_catalog: ${yes(r.matches)}`);
	return lines;
}

/** Runs the check; returns the process exit code. */
export async function runCheckCli(
	argv: string[],
	env: StripeKeyEnv,
	makeClient: (key: string) => StripeClient,
	log: (line: string) => void,
): Promise<number> {
	let live = false;
	let json = false;
	let webhookUrl: string | undefined;
	for (const a of argv) {
		if (a === "--") continue;
		else if (a === "--live") live = true;
		else if (a === "--json") json = true;
		else if (a.startsWith("--webhook-url=")) webhookUrl = a.slice("--webhook-url=".length);
		else {
			log(`✗ Unknown argument: ${a}`);
			return 2;
		}
	}
	const key = resolveKey(env);
	if (!key.ok) {
		log(`✗ ${key.error}`);
		return 2;
	}
	const refusal = modeRefusal(key.mode, live);
	if (refusal) {
		log(`✗ ${refusal}`);
		return 2;
	}
	const client = makeClient(key.key);
	// The target account is printed before anything else is read (in JSON it is the `account` field).
	if (!json) log(`→ ${describeAccount(await client.accounts.retrieveCurrent(), key.mode)}`);
	const report = await runCheck(client, key.mode, webhookUrl);
	if (json) log(JSON.stringify(report, null, 2));
	else for (const line of formatCheck(report)) log(line);
	return report.matches ? 0 : 1;
}

/** True when this file is the entry point. */
function isEntryPoint(): boolean {
	const entry = process.argv[1];
	return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntryPoint()) {
	runCheckCli(
		process.argv.slice(2),
		process.env,
		(key) => new Stripe(key, { appInfo: { name: "Alethia stripe-check" } }),
		(line) => console.log(line),
	)
		.then((code) => process.exit(code))
		.catch((err: unknown) => {
			console.error(`✗ stripe-check failed: ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		});
}
