// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Where an ENVIRONMENT reads its secrets from.
//
// `project_secrets.provider` is a per-row column, but the runtime is per-environment: at deploy,
// `categories.dominantProvider` takes the FIRST pluggable row's slug and applies it to every secret,
// and `secretsProviderConfig` takes `provider_config` from the first row carrying that slug and
// discards the rest. So a per-secret choice is not a thing the backend can honour — one environment
// reads through one store.
//
// The console therefore presents ONE choice per environment and writes it to every secret row, so
// the database says exactly what the deploy will do and the dominance rule becomes a no-op instead
// of a silent collapse. These helpers are the shared reading of that state, so the picker (env
// settings) and the readout (the Secrets panel) can never disagree about the current store.

import { toRecord } from "@/lib/coerce";
import { getConnectorProviderBySlug } from "@/lib/connectors/registry.generated";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";

/** How the cluster's own secret store reads in the UI. */
export const NATIVE_SECRETS_LABEL = "Cluster native";

/** Secret stores that are connectable but cannot actually serve secrets to a cluster. */
const NO_RUNTIME_READ: Record<string, string> = {
	// Both are `status: active` and have a working credential flow, but neither has a first-class ESO
	// runtime-read path on the pinned external-secrets chart (0.9.12) — see
	// packages/core/categories/provider.go IsSaaSSecretStore. Selecting one is worse than doing
	// nothing: it flips `secrets_provider` off "native", so every per-cloud custom_secrets.tf stops
	// creating the native secrets, while no ClusterSecretStore renders to read from instead. Every
	// secret binding is then reported unsatisfiable at deploy.
	infisical: "no in-cluster read yet",
	onepassword: "no in-cluster read yet",
};

/** Why this store can't be selected, or null when it can. */
export function secretsStoreUnavailable(slug: string): string | null {
	return NO_RUNTIME_READ[slug] ?? null;
}

export interface EnvironmentSecretsStore {
	/** The selected connector slug, or null for the cluster's native store. */
	provider: string | null;
	/** The selected provider's non-secret knobs. */
	providerConfig: Record<string, unknown>;
	/** How many secrets this environment has — 0 means there is no row to carry a choice. */
	secretCount: number;
}

/**
 * The environment's secret store, read off its secret nodes.
 *
 * The rows agree by construction (the picker writes through to all of them), but a project
 * configured before this control existed — or through the CLI, which can set `provider` but not
 * `provider_config` — may disagree. Resolve that the same way the RUNTIME does: first pluggable row
 * wins. Showing anything else would mean the console and the deploy disagree about what is
 * configured, which is the failure this whole surface exists to remove.
 */
export function environmentSecretsStore(nodes: CanvasNode[]): EnvironmentSecretsStore {
	const secrets = nodes.filter((n) => n.data.kind === "secret");
	for (const node of secrets) {
		const config = toRecord(node.data.config);
		const provider = typeof config.provider === "string" ? config.provider : "";
		// "" and "native" both mean the cluster's own store — IsPluggable treats them identically.
		if (!provider || provider === "native") continue;
		return {
			provider,
			providerConfig: toRecord(config.provider_config),
			secretCount: secrets.length,
		};
	}
	return { provider: null, providerConfig: {}, secretCount: secrets.length };
}

/** The store's display name — the connector's own name, or the native label. */
export function secretsStoreLabel(provider: string | null): string {
	if (!provider || provider === "native") return NATIVE_SECRETS_LABEL;
	return getConnectorProviderBySlug(provider)?.name ?? provider;
}
