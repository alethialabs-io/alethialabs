"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Settings2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { Button } from "@repo/ui/button";
import { Label } from "@repo/ui/label";
import { SectionHeading } from "@repo/ui/section-heading";
import { useStore } from "zustand";
import { EmptyState } from "@repo/ui/empty";
import { StatusBadge } from "@repo/ui/status-badge";
import { DeployPane } from "@/components/agent/deploy-pane";
import type { DeployState } from "@/lib/canvas/component-status";
import { JOB_LABEL } from "@/lib/canvas/job-display";
import { useBoard } from "@/lib/canvas/store/canvas-store-provider";
import { PROJECT_NODE_ID, type InspectorTab } from "@/lib/canvas/store/types";
import {
	useAllNodes,
	useEffectiveProvider,
	useInspectorTab,
} from "@/lib/canvas/store/use-board";
import {
	NATIVE_LABELS,
	environmentConnector,
	registryUnavailable,
	secretsStoreUnavailable,
} from "@/lib/canvas/environment-connector";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import { ConfigFields } from "../inspector/config-fields";
import { getKindConfig } from "../inspector/config-schema";
import { ConnectorSelect } from "../inspector/connector-select";
import { useNodeCapabilities } from "../inspector/use-node-capabilities";
import { CompatAlert } from "../inspector/compat-alert";
import { InspectorFrame } from "../inspector-shell/inspector-frame";
import {
	EnvironmentBlock,
	environmentStatusLabel,
	environmentStatusTier,
} from "../inspector-shell/node-subject";
import { resolveTab, useCloseInspector } from "../inspector-shell/subject";
import { useClusterK8sVersion } from "../use-cluster-k8s-version";
import { DestroyEnvironmentDialog, type DestroyTreeState } from "./destroy-environment-dialog";
import { DestroyHoldNotice, useDestroyHold } from "./destroy-hold";
import {
	type DestroyEnvironmentControl,
	type DestroyTreeNode,
	environmentSettingsHref,
} from "./destroy-tree-view";

/** Where the saved design stands against the last deploy, as a sentence for the status row. */
const DEPLOY_STATE_LINE: Record<DeployState, string> = {
	never: "This environment has not been deployed yet.",
	ahead: "The saved design is ahead of what is deployed.",
	"in-sync": "The saved design is what is deployed.",
};

/**
 * The status row's sentence. A FAILED environment with no deployed design is not "not deployed yet":
 * its first deploy started and did not finish (it failed, or was cancelled mid-apply), so it may
 * already have created cloud resources (#7290). Saying "not deployed" there tells the operator there
 * is nothing to clean up when there may be.
 */
function deployStateLine(status: string, deployState: DeployState): string {
	if (status === "FAILED" && deployState === "never") {
		return "The last deploy did not finish. Cloud resources it created may still exist; destroy the environment to remove them.";
	}
	return DEPLOY_STATE_LINE[deployState];
}

/**
 * The inspector on the ENVIRONMENT (#6834): everything that belongs to the environment as a whole
 * rather than to any one card. Four views:
 *
 *   Settings  the cluster and its VPC, where secrets and images come from, and Destroy
 *   Sources   the infrastructure module that governs the environment, and its charts
 *   Status    what state the environment is in, and how it is delivered
 *   Activity  what has run against it
 *
 * The cluster and the network are not cards on the board (one environment IS one cluster inside
 * one VPC). They are env-scoped singletons that persist as hidden design nodes, so Settings edits
 * them through the same `updateNodeConfig` and the same config schema a node's Settings uses —
 * `graphToForm` and the deploy snapshot are unchanged. The secret store and the registry are
 * env-level for the same reason: the runtime reads one store per environment, so the choice is
 * written through to every row of the kind.
 *
 * "Per environment" needs no control here: the canvas is already scoped to one environment by the
 * topbar's environment switcher, and the board is remounted when it changes.
 *
 * This is also where the environment is DESTROYED (#4775): it acts on the environment as a whole.
 *
 * Sources and Activity used to be two more cards with two more headers. They are views of this
 * subject now, drawn inside its frame. The host hands both in, so this file reads no server action
 * and a view the host cannot fill is not offered as an empty tab.
 */
export function EnvSettingsCard({
	destroyEnvironment,
	sources,
	activity,
}: {
	/** Read the destroy tree and queue a DESTROY job. Absent where there is no provisioned
	 * environment to destroy. */
	destroyEnvironment?: DestroyEnvironmentControl;
	/** The Sources view. The view is offered only when the host hands one in. */
	sources?: ReactNode;
	/** The Activity view. Offered only when the host has a project and an environment to read. */
	activity?: ReactNode;
}) {
	const envStatus = useEnvironmentStatus();
	// A BYO-IaC source in replace mode OWNS the substrate: the cluster's version and the VPC come
	// from the module, and a deploy ignores anything staged here. The toolbar button that used to be
	// the only way in is hidden in that case, but the card is reachable by other routes — the Secrets
	// vault's "Store · …" row, and the `?card=env-settings` deep link — so the gate belongs on the
	// SECTIONS, not on the button. Hiding the two substrate sections rather than refusing the whole
	// card keeps the settings the console still owns reachable; refusing outright would make that
	// readout do nothing at all, with no way for the operator to tell why.
	const iacGoverned = envStatus.iac !== null;
	const board = useBoard();
	const close = useCloseInspector();
	const cameFrom = useStore(board.view, (v) => v.cardBack);
	const requested = useInspectorTab();
	const tabs: InspectorTab[] = ["configure"];
	if (sources) tabs.push("sources");
	tabs.push("status");
	if (activity) tabs.push("activity");
	const tab = resolveTab(requested, tabs);
	const environment = envStatus.environment;
	const nodes = useAllNodes();
	const updateNodeConfig = (id: string, patch: Record<string, unknown>) =>
		board.document.getState().updateNodeConfig(id, patch);
	const provider = useEffectiveProvider(PROJECT_NODE_ID);

	const secretsStore = environmentConnector(nodes, "secret");
	const secretNodes = nodes.filter((n) => n.data.kind === "secret");
	const registryStore = environmentConnector(nodes, "registry");
	const registryNodes = nodes.filter((n) => n.data.kind === "registry");

	const cluster = nodes.find((n) => n.data.kind === "cluster");
	const network = nodes.find((n) => n.data.kind === "network");
	const clusterSchema = getKindConfig("cluster");
	const networkSchema = getKindConfig("network");

	// Cluster and network are env-level singletons, but each resolves through its OWN node so a
	// per-resource placement override is honoured rather than silently reading the project's account.
	const clusterCaps = useNodeCapabilities(cluster?.id ?? null);

	// The compat subject, assembled from the store — no new query. `addon` nodes are the environment's
	// enabled marketplace installs; the config-time resolver also sees Hetzner data services and BYO
	// charts, which is why CompatAlert never claims a clean bill of health.
	// As it will DEPLOY: an unset version resolves to the catalog default (#5314) — but not on
	// BYO-IaC, where the module decides it and an unset one stays `not_evaluable` (#5365).
	const clusterK8s = useClusterK8sVersion();
	const addonIds = useMemo(
		() =>
			nodes
				.filter((n) => n.data.kind === "addon")
				.map((n) => ("id" in n.data.config && typeof n.data.config.id === "string" ? n.data.config.id : ""))
				.filter(Boolean),
		[nodes],
	);
	const networkCaps = useNodeCapabilities(network?.id ?? null);

	return (
		<InspectorFrame
			icon={<Settings2 className="h-4 w-4" />}
			eyebrow="Environment"
			title="Environment settings"
			summary={
				environment
					? `${environment.name} · ${environment.stage}`
					: "The cluster, its network, and where secrets and images come from."
			}
			status={
				environment
					? {
							label: environmentStatusLabel(environment.status),
							tier: environmentStatusTier(environment.status),
							message:
								envStatus.deployRefusal?.message ??
								deployStateLine(environment.status, envStatus.deployState),
						}
					: null
			}
			// Arrived here from the control that asked the question (the Secrets vault's "Store"
			// row): the subject was replaced, so this is the way back to it.
			back={
				cameFrom ? { label: "Back", onClick: () => board.view.getState().goBackCard() } : null
			}
			tabs={tabs}
			tab={tab}
			onTabChange={(next) => board.view.getState().setTab(next)}
			onClose={close}
		>
			{tab === "sources" && sources}
			{tab === "status" && <EnvironmentStatusView />}
			{tab === "activity" && activity}
			{tab === "configure" && (
			<div className="space-y-6">
				{iacGoverned && (
					<p className="text-xs text-muted-foreground">
						This environment&apos;s cluster and network are defined by its infrastructure
						source, so they are not edited here.
					</p>
				)}
				{!iacGoverned && cluster && clusterSchema && (
					<section className="space-y-2">
						<SectionHeading level={3} title="Cluster" />
						{/* Compat sits next to the Kubernetes version that causes it (#1221). Silent unless
						    something actually fails — see CompatAlert's two honesty rules. */}
						<CompatAlert
							provider={provider}
							k8sVersion={clusterK8s.version}
							addonIds={addonIds}
						/>
						<ConfigFields
							schema={clusterSchema}
							config={cluster.data.config}
							provider={provider}
							kind="cluster"
							capabilities={clusterCaps}
							onChange={(patch) => updateNodeConfig(cluster.id, patch)}
						/>
					</section>
				)}
				{!iacGoverned && network && networkSchema && (
					<section className="space-y-2">
						<SectionHeading level={3} title="Network (VPC)" />
						<ConfigFields
							schema={networkSchema}
							config={network.data.config}
							provider={provider}
							kind="network"
							capabilities={networkCaps}
							onChange={(patch) => updateNodeConfig(network.id, patch)}
						/>
					</section>
				)}
				<section className="space-y-2">
					{/* A Label rather than the `SectionHeading` cluster/network use, so the select has
					    an accessible name — it is the only control in this section, and "Secrets" is
					    exactly what names it. It carries `SectionHeading`'s own rung (`--text-ui-lg`,
					    medium, tight) so all four sections still read alike, which is the whole
					    reason that heading has ONE size at every level. */}
					<Label
						htmlFor="env-secrets-store"
						className="text-ui-lg font-medium tracking-tight"
					>
						Secrets
					</Label>
					{secretNodes.length === 0 ? (
						<p className="text-xs text-muted-foreground">
							Add a secret to choose where this environment&apos;s secrets are read from.
						</p>
					) : (
						<>
							<ConnectorSelect
								id="env-secrets-store"
								category="secrets"
								value={secretsStore.provider}
								providerConfig={secretsStore.providerConfig}
								// The cluster's own secret store is the default and must stay reachable —
								// a project that tried Vault has to be able to go back.
								nativeOption={{
									label: NATIVE_LABELS.secret,
									description: "cloud secret manager",
								}}
								unavailable={(p) => secretsStoreUnavailable(p.slug)}
								// WRITE-THROUGH: one store per environment, so the choice goes to every
								// secret row. Leaving the others behind would mean the database says two
								// different things while the deploy silently picks one (dominantProvider),
								// which is exactly the ambiguity this control exists to remove.
								onChange={(patch) => {
									for (const node of secretNodes) updateNodeConfig(node.id, patch);
								}}
							/>
							<p className="text-xs text-muted-foreground">
								Applies to all {secretNodes.length}{" "}
								{secretNodes.length === 1 ? "secret" : "secrets"} in this environment — one
								environment reads through one store.
							</p>
						</>
					)}
				</section>
				<section className="space-y-2">
					<Label
						htmlFor="env-registry"
						className="text-ui-lg font-medium tracking-tight"
					>
						Container registry
					</Label>
					{registryNodes.length === 0 ? (
						<p className="text-xs text-muted-foreground">
							Add a container registry to choose where this environment&apos;s images are
							pushed and pulled from.
						</p>
					) : (
						<>
							<ConnectorSelect
								id="env-registry"
								category="registry"
								value={registryStore.provider}
								providerConfig={registryStore.providerConfig}
								// The cloud's own registry (ECR / Artifact Registry / ACR) is the default,
								// and a credential-based connector REPLACES it — so going back must be
								// possible.
								nativeOption={{
									label: NATIVE_LABELS.registry,
									description: "ECR / Artifact Registry / ACR",
								}}
								unavailable={(p) => registryUnavailable(p.slug)}
								// WRITE-THROUGH: dominantProvider takes the first pluggable row's slug for
								// the whole project and there is exactly ONE pull secret, so a row left
								// behind would have its images pulled with a credential for another
								// registry — an ImagePullBackOff against a secret that exists.
								onChange={(patch) => {
									for (const node of registryNodes) {
										// `provider_config` may be replaced whole now. It used to also carry
										// this row's OWN cloud-registry settings (immutable tags, scanning),
										// which are per row while the provider is per environment, so the
										// patch had to be merged over them or two registries' distinct
										// settings were flattened on any provider change. Those two became
										// typed columns in #1811, and this write never touches them.
										updateNodeConfig(node.id, {
											provider: patch.provider,
											provider_config: patch.provider_config,
										});
									}
								}}
							/>
							<p className="text-xs text-muted-foreground">
								Applies to all {registryNodes.length}{" "}
								{registryNodes.length === 1 ? "registry" : "registries"} in this environment
								— one environment pushes through one registry.
							</p>
						</>
					)}
				</section>
				{/* Not gated on `iacGoverned`: an environment whose substrate comes from a BYO-IaC
				    module is still one that can be torn down. */}
				{destroyEnvironment && <DestroyEnvironmentZone control={destroyEnvironment} />}
			</div>
			)}
		</InspectorFrame>
	);
}

/**
 * The environment's Status view: which environment this is and what state it is in, what is
 * running against it now, and how it is delivered.
 */
function EnvironmentStatusView() {
	const env = useEnvironmentStatus();
	return (
		<div className="space-y-6">
			{env.environment ? (
				<EnvironmentBlock env={env.environment} />
			) : (
				<EmptyState
					className="px-0 py-4 md:px-0 md:py-4"
					title="This environment's status has not loaded"
					description="It is read with the board. Reload the page if this does not change."
				/>
			)}
			{env.activeJob && (
				<section className="space-y-2">
					<SectionHeading level={3} title="Running now" />
					<div className="flex items-center gap-2 border border-border bg-surface-sunken px-2.5 py-1.5">
						<StatusBadge status="running" tier="live" className="shrink-0" />
						<span className="font-mono text-ui-2xs uppercase tracking-wide">
							{JOB_LABEL[env.activeJob.type] ?? env.activeJob.type}
						</span>
					</div>
				</section>
			)}
			{env.unattributedDrift.length > 0 && (
				<section className="space-y-2">
					<SectionHeading level={3} title="Drift" />
					<ul className="space-y-1">
						{env.unattributedDrift.map((d) => (
							<li
								key={d.address}
								className="flex items-center gap-2 border border-border bg-surface-sunken px-2 py-1 font-mono text-ui-2xs"
							>
								<span className="min-w-0 flex-1 truncate">{d.address}</span>
								<span className="vx-eyebrow shrink-0 text-ui-3xs">{d.kind}</span>
							</li>
						))}
					</ul>
				</section>
			)}
			<section className="space-y-2">
				<SectionHeading level={3} title="Delivery" />
				<DeployPane status={env.gitops} />
			</section>
		</div>
	);
}

/**
 * Environment-level danger action: tear down the active environment's provisioned infra.
 *
 * Clicking Destroy opens the confirmation AND reads the destroy tree (#5261) — the dialog opens at
 * once and fills in when the read lands. The read has to come first: a production build redacts a
 * server action's error text, so the server's refusal naming the tenants would reach the browser as
 * an unreadable digest.
 */
function DestroyEnvironmentZone({ control }: { control: DestroyEnvironmentControl }) {
	const [open, setOpen] = useState(false);
	const [tree, setTree] = useState<DestroyTreeState>({ phase: "loading" });
	const [childrenFirst, setChildrenFirst] = useState<DestroyTreeNode[] | null>(null);
	const hold = useDestroyHold(control.loadTree);
	const { loadTree, destroy } = control;

	/** Open the confirmation and read what destroying this environment would take with it. */
	function openConfirm() {
		setTree({ phase: "loading" });
		setChildrenFirst(null);
		setOpen(true);
		loadTree()
			.then((t) => setTree({ phase: "ready", tree: t }))
			.catch(() => setTree({ phase: "error" }));
	}

	return (
		<div className="space-y-3">
			{hold && <DestroyHoldNotice hold={hold} />}
			<div className="rounded-none border border-destructive/30">
				<div className="flex items-center gap-2 border-b border-destructive/20 px-4 py-3">
					<TriangleAlert className="h-4 w-4 text-destructive" />
					<p className="text-sm font-medium text-destructive">Danger zone</p>
				</div>
				<div className="flex items-center justify-between gap-4 px-4 py-4">
					<div className="min-w-0">
						<p className="text-sm font-medium">Destroy environment</p>
						<p className="text-xs text-muted-foreground">
							Queue a teardown of the provisioned infrastructure for this environment.
						</p>
					</div>
					<Button type="button" variant="destructive" size="sm" onClick={openConfirm}>
						Destroy
					</Button>
				</div>
				{childrenFirst && childrenFirst.length > 0 && (
					<div className="space-y-2 border-t border-destructive/20 px-4 py-3 text-ui-md">
						<p>
							Destroy {childrenFirst.length === 1 ? "this environment" : "these environments"}{" "}
							first. {childrenFirst.length === 1 ? "It is" : "Each is"} placed on this
							environment&apos;s cluster:
						</p>
						<ol className="list-decimal space-y-1 pl-5">
							{childrenFirst.map((t) => (
								<li key={t.environment_id}>
									<Link
										href={environmentSettingsHref(t.environment_id)}
										className="underline underline-offset-2"
									>
										{t.name}
									</Link>{" "}
									<span className="text-muted-foreground">({t.placement_mode})</span>
								</li>
							))}
						</ol>
						<p className="text-muted-foreground">
							When {childrenFirst.length === 1 ? "it is" : "they are"} destroyed, destroy this
							environment.
						</p>
					</div>
				)}
			</div>
			<DestroyEnvironmentDialog
				open={open}
				onOpenChange={setOpen}
				state={tree}
				projectName={control.projectName}
				onDestroy={(options) => void destroy(options)}
				onChildrenFirst={setChildrenFirst}
			/>
		</div>
	);
}
