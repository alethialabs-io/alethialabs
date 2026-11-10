// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The namespaces a bring-your-own chart may never target (#6439).
//
// ⚠️ A MIRROR, not a source. The list is packages/core/argocd/byo_reserved_namespaces.json, which the
// runner embeds and enforces at deploy time; this copy exists so the attach form refuses the same
// names BEFORE a chart is saved, rather than letting the deploy refuse it later. A parity test
// (tests/lib/validations/byo-reserved-namespaces.test.ts) deep-equals the two, and also pins the
// marketplace group to `ADDON_CATALOG`'s own namespaces, so a new add-on reds CI until it is listed.
//
// Why a copy and not an import of the JSON: no console module imports a file out of packages/core —
// the Go-owned data files it consumes (catalog.json, matrix.json) arrive as checked-in TS copies under
// lib/**/generated/. This one is small enough to keep by hand; the parity test, not a generator, is
// what stops it drifting.

/** One group of reserved namespaces and the reason shown to the user. */
export interface ReservedNamespaceGroup {
	id: string;
	reason: string;
	namespaces: readonly string[];
}

/** A reserved namespace prefix and the reason shown to the user. */
export interface ReservedNamespacePrefix {
	prefix: string;
	reason: string;
}

/** The reserved-namespace list, mirrored field for field from byo_reserved_namespaces.json. */
export const BYO_RESERVED_NAMESPACES: {
	groups: readonly ReservedNamespaceGroup[];
	prefixes: readonly ReservedNamespacePrefix[];
	/** Refused for a NAMESPACE-PLACED environment only (lib/validations/placement-namespace.ts, #6551),
	 *  never for a BYO chart: `byo-` is where a BYO chart deploys. */
	placementPrefixes: readonly ReservedNamespacePrefix[];
} = {
	groups: [
		{
			id: "kubernetes",
			reason: "it is a Kubernetes system namespace",
			namespaces: ["kube-node-lease", "kube-public", "kube-system"],
		},
		{
			id: "platformTemplates",
			reason:
				"the platform's own controllers (ArgoCD, cert-manager, External Secrets, ingress, DNS, autoscaling) install there",
			namespaces: [
				"agic",
				"argocd",
				"cert-manager",
				"external-dns",
				"external-secrets-operator",
				"karpenter",
				"kube-system",
			],
		},
		{
			id: "platformCategories",
			reason:
				"the platform's own infrastructure modules (Datadog, Grafana, cluster networking and storage) install there",
			namespaces: ["datadog", "kube-system", "monitoring"],
		},
		{
			id: "platformRuntime",
			reason: "the platform runs its own components there",
			namespaces: [
				"alethia-build",
				"alethia-system",
				"argocd",
				"external-secrets-operator",
				"queues",
				"registries",
				"secrets",
			],
		},
		{
			id: "platformByoDBUsers",
			reason: "the platform's BYO database users Job runs there, with the credentials it needs",
			namespaces: ["alethia-byo-db-users"],
		},
		{
			id: "platformWorkloads",
			reason:
				"the platform's own workloads, their Secrets and their service accounts run there",
			namespaces: ["default"],
		},
		{
			id: "platformDataServices",
			reason:
				"the platform runs its in-cluster data services there (databases, caches, queues, operators), with their credentials",
			namespaces: [
				"caches",
				"cnpg-system",
				"databases",
				"nosql",
				"queues",
				"registries",
				"scylla-operator",
				"secrets",
				"topics",
			],
		},
		{
			id: "platformCloudIdentities",
			reason: "a cloud identity the platform's templates create trusts a service account there",
			namespaces: [
				"agic",
				"alethia-build",
				"argocd",
				"cert-manager",
				"default",
				"external-dns",
				"external-secrets-operator",
				"fluent-bit",
				"karpenter",
				"kube-system",
			],
		},
		{
			id: "marketplaceAddOns",
			reason: "a platform-managed add-on from the marketplace installs there",
			namespaces: [
				"argo-rollouts",
				"external-dns",
				"falco",
				"goldilocks",
				"harbor",
				"ingress-nginx",
				"keda",
				"kube-system",
				"kyverno",
				"minio",
				"monitoring",
				"observability",
				"reloader",
				"trivy-system",
				"vault",
				"velero",
			],
		},
	],
	prefixes: [
		{
			prefix: "kube-",
			reason: "Kubernetes reserves the kube- prefix for its system namespaces",
		},
		{
			prefix: "vcluster-",
			reason: "the platform names every virtual cluster's host namespace vcluster-<name>",
		},
	],
	placementPrefixes: [
		{
			prefix: "byo-",
			reason:
				"the environment that owns this cluster installs its bring-your-own charts into byo-<chart id>",
		},
	],
};

/**
 * Why `namespace` is reserved for the platform, or `null` when a BYO chart may use it. Same order as
 * the runner's `byoReservedNamespaceReason`: an exact name (first group listing it) before a prefix.
 */
export function byoReservedNamespaceReason(namespace: string): string | null {
	for (const group of BYO_RESERVED_NAMESPACES.groups) {
		if (group.namespaces.includes(namespace)) return group.reason;
	}
	for (const p of BYO_RESERVED_NAMESPACES.prefixes) {
		if (namespace.startsWith(p.prefix)) return p.reason;
	}
	return null;
}

/** The message the form and the attach action show for a reserved namespace, or `null`. */
export function byoReservedNamespaceMessage(namespace: string): string | null {
	const reason = byoReservedNamespaceReason(namespace);
	return reason
		? `“${namespace}” is reserved for the platform: ${reason}. Choose a namespace of your own.`
		: null;
}
