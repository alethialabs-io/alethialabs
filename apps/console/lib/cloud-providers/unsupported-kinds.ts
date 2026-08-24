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
 * cache→Valkey, queue→RabbitMQ, registry→Harbor — see lib/cloud-providers/hetzner-services.ts, which synthesizes them
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
 * `secret` is blocked on Hetzner: there is NO cloud secret store (the runner already says so —
 * argocd/decisions.go externalSecretsStoreDecision: "Hetzner has no cloud secret store — use the Vault
 * connector"), and `hetznerProvider.ProviderTfvars` never emits `custom_secrets` (every managed cloud
 * does). Before this gate the component was SILENTLY DROPPED and the deploy still reported SUCCESS —
 * exactly the failure mode this map exists to prevent. In-cluster secrets (Vault add-on + an ESO
 * ClusterSecretStore over a Vault backend) is a real feature with its own init/unseal design, not a
 * silent no-op; until it lands, reject the kind honestly.
 */
export const UNSUPPORTED_KINDS_BY_PROVIDER: Partial<
	Record<CloudProviderSlug, readonly NodeKind[]>
> = {
	hetzner: ["topic", "nosql", "secret"],
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
