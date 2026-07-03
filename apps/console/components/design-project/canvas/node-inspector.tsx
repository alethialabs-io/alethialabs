"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import { ConfirmDialog } from "@/components/alerts/confirm-dialog";
import { Alert, AlertDescription } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/tabs";
import { cn } from "@repo/ui/utils";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { CloudIdentitySelector } from "../cloud-identity-selector";
import { NODE_REGISTRY } from "./graph/node-registry";
import type { CanvasNode } from "./graph/types";
import { CONFIG_SCHEMA } from "./inspector/config-schema";
import { ConfigFields } from "./inspector/config-fields";
import { DangerZone } from "./inspector/danger-zone";

/** A labelled field row (used by the cloud-account selector). */
function Field({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="space-y-1.5">
			<Label className="text-xs">{label}</Label>
			{children}
		</div>
	);
}

interface InspectorPanelProps {
	identities: CloudIdentityOption[];
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
 */
export function InspectorPanel({
	identities,
	onDestroyEnvironment,
}: InspectorPanelProps) {
	const inspectorNodeId = useCanvasStore((s) => s.inspectorNodeId);
	const node = useCanvasStore((s) =>
		inspectorNodeId ? s.nodes.find((n) => n.id === inspectorNodeId) : undefined,
	);
	const openInspector = useCanvasStore((s) => s.openInspector);
	const updateNodeConfig = useCanvasStore((s) => s.updateNodeConfig);
	const setNodeIdentity = useCanvasStore((s) => s.setNodeIdentity);
	const getEffectiveProvider = useCanvasStore((s) => s.getEffectiveProvider);

	const core = useCanvasStore((s) => s.getCoreIdentity());
	const provider = node ? getEffectiveProvider(node.id) : null;
	const def = node ? NODE_REGISTRY[node.data.kind] : null;
	const schema = node ? CONFIG_SCHEMA[node.data.kind] : undefined;
	if (!node || !def) return null;

	const gated =
		def.classification === "core" &&
		!!core &&
		(node.data.cloud_identity_id ?? core) !== core;

	// Which config key (if any) holds this node's editable display name.
	const nameKey =
		node.data.kind === "project"
			? "project_name"
			: typeof node.data.config.name === "string"
				? "name"
				: null;

	const Icon = def.icon;
	const summary = schema
		? schema.summary(node.data.config, provider)
		: undefined;

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-start gap-3 border-b border-border p-4">
				{Icon && (
					<span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border text-muted-foreground">
						<Icon className="h-4 w-4" />
					</span>
				)}
				<div className="min-w-0 flex-1 space-y-1">
					<div className="flex flex-wrap items-center gap-2">
						{nameKey ? (
							<Input
								value={(node.data.config[nameKey] as string) ?? ""}
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
						<span className="vx-eyebrow rounded border border-border px-1.5 py-0.5">
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
					<Overview node={node} provider={provider} />
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

					{def.cloudScoped && (
						<IdentityField
							node={node}
							identities={identities}
							onPick={(id, prov) => setNodeIdentity(node.id, id, prov)}
							onInherit={() => setNodeIdentity(node.id, null, null)}
						/>
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
		<div className="rounded-lg border border-destructive/30">
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

/** Per-node cloud account selector (root sets the CORE; others may diverge). */
function IdentityField({
	node,
	identities,
	onPick,
	onInherit,
}: {
	node: CanvasNode;
	identities: CloudIdentityOption[];
	onPick: (id: string, provider: CloudProviderSlug) => void;
	onInherit: () => void;
}) {
	const isRoot = node.data.kind === "project";
	return (
		<Field label={isRoot ? "Cloud account (core)" : "Cloud account"}>
			<CloudIdentitySelector
				identities={identities}
				value={node.data.cloud_identity_id}
				onChange={onPick}
				manageGlobalStore={false}
			/>
			{!isRoot && node.data.cloud_identity_id && (
				<button
					type="button"
					onClick={onInherit}
					className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
				>
					Inherit project cloud
				</button>
			)}
		</Field>
	);
}

/** Read-only summary of a node: placement + its primitive config values. Provisioned
 * outputs (endpoints/ARNs) will surface here once the node carries live status. */
function Overview({
	node,
	provider,
}: {
	node: CanvasNode;
	provider: CloudProviderSlug | null;
}) {
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
				<dt className="text-muted-foreground">Cloud</dt>
				<dd>{provider ? provider.toUpperCase() : "Inherits project"}</dd>
				<dt className="text-muted-foreground">Status</dt>
				<dd className="text-muted-foreground">Draft — not provisioned</dd>
			</dl>
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
