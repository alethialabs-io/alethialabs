// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The namespaces a NAMESPACE-PLACED environment may never be deployed into (#6551).
//
// A namespace placement shares the cluster of the environment that owns its Fabric (the host), and its
// AppProject admits workloads into its own namespace — so whatever else lives in that namespace is in
// its reach. This is the console's copy of the runner's rule (Go `argocd.PlacementNamespaceReason`),
// checked when a placement is created so it is refused up front; the runner checks the stored value
// again at deploy, fail-closed.
//
// ONE list. The static half is BYO_RESERVED_NAMESPACES — every group and prefix a BYO chart is refused
// (it already carries `default`, `argocd`, `kube-*` and `alethia-byo-db-users`) plus its
// `placementPrefixes` — mirrored from packages/core/argocd/byo_reserved_namespaces.json under a parity
// test. The dynamic half is the host environment's own BYO chart namespaces, which the caller reads
// (lib/queries/placement-host-namespaces.ts) and passes in.

import { slugifyOrEmpty } from "@/lib/utils/slugify";
import {
	BYO_RESERVED_NAMESPACES,
	byoReservedNamespaceReason,
} from "@/lib/validations/byo-reserved-namespaces";

/** The reason given for a namespace one of the host environment's own BYO charts installs into.
 *  Mirrors Go `argocd.PlacementHostNamespaceReason`. */
export const PLACEMENT_HOST_NAMESPACE_REASON =
	"a bring-your-own chart of the environment that owns this cluster installs there";

/**
 * Why `namespace` may not be a namespace placement's destination, or `null` when it may be. Same order
 * as the runner: the BYO list (an exact name, then a prefix), then the placement-only prefixes, then
 * the host's namespaces.
 */
export function placementNamespaceReason(
	namespace: string,
	hostNamespaces: readonly string[],
): string | null {
	const reserved = byoReservedNamespaceReason(namespace);
	if (reserved) return reserved;
	for (const p of BYO_RESERVED_NAMESPACES.placementPrefixes) {
		if (namespace.startsWith(p.prefix)) return p.reason;
	}
	if (hostNamespaces.some((h) => h.trim() === namespace)) return PLACEMENT_HOST_NAMESPACE_REASON;
	return null;
}

/** The refusal shown for a reserved placement namespace, or `null`. Names the namespace and why. */
export function placementNamespaceMessage(
	namespace: string,
	hostNamespaces: readonly string[],
): string | null {
	const reason = placementNamespaceReason(namespace, hostNamespaces);
	return reason
		? `Namespace “${namespace}” is reserved on the host cluster: ${reason}. A namespace-placed environment needs a namespace of its own.`
		: null;
}

/**
 * The namespace a namespace placement deploys into: its own, else the slug of its name — the fallback
 * `resolveTargetEnvironment` applies when it builds the snapshot, so an environment NAMED `argocd`
 * with no namespace is checked as the `argocd` it would deploy into.
 */
export function effectivePlacementNamespace(env: {
	name: string;
	namespace?: string | null;
}): string {
	return env.namespace ?? slugifyOrEmpty(env.name);
}

/** The refusal for a namespace another namespace placement on the same Fabric already resolves to. */
export function placementNamespaceTakenMessage(namespace: string, environment: string): string {
	return `Namespace “${namespace}” is already used by the environment “${environment}” on this Fabric. Two namespace-placed environments cannot share a namespace; choose another.`;
}

/**
 * The first namespace two of `envs` resolve to, as a refusal, or `null` when every namespace
 * placement in the list resolves to its own namespace. For a create matrix, whose shared
 * placements all land on the same host Fabric.
 */
export function duplicatePlacementNamespace(
	envs: readonly { name: string; namespace?: string | null; placement_mode: string }[],
): { index: number; message: string } | null {
	const seen = new Map<string, string>();
	for (const [index, env] of envs.entries()) {
		if (env.placement_mode !== "namespace") continue;
		const ns = effectivePlacementNamespace(env);
		const holder = seen.get(ns);
		if (holder !== undefined) return { index, message: placementNamespaceTakenMessage(ns, holder) };
		seen.set(ns, env.name);
	}
	return null;
}
