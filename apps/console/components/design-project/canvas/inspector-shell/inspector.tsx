"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The ONE inspector (#6834): what the rail shows is a function of the view store's `Subject`, and
// of nothing else.
//
//   a design node        its Settings, Connections and Status
//   an add-on            its configuration, staged, and how it is installed
//   a chart              its safety scan
//   a chart's workload   the overlay, staged, and what the chart describes
//   a module's resources the read-only list
//   a collection         its members; a row opens that member, with a crumb back
//   the environment      Settings, Sources, Status and Activity
//   several cards        what can be done to all of them
//   nothing              the rail is closed
//
// Every one of them is drawn in `InspectorFrame`. There is no "which card is open" beside "what is
// selected" any more: the legacy rail card still exists in the view store for the shell files that
// set it, and the store maps it onto the subject this file reads.

import { Copy, Trash2 } from "lucide-react";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { AddonConfigCard } from "@/components/addons/addon-config-card";
import { isDesignNode } from "@/lib/canvas/store/derive";
import { useBoard } from "@/lib/canvas/store/canvas-store-provider";
import { useDesignNodes, useSubject } from "@/lib/canvas/store/use-board";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { ActivityCard } from "../cards/activity-card";
import { ChartScanCard } from "../cards/chart-scan-card";
import type { DestroyEnvironmentControl } from "../cards/destroy-tree-view";
import { EnvSettingsCard } from "../cards/env-settings-card";
import { configName } from "../graph/node-config";
import { NODE_REGISTRY } from "../graph/node-registry";
import { ChartWorkloadPanel } from "../inspector/chart-workload-panel";
import { CollectionPanel } from "../inspector/collection-panel";
import { ExternalPanel } from "../inspector/external-panel";
import { EnvironmentSources } from "./environment-sources";
import { InspectorEmbed, InspectorFrame } from "./inspector-frame";
import { NodeSubject } from "./node-subject";
import {
	addonIdOf,
	chartIdOf,
	inspectorOpen,
	useCloseInspector,
	useSubjectNode,
	type InspectorContext,
} from "./subject";

export interface InspectorProps extends InspectorContext {
	/** Read the destroy tree and queue a DESTROY job, for the environment subject. */
	destroyEnvironment?: DestroyEnvironmentControl;
}

/** The inspector's content for the subject in the view store. Draws nothing when there is none. */
export function Inspector({ projectId, environmentId, destroyEnvironment }: InspectorProps) {
	const subject = useSubject();
	if (!subject || !inspectorOpen(subject, { projectId, environmentId })) return null;
	switch (subject.kind) {
		case "environment":
			return (
				<EnvSettingsCard
					destroyEnvironment={destroyEnvironment}
					sources={<EnvironmentSources />}
					activity={
						projectId && environmentId ? (
							<InspectorEmbed>
								<ActivityCard projectId={projectId} environmentId={environmentId} />
							</InspectorEmbed>
						) : undefined
					}
				/>
			);
		case "collection":
			return <CollectionPanel kind={subject.nodeKind} />;
		case "selection":
			return <SelectionSubject ids={subject.ids} />;
		case "node":
			return (
				<NodeSubjectRouter id={subject.id} projectId={projectId} environmentId={environmentId} />
			);
	}
}

/**
 * The subject a node id names. A design node is a `NodeSubject`; the cards the design does not own
 * each have their own, and an add-on is addressed by id whether or not it is on the board.
 */
function NodeSubjectRouter({ id, projectId, environmentId }: { id: string } & InspectorContext) {
	const node = useSubjectNode(id);
	if (node && isDesignNode(node)) return <NodeSubject node={node} />;

	const addonId = addonIdOf(id);
	if (addonId !== null) {
		// `inspectorOpen` declines an add-on without a project, so this is never reached without one.
		return projectId ? (
			<AddonConfigCard itemId={addonId} projectId={projectId} environmentId={environmentId ?? null} />
		) : null;
	}
	const chartId = chartIdOf(id);
	if (chartId !== null) return <ChartScanCard chartId={chartId} />;
	if (node?.data.kind === "chart_workload") return <ChartWorkloadPanel nodeId={id} />;
	if (node?.data.kind === "external") return <ExternalPanel nodeId={id} />;
	return <MissingSubject />;
}

/** The subject names something that is not on the board: say so, rather than an empty rail. */
function MissingSubject() {
	const close = useCloseInspector();
	return (
		<InspectorFrame eyebrow="Inspector" title="Nothing to show" onClose={close}>
			<EmptyState
				title="This is no longer on the board"
				description="It was removed, or the environment changed under it. Select a card to inspect it."
			/>
		</InspectorFrame>
	);
}

/** Several cards at once: how many, which, and what can be done to all of them. */
function SelectionSubject({ ids }: { ids: string[] }) {
	const board = useBoard();
	const close = useCloseInspector();
	const designNodes = useDesignNodes();
	const duplicateNodes = useCanvasStore((s) => s.duplicateNodes);
	const removeNodes = useCanvasStore((s) => s.removeNodes);
	const members = designNodes.filter((n) => ids.includes(n.id));
	const duplicable = members.filter((n) => NODE_REGISTRY[n.data.kind].cardinality === "array");
	const removable = members.filter((n) => n.deletable !== false);
	const outside = ids.length - members.length;

	return (
		<InspectorFrame
			eyebrow="Selection"
			title={`${ids.length} selected`}
			summary="What you do here applies to every selected card, and is one undo step."
			onClose={close}
		>
			<div className="space-y-4">
				<ul className="border-t border-border">
					{members.map((node) => (
						<li key={node.id} className="border-b border-border">
							<button
								type="button"
								onClick={() => board.view.getState().setSubject({ kind: "node", id: node.id })}
								className="flex w-full items-center justify-between gap-3 px-1 py-2 text-left transition-colors hover:bg-muted focus-visible:outline-1 focus-visible:outline-ring"
							>
								<span className="min-w-0 truncate font-mono text-xs">
									{configName(node.data) || NODE_REGISTRY[node.data.kind].label}
								</span>
								<span className="vx-eyebrow shrink-0 text-ui-3xs">
									{NODE_REGISTRY[node.data.kind].eyebrow}
								</span>
							</button>
						</li>
					))}
				</ul>
				{outside > 0 && (
					<p className="text-xs text-muted-foreground">
						{outside === 1 ? "1 selected card is" : `${outside} selected cards are`} not part of
						the design (a chart, an add-on or a module&apos;s resources) and cannot be duplicated
						or removed from here.
					</p>
				)}
				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						aria-disabled={duplicable.length === 0 ? true : undefined}
						title={
							duplicable.length === 0
								? "None of the selected cards is a kind that can have a copy."
								: undefined
						}
						onClick={() => {
							if (duplicable.length > 0) duplicateNodes(duplicable.map((n) => n.id));
						}}
					>
						<Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
						Duplicate
					</Button>
					<Button
						type="button"
						variant="destructive"
						size="sm"
						aria-disabled={removable.length === 0 ? true : undefined}
						title={
							removable.length === 0 ? "None of the selected cards can be removed." : undefined
						}
						onClick={() => {
							if (removable.length > 0) removeNodes(removable.map((n) => n.id));
						}}
					>
						<Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
						Remove
					</Button>
				</div>
				<p className="text-xs text-muted-foreground">
					Removing takes the cards off the board. It can be undone with ⌘Z.
				</p>
			</div>
		</InspectorFrame>
	);
}
