// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Which pluggable connector an ENVIRONMENT uses for a category.
//
// `provider` is a per-row column on every component table, but for `secrets` and `registry` the
// runtime is per-environment: `categories.dominantProvider` (packages/core/categories/compose.go)
// takes the FIRST pluggable row's slug and applies it to the whole category, and the matching
// `*ProviderConfig` helper takes the knobs from the first row carrying that slug and discards the
// rest. So a per-row choice is not something the backend can honour — one environment reads through
// one store, and pushes through one registry.
//
// The console therefore presents ONE choice per environment and writes it to every row, so the
// database says exactly what the deploy will do and the dominance rule becomes a no-op instead of a
// silent collapse. This module is the shared reading of that state, so the picker (env settings) and
// the readouts (collection panel, cards) can never disagree.
//
// DNS is deliberately NOT here: it is a true singleton (`unique(project_id, environment_id)`), so
// its provider lives on its one row and needs no dominance modelling.

import { toRecord } from "@/lib/coerce";
import { getConnectorProviderBySlug } from "@/lib/connectors/registry.generated";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import type { NodeKind } from "@/components/design-project/canvas/graph/types";

/** How "no connector — the cluster cloud's own" reads for each category. */
export const NATIVE_LABELS = {
	secret: "Cluster native",
	registry: "Cloud native",
} as const;

export interface EnvironmentConnector {
	/** The selected connector slug, or null for the cluster cloud's native service. */
	provider: string | null;
	/** The selected provider's non-secret knobs. */
	providerConfig: Record<string, unknown>;
	/** How many rows of this kind the environment has — 0 means no row can carry a choice. */
	count: number;
}

/**
 * The environment's connector for a node kind, read off its nodes.
 *
 * The rows agree by construction (the picker writes through to all of them), but a project
 * configured before this control existed — or through the CLI, which can set `provider` but not
 * `provider_config` — may disagree. Resolve that the same way the RUNTIME does: first pluggable row
 * wins. Showing anything else would mean the console and the deploy disagree about what is
 * configured, which is the failure this surface exists to remove.
 */
export function environmentConnector(
	nodes: CanvasNode[],
	kind: NodeKind,
): EnvironmentConnector {
	const rows = nodes.filter((n) => n.data.kind === kind);
	for (const node of rows) {
		const config = toRecord(node.data.config);
		const provider = typeof config.provider === "string" ? config.provider : "";
		// "" and "native" both mean the cloud's own service — IsPluggable treats them identically.
		if (!provider || provider === "native") continue;
		return {
			provider,
			providerConfig: toRecord(config.provider_config),
			count: rows.length,
		};
	}
	return { provider: null, providerConfig: {}, count: rows.length };
}

/** The connector's display name, or the category's native label. */
export function connectorLabel(provider: string | null, nativeLabel: string): string {
	if (!provider || provider === "native") return nativeLabel;
	return getConnectorProviderBySlug(provider)?.name ?? provider;
}

/**
 * Knobs on `project_container_registries.provider_config` that describe the CLOUD's registry
 * (ECR / Artifact Registry / ACR), not any connector.
 *
 * They are genuinely PER ROW — one registry can have immutable tags while another doesn't — but the
 * provider is per environment, so the picker writes through to every row. Without preserving these,
 * choosing a provider would replace each row's whole bag and silently flatten those settings, with
 * no way to get them back. Registry is the only category where `provider_config` mixes per-row cloud
 * settings with per-environment connector knobs.
 */
const NATIVE_REGISTRY_KNOBS = ["immutable_tags", "vulnerability_scanning"] as const;

/** A row's own cloud-registry settings, to carry across an environment-level provider change. */
export function nativeRegistryKnobs(
	providerConfig: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of NATIVE_REGISTRY_KNOBS) {
		if (key in providerConfig) out[key] = providerConfig[key];
	}
	return out;
}

/** Whether a slug names a pluggable connector rather than the cloud's own service. */
export function isPluggable(provider: unknown): provider is string {
	return typeof provider === "string" && provider !== "" && provider !== "native";
}

// ── per-category "connectable but it won't work" reasons ──────────────────────────────────────

/**
 * Secret stores that are connectable but cannot serve secrets to a cluster.
 *
 * Both are `status: active` with a working credential flow, but neither has a first-class ESO
 * runtime-read path on the pinned external-secrets chart — see
 * packages/core/categories/provider.go IsSaaSSecretStore. Selecting one is WORSE than doing nothing:
 * it flips `secrets_provider` off "native", so every per-cloud custom_secrets.tf stops creating the
 * native secrets, while no ClusterSecretStore renders to read from instead.
 */
const SECRETS_NO_RUNTIME_READ: Record<string, string> = {
	infisical: "no in-cluster read yet",
	onepassword: "no in-cluster read yet",
};

/** Why this secret store can't be selected, or null when it can. */
export function secretsStoreUnavailable(slug: string): string | null {
	return SECRETS_NO_RUNTIME_READ[slug] ?? null;
}

/**
 * Why this registry can't be selected, or null when it can.
 *
 * The cross-account (`*-xacct`) registries are `coming_soon` AND dark-flagged behind
 * ALETHIA_XACCT_REGISTRY_ENABLED (packages/core/provisioner/manifests_gen.go). With the flag off —
 * the default — selecting one still sets `registry_pull_provider`, so the pull IRSA/GSA/UAMI IS
 * provisioned in tofu, while no refresher renders and no pull secret ever exists. That half-built
 * state is worse than the secrets case, so say so rather than letting it be chosen.
 *
 * `ConnectorSelect` already filters `coming_soon` out of the list, so this is belt-and-braces for
 * the day they flip to active while the runtime flag is still off.
 */
export function registryUnavailable(slug: string): string | null {
	return slug.endsWith("-xacct") ? "not enabled yet" : null;
}
