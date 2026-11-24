// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Read-only check that a Paddle account matches the catalog (Paddle Billing plan, lane L2). It
// makes no change.
//
//   pnpm creds paddle-sandbox -- pnpm -C apps/console run paddle:check
//   pnpm creds paddle-live -- pnpm -C apps/console run paddle:check -- --live \
//     --webhook-url=<the console Paddle webhook URL, lane L3 route> [--json]
//
// It reports the environment, each tagged product with its tax category, each catalog price with
// its amounts, and every notification destination with whether its events are exactly
// PADDLE_WEBHOOK_EVENTS. Each line is `key: value`; `--json` prints the same report as one JSON
// object. Exit 0 when the account matches paddle-setup's desired state (the setup plan is empty),
// 1 when it does not, 2 on a usage error. A live key is refused unless `--live` is given.

import { pathToFileURL } from "node:url";
import {
	catalogEnvLines,
	computePlan,
	createPaddleClient,
	DESIRED_PRICES,
	DESIRED_PRODUCTS,
	describeTarget,
	environmentRefusal,
	formatPlan,
	PADDLE_WEBHOOK_EVENTS,
	type PaddleClient,
	type PaddleEnvironment,
	type PaddleKeyEnv,
	priceDrift,
	readState,
	resolveKey,
} from "./paddle-setup";

/** One notification destination as the report shows it. */
export interface DestinationReport {
	id: string;
	type: string;
	destination: string;
	active: boolean;
	events: string[];
	/** True when its events are exactly PADDLE_WEBHOOK_EVENTS. */
	matchesHandler: boolean;
}

/** Everything the check found. */
export interface CheckReport {
	environment: PaddleEnvironment;
	products: { tag: string; id: string | null; taxCategory: string | null }[];
	prices: {
		envVar: string;
		key: string;
		/** The active price that matches the catalog, or null. */
		id: string | null;
		usd: string | null;
		eur: string | null;
		/** Active prices carrying the key (more than one is drift). */
		active: number;
	}[];
	destinations: DestinationReport[];
	/** The env lines paddle-setup prints for this account. */
	env: string[];
	/** paddle-setup's plan against this account; empty actions and errors means it matches. */
	plan: string[];
	matches: boolean;
}

/**
 * Reads the account and compares it to paddle-setup's desired state. Read-only. A destination
 * counts toward `matches` when `webhookUrl` is given; every destination is reported either way.
 */
export async function runCheck(
	client: PaddleClient,
	environment: PaddleEnvironment,
	webhookUrl: string | undefined,
): Promise<CheckReport> {
	const obs = await readState(client, webhookUrl);
	const plan = computePlan(obs);
	const want = [...PADDLE_WEBHOOK_EVENTS].sort().join(",");
	const destinations = (await client.listNotificationSettings()).map((n) => {
		const events = n.subscribed_events.map((e) => e.name).sort();
		return {
			id: n.id,
			type: n.type,
			destination: n.destination,
			active: n.active,
			events,
			matchesHandler: events.join(",") === want,
		};
	});
	const productIdOf = (tag: string) => obs.products.get(tag)?.[0]?.id ?? null;
	return {
		environment,
		products: DESIRED_PRODUCTS.map((d) => {
			const p = obs.products.get(d.tag)?.[0];
			return { tag: d.tag, id: p?.id ?? null, taxCategory: p?.tax_category ?? null };
		}),
		prices: DESIRED_PRICES.map((d) => {
			const active = obs.prices.get(d.key) ?? [];
			const match = active.find((p) => priceDrift(p, d, productIdOf(d.productTag)).length === 0) ?? null;
			const shown = match ?? active[0] ?? null;
			const eur = shown?.unit_price_overrides.find((o) => o.unit_price.currency_code === "EUR");
			return {
				envVar: d.envVar,
				key: d.key,
				id: match?.id ?? null,
				usd: shown ? `${shown.unit_price.amount} ${shown.unit_price.currency_code}` : null,
				eur: eur ? `${eur.unit_price.amount} EUR × ${eur.country_codes.length} countries` : null,
				active: active.length,
			};
		}),
		destinations,
		env: catalogEnvLines(obs),
		plan: formatPlan(plan),
		matches: plan.actions.length === 0 && plan.errors.length === 0,
	};
}

/** The report as `key: value` lines. */
export function formatCheck(r: CheckReport): string[] {
	const yes = (b: boolean) => (b ? "yes" : "no");
	const lines = [`environment: ${r.environment}`];
	for (const p of r.products) lines.push(`product.${p.tag}: ${p.id ?? "(missing)"} tax_category=${p.taxCategory ?? "(none)"}`);
	for (const p of r.prices) {
		lines.push(
			`price.${p.key}: ${p.id ?? "(missing)"} usd=${p.usd ?? "(none)"} eur=${p.eur ?? "(none)"} active=${p.active} (${p.envVar})`,
		);
	}
	if (!r.destinations.length) lines.push("notification_destination: (none)");
	for (const d of r.destinations) {
		lines.push(
			`notification_destination.${d.id}: ${d.type} ${d.destination} active=${yes(d.active)} events=${d.events.length} matches_handler=${yes(d.matchesHandler)}`,
		);
	}
	lines.push(...r.env.map((l) => `env: ${l}`), ...r.plan, `matches_catalog: ${yes(r.matches)}`);
	return lines;
}

/** Runs the check; returns the process exit code. */
export async function runCheckCli(
	argv: string[],
	env: PaddleKeyEnv,
	makeClient: (key: string, environment: PaddleEnvironment) => PaddleClient,
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
	const refusal = environmentRefusal(key.environment, live);
	if (refusal) {
		log(`✗ ${refusal}`);
		return 2;
	}
	// The target environment is printed before anything is read (in JSON it is the `environment` field).
	if (!json) log(`→ ${describeTarget(key.environment)}`);
	const report = await runCheck(makeClient(key.key, key.environment), key.environment, webhookUrl);
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
		(key, environment) => createPaddleClient(key, environment),
		(line) => console.log(line),
	)
		.then((code) => process.exit(code))
		.catch((err: unknown) => {
			console.error(`✗ paddle-check failed: ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		});
}
