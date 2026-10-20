"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Resolves the capability bag for ONE canvas node.
//
// Keyed on the node's EFFECTIVE identity rather than the project's, because a node can carry its own
// `cloud_identity_id` and diverge from the core. A divergent node just gets its own cached entry —
// one extra fetch, cached and deduped by the query cache.
//
// ⚠ `getEffectiveIdentity` and `getEffectiveProvider` resolve by INDEPENDENT paths
// (`cloud_identity_id ?? core` vs `provider ?? project.provider`) and can disagree — a node can
// carry a provider with no identity. Keying on the identity should make a mismatch unreachable, but
// `capability-options.ts` keeps its provider-mismatch guard anyway: the failure it prevents (an AWS
// project offering GCP machine types) is silent and looks like a product bug.
//
// SERVER STATE, SO A QUERY (ADR 0005 D5, #6119). This used to be a Zustand store with its own TTL,
// in-flight dedupe and invalidation — a re-implementation of TanStack Query. The read is the
// `canvas.capabilities` GET procedure; N mounted fields share one request because they share one key.

import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/rpc/client";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";
import { nodeOfKind } from "../graph/types";
import { NO_CAPABILITIES, type CapabilityBag } from "./config-schema";

/**
 * How long a capability bag is trusted. The catalog is refreshed by a server sweeper on the order of
 * hours, so a picker re-reading it every 30 s (the console's default) would be pure load.
 */
const CAPABILITIES_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * The bag for an identity and region. Never blocks a picker: while the read is in flight it is a
 * `loading` bag, and a failed read is an `error` bag — both resolve to the static catalog, so the
 * canvas stays usable whatever the network does (fail OPEN, loudly enough for the field footnote).
 */
export function useCapabilities(identityId: string | null, region: string | null): CapabilityBag {
	const query = useQuery({
		...orpc.canvas.capabilities.queryOptions({
			input: { identityId: identityId ?? "", region },
		}),
		enabled: identityId !== null,
		staleTime: CAPABILITIES_STALE_MS,
	});
	if (identityId === null) return NO_CAPABILITIES;
	if (query.data) return query.data;
	if (query.isError) return { ...NO_CAPABILITIES, identityId, state: "error" };
	return { ...NO_CAPABILITIES, identityId, state: "loading" };
}

/**
 * The bag for `nodeId`. Returns `NO_CAPABILITIES` until the read resolves — every picker then shows
 * the static catalog, which is exactly the pre-capabilities behaviour, so nothing flashes empty.
 */
export function useNodeCapabilities(nodeId: string | null): CapabilityBag {
	const identity = useCanvasStore((s) =>
		nodeId ? s.getEffectiveIdentity(nodeId) : null,
	);
	// Region is a PROJECT-level field on the canvas, and it scopes the region-sensitive axes.
	// `nodeOfKind` is the sanctioned narrowing seam — the node union has no common `region`.
	const region = useCanvasStore((s) => {
		const project = nodeOfKind(
			s.nodes.find((n) => n.id === PROJECT_NODE_ID),
			"project",
		);
		return project?.data.config.region || null;
	});

	return useCapabilities(identity?.id ?? null, region);
}
