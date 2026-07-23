// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The cluster add-on catalog — a code SSOT (no DB enum, like lib/alerts/catalog.ts) of free
// OSS Helm charts the customer's cluster can come up with. Each entry pins a chart + a small
// set of user-tunable knobs. The engine (packages/core/argocd/addons.go) renders ANY entry
// without code changes, so growing the catalog is data, not plumbing. v1 seeds the L10
// observability stack; the broader backlog (security/secrets/networking/…) lands per the
// plan's catalog table.

import { asRecord } from "@/lib/records";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
	type ChartWorkloadOverlay,
	composeChartOverlay,
} from "./chart-overlay";
import { hasStoredSecret, secretFieldKeys, stripAddonSecrets } from "./secrets";
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
				asRecord(b),
				asRecord(v),
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

/** The curated catalog. Ordered for display; grouped by category in the UI.
 *
 * SSOT: this array is the single source of truth for the marketplace add-on set. Its length is
 * guarded by tests/lib/addons/catalog-count.test.ts (the BYOC proof's ArgoCD expected-set
 * derivation depends on it) — a deliberate add/remove here must update that test. */
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
			/** How often Prometheus scrapes targets. */
			scrapeInterval: z.enum(["15s", "30s", "60s"]).default("30s"),
			/** Bundle Grafana dashboards. */
			grafana: z.boolean().default(true),
			/** Grafana admin username (paired with the password in the same admin Secret). */
			adminUser: z.string().min(1).default("admin"),
			/** Grafana admin password (secret — encrypted at rest; empty = chart-generated). */
			adminPassword: z.string().default(""),
			/** Deploy Alertmanager alongside Prometheus. */
			alertmanager: z.boolean().default(true),
		}),
		toValues: (c) => ({
			grafana: { enabled: c.grafana },
			alertmanager: { enabled: c.alertmanager },
			prometheus: {
				prometheusSpec: {
					retention: `${c.retentionDays}d`,
					scrapeInterval: c.scrapeInterval,
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
		// Grafana's chart resolves BOTH admin user and password from ONE Secret
		// (`grafana.admin.existingSecret` + userKey/passwordKey — verified via
		// `helm template kube-prometheus-stack --version 61.9.0`). The password rides the
		// #640 runner-seeded Secret; the username is not a secret, so it pairs in via
		// secretStaticData. No stored password ⇒ no wiring (chart generates its own).
		secretValues: (refs) =>
			refs.adminPassword
				? {
						grafana: {
							admin: {
								existingSecret: refs.adminPassword.name,
								userKey: "adminUser",
								passwordKey: "adminPassword",
							},
						},
					}
				: {},
		secretStaticData: (c) => ({ adminUser: c.adminUser }),
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
				key: "scrapeInterval",
				label: "Scrape interval",
				type: "enum",
				default: "30s",
				options: [
					{ value: "15s", label: "15 seconds" },
					{ value: "30s", label: "30 seconds" },
					{ value: "60s", label: "60 seconds" },
				],
			},
			{
				key: "grafana",
				label: "Bundle Grafana dashboards",
				type: "boolean",
				default: true,
			},
			{
				key: "adminUser",
				label: "Grafana admin username",
				type: "string",
				default: "admin",
			},
			{
				key: "adminPassword",
				label: "Grafana admin password",
				type: "secret",
				secret: true,
				help: "Stored encrypted; delivered to the cluster as a k8s Secret — never in the manifest. Empty = the chart generates one.",
			},
			{
				key: "alertmanager",
				label: "Enable Alertmanager",
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
			/** Persistent volume size for the single-binary store (GiB). */
			storageGb: z.coerce.number().int().min(5).max(1000).default(10),
		}),
		toValues: (c) => ({
			loki: {
				limits_config: {
					retention_period: c.retentionDays > 0 ? `${c.retentionDays * 24}h` : "0s",
				},
			},
			singleBinary: { persistence: { size: `${c.storageGb}Gi` } },
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
			{
				key: "storageGb",
				label: "Log storage (GiB)",
				type: "number",
				default: 10,
				min: 5,
				max: 1000,
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
		configSchema: z.object({
			/** Controller replicas (raise for HA). */
			replicas: z.coerce.number().int().min(1).max(5).default(1),
			/** Expose a Prometheus ServiceMonitor for cert-manager metrics. */
			serviceMonitor: z.boolean().default(false),
		}),
		toValues: (c) => ({
			replicaCount: c.replicas,
			prometheus: { enabled: true, servicemonitor: { enabled: c.serviceMonitor } },
		}),
		fields: [
			{ key: "replicas", label: "Controller replicas", type: "number", default: 1, min: 1, max: 5 },
			{
				key: "serviceMonitor",
				label: "Prometheus ServiceMonitor",
				type: "boolean",
				default: false,
			},
		],
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
		configSchema: z.object({
			/** Controller replicas (raise for HA). */
			replicas: z.coerce.number().int().min(1).max(10).default(1),
			/** How the controller is exposed. LoadBalancer needs a cloud LB; NodePort/ClusterIP don't. */
			serviceType: z.enum(["LoadBalancer", "NodePort", "ClusterIP"]).default("LoadBalancer"),
			/** Expose Prometheus metrics for the controller. */
			metrics: z.boolean().default(false),
		}),
		toValues: (c) => ({
			controller: {
				replicaCount: c.replicas,
				service: { type: c.serviceType },
				metrics: { enabled: c.metrics },
			},
		}),
		fields: [
			{ key: "replicas", label: "Controller replicas", type: "number", default: 1, min: 1, max: 10 },
			{
				key: "serviceType",
				label: "Service type",
				type: "enum",
				default: "LoadBalancer",
				options: [
					{ value: "LoadBalancer", label: "LoadBalancer" },
					{ value: "NodePort", label: "NodePort" },
					{ value: "ClusterIP", label: "ClusterIP" },
				],
			},
			{ key: "metrics", label: "Enable metrics", type: "boolean", default: false },
		],
		syncWave: 1,
		requires: ["ingress"],
	}),
	defineAddOn({
		id: "velero",
		name: "Velero",
		category: "backup",
		icon: "Archive",
		summary:
			"Cluster backup + restore + migration to an object-store backup location — set the provider, bucket, and region below.",
		docsUrl: "https://velero.io/docs/latest/",
		license: "Apache-2.0",
		chartRepo: "https://vmware-tanzu.github.io/helm-charts",
		chart: "velero",
		version: "7.2.1",
		namespace: "velero",
		defaultValues: { snapshotsEnabled: true },
		configSchema: z.object({
			/** Object-store provider for the backup location (the velero plugin's provider name). */
			provider: z.enum(["aws", "gcp", "azure"]).default("aws"),
			/** Backup bucket name. Empty = no backup location configured (velero installs unconfigured). */
			bucket: z.string().default(""),
			/** Bucket region (AWS/S3-compatible). */
			region: z.string().default(""),
			/** Also back up file volumes (deploys the node-agent DaemonSet). */
			deployNodeAgent: z.boolean().default(false),
			/** Take cloud volume snapshots alongside object-store backups. */
			snapshotsEnabled: z.boolean().default(true),
			/** Provider credentials FILE contents (secret — the velero plugin's cloud file;
			 * mounted from the runner-seeded Secret's `cloud` key, never inlined). */
			cloud: z.string().default(""),
		}),
		toValues: (c) => ({
			snapshotsEnabled: c.snapshotsEnabled,
			deployNodeAgent: c.deployNodeAgent,
			...(c.bucket
				? {
						configuration: {
							backupStorageLocation: [
								{
									name: "default",
									provider: c.provider,
									bucket: c.bucket,
									default: true,
									...(c.region ? { config: { region: c.region } } : {}),
								},
							],
						},
					}
				: {}),
		}),
		// Velero mounts `credentials.existingSecret` at /credentials and every provider env
		// (AWS_SHARED_CREDENTIALS_FILE, GOOGLE_APPLICATION_CREDENTIALS, …) points at the
		// fixed `cloud` KEY inside it — verified via `helm template velero --version 7.2.1`.
		// The field key is therefore `cloud`, and the whole credentials file rides the #640
		// runner-seeded Secret (NEVER `secretContents.cloud`, which would inline it).
		secretValues: (refs) =>
			refs.cloud ? { credentials: { existingSecret: refs.cloud.name } } : {},
		fields: [
			{
				key: "provider",
				label: "Backup provider",
				type: "enum",
				default: "aws",
				options: [
					{ value: "aws", label: "AWS S3 / S3-compatible" },
					{ value: "gcp", label: "Google Cloud Storage" },
					{ value: "azure", label: "Azure Blob" },
				],
			},
			{ key: "bucket", label: "Backup bucket", type: "string", default: "" },
			{ key: "region", label: "Region (AWS/S3)", type: "string", default: "" },
			{ key: "deployNodeAgent", label: "Back up file volumes (node-agent)", type: "boolean", default: false },
			{ key: "snapshotsEnabled", label: "Volume snapshots", type: "boolean", default: true },
			{
				key: "cloud",
				label: "Provider credentials file",
				type: "secret",
				secret: true,
				help: "The velero plugin's credentials file contents (e.g. an AWS credentials profile). Stored encrypted; delivered as a k8s Secret the chart mounts — never in the manifest.",
			},
		],
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
		configSchema: z.object({
			/** Admission-controller replicas (≥3 recommended for HA / production). */
			replicas: z.coerce.number().int().min(1).max(5).default(3),
			/** Run the background controller (scans + generates on existing resources). */
			backgroundScan: z.boolean().default(true),
		}),
		toValues: (c) => ({
			admissionController: { replicas: c.replicas },
			backgroundController: { enabled: c.backgroundScan },
		}),
		fields: [
			{ key: "replicas", label: "Admission replicas", type: "number", default: 3, min: 1, max: 5 },
			{
				key: "backgroundScan",
				label: "Background controller",
				type: "boolean",
				default: true,
			},
		],
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
		configSchema: z.object({
			/** How long traces are retained. */
			retentionHours: z.coerce.number().int().min(1).max(8760).default(24),
			/** Persistent volume size for the trace store (GiB). */
			storageGb: z.coerce.number().int().min(5).max(1000).default(10),
		}),
		toValues: (c) => ({
			tempo: { retention: `${c.retentionHours}h` },
			persistence: { enabled: true, size: `${c.storageGb}Gi` },
		}),
		fields: [
			{ key: "retentionHours", label: "Trace retention (hours)", type: "number", default: 24, min: 1, max: 8760 },
			{ key: "storageGb", label: "Trace storage (GiB)", type: "number", default: 10, min: 5, max: 1000 },
		],
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
		configSchema: z.object({
			/** Deployment topology: one Deployment, a per-node DaemonSet, or a StatefulSet. */
			mode: z.enum(["deployment", "daemonset", "statefulset"]).default("deployment"),
			/** Replicas (deployment/statefulset modes; ignored for daemonset). */
			replicas: z.coerce.number().int().min(1).max(10).default(1),
		}),
		toValues: (c) => ({
			mode: c.mode,
			replicaCount: c.replicas,
		}),
		fields: [
			{
				key: "mode",
				label: "Mode",
				type: "enum",
				default: "deployment",
				options: [
					{ value: "deployment", label: "Deployment" },
					{ value: "daemonset", label: "DaemonSet (per node)" },
					{ value: "statefulset", label: "StatefulSet" },
				],
			},
			{ key: "replicas", label: "Replicas", type: "number", default: 1, min: 1, max: 10 },
		],
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
		configSchema: z.object({
			/** Install the Vertical Pod Autoscaler dependency Goldilocks needs for recommendations. */
			vpa: z.boolean().default(false),
			/** Dashboard replicas. */
			dashboardReplicas: z.coerce.number().int().min(1).max(5).default(2),
		}),
		toValues: (c) => ({
			vpa: { enabled: c.vpa },
			dashboard: { replicaCount: c.dashboardReplicas },
		}),
		fields: [
			{ key: "vpa", label: "Install VPA", type: "boolean", default: false },
			{ key: "dashboardReplicas", label: "Dashboard replicas", type: "number", default: 2, min: 1, max: 5 },
		],
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
		configSchema: z.object({
			/** Syscall capture driver. `auto` picks the best available for the kernel. */
			driver: z.enum(["auto", "modern_ebpf", "ebpf", "kmod"]).default("auto"),
			/** Emit events as JSON (recommended for log pipelines). */
			jsonOutput: z.boolean().default(false),
			/** Deploy Falcosidekick to fan out alerts to external destinations. */
			falcosidekick: z.boolean().default(false),
		}),
		toValues: (c) => ({
			driver: { kind: c.driver },
			falco: { json_output: c.jsonOutput },
			falcosidekick: { enabled: c.falcosidekick },
		}),
		fields: [
			{
				key: "driver",
				label: "Driver",
				type: "enum",
				default: "auto",
				options: [
					{ value: "auto", label: "Auto" },
					{ value: "modern_ebpf", label: "Modern eBPF" },
					{ value: "ebpf", label: "eBPF" },
					{ value: "kmod", label: "Kernel module" },
				],
			},
			{ key: "jsonOutput", label: "JSON output", type: "boolean", default: false },
			{ key: "falcosidekick", label: "Enable Falcosidekick", type: "boolean", default: false },
		],
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
		chartRepo: "https://bitnami.github.io/sealed-secrets",
		chart: "sealed-secrets",
		version: "2.16.1",
		namespace: "kube-system",
		configSchema: z.object({
			/** Sealing-key renewal period in days (0 = never renew). */
			keyRenewalDays: z.coerce.number().int().min(0).max(365).default(30),
		}),
		toValues: (c) => ({
			keyrenewperiod: c.keyRenewalDays > 0 ? `${c.keyRenewalDays * 24}h` : "0",
		}),
		fields: [
			{
				key: "keyRenewalDays",
				label: "Key renewal (days, 0 = never)",
				type: "number",
				default: 30,
				min: 0,
				max: 365,
			},
		],
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
		configSchema: z.object({
			/** Watch all namespaces (off = only namespaces/resources with the reloader annotation). */
			watchGlobally: z.boolean().default(true),
			/** Reloader replicas. */
			replicas: z.coerce.number().int().min(1).max(3).default(1),
		}),
		toValues: (c) => ({
			reloader: {
				watchGlobally: c.watchGlobally,
				deployment: { replicas: c.replicas },
			},
		}),
		fields: [
			{ key: "watchGlobally", label: "Watch all namespaces", type: "boolean", default: true },
			{ key: "replicas", label: "Replicas", type: "number", default: 1, min: 1, max: 3 },
		],
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
		configSchema: z.object({
			/** Operator replicas (raise for HA). */
			replicas: z.coerce.number().int().min(1).max(3).default(1),
		}),
		toValues: (c) => ({
			operator: { replicaCount: c.replicas },
		}),
		fields: [
			{ key: "replicas", label: "Operator replicas", type: "number", default: 1, min: 1, max: 3 },
		],
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
		configSchema: z.object({
			/** Controller replicas (raise for HA). */
			replicas: z.coerce.number().int().min(1).max(5).default(2),
			/** Deploy the Argo Rollouts dashboard. */
			dashboard: z.boolean().default(false),
		}),
		toValues: (c) => ({
			controller: { replicas: c.replicas },
			dashboard: { enabled: c.dashboard },
		}),
		fields: [
			{ key: "replicas", label: "Controller replicas", type: "number", default: 2, min: 1, max: 5 },
			{ key: "dashboard", label: "Enable dashboard", type: "boolean", default: false },
		],
		syncWave: 2,
	}),
	// ── OSS parity add-ons: S3/registry/DNS equivalents so a compute-only cloud (Hetzner)
	//    reaches AWS-level breadth without managed services. Cloud-agnostic — run on any cluster.
	defineAddOn({
		id: "minio",
		name: "MinIO",
		category: "data",
		icon: "Boxes",
		summary:
			"S3-compatible object storage in your cluster — buckets, versioning, and an S3 API for apps and backups (a self-hosted S3).",
		docsUrl: "https://min.io/docs/minio/kubernetes/upstream/",
		license: "AGPL-3.0",
		chartRepo: "https://charts.min.io/",
		chart: "minio",
		version: "5.2.0",
		namespace: "minio",
		defaultValues: { mode: "standalone" },
		configSchema: z.object({
			/** Persistent volume size for MinIO (GiB). */
			storageGb: z.coerce.number().int().min(5).max(2000).default(50),
			/** standalone (single node) or distributed (HA, ≥4 drives). */
			mode: z.enum(["standalone", "distributed"]).default("standalone"),
			/** Root (admin) username — paired with the password in the same Secret. */
			rootUser: z.string().min(3).default("admin"),
			/** Root password (secret — encrypted at rest; empty = chart-generated). */
			rootPassword: z.string().default(""),
		}),
		toValues: (c) => ({
			mode: c.mode,
			persistence: { size: `${c.storageGb}Gi` },
		}),
		// The minio chart's `existingSecret` reads FIXED keys `rootUser`/`rootPassword`
		// (verified via `helm template minio --version 5.2.0` — MINIO_ROOT_USER/_PASSWORD
		// secretKeyRefs). Field keys match; the username pairs in via secretStaticData.
		secretValues: (refs) =>
			refs.rootPassword ? { existingSecret: refs.rootPassword.name } : {},
		secretStaticData: (c) => ({ rootUser: c.rootUser }),
		fields: [
			{ key: "storageGb", label: "Storage (GiB)", type: "number", default: 50, min: 5, max: 2000 },
			{
				key: "mode",
				label: "Mode",
				type: "enum",
				default: "standalone",
				options: [
					{ value: "standalone", label: "Standalone (single node)" },
					{ value: "distributed", label: "Distributed (HA, ≥4 drives)" },
				],
			},
			{ key: "rootUser", label: "Root username", type: "string", default: "admin" },
			{
				key: "rootPassword",
				label: "Root password",
				type: "secret",
				secret: true,
				help: "Stored encrypted; delivered to the cluster as a k8s Secret — never in the manifest. Empty = the chart generates one.",
			},
		],
		syncWave: 2,
		requires: ["storage"],
	}),
	defineAddOn({
		id: "harbor",
		name: "Harbor",
		category: "platform",
		icon: "Boxes",
		summary:
			"Private OCI container registry with vulnerability scanning, RBAC, and image signing — a self-hosted ECR/GCR/ACR.",
		docsUrl: "https://goharbor.io/docs/",
		license: "Apache-2.0",
		chartRepo: "https://helm.goharbor.io",
		chart: "harbor",
		version: "1.15.1",
		namespace: "harbor",
		configSchema: z.object({
			/** Persistent volume size for the registry store (GiB). */
			storageGb: z.coerce.number().int().min(10).max(2000).default(50),
			/** How the registry is exposed outside the cluster. */
			exposeType: z
				.enum(["ingress", "clusterIP", "nodePort", "loadBalancer"])
				.default("ingress"),
			/** Harbor admin password (secret — encrypted at rest; empty = chart default). */
			adminPassword: z.string().default(""),
		}),
		toValues: (c) => ({
			persistence: {
				persistentVolumeClaim: { registry: { size: `${c.storageGb}Gi` } },
			},
			expose: { type: c.exposeType },
		}),
		// Harbor reads HARBOR_ADMIN_PASSWORD from `existingSecretAdminPassword` at the key
		// named by `existingSecretAdminPasswordKey` — verified via `helm template harbor
		// --version 1.15.1`. Rides the #640 runner-seeded Secret.
		secretValues: (refs) =>
			refs.adminPassword
				? {
						existingSecretAdminPassword: refs.adminPassword.name,
						existingSecretAdminPasswordKey: "adminPassword",
					}
				: {},
		fields: [
			{ key: "storageGb", label: "Registry storage (GiB)", type: "number", default: 50, min: 10, max: 2000 },
			{
				key: "exposeType",
				label: "Expose type",
				type: "enum",
				default: "ingress",
				options: [
					{ value: "ingress", label: "Ingress" },
					{ value: "clusterIP", label: "ClusterIP" },
					{ value: "nodePort", label: "NodePort" },
					{ value: "loadBalancer", label: "LoadBalancer" },
				],
			},
			{
				key: "adminPassword",
				label: "Admin password",
				type: "secret",
				secret: true,
				help: "Stored encrypted; delivered to the cluster as a k8s Secret — never in the manifest. Empty = the chart default (change it on first login).",
			},
		],
		syncWave: 2,
		requires: ["storage"],
	}),
	defineAddOn({
		id: "external-dns",
		name: "ExternalDNS",
		category: "networking",
		icon: "Network",
		summary:
			"Automatically manages DNS records for your Services and Ingresses in an external DNS provider (Hetzner, Cloudflare, …).",
		docsUrl: "https://kubernetes-sigs.github.io/external-dns/latest/",
		license: "Apache-2.0",
		chartRepo: "https://kubernetes-sigs.github.io/external-dns/",
		chart: "external-dns",
		version: "1.15.0",
		namespace: "external-dns",
		configSchema: z.object({
			/** DNS provider the controller writes records to (a fixed choice — enum). */
			provider: z
				.enum(["cloudflare", "hetzner", "aws", "google", "azure", "digitalocean"])
				.default("cloudflare"),
			/** Restrict record management to this domain (optional). */
			domainFilter: z.string().default(""),
			/** Provider API token (secret — encrypted at rest). Cloudflare's CF_API_TOKEN for now;
			 * other providers wire their own env in a follow-up. */
			apiToken: z.string().default(""),
		}),
		toValues: (c) => ({
			provider: { name: c.provider },
			...(c.domainFilter ? { domainFilters: [c.domainFilter] } : {}),
			// The API token deliberately does NOT appear here (W4.5): toValues never sees
			// secret knobs. The token reaches the chart via `secretValues` below — an env
			// valueFrom.secretKeyRef into the runner-seeded Secret, the same shape the
			// platform's own infra external-dns uses (infra/templates/argocd/external-dns.yaml).
		}),
		secretValues: (refs, c) => {
			const ref = refs.apiToken;
			if (!ref) return {};
			// Provider token env var (cloudflare's CF_API_TOKEN for now — matching the
			// pre-W4.5 wiring; other providers add their own env names in a follow-up).
			const envName = c.provider === "digitalocean" ? "DO_TOKEN" : "CF_API_TOKEN";
			return {
				env: [
					{
						name: envName,
						valueFrom: { secretKeyRef: { name: ref.name, key: ref.key } },
					},
				],
			};
		},
		fields: [
			{
				key: "provider",
				label: "DNS provider",
				type: "enum",
				default: "cloudflare",
				options: [
					{ value: "cloudflare", label: "Cloudflare" },
					{ value: "hetzner", label: "Hetzner" },
					{ value: "aws", label: "AWS Route 53" },
					{ value: "google", label: "Google Cloud DNS" },
					{ value: "azure", label: "Azure DNS" },
					{ value: "digitalocean", label: "DigitalOcean" },
				],
			},
			{ key: "domainFilter", label: "Domain filter (optional)", type: "string", default: "" },
			{ key: "apiToken", label: "Provider API token", type: "secret", secret: true },
		],
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
			return asRecord(parsed);
		}
	} catch {
		// Malformed YAML — ignore (the enable action validates before persisting).
	}
	return null;
}

/** The deterministic name of the k8s Secret the runner seeds for an add-on's secret knobs
 * (W4.5). Per-add-on, in the add-on's install namespace — distinct from the platform's own
 * infra secrets (e.g. `external-dns-cloudflare` in the infra external-dns). */
export function addonSecretName(addonId: string): string {
	return `alethia-addon-${addonId}`;
}

/**
 * Resolves an enabled `project_addons` row into the runner-facing install spec: pins the
 * chart coords, validates + defaults the stored knobs, and deep-merges them onto the add-on's
 * base values. Returns null when the add-on id is no longer in the catalog (so a retired
 * add-on is skipped, not mis-provisioned).
 *
 * SECRET knobs (W4.5, #640): their values are NEVER resolved here — they are stripped before
 * validation (the schema default applies), so neither `toValues` nor the returned `values`
 * can carry a credential, and nothing plaintext enters the DEPLOY job's config snapshot.
 * Instead the spec carries a `secretRef` (deterministic Secret name + the data keys); the
 * runner fetches the plaintext at execution time over the authenticated job channel and
 * seeds the Secret in-cluster, and the def's `secretValues` wires the chart at it.
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
	const stored = row.values ?? {};
	// Strip secret-typed knobs BEFORE validation — the schema sees its default, never a
	// credential (neither an EncryptedSecret envelope nor a legacy pre-W4 plaintext).
	const sansSecrets = stripAddonSecrets(def, stored);
	// Validate the stored knobs; fall back to schema defaults on any mismatch so a stale row
	// never blocks a deploy.
	const parsed = def.configSchema.safeParse(sansSecrets);
	const config = parsed.success ? parsed.data : def.configSchema.parse({});
	const knobValues = def.toValues ? def.toValues(config) : {};
	// Which secret fields actually HAVE a stored value → the Secret's data keys + the refs
	// handed to the def's chart wiring.
	const secretKeys = secretFieldKeys(def).filter((k) => hasStoredSecret(stored[k]));
	const secretName = addonSecretName(def.id);
	const refs = Object.fromEntries(
		secretKeys.map((k) => [k, { name: secretName, key: k }]),
	);
	const secretWiring =
		secretKeys.length > 0 && def.secretValues ? def.secretValues(refs, config) : {};
	// Precedence (low → high): chart defaults → schema knobs → secret wiring → the user's raw
	// Helm-values YAML. Unparseable raw YAML is ignored (the save-time action validates it) so
	// it never blocks a deploy.
	let values = deepMerge(def.defaultValues ?? {}, knobValues);
	values = deepMerge(values, secretWiring);
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
		...(secretKeys.length > 0
			? {
					secretRef: {
						secretName,
						namespace: def.namespace,
						keys: secretKeys,
						// Paired NON-secret Secret data (#644): e.g. the admin USERNAME a chart
						// reads from the same Secret as the password. Snapshot-safe by contract.
						...(def.secretStaticData
							? { staticData: def.secretStaticData(config) }
							: {}),
					},
				}
			: {}),
	};
}

/** The sync-wave BYO charts install on — after core infra add-ons (0) so a chart depending on,
 * say, an ingress controller finds it present. */
const BYO_CHART_SYNC_WAVE = 5;

/**
 * Resolves a bring-your-own (source='byo') project_addons row into a git-source install spec the
 * runner renders as an ArgoCD Application inside the project's hardened "byo-<slug>" AppProject.
 * The chart comes from the customer's git repo (chart_repo + chart_path + version=ref), NOT the
 * OSS catalog — so there is no schema to validate against; the stored `values` ride through as-is,
 * with a raw Helm-values YAML override deep-merged on top (same precedence as catalog add-ons).
 * Returns null when required git coordinates are missing (a mis-built row is skipped, never
 * mis-provisioned).
 */
export function resolveByoChartInstall(
	row: {
		addon_id: string;
		mode: AddOnMode;
		version?: string | null;
		chart_repo?: string | null;
		chart_path?: string | null;
		namespace?: string | null;
		values?: Record<string, unknown> | null;
		values_yaml?: string | null;
	},
	// The described workloads' user overlay (W5 Lane 2). Their static config (replicas/env) is
	// composed onto the pristine `values` at each knob's value-path — see lib/addons/chart-overlay.
	// Binding write-back is runner-side (Lane 2b) and intentionally not composed here.
	workloads: ChartWorkloadOverlay[] = [],
): AddOnInstallSpec | null {
	if (!row.chart_repo) return null;
	// An `oci://` repo is a private OCI Helm registry (source='helm'); anything else is a git repo
	// (source='git') whose chart lives at chart_path.
	const isOci = row.chart_repo.startsWith("oci://");
	if (!isOci && !row.chart_path) return null;
	// Precedence (low → high): pristine project_addons.values → workload config overlay → raw YAML.
	let values: Record<string, unknown> = { ...(row.values ?? {}) };
	if (workloads.length > 0) {
		values = composeChartOverlay(values, workloads).values;
	}
	const rawOverride = parseValuesYaml(row.values_yaml);
	if (rawOverride) values = deepMerge(values, rawOverride);
	// Forward the workloads' bindings + value_paths for the runner to resolve at deploy (Lane 2b):
	// only those with bindings (the runtime write-back is the only reason the runner needs them).
	const bound = workloads
		.filter((w) => w.bindings.length > 0)
		.map((w) => ({
			name: w.name,
			bindings: w.bindings,
			valuePaths: w.value_paths,
		}));
	if (isOci) {
		// Private OCI Helm chart. ArgoCD's OCI source splits `oci://<host>/<ns>/<chart>` into
		// repoURL (host + namespace, chart stripped) + chart (the last path segment) + targetRevision
		// (the chart version). We KEEP the `oci://` scheme so the Application repoURL is a prefix of
		// the seeded repo-cred `url` (e.g. cred `oci://ghcr.io` prefixes `oci://ghcr.io/acme`) — the
		// convention packages/core/argocd/helm_repo_secrets.go + the helm_registry_oci_* providers
		// already commit to. (Note: some ArgoCD versions want repoURL without the scheme; if that
		// surfaces, strip `oci://` on BOTH the Application and the seeded cred in lockstep.)
		const segments = row.chart_repo
			.slice("oci://".length)
			.replace(/\/+$/, "")
			.split("/")
			.filter(Boolean);
		const chart = segments.pop() ?? "";
		// Need at least a host AND a chart segment to address a chart.
		if (!chart || segments.length === 0) return null;
		return {
			id: row.addon_id,
			mode: row.mode,
			source: "helm",
			chartRepo: `oci://${segments.join("/")}`,
			// Unused for a helm source (the chart is named separately), but the spec requires it.
			path: "",
			chart,
			// The chart version (ArgoCD targetRevision); `*` = latest when unset.
			version: row.version || "*",
			namespace: row.namespace ?? "default",
			values,
			syncWave: BYO_CHART_SYNC_WAVE,
			...(bound.length > 0 ? { workloads: bound } : {}),
			// project is set by the runner (byo-<slug>); leave undefined here.
		};
	}
	return {
		id: row.addon_id,
		mode: row.mode,
		source: "git",
		chartRepo: row.chart_repo,
		// The chart directory within the repo (rendered as ArgoCD `source.path`).
		path: row.chart_path ?? "",
		// Unused for git source, but the spec requires the field; keep it empty.
		chart: "",
		// The git ref (branch/tag/sha); default to HEAD so an unset ref still resolves.
		version: row.version ?? "HEAD",
		namespace: row.namespace ?? "default",
		values,
		syncWave: BYO_CHART_SYNC_WAVE,
		...(bound.length > 0 ? { workloads: bound } : {}),
		// project is set by the runner (byo-<slug>); leave undefined here.
	};
}
