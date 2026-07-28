"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Resolves the capability bag for ONE canvas node.
//
// Keyed on the node's EFFECTIVE identity rather than the project's, because a node can carry its own
// `cloud_identity_id` and diverge from the core. A divergent node just gets its own cached entry —
// one extra fetch, TTL'd and deduped.
//
// ⚠ `getEffectiveIdentity` and `getEffectiveProvider` resolve by INDEPENDENT paths
// (`cloud_identity_id ?? core` vs `provider ?? project.provider`) and can disagree — a node can
// carry a provider with no identity. Keying on the identity should make a mismatch unreachable, but
// `capability-options.ts` keeps its provider-mismatch guard anyway: the failure it prevents (an AWS
// project offering GCP machine types) is silent and looks like a product bug.

import { useEffect } from "react";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";
import { useCapabilitiesStore } from "@/lib/stores/use-capabilities-store";
import { nodeOfKind } from "../graph/types";
import { NO_CAPABILITIES, type CapabilityBag } from "./config-schema";

/**
 * The bag for `nodeId`. Returns `NO_CAPABILITIES` until the fetch resolves — every picker then shows
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

	const identityId = identity?.id ?? null;
	const ensure = useCapabilitiesStore((s) => s.ensure);

	useEffect(() => {
		if (identityId) ensure(identityId, region);
	}, [identityId, region, ensure]);

	return useCapabilitiesStore((s) => s.get(identityId, region)) ?? NO_CAPABILITIES;
}
