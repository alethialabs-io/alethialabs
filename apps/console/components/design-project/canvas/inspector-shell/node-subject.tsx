"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The inspector on ONE design node (#6834): a database, a service, a bucket, the project root.
//
// Three views, and the first is always the one in front when a node is selected:
//
//   Settings     the node's config, built from its schema, with the danger zone at the foot
//   Connections  a service's bindings, as rows (only a kind that binds has this view)
//   Status       what state it is in and why, what the deploy produced, drift, and cost
//
// It used to open on an Overview that repeated the card's own facts, with Cost and an
// environment-wide Activity list beside it — three views that were empty on a project that had
// never deployed, in front of the one the person came for. Activity is the environment's and is
// shown there.
//
// Nothing here is saved by this component. Every edit is `updateNodeConfig` on the document: it is
// staged, it is an undo step, and it is committed from the changes bar.

import { useEffect, useMemo, useRef } from "react";
import { formatMonthlyRate } from "@repo/format";
import { Alert, AlertDescription } from "@repo/ui/alert";
import { CopyButton } from "@repo/ui/copy-button";
import { SectionHeading } from "@repo/ui/section-heading";
import { StatusBadge } from "@repo/ui/status-badge";
import type { EnvironmentInfo } from "@/lib/canvas/component-status";
import { isCollectionKind } from "@/lib/canvas/collections";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import { ago } from "@/lib/canvas/job-display";
import {
	NODE_STATUS_META,
	nodeStatusHint,
	useNodeStatus,
	type NodeStatusMeta,
} from "@/lib/canvas/node-status";
import { useBoard, useIdentities } from "@/lib/canvas/store/canvas-store-provider";
import { coreIdentity, effectiveProvider } from "@/lib/canvas/store/derive";
import type { InspectorTab } from "@/lib/canvas/store/types";
import { useDesignNodes, useFieldFocus, useInspectorTab } from "@/lib/canvas/store/use-board";
import { configName } from "../graph/node-config";
import { NODE_REGISTRY } from "../graph/node-registry";
import { type CanvasNode, nodeOfKind } from "../graph/types";
import { BindingsField } from "../inspector/bindings-field";
import { ConfigFields } from "../inspector/config-fields";
import { getKindConfig, type KindConfig } from "../inspector/config-schema";
import { DangerZone } from "../inspector/danger-zone";
import { useNodeCapabilities } from "../inspector/use-node-capabilities";
import { InspectorAction, InspectorFrame } from "./inspector-frame";
import { resolveTab, useCloseInspector } from "./subject";

/** A config schema without the fields of one type, and without a section that leaves empty. */
function withoutFieldType(schema: KindConfig, type: string): KindConfig {
	return {
		...schema,
		sections: schema.sections
			.map((s) => ({ ...s, fields: s.fields.filter((f) => f.type !== type) }))
			.filter((s) => s.fields.length > 0),
	};
}

/** A config schema with one field removed from every section. */
function withoutField(schema: KindConfig, key: string): KindConfig {
	return {
		...schema,
		sections: schema.sections.map((s) => ({
			...s,
			fields: s.fields.filter((f) => f.key !== key),
		})),
	};
}

/** A provisioning status → the board's grayscale dot vocabulary. Status never reads as hue. */
const ENV_STATUS_VX: Record<string, NodeStatusMeta["vx"]> = {
	DRAFT: "idle",
	QUEUED: "pending",
	PROVISIONING: "live",
	ACTIVE: "active",
	FAILED: "failed",
	DESTROYING: "pending",
	DESTROYED: "disabled",
};

/** The grayscale tier an environment's provisioning status is drawn in. */
export function environmentStatusTier(status: string): NodeStatusMeta["vx"] {
	return ENV_STATUS_VX[status] ?? "idle";
}

/** An environment's provisioning status as a word: `PROVISIONING` → `Provisioning`. */
export function environmentStatusLabel(status: string): string {
	return status.charAt(0) + status.slice(1).toLowerCase();
}

/**
 * The environment a subject is bound to: its name, stage and provisioning status, read from the
 * environment status. Shown on the project root and on the environment subject's Status view.
 */
export function EnvironmentBlock({ env }: { env: EnvironmentInfo }) {
	return (
		<div className="border border-border bg-surface-sunken">
			<div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
				<span className="vx-eyebrow">Environment</span>
				<StatusBadge
					status={env.status}
					tier={environmentStatusTier(env.status)}
					label={environmentStatusLabel(env.status)}
					className="shrink-0"
				/>
			</div>
			<dl className="space-y-1.5 px-3 py-2.5 text-xs">
				<div className="flex gap-3">
					<dt className="w-20 shrink-0 text-muted-foreground">Name</dt>
					<dd className="min-w-0 truncate font-mono">{env.name}</dd>
				</div>
				<div className="flex gap-3">
					<dt className="w-20 shrink-0 text-muted-foreground">Stage</dt>
					<dd className="capitalize">{env.stage}</dd>
				</div>
			</dl>
		</div>
	);
}

/** The inspector on one design node. */
export function NodeSubject({ node }: { node: CanvasNode }) {
	const board = useBoard();
	const close = useCloseInspector();
	const requested = useInspectorTab();
	const focus = useFieldFocus();
	const designNodes = useDesignNodes();
	const identities = useIdentities();
	const env = useEnvironmentStatus();
	const status = useNodeStatus(node.id);
	const capabilities = useNodeCapabilities(node.id);
	const body = useRef<HTMLDivElement | null>(null);

	const def = NODE_REGISTRY[node.data.kind];
	const schema = getKindConfig(node.data.kind);
	const provider = useMemo(
		() => effectiveProvider(designNodes, node.id, identities),
		[designNodes, node.id, identities],
	);
	const core = useMemo(() => coreIdentity(designNodes), [designNodes]);
	const service = nodeOfKind(node, "service");
	// Read as the schema's own renderer reads it: the stored value, a list or nothing.
	const storedBindings: unknown = service?.data.config.bindings;

	const tabs: InspectorTab[] = service
		? ["configure", "connections", "status"]
		: ["configure", "status"];
	const tab = resolveTab(requested, tabs);

	// The review view's "Go to": bring the named field into view and put the caret in it. A field
	// carries `data-field-key` when its renderer marks it; until then the first control of the view
	// is the nearest honest answer, and it is still inside the right node's Settings.
	useEffect(() => {
		if (!focus || focus.nodeId !== node.id) return;
		const root = body.current;
		if (!root) return;
		const marked = Array.from(root.querySelectorAll("[data-field-key]")).find(
			(el) => el.getAttribute("data-field-key") === focus.path,
		);
		const target = marked ?? root.querySelector("input, textarea, select, [role='combobox']");
		if (target instanceof HTMLElement) {
			if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "center" });
			target.focus();
		}
		board.view.getState().clearFocus();
	}, [focus, node.id, board]);

	// The project panel is bound to the REAL environment being viewed, so its stage is a fact of
	// that environment and not a choice: the static stage radio is dropped and the fact is shown.
	const realEnv = node.data.kind === "project" ? env.environment : null;
	const settingsSchema = useMemo(() => {
		if (!schema) return undefined;
		const withoutBindings = withoutFieldType(schema, "bindings");
		return realEnv ? withoutField(withoutBindings, "environment_stage") : withoutBindings;
	}, [schema, realEnv]);

	const gated =
		def.classification === "core" && !!core && (node.data.cloud_identity_id ?? core) !== core;

	// Which config key (if any) holds this node's editable display name.
	const nameKey =
		node.data.kind === "project" ? "project_name" : def.cardinality === "array" ? "name" : null;
	const update = (patch: Record<string, unknown>) =>
		board.document.getState().updateNodeConfig(node.id, patch);

	const Icon = def.icon;
	const summary = schema ? schema.summary(node.data.config, provider) : "";
	const meta = NODE_STATUS_META[status.state];
	const drifted = status.drift.length;

	// A member of a collapsed kind has no card of its own on the board, so without a way back up
	// you would be stranded in a secret with no route to the vault it belongs to.
	const parent = isCollectionKind(node.data.kind) ? node.data.kind : null;
	const parentTitle = parent ? NODE_REGISTRY[parent].collection?.title : undefined;

	return (
		<InspectorFrame
			icon={Icon ? <Icon className="h-4 w-4" /> : undefined}
			eyebrow={def.eyebrow}
			title={def.label}
			name={
				nameKey
					? {
							value: configName(node.data) ?? "",
							onChange: (next) =>
								update({ [nameKey]: nameKey === "project_name" ? next : next.toLowerCase() }),
							mono: nameKey === "name",
							maxLength: nameKey === "project_name" ? 50 : undefined,
							placeholder: nameKey === "project_name" ? "My Project" : "name",
						}
					: undefined
			}
			summary={
				summary ||
				(def.classification === "root"
					? "Project basics and the stack's core cloud account."
					: def.classification === "core"
						? "Core resource: runs on the stack's cloud."
						: "Periphery: may run on any connected cloud.")
			}
			status={{
				label: meta.label,
				tier: meta.vx,
				message: status.message ?? nodeStatusHint(status.state),
				detail:
					drifted > 0 ? (
						<span
							className="shrink-0 border border-border-strong px-1.5 py-0.5 font-mono text-ui-2xs text-foreground"
							title={status.drift.map((d) => d.address).join("\n")}
						>
							{drifted} drifted
						</span>
					) : undefined,
			}}
			action={
				status.state === "needs-setup" && tab !== "configure" ? (
					<InspectorAction
						label="Open settings"
						onClick={() => board.view.getState().setTab("configure")}
					/>
				) : undefined
			}
			back={
				parent && parentTitle
					? {
							label: parentTitle,
							onClick: () =>
								board.view.getState().setSubject({ kind: "collection", nodeKind: parent }),
						}
					: null
			}
			tabs={tabs}
			tab={tab}
			onTabChange={(next) => board.view.getState().setTab(next)}
			onClose={close}
		>
			<div ref={body} className="space-y-4">
				{tab === "configure" && (
					<>
						{gated && (
							<Alert variant="default" className="border-border bg-muted">
								<AlertDescription className="text-xs">
									This core resource sits on a different cloud than the stack. It can be drawn,
									but the project will not provision until it is on the stack&apos;s cloud.
								</AlertDescription>
							</Alert>
						)}
						{realEnv && <EnvironmentBlock env={realEnv} />}
						{settingsSchema && (
							<ConfigFields
								schema={settingsSchema}
								config={node.data.config}
								provider={provider}
								kind={node.data.kind}
								capabilities={capabilities}
								onChange={update}
							/>
						)}
						<DangerZone node={node} />
					</>
				)}

				{tab === "connections" && service && (
					<section className="space-y-3">
						<SectionHeading
							level={3}
							title="Backing infrastructure"
							description="What this service is connected to. Alethia injects each endpoint and its credentials at deploy, without a stored key."
						/>
						<BindingsField
							value={Array.isArray(storedBindings) ? storedBindings : []}
							onChange={(bindings) => update({ bindings })}
							enableIacTargets
						/>
					</section>
				)}

				{tab === "status" && <NodeStatusView node={node} />}
			</div>
		</InspectorFrame>
	);
}

/**
 * A node's Status view: its resolved state and why, what the deploy produced, what has drifted,
 * and what it costs. All of it is read; none of it is edited here.
 */
function NodeStatusView({ node }: { node: CanvasNode }) {
	const status = useNodeStatus(node.id);
	const env = useEnvironmentStatus();
	const meta = NODE_STATUS_META[status.state];
	const lines = [...status.costLines].sort((a, b) => b.monthlyCost - a.monthlyCost);
	const priced = status.monthlyCost != null || lines.length > 0;

	return (
		<div className="space-y-5 text-sm">
			<section className="space-y-2">
				<SectionHeading level={3} title="State" />
				<p className="text-xs text-muted-foreground">
					{meta.label}
					{status.message ? `: ${status.message}` : ""}
				</p>
			</section>

			{/* What the deploy actually PRODUCED: the endpoint, the reader endpoint, the repository
			    URL. Without this you open the cloud console to find your own database's hostname. */}
			{status.outputs.length > 0 && (
				<section className="space-y-2">
					<SectionHeading level={3} title="Endpoints" />
					<dl className="space-y-1">
						{status.outputs.map((o) => (
							<div
								key={o.label}
								className="flex items-center gap-2 border border-border bg-surface-sunken px-2 py-1.5"
							>
								<dt className="shrink-0 text-ui-xs text-muted-foreground">{o.label}</dt>
								<dd className="min-w-0 flex-1 truncate text-right font-mono text-ui-xs">
									{o.value}
								</dd>
								<CopyButton text={o.value} className="h-6 w-6 shrink-0" />
							</div>
						))}
					</dl>
				</section>
			)}

			{/* Drift is an overlay, not a state: it is listed on its own, per drifted resource, with
			    the address that actually diverged. */}
			{status.drift.length > 0 && (
				<section className="space-y-2">
					<SectionHeading level={3} title="Drift" />
					<ul className="space-y-1">
						{status.drift.map((d) => (
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
				<SectionHeading level={3} title="Cost" />
				{priced ? (
					<>
						<div className="flex items-baseline justify-between border border-border bg-surface-sunken px-3 py-2.5">
							<span className="vx-eyebrow">Monthly</span>
							<span className="font-mono text-ui-lg font-semibold">
								{status.monthlyCost != null ? formatMonthlyRate(status.monthlyCost, "exact") : "—"}
							</span>
						</div>
						{env.costCapturedAt && (
							<p className="text-ui-xs text-muted-foreground">
								As of the last plan, {ago(env.costCapturedAt)} ago.
							</p>
						)}
						{lines.length > 0 ? (
							<ul className="space-y-1">
								{lines.map((l) => (
									<li
										key={l.address}
										className="flex items-center gap-2 border border-border bg-surface-sunken px-2 py-1.5 font-mono text-ui-2xs"
									>
										<span className="min-w-0 flex-1 truncate">{l.address}</span>
										<span className="shrink-0">{formatMonthlyRate(l.monthlyCost, "exact")}</span>
									</li>
								))}
							</ul>
						) : (
							<p className="text-xs text-muted-foreground">
								This resource carries a total price with no per-line breakdown.
							</p>
						)}
					</>
				) : (
					// A resource that was never priced says so. A confident zero would be a lie.
					<p className="text-xs text-muted-foreground">
						Not priced yet. Review a plan from the changes bar and this resource&apos;s
						estimated monthly cost appears here.
					</p>
				)}
			</section>
		</div>
	);
}
