// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The cluster add-on catalog — a code SSOT (no DB enum, like lib/alerts/catalog.ts) of free
// OSS Helm charts the customer's cluster can come up with. Each entry pins a chart + a small
// set of user-tunable knobs. The engine (packages/core/argocd/addons.go) renders ANY entry
// without code changes, so growing the catalog is data, not plumbing. v1 seeds the L10
// observability stack; the broader backlog (security/secrets/networking/…) lands per the
// plan's catalog table.

import { z } from "zod";
import type { AddOnDef, AddOnInstallSpec, AddOnMode } from "./types";

/**
 * Deep-merges plain objects (later wins). Arrays and primitives are replaced, not merged —
 * matches how Helm values overrides behave. Used to layer user knobs onto an add-on's
 * `defaultValues`.
 */
export function deepMerge(
	base: Record<string, unknown>,
	override: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...base };
	for (const [k, v] of Object.entries(override)) {
		const b = out[k];
		if (
			v &&
			b &&
			typeof v === "object" &&
			typeof b === "object" &&
			!Array.isArray(v) &&
			!Array.isArray(b)
		) {
			out[k] = deepMerge(
				b as Record<string, unknown>,
				v as Record<string, unknown>,
			);
		} else {
			out[k] = v;
		}
	}
	return out;
}

/** Identity helper that preserves each entry's Zod schema generic, so `toValues` receives a
 * properly-typed `config` (a plain `AddOnDef[]` annotation would erase it to `unknown`). */
function defineAddOn<S extends z.ZodTypeAny>(def: AddOnDef<S>): AddOnDef<S> {
	return def;
}

/** The curated catalog. Ordered for display; grouped by category in the UI. */
export const ADDON_CATALOG: AddOnDef[] = [
	defineAddOn({
		id: "kube-prometheus-stack",
		name: "Prometheus + Grafana",
		category: "observability",
		icon: "LineChart",
		summary:
			"Full metrics stack — Prometheus, Grafana dashboards, and Alertmanager — installed and wired to your cluster.",
		docsUrl: "https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack",
		license: "Apache-2.0",
		chartRepo: "https://prometheus-community.github.io/helm-charts",
		chart: "kube-prometheus-stack",
		version: "61.9.0",
		namespace: "monitoring",
		defaultValues: {
			grafana: { enabled: true },
			// Keep the footprint small by default; the knobs below tune it.
			prometheus: { prometheusSpec: {} },
		},
		configSchema: z.object({
			/** Prometheus metric retention in days. */
			retentionDays: z.coerce.number().int().min(1).max(365).default(15),
			/** Persistent volume size for Prometheus (GiB). */
			storageGb: z.coerce.number().int().min(5).max(1000).default(20),
			/** Bundle Grafana dashboards. */
			grafana: z.boolean().default(true),
		}),
		toValues: (c) => ({
			grafana: { enabled: c.grafana },
			prometheus: {
				prometheusSpec: {
					retention: `${c.retentionDays}d`,
					storageSpec: {
						volumeClaimTemplate: {
							spec: {
								resources: { requests: { storage: `${c.storageGb}Gi` } },
							},
						},
					},
				},
			},
		}),
		fields: [
			{
				key: "retentionDays",
				label: "Metric retention (days)",
				type: "number",
				default: 15,
				min: 1,
				max: 365,
			},
			{
				key: "storageGb",
				label: "Prometheus storage (GiB)",
				type: "number",
				default: 20,
				min: 5,
				max: 1000,
			},
			{
				key: "grafana",
				label: "Bundle Grafana dashboards",
				type: "boolean",
				default: true,
			},
		],
		syncWave: 2,
		requires: ["storage"],
	}),
	defineAddOn({
		id: "loki",
		name: "Grafana Loki",
		category: "observability",
		icon: "ScrollText",
		summary:
			"Log aggregation for the cluster — query pod logs in Grafana alongside your metrics.",
		docsUrl: "https://github.com/grafana/loki/tree/main/production/helm/loki",
		license: "AGPL-3.0",
		chartRepo: "https://grafana.github.io/helm-charts",
		chart: "loki",
		version: "6.6.0",
		namespace: "monitoring",
		defaultValues: {
			// Single-binary, filesystem-backed — the lightest footprint for a starter install.
			deploymentMode: "SingleBinary",
			loki: {
				commonConfig: { replication_factor: 1 },
				storage: { type: "filesystem" },
				schemaConfig: {
					configs: [
						{
							from: "2024-01-01",
							store: "tsdb",
							object_store: "filesystem",
							schema: "v13",
							index: { prefix: "index_", period: "24h" },
						},
					],
				},
			},
			read: { replicas: 1 },
			write: { replicas: 1 },
			backend: { replicas: 1 },
		},
		configSchema: z.object({
			/** Log retention in days (0 = keep forever). */
			retentionDays: z.coerce.number().int().min(0).max(365).default(14),
		}),
		toValues: (c) => ({
			loki: {
				limits_config: {
					retention_period: c.retentionDays > 0 ? `${c.retentionDays * 24}h` : "0s",
				},
			},
		}),
		fields: [
			{
				key: "retentionDays",
				label: "Log retention (days, 0 = forever)",
				type: "number",
				default: 14,
				min: 0,
				max: 365,
			},
		],
		syncWave: 3,
		requires: ["storage"],
	}),
];

/** A catalog add-on id (the `project_addons.addon_id`). */
export type AddOnId = string;

/** Looks up a catalog entry by id, or null when the id is unknown/retired. */
export function getAddOn(id: string): AddOnDef | null {
	return ADDON_CATALOG.find((a) => a.id === id) ?? null;
}

/**
 * Resolves an enabled `project_addons` row into the runner-facing install spec: pins the
 * chart coords, validates + defaults the stored knobs, and deep-merges them onto the add-on's
 * base values. Returns null when the add-on id is no longer in the catalog (so a retired
 * add-on is skipped, not mis-provisioned).
 */
export function resolveAddOnInstall(row: {
	addon_id: string;
	mode: AddOnMode;
	version?: string | null;
	values?: Record<string, unknown> | null;
}): AddOnInstallSpec | null {
	const def = getAddOn(row.addon_id);
	if (!def) return null;
	// Validate the stored knobs; fall back to schema defaults on any mismatch so a stale row
	// never blocks a deploy.
	const parsed = def.configSchema.safeParse(row.values ?? {});
	const config = parsed.success ? parsed.data : def.configSchema.parse({});
	const knobValues = def.toValues ? def.toValues(config) : {};
	const values = deepMerge(def.defaultValues ?? {}, knobValues);
	return {
		id: def.id,
		mode: row.mode,
		chartRepo: def.chartRepo,
		chart: def.chart,
		version: row.version ?? def.version,
		namespace: def.namespace,
		values,
		syncWave: def.syncWave,
	};
}
