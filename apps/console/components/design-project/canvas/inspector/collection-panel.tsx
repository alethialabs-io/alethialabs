"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Plus, X } from "lucide-react";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { cn } from "@repo/ui/utils";
import { useState } from "react";
import { NODE_REGISTRY } from "../graph/node-registry";
import { configName } from "../graph/node-config";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import {
	NODE_STATUS_META,
	resolveNodeStatusFor,
} from "@/lib/canvas/node-status";
import type { NodeKind } from "../graph/types";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

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
	const nodes = useCanvasStore((s) => s.nodes);
	const core = useCanvasStore((s) => s.getCoreIdentity());
	const env = useEnvironmentStatus();
	const addNode = useCanvasStore((s) => s.addNode);
	const removeNodes = useCanvasStore((s) => s.removeNodes);
	const openInspector = useCanvasStore((s) => s.openInspector);
	const [filter, setFilter] = useState("");

	const members = nodes.filter((n) => n.data.kind === kind);
	const needle = filter.trim().toLowerCase();
	const shown = needle
		? members.filter((n) => (configName(n.data) ?? "").toLowerCase().includes(needle))
		: members;

	const title = def.collection?.title ?? def.label;
	const singular = def.collection?.singular ?? def.label.toLowerCase();
	const Icon = def.icon;

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-start gap-3 border-b border-border p-4">
				<span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border text-muted-foreground">
					<Icon className="h-4 w-4" />
				</span>
				<div className="min-w-0 flex-1 space-y-1">
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-base font-semibold">{title}</span>
						<span className="vx-eyebrow rounded border border-border px-1.5 py-0.5">
							{members.length}
						</span>
					</div>
					<p className="truncate text-xs text-muted-foreground">
						{members.length} {members.length === 1 ? singular : `${singular}s`} in this
						environment.
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

			<div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
				{/* A vault with forty entries needs a filter, or the list is as unusable as forty cards. */}
				<Input
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					placeholder={`Filter ${singular}s…`}
					className="h-8 font-mono text-xs"
				/>
				<Button
					type="button"
					size="sm"
					className="h-8 shrink-0 text-xs"
					onClick={() => addNode(kind)}
				>
					<Plus className="mr-1 h-3.5 w-3.5" />
					Add
				</Button>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				{shown.length === 0 ? (
					<p className="px-4 py-8 text-center text-xs text-muted-foreground">
						{members.length === 0
							? `No ${singular}s yet. Add one to get started.`
							: `No ${singular} matches “${filter}”.`}
					</p>
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
										onClick={() => openInspector(node.id)}
										className="flex min-w-0 flex-1 items-center gap-2.5 py-2.5 pl-4 text-left"
									>
										<span
											className={cn("vx-status shrink-0", `vx-status--${meta.vx}`)}
											title={status.message ?? meta.label}
											suppressHydrationWarning
										>
											<span className="vx-status__dot" />
										</span>
										<span className="min-w-0 flex-1 truncate font-mono text-xs">
											{name}
										</span>
										{/* A failed secret has to be visible from the list — collapsing the
										    view must never hide trouble. */}
										{!nominal && (
											<span className="vx-eyebrow shrink-0 text-[9px]">
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
		</div>
	);
}
