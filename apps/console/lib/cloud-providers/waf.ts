// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CloudProvider } from "@/lib/db/schema/enums";
import type { CloudProviderSlug } from "./generated/catalog";

/**
 * Which clouds can honor the canvas's `waf_enabled` switch — the SINGLE source of truth shared by
 * the canvas gate (`config-schema.ts`'s `waf_enabled` field), the canvas store's normalizer, and the
 * deploy-time fail-closed gate (`buildConfigSnapshot`). Modelled on `keyless.ts`: a tiny runtime-only
 * module with no client (`lucide-react`/React-Flow) imports, so the server action can import it
 * without pulling the whole canvas registry into the server bundle.
 *
 * Only Alibaba is withheld, and it is a PRODUCT decision rather than a gap (#1841) — which is why
 * this is a hand-written constant and not a generated table like `KEYLESS_CELLS`. There is nothing
 * upstream to derive it from: the reason is a statement about the alicloud provider's resource model,
 * not about a renderer flag we could add.
 */

/** Clouds where Alethia does not provision a WAF, mapped to the reason a user reads. */
const WAF_WITHHELD: Partial<Record<string, string>> = {
	// Kept in step with the `dns:waf_enabled` / alibaba entry in infra/offer-exclusions.yaml, which
	// prints its own reason verbatim into the public parity matrix. The two are worded the same on
	// purpose: a canvas that says one thing and a matrix that says another is worse than either.
	alibaba:
		"Unavailable on Alibaba Cloud. WAF 3.0 is an account-level purchase there — the provider gives no way to tell two instances apart, so a project that owned one would release the whole account's firewall when it was destroyed. Buy a WAF 3.0 instance in your account and put it in front of your ingress from the WAF console.",
	// Hetzner is NOT listed, and that is a scope boundary rather than a judgement that its cell is
	// different. `dns:waf_enabled` / hetzner is an equally real documented exclusion whose canvas
	// switch is equally ungated today — a pre-existing gap this table is the right home for. It is
	// left alone here because #1841 withdrew Alibaba's offer specifically, and adding hetzner would
	// make the deploy gate below start refusing live Hetzner projects that already carry
	// `waf_enabled: true`. That is a real break and belongs to whoever picks the hetzner cell up,
	// with its own decision about migrating those rows.
};

/** Why this cloud cannot honor the application WAF switch, or null when it can.
 *
 * A null provider returns null — "no cloud picked yet" is not a refusal, and the field carries
 * `requiresProvider` so the inspector already tells the user to pick one. One case, one owner. */
export function wafUnavailableReason(
	provider: CloudProviderSlug | null,
): string | null {
	if (!provider) return null;
	return WAF_WITHHELD[provider] ?? null;
}

/**
 * The server-side sibling, taking the full generated `cloud_provider` enum.
 *
 * Unlike `keylessUnavailableReasonForCloud`, a cloud absent from the table is ALLOWED rather than
 * refused. The directions differ because the risks do: keyless is a security setting, where an
 * unknown cloud must fail closed, whereas this gate exists to stop a canvas switch making a false
 * promise. Refusing every connect-only cloud here would block deploys over a switch that is simply
 * not withheld for them.
 */
export function wafUnavailableReasonForCloud(
	provider: CloudProvider,
): string | null {
	return WAF_WITHHELD[provider] ?? null;
}

/**
 * Force `waf_enabled` off on a cloud that cannot honor it; returns the config untouched otherwise.
 *
 * The canvas gate is display-only — `unavailableWhen` filters the RENDER, and nothing in the store,
 * the graph→form projection or the server actions reacts. Without this, a project designed on AWS
 * with the WAF on and then re-placed on Alibaba carries `waf_enabled: true` into the config
 * snapshot, the deployment payload, the clone path and env promotions, with a disabled toggle
 * reading "off" above it. That is the exact gap #1510 closed for `iam_auth`, in the same store.
 */
export function normalizeWafEnabled<C extends { waf_enabled?: boolean | null }>(
	config: C,
	provider: CloudProviderSlug | null,
): C {
	if (!config.waf_enabled) return config;
	return wafUnavailableReason(provider) ? { ...config, waf_enabled: false } : config;
}
