"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { judgedK8sVersion, type JudgedK8sVersion } from "@/lib/compat";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

/**
 * The environment cluster's Kubernetes version as the compat checks must judge it: the version
 * that will DEPLOY.
 *
 * On the template path an unset `cluster_version` resolves to the catalog default for the cluster's
 * cloud (#5314) — the same answer the apply gate reaches — instead of reading as "unset" and
 * skipping every check. On a BYO-IaC environment (`EnvironmentStatus.iac`, the enabled source the
 * server reads) the customer's module decides the version, so an unset one is NOT resolved: it
 * comes back as `version: undefined` with a `reason` the surfaces show in their existing
 * "Unverified" style (#5365). An explicit version is judged as written on both paths, as the
 * server does.
 *
 * `version` is also undefined when the design has no cluster yet (or no resolvable cloud), which
 * the engine reports as `not_evaluable`, never a pass. A BYO-IaC environment with no cluster card
 * carries the BYO reason too: its module owns the cluster, so that is the true answer there.
 *
 * One hook for the env card's alert, the palette badges, the canvas chips and the add-on card,
 * which each used to read the raw value with their own copy of the same selector. Display only:
 * nothing writes the resolved value back into the cluster's config.
 */
export function useClusterK8sVersion(): JudgedK8sVersion {
	const byoIac = useEnvironmentStatus().iac !== null;
	// Two primitive selections, not one object: a selector returning a fresh object every call
	// would re-render (and, in zustand, loop) on every store change.
	const raw = useCanvasStore((s) => {
		const c = s.nodes.find((n) => n.data.kind === "cluster")?.data.config;
		return c && "cluster_version" in c && typeof c.cluster_version === "string" ? c.cluster_version : undefined;
	});
	const provider = useCanvasStore((s) => {
		const cluster = s.nodes.find((n) => n.data.kind === "cluster");
		return cluster ? s.getEffectiveProvider(cluster.id) : null;
	});
	return judgedK8sVersion(provider, raw, byoIac);
}
