// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Derives a project's chart-repo selection (`project_helm_registries`) from the `oci://` hosts its
// charts actually reference, matched against the org's CONNECTED `helm_registry` connectors.
//
// Why derive at all: a chart repo is credential plumbing, not architecture. The user already told us
// the host when they typed `oci://ghcr.io/acme/payments`, and they already connected the ghcr
// connector on the Connectors page — asking them to restate the pairing is a manual step that can
// only be got wrong. So we infer it, show what we inferred, and let them override.
//
// Why an override is REQUIRED (not just nice): `connector_credentials` stores the secret bag only —
// there is no org-level host on a connector. For the fixed-host providers (ghcr / Docker Hub) the
// host is hardcoded in the Go provider so the match is exact; for the "any host" providers
// (generic / Scaleway) the host can ONLY come from the chart URL, and if more than one of them is
// connected the pairing is genuinely ambiguous. That case, plus `helm-https` (a classic index.yaml
// repo is never referenced as `oci://`), is what the explicit picker exists for.
//
// The host rules mirror each provider's `RepoCred` in packages/core/categories/helm_registry_*.go —
// that Go code builds the ArgoCD repo-credential URL, and the URL we show/dedup on must be the same
// string, since ArgoCD matches an Application to a credential by repoURL prefix.

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
	provider_config?: HelmRegistryProviderConfig | null;
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
 * `packages/core/categories/helm_registry_*.go` seeds, so what the sheet shows is what ArgoCD
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

/** Row name for a derived selection — the host, RFC1123-ish (`ghcr.io` → `ghcr-io`). */
export function helmRegistryRowName(host: string): string {
	return host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "charts";
}

/** Every host a selection already covers, so derivation never proposes a duplicate. */
function coveredHosts(existing: HelmRegistryItem[]): Set<string> {
	const hosts = new Set<string>();
	for (const item of existing) {
		const host = ociHostOf(helmRegistryUrl(item));
		if (host) hosts.add(host);
		const rule = item.provider ? HELM_REGISTRY_HOST_RULES[item.provider] : undefined;
		for (const alias of rule?.hostAliases ?? []) hosts.add(alias);
	}
	return hosts;
}

/** A host used by a chart that no selection covers and derivation could not resolve. */
export interface UnresolvedChartHost {
	host: string;
	/** `no_connector` — nothing connected can serve it; `ambiguous` — more than one could. */
	reason: "no_connector" | "ambiguous";
	/** Connected slugs that could serve the host (empty for `no_connector`). */
	candidates: string[];
}

export interface DeriveResult {
	/** Selections to ADD. Never modifies or removes an existing row — an explicit pick is durable. */
	additions: HelmRegistryItem[];
	unresolved: UnresolvedChartHost[];
}

/**
 * Matches each chart host against the connected chart-repo connectors.
 *
 * Order is deterministic so the same project always derives the same rows:
 *   1. exact fixed/default host (ghcr.io, registry-1.docker.io, registry.gitlab.com)
 *   2. a wildcard provider whose host suffix hints at it (`*.scw.cloud` → Scaleway)
 *   3. exactly ONE connected wildcard provider (host taken from the chart URL)
 *   4. otherwise unresolved — 0 candidates (`no_connector`) or >1 (`ambiguous`)
 *
 * Hosts already covered by an existing selection are skipped entirely, which is what lets an
 * explicit override survive without a `derived` column (i.e. without a migration).
 */
export function deriveHelmRegistries(input: {
	/** Chart repo references from the project's BYO/add-on charts (`oci://…` or otherwise). */
	chartRepos: (string | null | undefined)[];
	/** Slugs of the org's CONNECTED helm_registry connectors. */
	connectedSlugs: Iterable<string>;
	/** Selections already on the project — treated as authoritative. */
	existing: HelmRegistryItem[];
}): DeriveResult {
	const connected = [...input.connectedSlugs].filter(isSelectableHelmRegistry);
	const covered = coveredHosts(input.existing);
	const takenNames = new Set(input.existing.map((r) => r.name));

	const additions: HelmRegistryItem[] = [];
	const unresolved: UnresolvedChartHost[] = [];
	const seen = new Set<string>();

	for (const repo of input.chartRepos) {
		const host = ociHostOf(repo);
		if (!host || seen.has(host) || covered.has(host)) continue;
		seen.add(host);

		// 1 — exact host match.
		const exact = connected.find((slug) => {
			const rule = HELM_REGISTRY_HOST_RULES[slug];
			if (!rule.oci) return false;
			const known = [rule.fixedHost, rule.defaultHost, ...(rule.hostAliases ?? [])];
			return known.filter(Boolean).includes(host);
		});
		if (exact) {
			additions.push(buildRow(exact, host, takenNames));
			continue;
		}

		const wildcards = connected.filter((slug) => HELM_REGISTRY_HOST_RULES[slug].wildcard);
		// 2 — suffix hint (rg.fr-par.scw.cloud → Scaleway even when generic is also connected).
		const hinted = wildcards.filter((slug) =>
			(HELM_REGISTRY_HOST_RULES[slug].hostSuffixes ?? []).some((s) => host.endsWith(s)),
		);
		const chosen = hinted.length === 1 ? hinted : wildcards;
		// 3 — exactly one candidate.
		if (chosen.length === 1) {
			additions.push(buildRow(chosen[0], host, takenNames));
			continue;
		}
		// 4 — honest about what we can't decide.
		unresolved.push({
			host,
			reason: chosen.length === 0 ? "no_connector" : "ambiguous",
			candidates: chosen,
		});
	}

	return { additions, unresolved };
}

/** Builds a selection row for `slug` serving `host`, with a name unique within the environment. */
function buildRow(slug: string, host: string, taken: Set<string>): HelmRegistryItem {
	const rule = HELM_REGISTRY_HOST_RULES[slug];
	let name = helmRegistryRowName(host);
	for (let i = 2; taken.has(name); i++) name = `${helmRegistryRowName(host)}-${i}`;
	taken.add(name);
	return {
		name,
		provider: slug,
		// Only the "any host" providers carry the host; a fixed-host provider stores nothing, so the
		// URL can never drift from what the Go provider hardcodes.
		provider_config: rule.wildcard ? { registry_host: host } : {},
	};
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
