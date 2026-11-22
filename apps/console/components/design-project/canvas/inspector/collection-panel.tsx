"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Plus, X } from "lucide-react";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { Input } from "@repo/ui/input";
import { StatusBadge } from "@repo/ui/status-badge";
import { useState } from "react";
import { useBoard } from "@/lib/canvas/store/canvas-store-provider";
import { InspectorAction, InspectorFrame } from "../inspector-shell/inspector-frame";
import { useCloseInspector } from "../inspector-shell/subject";
import { NODE_REGISTRY } from "../graph/node-registry";
import { configName } from "../graph/node-config";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import {
	NATIVE_LABELS,
	connectorLabel,
	environmentConnector,
} from "@/lib/canvas/environment-connector";
import {
	NODE_STATUS_META,
	resolveNodeStatusFor,
} from "@/lib/canvas/node-status";
import type { NodeKind } from "../graph/types";
import { useAllNodes, useBoardActions, useCoreIdentity } from "@/lib/canvas/store/use-board";

/**
 * The vault's panel — where a collection kind's resources actually live.
 *
 * The board shows ONE card for thirty secrets; this is the list behind it. Each row carries the
 * resource's real, individually-resolved status (so a failed secret is visible without opening it),
 * and clicking one opens its own inspector — collapsing the view never takes away the ability to
 * configure a single resource.
 */
export function CollectionPanel({ kind }: { kind: NodeKind }) {
	const def = NODE_REGISTRY[kind];
	const nodes = useAllNodes();
	const core = useCoreIdentity();
	const env = useEnvironmentStatus();
	const { addNode, removeNodes } = useBoardActions();
	const board = useBoard();
	const updateNodeConfig = (id: string, patch: Record<string, unknown>) =>
		board.document.getState().updateNodeConfig(id, patch);
	const close = useCloseInspector();
	const [filter, setFilter] = useState("");

	const members = nodes.filter((n) => n.data.kind === kind);
	const needle = filter.trim().toLowerCase();
	const shown = needle
		? members.filter((n) => (configName(n.data) ?? "").toLowerCase().includes(needle))
		: members;

	// Secrets read through ONE store per environment (#1412). Surface which one here, where the
	// secrets are managed, even though the choice is made in the environment-settings sheet — someone
	// looking at a list of secrets is exactly who needs to know where they come from.
	const secretsStore = kind === "secret" ? environmentConnector(nodes, "secret") : null;

	const title = def.collection?.title ?? def.label;
	const singular = def.collection?.singular ?? def.label.toLowerCase();
	const Icon = def.icon;

	/** Add a member, on the store this environment's secrets already read from. */
	const addMember = () => {
		const id = addNode(kind);
		if (secretsStore?.provider) {
			updateNodeConfig(id, {
				provider: secretsStore.provider,
				provider_config: secretsStore.providerConfig,
			});
		}
	};

	return (
		<InspectorFrame
			icon={<Icon className="h-4 w-4" />}
			eyebrow="Collection"
			title={title}
			summary={`${members.length} ${members.length === 1 ? singular : `${singular}s`} in this environment.`}
			action={
				<InspectorAction
					label="Add"
					icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
					onClick={addMember}
				/>
			}
			onClose={close}
			bodyClassName="p-0 pb-0 pt-0"
		>
			{secretsStore && members.length > 0 ? (
				<button
					type="button"
					// A DETOUR: the store this vault reads through is an environment setting, so the
					// control that changes it lives on another card — and one card on the rail means
					// opening it replaces this one. `back: true` remembers where you were.
					onClick={() => board.view.getState().openCard({ kind: "env-settings" }, { back: true })}
					className="flex w-full items-center justify-between gap-2 border-b border-border px-4 py-2 text-left hover:bg-accent"
				>
					<span className="text-xs text-muted-foreground">
						Store{" "}
						<span className="font-mono text-foreground">
							{connectorLabel(secretsStore.provider, NATIVE_LABELS.secret)}
						</span>
					</span>
					<span className="vx-eyebrow text-ui-2xs text-muted-foreground">Change</span>
				</button>
			) : null}

			<div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
				{/* A vault with forty entries needs a filter, or the list is as unusable as forty cards. */}
				<Input
					aria-label={`Filter ${singular}s`}
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					placeholder={`Filter ${singular}s…`}
					className="h-8 font-mono text-xs"
				/>
			</div>

			<div>
				{shown.length === 0 ? (
					<EmptyState
						className="px-4 py-8 md:px-4 md:py-8"
						title={
							members.length === 0
								? `No ${singular}s yet`
								: `No ${singular} matches “${filter}”`
						}
						description={members.length === 0 ? "Add one to get started." : undefined}
					/>
				) : (
					<ul>
						{shown.map((node) => {
							const status = resolveNodeStatusFor(nodes, core, env, node.id);
							const meta = NODE_STATUS_META[status.state];
							const nominal = status.state === "ready" || status.state === "live";
							const name = configName(node.data) || `(unnamed ${singular})`;
							return (
								// The remove control is a SIBLING of the row button, not a child — a button
								// inside a button is invalid HTML and swallows the click.
								<li
									key={node.id}
									className="flex items-center border-b border-border/60 transition-colors hover:bg-muted"
								>
									<button
										type="button"
										onClick={() => board.view.getState().setSubject({ kind: "node", id: node.id })}
										className="flex min-w-0 flex-1 items-center gap-2.5 py-2.5 pl-4 text-left"
									>
										<StatusBadge
											status={meta.label}
											tier={meta.vx}
											showLabel={false}
											className="shrink-0"
											title={status.message ?? meta.label}
											suppressHydrationWarning
										/>
										<span className="min-w-0 flex-1 truncate font-mono text-xs">
											{name}
										</span>
										{/* A failed secret has to be visible from the list — collapsing the
										    view must never hide trouble. */}
										{!nominal && (
											<span className="vx-eyebrow shrink-0 text-ui-3xs">
												{meta.label}
											</span>
										)}
									</button>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										className="mr-2 h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
										aria-label={`Remove ${name}`}
										onClick={() => removeNodes([node.id])}
									>
										<X className="h-3.5 w-3.5" />
									</Button>
								</li>
							);
						})}
					</ul>
				)}
			</div>
		</InspectorFrame>
	);
}
