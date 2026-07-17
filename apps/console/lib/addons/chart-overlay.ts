// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W5 Path A Lane 2 — compose a BYO chart's user overlay (config + bindings) into its Helm values.
//
// A described chart workload (`project_chart_workloads`) carries a user overlay preserved across
// re-scans: `config` (v1: replicas + env), `bindings` (W3 ServiceBinding[]), and `value_paths`
// (logical knob → dot-path within the chart's values). This module turns that overlay into a
// values fragment applied at `resolveByoChartInstall` time, onto the pristine `project_addons.values`
// base — auditable and reversible (drop the overlay ⇒ back to the pristine values).
//
// Timing boundary: this composes CONSOLE-side, at deploy-snapshot build, BEFORE the runner has any
// tofu outputs. So only the STATIC overlay is composable here:
//   - config.replicas / config.env  → literal values at their value-path.  ✓ (this lane)
// Binding write-back is deliberately NOT composed here: a non-secret facet (endpoint) needs runtime
// tofu outputs, and a credential facet must become a keyless ExternalSecret/secretKeyRef whose Secret
// name is the runner's `BindingSecretName` (packages/core/manifests) — both are runner-side. Doing
// them here would either inline a plaintext credential (the Go renderer marshals `values` verbatim,
// so anything here lands in the manifest — see #640) or duplicate the Go DNS-1123 name contract.
// Bindings are persisted + surfaced by this lane's server actions; their runtime compose is Lane 2b.

import type {
	ChartValuePathMap,
	ChartWorkloadConfig,
	ChartWorkloadRendered,
	ServiceBinding,
	ServiceBindingFacet,
} from "@/types/jsonb.types";

/** The overlay-bearing slice of a `project_chart_workloads` row this module composes. */
export interface ChartWorkloadOverlay {
	name: string;
	rendered: ChartWorkloadRendered;
	config: ChartWorkloadConfig;
	bindings: ServiceBinding[];
	value_paths: ChartValuePathMap;
}

/** Credential (secret) binding facets — materialized keyless via ExternalSecret/secretKeyRef, never
 * a literal. Mirrors `IsCredentialFacet` (packages/core/manifests/externalsecret.go). */
const CREDENTIAL_FACETS: ReadonlySet<ServiceBindingFacet> = new Set([
	"username",
	"password",
	"connection_string",
]);

/** Whether a binding facet resolves to a secret (ref), not a templated literal. */
export function isCredentialFacet(facet: ServiceBindingFacet): boolean {
	return CREDENTIAL_FACETS.has(facet);
}

// ── value_paths keying convention (this lane defines it) ─────────────────────────────────────────
// Logical knob keys in `value_paths`:
//   "replicas"                       → chart replica-count path
//   "env"                            → chart extra-env list path
//   "bind:{kind}:{name}:{facet}"     → chart path for that binding facet (Lane 2b compose)

/** The value_paths key for the replica-count knob. */
export const REPLICAS_KNOB = "replicas";
/** The value_paths key for the extra-env-list knob. */
export const ENV_KNOB = "env";
/** The value_paths key for one binding facet. */
export function bindingKnob(
	kind: string,
	name: string,
	facet: string,
): string {
	return `bind:${kind}:${name}:${facet}`;
}

/**
 * Sets `value` at a dot-path (`"a.b.c"`) inside a values object, creating intermediate objects.
 * Returns a new object (the input is not mutated); an existing non-object at an intermediate segment
 * is overwritten with an object so the leaf can be placed. An empty path is a no-op (returns a copy).
 */
export function setByPath(
	obj: Record<string, unknown>,
	dotPath: string,
	value: unknown,
): Record<string, unknown> {
	const segments = dotPath.split(".").filter((s) => s.length > 0);
	if (segments.length === 0) return { ...obj };
	const root: Record<string, unknown> = { ...obj };
	let cursor = root;
	for (let i = 0; i < segments.length - 1; i++) {
		const key = segments[i];
		const existing = cursor[key];
		const next: Record<string, unknown> =
			existing && typeof existing === "object" && !Array.isArray(existing)
				? { ...(existing as Record<string, unknown>) }
				: {};
		cursor[key] = next;
		cursor = next;
	}
	cursor[segments[segments.length - 1]] = value;
	return root;
}

/**
 * Infers the default value-path for each overlay knob a workload actually has, from common chart
 * conventions (bitnami/community). Only knobs present on the workload get a candidate; the user can
 * override any of these (persisted on `value_paths`). Never guesses a path for a knob the workload
 * lacks — an absent knob must not write into the chart.
 */
export function inferValuePaths(workload: {
	rendered: ChartWorkloadRendered;
	config: ChartWorkloadConfig;
	bindings: ServiceBinding[];
}): ChartValuePathMap {
	const paths: ChartValuePathMap = {};
	// Replicas: only for a workload the chart renders with a replica count (Deployment/StatefulSet).
	if (workload.rendered.replicas !== undefined) {
		paths[REPLICAS_KNOB] = "replicaCount";
	}
	// Extra env: the common bitnami list knob.
	paths[ENV_KNOB] = "extraEnvVars";
	// Binding facets: a credential facet's best-guess is the common existingSecret knob; a non-secret
	// facet has no single convention, so it is left for user override (Lane 2b resolves it runner-side).
	for (const b of workload.bindings) {
		for (const inj of b.inject) {
			if (isCredentialFacet(inj.from)) {
				paths[bindingKnob(b.target.kind, b.target.name, inj.from)] =
					"auth.existingSecret";
			}
		}
	}
	return paths;
}

/** The result of composing an overlay: the values fragment applied, and the knobs that had no
 * value-path (surfaced honestly rather than guessed into a wrong path or dropped silently). */
export interface OverlayComposition {
	values: Record<string, unknown>;
	/** Logical knob keys that were requested but had no resolved value-path. */
	unavailable: string[];
}

/**
 * Applies the STATIC half of a chart workload's overlay (config: replicas + env) onto a base values
 * object, at each knob's declared value-path. Bindings are intentionally NOT composed here (their
 * write-back is runner-side — Lane 2b); a binding knob with a config value but no path, or a config
 * knob with no path, is reported in `unavailable`. Never writes a secret value.
 */
export function composeWorkloadConfig(
	base: Record<string, unknown>,
	workload: ChartWorkloadOverlay,
): OverlayComposition {
	let values = base;
	const unavailable: string[] = [];
	const { config, value_paths } = workload;

	if (config.replicas !== undefined) {
		const path = value_paths[REPLICAS_KNOB];
		if (path) values = setByPath(values, path, config.replicas);
		else unavailable.push(REPLICAS_KNOB);
	}
	if (config.env !== undefined && config.env.length > 0) {
		const path = value_paths[ENV_KNOB];
		if (path) {
			// Emit as a k8s-style env list (name/value) — the shape bitnami `extraEnvVars` expects.
			values = setByPath(
				values,
				path,
				config.env.map((e) => ({ name: e.name, value: e.value })),
			);
		} else {
			unavailable.push(ENV_KNOB);
		}
	}
	return { values, unavailable };
}

/**
 * Composes every workload's static overlay onto a chart addon's pristine base values. Applied in
 * `resolveByoChartInstall` before the raw `values_yaml` override (which stays highest precedence).
 * Returns the merged values and the union of unavailable knobs across workloads (for surfacing).
 */
export function composeChartOverlay(
	base: Record<string, unknown>,
	workloads: ChartWorkloadOverlay[],
): OverlayComposition {
	let values: Record<string, unknown> = { ...base };
	const unavailable: string[] = [];
	for (const w of workloads) {
		const r = composeWorkloadConfig(values, w);
		values = r.values;
		for (const u of r.unavailable) unavailable.push(`${w.name}:${u}`);
	}
	return { values, unavailable };
}
