// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The cluster add-on catalog — a code SSOT (no DB enum, like lib/alerts/catalog.ts) of free
// OSS Helm charts the customer's cluster can come up with. Each entry pins a chart + a small
// set of user-tunable knobs. The engine (packages/core/argocd/addons.go) renders ANY entry
// without code changes, so growing the catalog is data, not plumbing. v1 seeds the L10
// observability stack; the broader backlog (security/secrets/networking/…) lands per the
// plan's catalog table.

import { parse as parseYaml } from "yaml";
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
	defineAddOn({
		id: "trivy-operator",
		name: "Trivy Operator",
		category: "security",
		icon: "ShieldCheck",
		summary:
			"Continuous in-cluster security scanning — vulnerabilities + misconfigurations, surfaced as Kubernetes reports.",
		docsUrl: "https://aquasecurity.github.io/trivy-operator/latest/",
		license: "Apache-2.0",
		chartRepo: "https://aquasecurity.github.io/helm-charts/",
		chart: "trivy-operator",
		version: "0.24.1",
		namespace: "trivy-system",
		defaultValues: { trivy: { ignoreUnfixed: true } },
		configSchema: z.object({
			/** Skip vulnerabilities with no available fix (reduces noise). */
			ignoreUnfixed: z.boolean().default(true),
		}),
		toValues: (c) => ({ trivy: { ignoreUnfixed: c.ignoreUnfixed } }),
		fields: [
			{
				key: "ignoreUnfixed",
				label: "Ignore unfixed vulnerabilities",
				type: "boolean",
				default: true,
			},
		],
		syncWave: 2,
	}),
	defineAddOn({
		id: "vault",
		name: "HashiCorp Vault",
		category: "secrets",
		icon: "KeyRound",
		summary:
			"In-cluster secrets management — dynamic secrets, encryption, and a UI (complements external-secrets-operator).",
		docsUrl: "https://developer.hashicorp.com/vault/docs/platform/k8s/helm",
		license: "BUSL-1.1",
		chartRepo: "https://helm.releases.hashicorp.com",
		chart: "vault",
		version: "0.28.1",
		namespace: "vault",
		defaultValues: { server: {} },
		configSchema: z.object({
			/** Enable the Vault web UI (ClusterIP service). */
			ui: z.boolean().default(true),
			/** High-availability (Raft) server instead of a single standalone pod. */
			ha: z.boolean().default(false),
		}),
		toValues: (c) => ({
			ui: { enabled: c.ui },
			server: { ha: { enabled: c.ha } },
		}),
		fields: [
			{ key: "ui", label: "Enable Vault UI", type: "boolean", default: true },
			{
				key: "ha",
				label: "High availability (Raft)",
				type: "boolean",
				default: false,
			},
		],
		syncWave: 2,
		requires: ["storage"],
	}),
	defineAddOn({
		id: "cert-manager",
		name: "cert-manager",
		category: "networking",
		icon: "Lock",
		summary:
			"Automated TLS certificates for the cluster — issues and renews certs (e.g. Let's Encrypt) for your ingress.",
		docsUrl: "https://cert-manager.io/docs/installation/helm/",
		license: "Apache-2.0",
		chartRepo: "https://charts.jetstack.io",
		chart: "cert-manager",
		version: "v1.15.3",
		namespace: "cert-manager",
		// Install the CRDs with the chart so ClusterIssuers/Certificates work out of the box.
		defaultValues: { crds: { enabled: true } },
		configSchema: z.object({}),
		fields: [],
		syncWave: 1,
	}),
	defineAddOn({
		id: "ingress-nginx",
		name: "Ingress NGINX",
		category: "networking",
		icon: "Network",
		summary:
			"The community NGINX ingress controller — routes external HTTP(S) traffic to your in-cluster services.",
		docsUrl: "https://kubernetes.github.io/ingress-nginx/",
		license: "Apache-2.0",
		chartRepo: "https://kubernetes.github.io/ingress-nginx",
		chart: "ingress-nginx",
		version: "4.11.2",
		namespace: "ingress-nginx",
		configSchema: z.object({}),
		fields: [],
		syncWave: 1,
		requires: ["ingress"],
	}),
	defineAddOn({
		id: "velero",
		name: "Velero",
		category: "backup",
		icon: "Archive",
		summary:
			"Cluster backup + restore + migration. Requires a cloud object-store backup location — set it under Advanced (raw values).",
		docsUrl: "https://velero.io/docs/latest/",
		license: "Apache-2.0",
		chartRepo: "https://vmware-tanzu.github.io/helm-charts",
		chart: "velero",
		version: "7.2.1",
		namespace: "velero",
		defaultValues: { snapshotsEnabled: true },
		configSchema: z.object({}),
		fields: [],
		syncWave: 3,
		requires: ["storage"],
	}),
	defineAddOn({
		id: "kyverno",
		name: "Kyverno",
		category: "policy",
		icon: "ShieldCheck",
		summary:
			"Kubernetes-native admission policy — validate, mutate, and generate resources with policies (no new language).",
		docsUrl: "https://kyverno.io/docs/installation/methods/",
		license: "Apache-2.0",
		chartRepo: "https://kyverno.github.io/kyverno/",
		chart: "kyverno",
		version: "3.2.6",
		namespace: "kyverno",
		configSchema: z.object({}),
		fields: [],
		syncWave: 1,
	}),
	defineAddOn({
		id: "tempo",
		name: "Grafana Tempo",
		category: "observability",
		icon: "LineChart",
		summary:
			"Distributed tracing backend — store and query traces in Grafana alongside metrics and logs.",
		docsUrl: "https://grafana.com/docs/tempo/latest/setup/helm-chart/",
		license: "AGPL-3.0",
		chartRepo: "https://grafana.github.io/helm-charts",
		chart: "tempo",
		version: "1.10.3",
		namespace: "monitoring",
		configSchema: z.object({}),
		fields: [],
		syncWave: 3,
		requires: ["storage"],
	}),
	defineAddOn({
		id: "opentelemetry-collector",
		name: "OpenTelemetry Collector",
		category: "observability",
		icon: "LineChart",
		summary:
			"Vendor-neutral pipeline for metrics, logs, and traces — receive, process, and export telemetry.",
		docsUrl:
			"https://github.com/open-telemetry/opentelemetry-helm-charts/tree/main/charts/opentelemetry-collector",
		license: "Apache-2.0",
		chartRepo: "https://open-telemetry.github.io/opentelemetry-helm-charts",
		chart: "opentelemetry-collector",
		version: "0.108.0",
		namespace: "observability",
		// The chart requires a mode + a config; a minimal OTLP-in/debug-out pipeline is a safe
		// starting point the customer tunes via Advanced values.
		defaultValues: {
			mode: "deployment",
			image: { repository: "otel/opentelemetry-collector-contrib" },
			config: {
				receivers: { otlp: { protocols: { grpc: {}, http: {} } } },
				exporters: { debug: {} },
				service: {
					pipelines: {
						traces: { receivers: ["otlp"], exporters: ["debug"] },
						metrics: { receivers: ["otlp"], exporters: ["debug"] },
						logs: { receivers: ["otlp"], exporters: ["debug"] },
					},
				},
			},
		},
		configSchema: z.object({}),
		fields: [],
		syncWave: 3,
	}),
	defineAddOn({
		id: "goldilocks",
		name: "Goldilocks",
		category: "observability",
		icon: "Gauge",
		summary:
			"Right-size your workloads — recommends CPU/memory requests + limits from actual usage (needs VPA).",
		docsUrl: "https://goldilocks.docs.fairwinds.com/installation/",
		license: "Apache-2.0",
		chartRepo: "https://charts.fairwinds.com/stable",
		chart: "goldilocks",
		version: "9.0.0",
		namespace: "goldilocks",
		configSchema: z.object({}),
		fields: [],
		syncWave: 4,
	}),
	defineAddOn({
		id: "falco",
		name: "Falco",
		category: "security",
		icon: "ShieldCheck",
		summary:
			"Runtime threat detection — flags anomalous container + host behaviour from kernel syscalls.",
		docsUrl: "https://falco.org/docs/setup/kubernetes/",
		license: "Apache-2.0",
		chartRepo: "https://falcosecurity.github.io/charts",
		chart: "falco",
		version: "4.9.0",
		namespace: "falco",
		configSchema: z.object({}),
		fields: [],
		syncWave: 2,
	}),
	defineAddOn({
		id: "sealed-secrets",
		name: "Sealed Secrets",
		category: "secrets",
		icon: "Lock",
		summary:
			"Encrypt secrets so they're safe to commit to Git — the controller decrypts them in-cluster.",
		docsUrl: "https://github.com/bitnami-labs/sealed-secrets#helm-chart",
		license: "Apache-2.0",
		chartRepo: "https://bitnami-labs.github.io/sealed-secrets",
		chart: "sealed-secrets",
		version: "2.16.1",
		namespace: "kube-system",
		configSchema: z.object({}),
		fields: [],
		syncWave: 1,
	}),
	defineAddOn({
		id: "reloader",
		name: "Reloader",
		category: "platform",
		icon: "Boxes",
		summary:
			"Auto-restart Deployments/StatefulSets when their ConfigMap or Secret changes — no manual rollout.",
		docsUrl: "https://github.com/stakater/Reloader#helm-charts",
		license: "Apache-2.0",
		chartRepo: "https://stakater.github.io/stakater-charts",
		chart: "reloader",
		version: "1.1.0",
		namespace: "reloader",
		configSchema: z.object({}),
		fields: [],
		syncWave: 1,
	}),
	defineAddOn({
		id: "keda",
		name: "KEDA",
		category: "autoscaling",
		icon: "Gauge",
		summary:
			"Event-driven autoscaling — scale workloads (to zero) on queue depth, cron, metrics, and 60+ sources.",
		docsUrl: "https://keda.sh/docs/latest/deploy/#helm",
		license: "Apache-2.0",
		chartRepo: "https://kedacore.github.io/charts",
		chart: "keda",
		version: "2.15.1",
		namespace: "keda",
		configSchema: z.object({}),
		fields: [],
		syncWave: 2,
	}),
	defineAddOn({
		id: "argo-rollouts",
		name: "Argo Rollouts",
		category: "autoscaling",
		icon: "Boxes",
		summary:
			"Progressive delivery — blue-green and canary deployments with automated analysis + rollback.",
		docsUrl: "https://argo-rollouts.readthedocs.io/en/stable/installation/",
		license: "Apache-2.0",
		chartRepo: "https://argoproj.github.io/argo-helm",
		chart: "argo-rollouts",
		version: "2.37.7",
		namespace: "argo-rollouts",
		configSchema: z.object({}),
		fields: [],
		syncWave: 2,
	}),
];

/** A catalog add-on id (the `project_addons.addon_id`). */
export type AddOnId = string;

/** Looks up a catalog entry by id, or null when the id is unknown/retired. */
export function getAddOn(id: string): AddOnDef | null {
	return ADDON_CATALOG.find((a) => a.id === id) ?? null;
}

/**
 * Parses a raw Helm-values YAML override into a plain object, or null when it's empty or not a
 * YAML mapping (a scalar/list is not a valid Helm values override). Never throws — resolution
 * treats a bad override as "no override".
 */
export function parseValuesYaml(
	yaml: string | null | undefined,
): Record<string, unknown> | null {
	if (!yaml || !yaml.trim()) return null;
	try {
		const parsed = parseYaml(yaml);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// Malformed YAML — ignore (the enable action validates before persisting).
	}
	return null;
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
	values_yaml?: string | null;
}): AddOnInstallSpec | null {
	const def = getAddOn(row.addon_id);
	if (!def) return null;
	// Validate the stored knobs; fall back to schema defaults on any mismatch so a stale row
	// never blocks a deploy.
	const parsed = def.configSchema.safeParse(row.values ?? {});
	const config = parsed.success ? parsed.data : def.configSchema.parse({});
	const knobValues = def.toValues ? def.toValues(config) : {};
	// Precedence (low → high): chart defaults → schema knobs → the user's raw Helm-values YAML.
	// Unparseable raw YAML is ignored (the save-time action validates it) so it never blocks a
	// deploy.
	let values = deepMerge(def.defaultValues ?? {}, knobValues);
	const rawOverride = parseValuesYaml(row.values_yaml);
	if (rawOverride) values = deepMerge(values, rawOverride);
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
