// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Where a chart-repo connector's HOST comes from, per provider slug.
//
// `connector_credentials` stores the secret bag only — a connector has no org-level host. For the
// fixed-host providers (ghcr, Docker Hub) the host is hardcoded in the Go provider; for the "any
// host" providers (generic / Scaleway / self-hosted GitLab) it can only come from the project's
// `provider_config.registry_host`; and `helm-https` is addressed by a whole `https://` URL. Those
// three shapes are what the rules below encode.
//
// The rules mirror each provider's `RepoCred` in packages/core/categories/helm_registry_*.go — that
// Go code builds the ArgoCD repository-credential URL, and the URL shown in the console must be the
// same string, since ArgoCD matches an Application to a credential by repoURL prefix.

import type { HelmRegistryProviderConfig } from "@/types/jsonb.types";

/**
 * One chart-repo selection. Declared structurally rather than as
 * `ProjectFormData["helm_registries"][number]` so this module has NO dependency on the form schema —
 * the schema imports the rules below for its own refinement, and a cycle between the two would be a
 * trap for whoever touches either next. Structurally identical to the form item.
 */
export interface HelmRegistryItem {
	name: string;
	provider?: string | null;
	provider_config?: HelmRegistryProviderConfig;
}

/** How a chart-repo provider's effective host is determined. */
interface HelmRegistryHostRule {
	/** False for the classic HTTPS index.yaml repo — it is never addressed as `oci://`. */
	oci: boolean;
	/** Host baked into the Go provider (ghcr.io, registry-1.docker.io) — an exact match. */
	fixedHost?: string;
	/** Other spellings of the same registry a chart URL may legitimately use. */
	hostAliases?: string[];
	/** Host used when `provider_config.registry_host` is unset. */
	defaultHost?: string;
	/** The `provider_config` key that carries the host/URL. */
	configKey?: "registry_host" | "repo_url";
	/** Serves ANY host — the host comes from the chart URL and is written to `configKey`. */
	wildcard?: boolean;
	/** Suffixes that make this wildcard provider the obvious choice for a host. */
	hostSuffixes?: string[];
	/** `coming_soon` in the catalog — never derived, never selectable. */
	comingSoon?: boolean;
}

/**
 * Per-slug host rules. Deliberately hand-written: the catalog (`registry.generated.ts`) knows a
 * provider's fields but NOT its host — that lives in the Go `RepoCred` implementations. A test
 * asserts every catalogued `helm_registry` slug has a rule here, so a new provider can't land
 * without one.
 */
export const HELM_REGISTRY_HOST_RULES: Record<string, HelmRegistryHostRule> = {
	// Classic Helm repository (index.yaml) — the URL is the whole `https://…`, so nothing about it
	// can be inferred from an `oci://` chart reference. Always chosen explicitly.
	"helm-https": { oci: false, configKey: "repo_url" },
	"oci-docker-hub": {
		oci: true,
		fixedHost: "registry-1.docker.io",
		hostAliases: ["docker.io", "index.docker.io"],
	},
	"oci-github-cr": { oci: true, fixedHost: "ghcr.io" },
	// GitLab defaults to gitlab.com but accepts a self-hosted host. Matched as a FIXED host at its
	// default only: treating it as a second wildcard would make every self-hosted registry ambiguous
	// with the generic provider. A self-hosted GitLab registry is an explicit pick.
	"oci-gitlab-cr": {
		oci: true,
		defaultHost: "registry.gitlab.com",
		configKey: "registry_host",
	},
	"oci-generic-cr": { oci: true, wildcard: true, configKey: "registry_host" },
	"oci-scaleway-cr": {
		oci: true,
		wildcard: true,
		configKey: "registry_host",
		hostSuffixes: [".scw.cloud"],
	},
	// Ephemeral 12h tokens, no stable stored password — a documented exclusion, not an oversight.
	"oci-ecr": { oci: true, comingSoon: true },
	"oci-public-ecr": { oci: true, comingSoon: true },
};

/** Whether a chart-repo provider can be selected today (the ECR rows are `coming_soon`). */
export function isSelectableHelmRegistry(slug: string | null | undefined): boolean {
	if (!slug) return false;
	const rule = HELM_REGISTRY_HOST_RULES[slug];
	return Boolean(rule) && !rule.comingSoon;
}

/** The registry host of an `oci://<host>/<ns>/<chart>` reference; null for anything else. */
export function ociHostOf(chartRepo: string | null | undefined): string | null {
	if (!chartRepo?.startsWith("oci://")) return null;
	const host = chartRepo.slice("oci://".length).split("/").filter(Boolean)[0];
	return host ? host.toLowerCase() : null;
}

/**
 * The ArgoCD repository-credential URL a selection resolves to — the same string
 * `packages/core/categories/helm_registry_*.go` seeds, so what the inspector shows is what ArgoCD
 * prefix-matches. Empty when the row is not yet configured.
 */
export function helmRegistryUrl(
	item: Pick<HelmRegistryItem, "provider" | "provider_config">,
): string {
	const rule = item.provider ? HELM_REGISTRY_HOST_RULES[item.provider] : undefined;
	if (!rule) return "";
	if (!rule.oci) return item.provider_config?.repo_url ?? "";
	const host =
		rule.fixedHost ?? item.provider_config?.registry_host ?? rule.defaultHost ?? "";
	return host ? `oci://${host}` : "";
}

/**
 * Whether a selection would serve `host` — i.e. whether a chart at `oci://<host>/…` can authenticate
 * through it. Used to tell someone attaching a private OCI chart whether any chart repo they have
 * configured actually covers the host they typed, instead of letting them find out at deploy.
 */
export function helmRegistryServesHost(
	item: Pick<HelmRegistryItem, "provider" | "provider_config">,
	host: string,
): boolean {
	const rule = item.provider ? HELM_REGISTRY_HOST_RULES[item.provider] : undefined;
	if (!rule?.oci) return false;
	const needle = host.toLowerCase();
	if (ociHostOf(helmRegistryUrl(item)) === needle) return true;
	// An alias is the same registry under another name (docker.io ↔ registry-1.docker.io), so a
	// selection that resolves to the canonical host still serves a chart addressed by the alias.
	return (rule.hostAliases ?? []).includes(needle) && Boolean(rule.fixedHost);
}

/**
 * Effective URLs claimed by more than one selection. The runner names the seeded Secret from a hash
 * of the URL (`HelmRepoCredSecretName`), so two rows resolving to one URL silently collapse into a
 * single credential — a race the user should see rather than discover at deploy.
 */
export function duplicateHelmRegistryUrls(items: HelmRegistryItem[]): string[] {
	const counts = new Map<string, number>();
	for (const item of items) {
		const url = helmRegistryUrl(item);
		if (url) counts.set(url, (counts.get(url) ?? 0) + 1);
	}
	return [...counts.entries()].filter(([, n]) => n > 1).map(([url]) => url);
}
