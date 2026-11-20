"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One cluster's record, in the drawer a row of the clusters table opens: its components each with
// their own derived status, what was last observed of the control plane, the ways out of a cluster
// found deleted, how to reach it (endpoint, kubeconfig command, the read-only download) and ArgoCD.
// The table row carries what an operator scans; this carries what they act on.

import { ClassificationControl } from "@/components/classification/classification-control";
import {
	type Observed,
	type Posture,
	controlPlaneBadge,
	humanize,
	inFlightLabel,
	offersMissingActions,
	runInFlight,
} from "@/components/clusters/cluster-posture";
import { KubeconfigDownload } from "@/components/clusters/kubeconfig-download/kubeconfig-download";
import { MissingClusterActions } from "@/components/clusters/missing-cluster-actions";
import { RelativeStamp } from "@/components/environments/env-ui";
import { jobHref } from "@/components/jobs/columns";
import { getProvider } from "@/lib/cloud-providers";
import { ARCHITECTURE } from "@/lib/copy/vocabulary";
import { envHref, projectHref } from "@/lib/routing";
import type { ClusterListItem } from "@/lib/rpc/procedures/clusters";
import { Button } from "@repo/ui/button";
import { COPY_FAILED_MESSAGE } from "@repo/ui/copy-button";
import { copyText } from "@repo/ui/copy-text";
import { DetailSheet } from "@repo/ui/detail-sheet";
import { SectionHeading } from "@repo/ui/section-heading";
import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";
import { Boxes, Check, Copy, Database, ExternalLink, Globe, HardDrive, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

/** The managed-Kubernetes product name per cloud — labels the control-plane row. */
const K8S_KIND: Record<string, string> = {
	aws: "EKS",
	gcp: "GKE",
	azure: "AKS",
	alibaba: "ACK",
	hetzner: "k8s",
};

/** A titled block of the drawer. */
const BLOCK = "flex flex-col gap-2 border-t pt-4";

/** A code row's box: an endpoint or a command, beside its copy button. */
const CODE =
	"min-w-0 flex-1 truncate rounded-sm border bg-surface-sunken px-2 py-1 font-mono text-ui-xs text-text-secondary";

/** The cloud a cluster runs on, as the table and the drawer print it; null when it is not known. */
export function cloudLabel(data: Pick<ClusterListItem, "cloud_identities">): string | null {
	const provider = data.cloud_identities?.provider;
	return provider ? getProvider(provider).shortName : null;
}

/** The cluster's one-line identity: cloud, region, Kubernetes version. */
export function clusterMeta(cluster: ClusterListItem): string {
	const k8s = cluster.project_cluster.k8s_version;
	return [cloudLabel(cluster), cluster.region, k8s ? `Kubernetes ${k8s}` : null].filter(Boolean).join(" · ");
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

/** A code value with its copy button. */
function CodeRow({ value, label }: { value: string; label: string }) {
	return (
		<div className="flex items-center gap-2">
			<code title={value} className={CODE}>
				{value}
			</code>
			<CopyButton value={value} label={label} />
		</div>
	);
}

/** A component row: icon + name + engine (+ endpoint) with its OWN derived status. */
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
		<li data-slot="cluster-component" className="flex flex-wrap items-center gap-2.5 py-2 first:pt-0 last:pb-0">
			<Icon className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden />
			<span className="text-ui-sm text-text-primary">{name}</span>
			{engine && <span className="font-mono text-ui-2xs text-text-tertiary">{engine}</span>}
			{endpoint && (
				<div className="ml-auto flex min-w-0 items-center gap-1">
					<code className="max-w-[160px] truncate font-mono text-ui-2xs text-text-tertiary">{endpoint}</code>
					<CopyButton value={endpoint} label={`Copy ${name} endpoint`} />
				</div>
			)}
			<div className={endpoint ? "shrink-0" : "ml-auto shrink-0"}>
				<StatusBadge status={status} tier={tier} label={label ?? humanize(status)} />
			</div>
		</li>
	);
}

/**
 * When the cluster's status was last observed, and by what — so a status nothing has looked at for
 * months reads as months old (#6736). A run in flight says how long it has been in flight; a drift
 * scan that reports the control plane deleted names what it found gone. What a probe was told when
 * it could not reach the control plane is the cloud's own text, so it sits behind "Details" and the
 * sentence above it is the console's.
 */
function ObservationLine({ observed, envStatus }: { observed: Observed; envStatus: string }) {
	const { observation } = observed;
	return (
		<div data-slot="cluster-observed" className="flex flex-col gap-1 text-ui-xs text-text-tertiary">
			{runInFlight(envStatus) && (
				<p>
					{inFlightLabel(envStatus)} since <RelativeStamp at={observed.statusSince} />
				</p>
			)}
			{observation.kind === "missing" &&
				(observation.source === "drift" ? (
					<p className="text-text-secondary">
						Drift scan <RelativeStamp at={observation.observedAt} /> reports deleted:{" "}
						<span className="font-mono">{observation.deleted.join(", ")}</span>
					</p>
				) : (
					<p className="text-text-secondary">
						Probe <RelativeStamp at={observation.observedAt} /> found the cluster deleted: the cloud reports
						it not found
					</p>
				))}
			{observation.kind === "unreachable" && (
				<div className="text-text-secondary">
					<p>
						A probe <RelativeStamp at={observation.observedAt} /> could not reach the control plane. Check
						that the cluster is running and that the runner can reach its endpoint.
					</p>
					{observation.message && (
						<details className="mt-1">
							<summary className="cursor-pointer text-text-tertiary">Details</summary>
							<p className="mt-1 break-words font-mono text-ui-2xs">{observation.message}</p>
						</details>
					)}
				</div>
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
 * The drawer for one cluster. `cluster` is null while no row is open, and the drawer is then
 * closed.
 *
 * Everything it shows arrived with the clusters read — its chips and whether the viewer may
 * download a kubeconfig included — so it opens complete.
 */
export function ClusterDetailSheet({
	cluster,
	posture,
	orgSlug,
	onClose,
}: {
	cluster: ClusterListItem | null;
	/** The open cluster's posture, derived once by the table. */
	posture: Posture | null;
	orgSlug: string;
	onClose: () => void;
}) {
	return (
		<DetailSheet
			open={cluster !== null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={cluster ? `${cluster.environment_stage} · ${cluster.project_name}` : "Cluster"}
			description={cluster ? clusterMeta(cluster) : undefined}
			badge={posture ? <StatusBadge status={posture.tier} tier={posture.tier} label={posture.name} /> : null}
			footer={cluster ? <ClusterLinks cluster={cluster} orgSlug={orgSlug} /> : undefined}
			className="sm:max-w-lg"
		>
			{cluster && posture && <ClusterDetail cluster={cluster} posture={posture} orgSlug={orgSlug} />}
		</DetailSheet>
	);
}

/** Where a cluster's record leads: its project, its environment on the board, and its last run. */
function ClusterLinks({ cluster, orgSlug }: { cluster: ClusterListItem; orgSlug: string }) {
	const slug = cluster.project_slug;
	return (
		<div className="flex flex-wrap gap-2">
			{slug && (
				<Button variant="outline" size="sm" nativeButton={false} render={<Link href={projectHref(orgSlug, slug)} />}>
					Open project
				</Button>
			)}
			{slug && cluster.environment_id && (
				<Button
					variant="outline"
					size="sm"
					nativeButton={false}
					render={<Link href={envHref(orgSlug, slug, cluster.environment_id)} />}
				>
					Open {ARCHITECTURE}
				</Button>
			)}
			{cluster.last_job_id && (
				<Button
					variant="outline"
					size="sm"
					nativeButton={false}
					render={<Link href={jobHref(orgSlug, cluster.last_job_id)} />}
				>
					View last run
				</Button>
			)}
		</div>
	);
}

/** The drawer's body for one cluster. */
function ClusterDetail({
	cluster: data,
	posture,
	orgSlug,
}: {
	cluster: ClusterListItem;
	posture: Posture;
	orgSlug: string;
}) {
	const provider = data.cloud_identities?.provider ?? null;
	const cluster = data.project_cluster;
	const dns = data.project_dns;
	const observed: Observed = { observation: cluster.observation, statusSince: data.status_since };
	const controlPlane = controlPlaneBadge(cluster.status, cluster.observation);

	// How to get a kubeconfig — `alethia cluster kubeconfig` on every cloud it can mint on, and the
	// cloud's own CLI command as the alternative on aws/gcp/azure — built on the server by the same
	// module `alethia cluster get` prints from (lib/clusters/kubeconfig-access.ts), so the drawer
	// never composes a command of its own. A note replaces the command where there is none.
	const kubeconfigCmd = cluster.kubeconfig.command;
	const kubeconfigAlt = cluster.kubeconfig.alternative;
	const kubeconfigNote = cluster.kubeconfig.note;

	// The ArgoCD admin password is never stored (it would be plaintext in our DB); it is retrieved
	// on demand from the cluster's argocd-initial-admin-secret. Show the command.
	const argocdPasswordCmd =
		"kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d";

	return (
		<div className="flex flex-col gap-4">
			{/* The rollup, and what was last observed. */}
			<div className="flex flex-col gap-2">
				<div className="flex flex-wrap items-center gap-2">
					<StatusBadge status={posture.rollupTier} tier={posture.rollupTier} label={posture.rollup} />
					<span className="font-mono text-ui-2xs tabular-nums text-text-tertiary">{posture.detail}</span>
				</div>
				<ObservationLine observed={observed} envStatus={data.status} />
				<ClassificationControl
					kind="project_cluster"
					id={cluster.id}
					canEdit
					initialAssignments={data.classification}
					label={`${data.environment_stage} in ${data.project_name}`}
					compact
				/>
			</div>

			{/* A cluster found deleted outside Alethia: nothing changes by itself — these are the ways
			    out, each a click (#6736). */}
			{offersMissingActions(data) && data.environment_id && (
				<div className={BLOCK}>
					<SectionHeading level={3} title="Resolve the missing cluster" />
					<MissingClusterActions
						orgSlug={orgSlug}
						projectSlug={data.project_slug}
						projectId={data.id}
						environmentId={data.environment_id}
						environmentName={data.environment_stage}
					/>
				</div>
			)}

			{/* Components — each with its own derived status. */}
			<div className={BLOCK}>
				<SectionHeading level={3} title="Components" />
				<ul className="flex flex-col divide-y divide-border-faint">
					<ComponentRow
						icon={Boxes}
						name="Control plane"
						engine={provider ? (K8S_KIND[provider] ?? "k8s") : "k8s"}
						status={controlPlane.tier}
						tier={controlPlane.tier}
						label={controlPlane.label}
					/>
					{data.project_databases.map((db) => (
						<ComponentRow
							key={db.name}
							icon={Database}
							name={db.name}
							engine={db.engine}
							endpoint={db.endpoint}
							status={db.status}
						/>
					))}
					{data.project_caches.map((cache) => (
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
				</ul>
			</div>

			{/* Cluster access. */}
			{cluster.cluster_endpoint && (
				<div className={BLOCK} data-slot="cluster-access">
					<SectionHeading level={3} title="Cluster access" />
					<CodeRow value={cluster.cluster_endpoint} label="Copy cluster endpoint" />
					{kubeconfigCmd && <CodeRow value={kubeconfigCmd} label="Copy kubeconfig command" />}
					{kubeconfigCmd && kubeconfigAlt && (
						<>
							<p className="text-ui-xs text-text-tertiary">Or, with access to the cloud account:</p>
							<CodeRow value={kubeconfigAlt} label="Copy cloud CLI kubeconfig command" />
						</>
					)}
					{!kubeconfigCmd && kubeconfigNote && <p className="text-ui-xs text-text-tertiary">{kubeconfigNote}</p>}
					{/* Stage 2 (#5285): a short-lived read-only kubeconfig minted by the runner and
					    opened in this browser. Renders nothing without cluster:access_readonly. */}
					<KubeconfigDownload
						clusterId={cluster.id}
						projectName={data.project_name}
						environment={data.environment_stage}
						allowed={data.can_download_kubeconfig}
					/>
					{data.kubeconfig_download_note && (
						<p className="text-ui-xs text-text-tertiary">{data.kubeconfig_download_note}</p>
					)}
				</div>
			)}

			{/* ArgoCD. */}
			{cluster.argocd_url && (
				<div className={BLOCK} data-slot="cluster-argocd">
					<SectionHeading level={3} title="ArgoCD" />
					<div className="flex items-center gap-2">
						<code className={CODE}>{cluster.argocd_url}</code>
						<Button
							variant="ghost"
							size="icon"
							className="h-6 w-6 shrink-0 text-text-tertiary"
							aria-label="Open ArgoCD in a new tab"
							nativeButton={false}
							render={<a href={cluster.argocd_url} target="_blank" rel="noopener noreferrer" />}
						>
							<ExternalLink className="h-3 w-3" />
						</Button>
					</div>
					<p className="text-ui-xs text-text-tertiary">
						{kubeconfigCmd
							? "Admin password — after the kubeconfig command above, run:"
							: "Admin password — with a kubeconfig for this cluster, run:"}
					</p>
					<CodeRow value={argocdPasswordCmd} label="Copy ArgoCD admin password command" />
				</div>
			)}
		</div>
	);
}
