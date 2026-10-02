"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveK8sVersion } from "@/lib/compat";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

/**
 * The environment cluster's Kubernetes version as the compat checks must judge it: the version
 * that will DEPLOY. An unset `cluster_version` resolves to the catalog default for the cluster's
 * cloud (#5314) — the same answer the apply gate reaches — instead of reading as "unset" and
 * skipping every check. `undefined` only when the design has no cluster yet (or no resolvable
 * cloud), which the engine reports as `not_evaluable`, never a pass.
 *
 * One hook for the env card's alert, the palette badges, the canvas chips and the add-on card,
 * which each used to read the raw value with their own copy of the same selector. Display only:
 * nothing writes the resolved value back into the cluster's config.
 */
export function useClusterK8sVersion(): string | undefined {
	return useCanvasStore((s) => {
		const cluster = s.nodes.find((n) => n.data.kind === "cluster");
		if (!cluster) return undefined;
		const c = cluster.data.config;
		const raw = "cluster_version" in c && typeof c.cluster_version === "string" ? c.cluster_version : undefined;
		return resolveK8sVersion(s.getEffectiveProvider(cluster.id), raw);
	});
}
