// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { NodeKind } from "@/components/design-project/canvas/graph/types";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import type { CloudProvider } from "@/lib/db/schema/enums";

/**
 * Node kinds a given cloud's built-in template can't provision — the SINGLE source of truth
 * shared by the canvas Add-palette (via `node-registry.ts`, which re-exports this) and the
 * deploy-time fail-closed gate (`buildConfigSnapshot`). Keeping it here — a tiny, runtime-only
 * module with no client (`lucide-react`/React-Flow) imports — lets the server action import it
 * without pulling the whole canvas registry into the server bundle.
 *
 * Compute-only Hetzner runs data services as in-cluster Helm charts (Postgres→CloudNativePG,
 * cache→Valkey, queue→RabbitMQ, registry→Harbor, secret→Vault — see lib/cloud-providers/hetzner-services.ts, which synthesizes them
 * as ArgoCD add-on Applications) and provisions buckets natively via Object Storage (the
 * aminueza/minio provider — see infra/templates/project/hetzner/buckets.tf); topic (SNS) and nosql
 * (DynamoDB) have no clean single-chart OSS equal, so those stay hidden in the palette and rejected
 * at deploy. When a provider gains a native path for a kind, drop it from this map and BOTH the
 * palette and the deploy gate follow.
 *
 * `registry` LEFT this list in #2431, and it took three things beyond the chart. On every other
 * cloud a project's own registry needs no imagePullSecret because the nodes authenticate to ECR /
 * Artifact Registry / ACR with their own identity; an in-cluster Harbor has none. So it needed a
 * scoped robot account minted by a Job running INSIDE the cluster (Harbor's API answers nowhere
 * else), that credential on the EnsureRegistryPullSecret rail, and a Talos containerd mirror — until
 * which the kubelet would not pull over plain HTTP from a cluster-local host at all. A chart that
 * installs is not a registry anybody can pull from.
 *
 * `secret` LEFT this list in #2432, and — like `registry` — the chart was never the missing half.
 * Hetzner still has no CLOUD secret store and `hetznerProvider.ProviderTfvars` still never emits
 * `custom_secrets`; what changed is that the platform now OPERATES a Vault rather than expecting the
 * customer to. One release per project (never per node: a `secret` node is a KV entry, not a server),
 * initialised, unsealed and seeded by a Job running inside the cluster, with a least-privilege ESO
 * token minted and root revoked before the Job exits — then read through a ClusterSecretStore exactly
 * as the other four clouds are.
 *
 * The honest limit, stated where it is created: the seal is Shamir and the unseal key lives in a
 * Kubernetes Secret in the same cluster, because Hetzner sells no KMS to seal against. Against a
 * cluster-admin or an etcd backup that buys nothing over a plain Secret. What it does buy — an audit
 * log of every read, leases, revocation, rotation, and one uniform ESO read path with the other four
 * clouds — is real, and is why the kind is offered rather than still rejected. The full statement
 * lives next to the code that creates the situation: packages/core/argocd/vault.go.
 */
export const UNSUPPORTED_KINDS_BY_PROVIDER: Partial<
	Record<CloudProviderSlug, readonly NodeKind[]>
> = {
	hetzner: ["topic", "nosql"],
};

/**
 * The kinds the given provider's template can't provision (empty when it backs everything).
 * Takes the full generated `cloud_provider` enum — wider than the `CloudProviderSlug` design set,
 * since a DB provider value may be a connect-only cloud (digitalocean/civo) with no unsupported map.
 */
export function unsupportedKindsFor(
	provider: CloudProvider | null,
): readonly NodeKind[] {
	if (!provider) return [];
	const byProvider: Partial<Record<string, readonly NodeKind[]>> =
		UNSUPPORTED_KINDS_BY_PROVIDER;
	return byProvider[provider] ?? [];
}
