// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CloudProvider } from "@/lib/db/schema/enums";
import type { CloudProviderSlug, EngineFamily } from "./generated/catalog";
import { KEYLESS_CELLS } from "./generated/keyless-cells";

/**
 * Which cloud × engine cells can honor keyless database auth — the SINGLE source of truth shared by
 * the canvas gate (`config-schema.ts`'s `iam_auth` field), the canvas store's normalizer, and the
 * deploy-time fail-closed gate (`buildConfigSnapshot`). Modelled on `unsupported-kinds.ts`: a tiny
 * runtime-only module with no client (`lucide-react`/React-Flow) imports, so the server action can
 * import it without pulling the whole canvas registry into the server bundle.
 *
 * The table itself is GENERATED from `packages/core/manifests/keyless.go`, the renderer that decides
 * whether a keyless binding renders a proxy or fails closed. That direction matters: the question the
 * canvas must answer is "will turning this on produce a working keyless database?", which is a claim
 * about what WE built, not about what the cloud sells. GCP MySQL keyless was unbuildable until #1505
 * purely because our renderer lacked a flag — a catalog-shaped answer would have told the user Google
 * couldn't do it, which is a lie that outlives the fix.
 */

/** The engine family a database config is on, normalizing the legacy concrete `engine` column.
 *
 * `engine_family` and `engine` are both nullable `text()` — there is no `db_engine` pgEnum — and a row
 * with neither set has always meant Postgres (the Go resolver's `dbEngineForName` agrees). This is the
 * one place that decision is written down; `engineLabel` and `dbEngineLabel` both defer to it. */
export function dbEngineFamily(config: {
	engine_family?: string | null;
	engine?: string | null;
}): EngineFamily {
	if (config.engine_family === "mysql") return "mysql";
	if (config.engine_family === "postgres") return "postgres";
	return typeof config.engine === "string" && config.engine.includes("mysql")
		? "mysql"
		: "postgres";
}

/** Why this cloud × engine cell cannot honor keyless database auth, or null when it can.
 *
 * A null provider returns null — "no cloud picked yet" is not a refusal, and the field carries
 * `requiresProvider` so the inspector already tells the user to pick one. One case, one owner. */
export function keylessUnavailableReason(
	provider: CloudProviderSlug | null,
	family: EngineFamily,
): string | null {
	if (!provider) return null;
	const cell = KEYLESS_CELLS[provider][family];
	return cell.state === "live" ? null : (cell.reason ?? null);
}

/** The server-side sibling, taking the full generated `cloud_provider` enum.
 *
 * A cloud with no cell at all — a connect-only value like digitalocean/civo, which has no project
 * template — is REFUSED, not allowed. The canvas's null means "no cloud picked yet"; a cloud that is
 * picked but absent from the table is the fail-open direction, and this is a security setting. */
export function keylessUnavailableReasonForCloud(
	provider: CloudProvider,
	family: EngineFamily,
): string | null {
	const byProvider: Partial<
		Record<string, Record<EngineFamily, { state: string; reason?: string }>>
	> = KEYLESS_CELLS;
	const cell = byProvider[provider]?.[family];
	if (!cell) {
		return `Keyless database auth is not available on ${provider}.`;
	}
	return cell.state === "live" ? null : (cell.reason ?? null);
}

/**
 * Force `iam_auth` off on a cell that cannot honor it; returns the config untouched otherwise.
 *
 * The canvas gate alone is display-only — `visibleWhen`/`unavailableWhen` filter the RENDER, and
 * nothing in the store, the graph→form projection or the server actions reacts. So enabling keyless
 * on AWS and then re-placing the node on Hetzner used to carry `iam_auth: true` all the way into the
 * deployed config snapshot. This is what makes the disabled toggle's "off" truthful rather than a
 * display trick; the deploy gate is still the authority, and it THROWS rather than coercing.
 */
export function normalizeKeylessAuth<
	C extends {
		iam_auth?: boolean | null;
		engine_family?: string | null;
		engine?: string | null;
	},
>(config: C, provider: CloudProviderSlug | null): C {
	if (!config.iam_auth) return config;
	const reason = keylessUnavailableReason(provider, dbEngineFamily(config));
	return reason ? { ...config, iam_auth: false } : config;
}
