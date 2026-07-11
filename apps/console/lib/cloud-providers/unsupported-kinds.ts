// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { NodeKind } from "@/components/design-project/canvas/graph/types";
import type { CloudProviderSlug } from "@/lib/cloud-providers";

/**
 * Node kinds a given cloud's built-in template can't provision — the SINGLE source of truth
 * shared by the canvas Add-palette (via `node-registry.ts`, which re-exports this) and the
 * deploy-time fail-closed gate (`buildConfigSnapshot`). Keeping it here — a tiny, runtime-only
 * module with no client (`lucide-react`/React-Flow) imports — lets the server action import it
 * without pulling the whole canvas registry into the server bundle.
 *
 * Compute-only Hetzner runs data services as in-cluster Helm charts (Postgres→CloudNativePG,
 * cache→Valkey, queue→RabbitMQ) and provisions buckets natively via Object Storage (the
 * aminueza/minio provider — see infra/templates/project/hetzner/buckets.tf); topic (SNS) and nosql
 * (DynamoDB) have no clean single-chart OSS equal and registry has no native Hetzner path, so those
 * stay hidden in the palette and rejected at deploy (the Harbor marketplace add-on covers registry
 * in-cluster). When a provider gains a native path for a kind, drop it from this map and BOTH the
 * palette and the deploy gate follow.
 */
export const UNSUPPORTED_KINDS_BY_PROVIDER: Partial<
	Record<CloudProviderSlug, readonly NodeKind[]>
> = {
	hetzner: ["topic", "nosql", "registry"],
};

/**
 * The kinds the given provider's template can't provision (empty when it backs everything).
 * Accepts a plain string so DB-enum provider values (which include clouds outside the narrower
 * `CloudProviderSlug` design set, e.g. digitalocean/civo) can be checked without a cast.
 */
export function unsupportedKindsFor(provider: string | null): readonly NodeKind[] {
	if (!provider) return [];
	const byProvider: Partial<Record<string, readonly NodeKind[]>> =
		UNSUPPORTED_KINDS_BY_PROVIDER;
	return byProvider[provider] ?? [];
}
