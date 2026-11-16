"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ClassificationControl } from "@/components/classification/classification-control";
import {
	CLUSTER_CARD_BLOCK,
	CLUSTER_CARD_FRAME,
	CLUSTER_COMPONENT_ROW,
	CLUSTER_OBSERVED_BLOCK,
	runInFlight,
} from "@/components/clusters/cluster-card-shape";
import { KubeconfigDownload } from "@/components/clusters/kubeconfig-download/kubeconfig-download";
import { RelativeStamp } from "@/components/environments/env-ui";
import type { ControlPlaneObservation } from "@/lib/clusters/observed-state";
import { getProvider } from "@/lib/cloud-providers";
import type { ClusterListItem } from "@/lib/rpc/procedures/clusters";
import { SectionHeading } from "@repo/ui/section-heading";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { Button } from "@repo/ui/button";
import { COPY_FAILED_MESSAGE } from "@repo/ui/copy-button";
import { copyText } from "@repo/ui/copy-text";
import { StatusBadge, statusTier, type StatusTier } from "@repo/ui/status-badge";
import {
	Boxes,
	Check,
	Copy,
	Database,
	ExternalLink,
	Globe,
	HardDrive,
	Server,
	Terminal,
	X,
} from "lucide-react";
import { useState } from "react";

/** The managed-Kubernetes product name per cloud — labels the control-plane row. */
const K8S_KIND: Record<string, string> = {
	aws: "EKS",
	gcp: "GKE",
	azure: "AKS",
	alibaba: "ACK",
	hetzner: "k8s",
};

/** Title-cases a SCREAMING_CASE component status ("UPDATING" → "Updating"). */
function humanize(status: string): string {
	return status.charAt(0) + status.slice(1).toLowerCase();
}

/** Component-health tally over the cluster + its data services. */
interface ComponentHealth {
	total: number;
	healthy: number;
	failed: number;
	pending: number;
}

/** A card's derived posture. */
interface Posture {
	tier: StatusTier;
	/** Posture shown next to the cluster name (what an operator scans). */
	name: string;
	/** Short mono rollup label. */
	rollup: string;
	/** The rollup badge's tier — the last run's outcome, which can differ from the cluster's. */
	rollupTier: StatusTier;
	/** Secondary mono detail under the rollup. */
	detail: string;
	health: ComponentHealth;
}

/** What the console has observed of the control plane, and since when the environment's status holds. */
export interface Observed {
	observation: ControlPlaneObservation;
	/** When the environment's status was last written (ISO). */
	statusSince: string;
}

/** No contradicting reading and a fresh one: what a caller that passes no observation means. */
const OBSERVED_FRESH: Observed = {
	observation: { kind: "reported", observedAt: null, source: "deploy", fresh: true },
	statusSince: new Date(0).toISOString(),
};

/**
 * The control plane's own badge: what was recorded, unless something observed since says otherwise.
 * A drift scan reporting it deleted reads "Missing"; a probe that could not reach it "Unreachable";
 * and an "Active" no reading has backed recently reads "Unverified" — the console has no fresh
 * evidence for it, so it does not repeat it (#6736).
 */
export function controlPlaneBadge(
	clusterStatus: string,
	observation: ControlPlaneObservation,
): { tier: StatusTier; label: string } {
	if (observation.kind === "missing") return { tier: "failed", label: "Missing" };
	if (observation.kind === "unreachable") return { tier: "failed", label: "Unreachable" };
	const tier = statusTier(clusterStatus);
	if (tier === "active" && !observation.fresh) return { tier: "idle", label: "Unverified" };
	return { tier, label: humanize(clusterStatus) };
}

/**
 * Rolls the cluster's own status and every database/cache status into a single posture, then lets
 * the ENVIRONMENT's lifecycle speak to what is happening to it. Every card is a cluster under
 * management — its environment has a live deployment (lib/queries/usage-counts.ts) — so:
 *   · a control plane a drift scan reports deleted reads as missing — unless a run started after
 *     that scan, which is then what is happening to it;
 *   · a run in flight (queued, provisioning, tearing down) reads as in flight;
 *   · a failed last run (a plan, a redeploy, a teardown) does NOT make a running cluster "Failed":
 *     the cluster keeps the posture its rows report, and the rollup says the last run failed;
 *   · otherwise a failed data service reads as degraded and a reconcile as reconciling;
 *   · and a control plane nothing has observed recently is never counted healthy (#6736).
 * The badge is DERIVED, never hardcoded.
 */
export function deriveHealth(
	clusterStatus: string,
	envStatus: string,
	componentStatuses: string[],
	observed: Observed = OBSERVED_FRESH,
): Posture {
	const { observation } = observed;
	const cp = controlPlaneBadge(clusterStatus, observation);
	const tiers = [cp.tier, ...componentStatuses.map((s) => statusTier(s))];
	const total = tiers.length;
	const healthy = tiers.filter((t) => t === "active").length;
	const failed = tiers.filter((t) => t === "failed").length;
	const pending = tiers.filter((t) => t === "pending").length;
	const health: ComponentHealth = { total, healthy, failed, pending };
	const detail = `${healthy} / ${total} healthy`;

	const envTier = statusTier(envStatus);
	const runAfterScan =
		observation.kind === "missing" && Date.parse(observed.statusSince) > Date.parse(observation.observedAt);
	if (observation.kind === "missing" && !(envTier === "pending" && runAfterScan)) {
		return { tier: "failed", name: "Missing", rollup: "Deleted outside Alethia", rollupTier: "failed", detail, health };
	}
	if (envTier === "pending") {
		return {
			tier: "pending",
			name: humanize(envStatus),
			rollup: envStatus === "DESTROYING" ? "Tearing down" : "Provisioning",
			rollupTier: "pending",
			detail,
			health,
		};
	}
	const posture = rowPosture(clusterStatus, cp, health, detail);
	return envTier === "failed" ? { ...posture, rollup: "Last run failed", rollupTier: "failed" } : posture;
}

/** The posture the cluster's own rows report, with no run in flight. */
function rowPosture(
	clusterStatus: string,
	cp: { tier: StatusTier; label: string },
	health: ComponentHealth,
	detail: string,
): Posture {
	const { total, healthy, failed, pending } = health;
	if (cp.tier === "failed" && cp.label === "Unreachable") {
		return { tier: "failed", name: "Unreachable", rollup: "Unreachable", rollupTier: "failed", detail, health };
	}
	if (failed > 0) {
		return { tier: "failed", name: "Degraded", rollup: `${failed} failed`, rollupTier: "failed", detail, health };
	}
	if (pending > 0) {
		// Surface the control plane's own in-flight verb when it's the one moving.
		const name = cp.tier === "pending" ? humanize(clusterStatus) : "Reconciling";
		return { tier: "pending", name, rollup: "Reconciling", rollupTier: "pending", detail, health };
	}
	if (healthy === total) {
		return { tier: "active", name: "Active", rollup: "Healthy", rollupTier: "active", detail, health };
	}
	if (cp.label === "Unverified") {
		return { tier: "idle", name: "Unverified", rollup: "Not observed recently", rollupTier: "idle", detail, health };
	}
	return { tier: cp.tier, name: cp.label, rollup: cp.label, rollupTier: cp.tier, detail, health };
}

/**
 * Copy-to-clipboard button used for endpoints and CLI commands. It confirms only a copy that
 * happened, and says so when it did not (the value beside it stays selectable).
 */
function CopyButton({ value, label }: { value: string; label: string }) {
	const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
	return (
		<Button
			variant="ghost"
			size="icon"
			className="h-6 w-6 shrink-0 text-text-tertiary"
			aria-label={state === "failed" ? COPY_FAILED_MESSAGE : label}
			title={state === "failed" ? COPY_FAILED_MESSAGE : undefined}
			onClick={async () => {
				const next = (await copyText(value)) ? "copied" : "failed";
				setState(next);
				setTimeout(() => setState("idle"), next === "copied" ? 2000 : 4000);
			}}
		>
			{state === "copied" ? (
				<Check className="h-3 w-3 text-text-primary" />
			) : state === "failed" ? (
				<X className="h-3 w-3 text-destructive" />
			) : (
				<Copy className="h-3 w-3" />
			)}
		</Button>
	);
}

/** A component row: icon + name + engine (+ endpoint) with its OWN derived status dot. */
function ComponentRow({
	icon: Icon,
	name,
	engine,
	endpoint,
	status,
	label,
	tier,
}: {
	icon: typeof Database;
	name: string;
	engine?: string | null;
	endpoint?: string | null;
	status: string;
	/** Overrides the badge label (e.g. DNS "Enabled" instead of the raw status). */
	label?: string;
	/** Overrides the tier the status resolves to (the control plane's is derived, not looked up). */
	tier?: StatusTier;
}) {
	return (
		<div className={CLUSTER_COMPONENT_ROW}>
			<Icon className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
			<span className="text-ui-sm text-text-primary">{name}</span>
			{engine && (
				<span className="font-mono text-ui-2xs text-text-tertiary">{engine}</span>
			)}
			{endpoint && (
				<div className="ml-auto flex min-w-0 items-center gap-1">
					<code className="max-w-[160px] truncate font-mono text-ui-2xs text-text-tertiary">
						{endpoint}
					</code>
					<CopyButton value={endpoint} label={`Copy ${name} endpoint`} />
				</div>
			)}
			<div className={endpoint ? "shrink-0" : "ml-auto shrink-0"}>
				<StatusBadge status={status} tier={tier} label={label ?? humanize(status)} />
			</div>
		</div>
	);
}

/**
 * When the card's status was last observed, and by what — so a status nothing has looked at for
 * months reads as months old (#6736). A run in flight says how long it has been in flight; a drift
 * scan that reports the control plane deleted names what it found gone.
 */
function ObservationLine({ observed, envStatus }: { observed: Observed; envStatus: string }) {
	const { observation } = observed;
	const inFlight = runInFlight(envStatus);
	return (
		<div data-slot="cluster-card-observed" className={`${CLUSTER_OBSERVED_BLOCK} text-ui-2xs text-text-tertiary`}>
			{inFlight && (
				<p>
					{humanize(envStatus)} since <RelativeStamp at={observed.statusSince} />
				</p>
			)}
			{observation.kind === "missing" && (
				<p className="text-text-secondary">
					Drift scan <RelativeStamp at={observation.observedAt} /> reports deleted:{" "}
					<span className="font-mono">{observation.deleted.join(", ")}</span>
				</p>
			)}
			{observation.kind === "unreachable" && (
				<p className="text-text-secondary">
					Probe <RelativeStamp at={observation.observedAt} /> could not reach the control plane
					{observation.message ? `: ${observation.message}` : ""}
				</p>
			)}
			{observation.kind === "reported" &&
				(observation.observedAt ? (
					<p>
						Control plane last observed <RelativeStamp at={observation.observedAt} />, by{" "}
						{observation.source === "probe" ? "a liveness probe" : "the last successful deploy"}
					</p>
				) : (
					<p>Control plane never observed</p>
				))}
		</div>
	);
}

/**
 * One cluster under management and its data services. Status is derived from the real read model:
 * the owning environment's lifecycle, `project_cluster.status` and each database/cache `status` roll
 * up into one posture, and every row carries its own `StatusBadge` — nothing is hardcoded to
 * "Active". Everything the card shows arrives with the clusters read: its chips and whether the
 * viewer may download a kubeconfig included, so it paints complete and asks nothing on mount.
 */
export function ClusterCard({ data }: { data: ClusterListItem }) {
	const provider = data.cloud_identities?.provider ?? "aws";
	const meta = getProvider(provider);
	const cluster = data.project_cluster;
	const databases = data.project_databases;
	const caches = data.project_caches;
	const dns = data.project_dns;

	const observed: Observed = { observation: cluster.observation, statusSince: data.status_since };
	const health = deriveHealth(
		cluster.status,
		data.status,
		[...databases.map((d) => d.status), ...caches.map((c) => c.status)],
		observed,
	);
	const controlPlane = controlPlaneBadge(cluster.status, cluster.observation);

	// How to get a kubeconfig — `alethia cluster kubeconfig` on every cloud it can mint on, and the
	// cloud's own CLI command as the alternative on aws/gcp/azure — built on the server by the same
	// module `alethia cluster get` prints from (lib/clusters/kubeconfig-access.ts), so the card never
	// composes a command of its own. A note replaces the command where there is none.
	const kubeconfigCmd = cluster.kubeconfig.command;
	const kubeconfigAlt = cluster.kubeconfig.alternative;
	const kubeconfigNote = cluster.kubeconfig.note;

	// The ArgoCD admin password is never stored (it would be plaintext in our DB); it is
	// retrieved on demand from the cluster's argocd-initial-admin-secret. Show the command.
	const argocdPasswordCmd =
		"kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d";

	return (
		<div className={CLUSTER_CARD_FRAME}>
			{/* Header: identity + derived posture rollup. */}
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 items-start gap-2.5">
					<ProviderIcon provider={provider} size={20} />
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-2">
							{/* The card's own heading rung, through the shared component: the card
							    used to hand-write an `<h3>` at `text-sm`, one of five sizes the
							    same rung was typeset at across the console.
							    `SectionHeading` fixes its heading at `text-ui-lg` whatever the
							    `level` — deliberately, so type scale is not chosen from the outline
							    — which inside an 18px-padded card over an 11px meta line would make
							    the title the largest type on the card, and larger than the sibling
							    environment card's name. The slot override keeps the card's rung and
							    takes only the tag from the component. */}
							<SectionHeading
								level={3}
								title={data.project_name}
								className="min-w-0 [&_[data-slot=section-heading-title]]:text-sm [&_[data-slot=section-heading-title]]:font-semibold"
							/>
							<StatusBadge status={health.tier} tier={health.tier} label={health.name} />
						</div>
						<p className="mt-0.5 font-mono text-ui-xs text-text-tertiary">
							{meta.shortName} · {data.region} · {data.environment_stage}
							{cluster.k8s_version ? ` · K8s ${cluster.k8s_version}` : ""}
						</p>
						<ClassificationControl
							kind="project_cluster"
							id={cluster.id}
							canEdit
							initialAssignments={data.classification}
							className="mt-1.5"
							compact
						/>
					</div>
				</div>
				<div className="shrink-0 text-right">
					<StatusBadge
						status={health.rollupTier}
						tier={health.rollupTier}
						label={health.rollup}
						className="justify-end"
					/>
					<div className="mt-1 font-mono text-ui-2xs tabular-nums text-text-tertiary">
						{health.detail}
					</div>
				</div>
			</div>

			{/* Components — each with its own derived status. */}
			<div className="flex flex-col border-t pt-1">
				<ComponentRow
					icon={Boxes}
					name="Control plane"
					engine={K8S_KIND[provider] ?? "k8s"}
					status={controlPlane.tier}
					tier={controlPlane.tier}
					label={controlPlane.label}
				/>
				{databases.map((db) => (
					<ComponentRow
						key={db.name}
						icon={Database}
						name={db.name}
						engine={db.engine}
						endpoint={db.endpoint}
						status={db.status}
					/>
				))}
				{caches.map((cache) => (
					<ComponentRow
						key={cache.name}
						icon={HardDrive}
						name={cache.name}
						engine={cache.engine}
						endpoint={cache.endpoint}
						status={cache.status}
					/>
				))}
				{dns?.domain_name && (
					<ComponentRow
						icon={Globe}
						name={dns.domain_name}
						engine="dns"
						status={dns.enabled ? "active" : "disabled"}
						label={dns.enabled ? "Enabled" : "Disabled"}
					/>
				)}
			</div>

			<ObservationLine observed={observed} envStatus={data.status} />

			{/* Cluster access. */}
			{cluster.cluster_endpoint && (
				<div className={CLUSTER_CARD_BLOCK}>
					<div className="flex items-center gap-1.5 text-text-tertiary">
						<Terminal className="h-3.5 w-3.5" />
						<span className="text-ui-xs font-medium text-text-secondary">
							Cluster access
						</span>
					</div>
					<div className="flex items-center gap-2">
						<code className="flex-1 truncate rounded-sm border bg-surface-sunken px-2 py-1 font-mono text-ui-xs text-text-secondary">
							{cluster.cluster_endpoint}
						</code>
						<CopyButton value={cluster.cluster_endpoint} label="Copy cluster endpoint" />
					</div>
					{kubeconfigCmd && (
						<div className="flex items-center gap-2">
							<code
								title={kubeconfigCmd}
								className="flex-1 truncate rounded-sm border bg-surface-sunken px-2 py-1 font-mono text-ui-xs text-text-secondary"
							>
								{kubeconfigCmd}
							</code>
							<CopyButton value={kubeconfigCmd} label="Copy kubeconfig command" />
						</div>
					)}
					{kubeconfigCmd && kubeconfigAlt && (
						<>
							<p className="text-ui-2xs text-text-tertiary">
								Or, with access to the cloud account:
							</p>
							<div className="flex items-center gap-2">
								<code
									title={kubeconfigAlt}
									className="flex-1 truncate rounded-sm border bg-surface-sunken px-2 py-1 font-mono text-ui-xs text-text-secondary"
								>
									{kubeconfigAlt}
								</code>
								<CopyButton value={kubeconfigAlt} label="Copy cloud CLI kubeconfig command" />
							</div>
						</>
					)}
					{!kubeconfigCmd && kubeconfigNote && (
						<p className="text-ui-2xs text-text-tertiary">{kubeconfigNote}</p>
					)}
					{/* Stage 2 (#5285): a short-lived read-only kubeconfig minted by the runner and
					    opened in this browser. Renders nothing without cluster:access_readonly. */}
					<KubeconfigDownload
						clusterId={cluster.id}
						projectName={data.project_name}
						environment={data.environment_stage}
						allowed={data.can_download_kubeconfig}
					/>
					{data.kubeconfig_download_note && (
						<p className="text-ui-2xs text-text-tertiary">{data.kubeconfig_download_note}</p>
					)}
				</div>
			)}

			{/* ArgoCD. */}
			{cluster.argocd_url && (
				<div className={CLUSTER_CARD_BLOCK}>
					<div className="flex items-center gap-1.5 text-text-tertiary">
						<Server className="h-3.5 w-3.5" />
						<span className="text-ui-xs font-medium text-text-secondary">ArgoCD</span>
					</div>
					<div className="flex items-center gap-2">
						<code className="flex-1 truncate rounded-sm border bg-surface-sunken px-2 py-1 font-mono text-ui-xs text-text-secondary">
							{cluster.argocd_url}
						</code>
						<a href={cluster.argocd_url} target="_blank" rel="noopener noreferrer">
							<Button
								variant="ghost"
								size="icon"
								className="h-6 w-6 shrink-0 text-text-tertiary"
								aria-label="Open ArgoCD"
							>
								<ExternalLink className="h-3 w-3" />
							</Button>
						</a>
					</div>
					<p className="text-ui-2xs text-text-tertiary">
						{kubeconfigCmd
							? "Admin password — after the kubeconfig command above, run:"
							: "Admin password — with a kubeconfig for this cluster, run:"}
					</p>
					<div className="flex items-center gap-2">
						<code className="flex-1 truncate rounded-sm border bg-surface-sunken px-2 py-1 font-mono text-ui-xs text-text-secondary">
							{argocdPasswordCmd}
						</code>
						<CopyButton value={argocdPasswordCmd} label="Copy ArgoCD admin password command" />
					</div>
				</div>
			)}
		</div>
	);
}
