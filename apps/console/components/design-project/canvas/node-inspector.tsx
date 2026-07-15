"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ArrowLeft, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/alerts/confirm-dialog";
import { Alert, AlertDescription } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import { CopyButton } from "@repo/ui/copy-button";
import { Input } from "@repo/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/tabs";
import { cn } from "@repo/ui/utils";
import {
	NODE_STATUS_META,
	useNodeStatus,
	type NodeStatusState,
} from "@/lib/canvas/node-status";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import {
	collectionNodeId,
	isCollectionKind,
	kindFromCollectionId,
} from "@/lib/canvas/collections";
import { CollectionPanel } from "./inspector/collection-panel";
import { ExternalPanel } from "./inspector/external-panel";
import { NODE_REGISTRY } from "./graph/node-registry";
import type { CanvasNode } from "./graph/types";
import { configName } from "./graph/node-config";
import { getKindConfig } from "./inspector/config-schema";
import { ConfigFields } from "./inspector/config-fields";
import { DangerZone } from "./inspector/danger-zone";

interface InspectorPanelProps {
	/** Edit mode only: tear down the active environment (queues a DESTROY job). Surfaced as a
	 * danger action on the project settings panel. */
	onDestroyEnvironment?: () => void;
}

/**
 * The service-config body of the canvas's inline docked side panel. Configures the selected node:
 * a header (resource icon, editable name, type badge, live one-line summary, close) over
 * Overview + Settings tabs, where Settings is built data-drivenly from the node's config schema
 * (collapsible sections, radio-cards, typed fields) plus a Danger zone. Rendered only when a node
 * is selected (`inspectorNodeId`).
 *
 * The cloud account is NOT set here — it's chosen once, at project creation, so there is no per-node
 * cloud selector. The effective provider is still resolved (it drives facts, zones, and the schema
 * summary), just never edited on the board.
 */
export function InspectorPanel({ onDestroyEnvironment }: InspectorPanelProps) {
	const inspectorNodeId = useCanvasStore((s) => s.inspectorNodeId);
	const node = useCanvasStore((s) =>
		inspectorNodeId ? s.nodes.find((n) => n.id === inspectorNodeId) : undefined,
	);
	const openInspector = useCanvasStore((s) => s.openInspector);
	const updateNodeConfig = useCanvasStore((s) => s.updateNodeConfig);
	const getEffectiveProvider = useCanvasStore((s) => s.getEffectiveProvider);

	const core = useCanvasStore((s) => s.getCoreIdentity());
	const provider = node ? getEffectiveProvider(node.id) : null;
	const def = node ? NODE_REGISTRY[node.data.kind] : null;
	const schema = node ? getKindConfig(node.data.kind) : undefined;

	// A collection card (the Secrets vault) is synthetic — it has no store row, so its id resolves to
	// no node. It gets the list panel instead, which is where its resources are actually managed.
	const collectionKind = inspectorNodeId ? kindFromCollectionId(inspectorNodeId) : null;
	if (collectionKind) return <CollectionPanel kind={collectionKind} />;

	if (!node || !def) return null;

	// An EXTERNAL card belongs to a bring-your-own IaC module. It has no editable config — changing
	// one of those resources means editing the customer's Terraform, not this panel — so it gets the
	// read-only member list instead of the config form (which would otherwise render an editable name
	// field and write a `name` into a config that has none).
	if (node.data.kind === "external") return <ExternalPanel nodeId={node.id} />;

	const gated =
		def.classification === "core" &&
		!!core &&
		(node.data.cloud_identity_id ?? core) !== core;

	// Which config key (if any) holds this node's editable display name.
	const nameKey =
		node.data.kind === "project"
			? "project_name"
			: NODE_REGISTRY[node.data.kind].cardinality === "array"
				? "name"
				: null;

	const Icon = def.icon;
	const summary = schema
		? schema.summary(node.data.config, provider)
		: undefined;

	// A member of a collapsed kind has no card of its own on the board, so without a way back up
	// you'd be stranded in a secret with no route to the vault it belongs to.
	const parentCollection = isCollectionKind(node.data.kind) ? node.data.kind : null;

	return (
		<div className="flex h-full flex-col">
			{parentCollection && (
				<button
					type="button"
					onClick={() => openInspector(collectionNodeId(parentCollection))}
					className="flex items-center gap-1.5 border-b border-border px-4 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
				>
					<ArrowLeft className="h-3.5 w-3.5" />
					{NODE_REGISTRY[parentCollection].collection?.title}
				</button>
			)}
			<div className="flex items-start gap-3 border-b border-border p-4">
				{Icon && (
					<span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-none border text-muted-foreground">
						<Icon className="h-4 w-4" />
					</span>
				)}
				<div className="min-w-0 flex-1 space-y-1">
					<div className="flex flex-wrap items-center gap-2">
						{nameKey ? (
							<Input
								value={configName(node.data) ?? ""}
								maxLength={nameKey === "project_name" ? 50 : undefined}
								placeholder={nameKey === "project_name" ? "My Project" : "name"}
								onChange={(e) =>
									updateNodeConfig(node.id, {
										[nameKey]:
											nameKey === "project_name"
												? e.target.value
												: e.target.value.toLowerCase(),
									})
								}
								className={cn(
									"h-8 max-w-[16rem] border-0 bg-transparent px-0 text-base font-semibold shadow-none focus-visible:ring-0",
									nameKey === "name" && "font-mono",
								)}
							/>
						) : (
							<span className="text-base font-semibold">{def.label}</span>
						)}
						<span className="vx-eyebrow rounded-none border border-border px-1.5 py-0.5">
							{def.eyebrow}
						</span>
					</div>
					<p className="truncate text-xs text-muted-foreground">
						{summary ||
							(def.classification === "root"
								? "Project basics and the stack's core cloud account."
								: def.classification === "core"
									? "Core resource — must run on the stack's cloud."
									: "Periphery — may run on any connected cloud.")}
					</p>
				</div>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="h-7 w-7 shrink-0"
					onClick={() => openInspector(null)}
					aria-label="Close"
				>
					<X className="h-4 w-4" />
				</Button>
			</div>

			<StatusHeader nodeId={node.id} />

			<Tabs
				defaultValue="settings"
				className="flex min-h-0 flex-1 flex-col gap-0"
			>
				<TabsList className="mx-4 mt-3 shrink-0">
					<TabsTrigger value="overview">Overview</TabsTrigger>
					<TabsTrigger value="settings">Settings</TabsTrigger>
				</TabsList>

				<TabsContent
					value="overview"
					className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 pt-4"
				>
					<Overview node={node} />
				</TabsContent>

				<TabsContent
					value="settings"
					className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-10 pt-4"
				>
					{gated && (
						<Alert variant="default" className="border-border bg-muted">
							<AlertDescription className="text-xs">
								This core resource sits on a different cloud than the stack. Hot
								cross-cloud data-plane edges are on the roadmap — it can be
								drawn, but the project will not provision until colocated.
							</AlertDescription>
						</Alert>
					)}

					{schema && (
						<ConfigFields
							schema={schema}
							config={node.data.config}
							provider={provider}
							onChange={(patch) => updateNodeConfig(node.id, patch)}
						/>
					)}

					{node.data.kind === "project" && onDestroyEnvironment && (
						<DestroyEnvironmentZone onDestroy={onDestroyEnvironment} />
					)}

					<DangerZone node={node} />
				</TabsContent>
			</Tabs>
		</div>
	);
}

/** Project-panel danger action: tear down the active environment's provisioned infra. */
function DestroyEnvironmentZone({ onDestroy }: { onDestroy: () => void }) {
	const [confirm, setConfirm] = useState(false);
	return (
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
				<Button
					type="button"
					variant="destructive"
					size="sm"
					onClick={() => setConfirm(true)}
				>
					Destroy
				</Button>
			</div>
			<ConfirmDialog
				open={confirm}
				onOpenChange={setConfirm}
				title="Destroy this environment?"
				description="This queues a DESTROY job that tears down the environment's provisioned cloud infrastructure. This cannot be undone."
				confirmLabel="Destroy environment"
				onConfirm={onDestroy}
			/>
		</div>
	);
}

/** The default line for a state when the server gave us no message of its own. */
const STATUS_HINT: Partial<Record<NodeStatusState, string>> = {
	gated: "Cross-cloud core placement — won't provision until colocated.",
	ready: "Configured and ready to deploy.",
	live: "Provisioned and matching the design.",
	"not-deployed": "Designed, but never applied.",
	queued: "Waiting for a runner to claim the job.",
	applying: "The runner is applying this resource now.",
	updating: "An apply is changing this resource in place.",
	"update-pending": "The design has moved ahead of what's deployed.",
	destroying: "Teardown in flight.",
	destroyed: "Torn down. Remove it from the design to clear it.",
	failed: "The last apply failed.",
	unreachable: "The cluster's API server did not answer the last probe.",
};

/**
 * A compact status strip under the inspector header: the node's RESOLVED status (design readiness
 * merged with the environment's server truth) and the most actionable line — the server's own
 * failure message when there is one, else a hint for the state. Drift rides alongside as an
 * overlay chip rather than replacing the state, because a drifted resource is still live.
 */
function StatusHeader({ nodeId }: { nodeId: string }) {
	const status = useNodeStatus(nodeId);
	const meta = NODE_STATUS_META[status.state];
	const drifted = status.drift.length;
	return (
		<div className="flex items-center gap-2.5 border-b border-border bg-surface-sunken/60 px-4 py-2.5">
			<span className={cn("vx-status shrink-0", `vx-status--${meta.vx}`)}>
				<span className="vx-status__dot" />
				{meta.label}
			</span>
			<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
				{status.message ?? STATUS_HINT[status.state] ?? ""}
			</span>
			{drifted > 0 && (
				<span
					className="shrink-0 border border-border-strong px-1.5 py-0.5 font-mono text-[10px] text-foreground"
					title={status.drift.map((d) => d.address).join("\n")}
				>
					{drifted} drifted
				</span>
			)}
		</div>
	);
}

/** Read-only summary of a node: its resolved status, any drift, and its config values. */
function Overview({ node }: { node: CanvasNode }) {
	const status = useNodeStatus(node.id);
	const meta = NODE_STATUS_META[status.state];
	const def = NODE_REGISTRY[node.data.kind];
	// Only show scalar config (skip nested objects/arrays — those have their own UIs).
	const rows = Object.entries(node.data.config).filter(
		([, v]) => v != null && typeof v !== "object" && String(v) !== "",
	);
	return (
		<div className="space-y-4 text-sm">
			<dl className="grid grid-cols-[8rem_1fr] gap-y-2">
				<dt className="text-muted-foreground">Type</dt>
				<dd>{def.label}</dd>
				<dt className="text-muted-foreground">Status</dt>
				<dd className="text-muted-foreground">
					{meta.label}
					{status.message ? ` — ${status.message}` : ""}
				</dd>
			</dl>

			{/* What the deploy actually PRODUCED. `endpoint` / `reader_endpoint` / `cluster_endpoint` /
			    `argocd_url` / `repository_url` are all written by the deploy finalizer and were, until
			    now, surfaced NOWHERE — you had to open the cloud console to find your own database's
			    hostname. */}
			{status.outputs.length > 0 && (
				<div className="space-y-2 border-t border-border/60 pt-3">
					<span className="vx-eyebrow">Endpoints</span>
					<dl className="space-y-1">
						{status.outputs.map((o) => (
							<div
								key={o.label}
								className="flex items-center gap-2 border border-border bg-surface-sunken px-2 py-1.5"
							>
								<dt className="shrink-0 text-[11px] text-muted-foreground">
									{o.label}
								</dt>
								<dd className="min-w-0 flex-1 truncate text-right font-mono text-[11px]">
									{o.value}
								</dd>
								<CopyButton text={o.value} className="h-6 w-6 shrink-0" />
							</div>
						))}
					</dl>
				</div>
			)}

			{/* Drift is an overlay, not a state — it's listed on its own, per drifted resource, with
			    the Terraform address that actually diverged. */}
			{status.drift.length > 0 && (
				<div className="space-y-2 border-t border-border/60 pt-3">
					<span className="vx-eyebrow">
						Drift · {status.drift.length} resource
						{status.drift.length > 1 ? "s" : ""}
					</span>
					<ul className="space-y-1">
						{status.drift.map((d) => (
							<li
								key={d.address}
								className="flex items-center gap-2 border border-border bg-surface-sunken px-2 py-1 font-mono text-[10px]"
							>
								<span className="min-w-0 flex-1 truncate">{d.address}</span>
								<span className="vx-eyebrow shrink-0 text-[9px]">{d.kind}</span>
							</li>
						))}
					</ul>
				</div>
			)}

			{rows.length > 0 && (
				<div className="space-y-2 border-t border-border/60 pt-3">
					<span className="vx-eyebrow">Configuration</span>
					<dl className="grid grid-cols-[8rem_1fr] gap-y-1.5 text-xs">
						{rows.map(([k, v]) => (
							<div key={k} className="contents">
								<dt className="text-muted-foreground">
									{k.replace(/_/g, " ")}
								</dt>
								<dd className="truncate font-mono">{String(v)}</dd>
							</div>
						))}
					</dl>
				</div>
			)}
		</div>
	);
}
