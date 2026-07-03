"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Handle, Position } from "@xyflow/react";
import type { ReactNode } from "react";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { Badge } from "@repo/ui/badge";
import { cn } from "@repo/ui/utils";
import { NODE_REGISTRY } from "../graph/node-registry";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

/** Small squared connection nub — grayscale, no radius (design system). */
const HANDLE_CLASS = "!h-2 !w-2 !rounded-none !border !border-border !bg-background";

interface BaseNodeProps {
	id: string;
	title: string;
	selected?: boolean;
	/** Connection handles to render. */
	handles?: { source?: boolean; target?: boolean };
	/** Terse summary lines shown under the title. */
	children?: ReactNode;
}

/**
 * Shared node chrome: hairline squared card, eyebrow kind label, Geist title, a
 * mono provider chip (glyph + identity), and a shape-based status dot. Grayscale
 * only — providers are read from text/glyph, never hue.
 */
export function BaseNode({
	id,
	title,
	selected,
	handles = { source: true, target: true },
	children,
}: BaseNodeProps) {
	const node = useCanvasStore((s) => s.nodes.find((n) => n.id === id));
	const identity = useCanvasStore((s) => s.getEffectiveIdentity(id));
	const core = useCanvasStore((s) => s.getCoreIdentity());
	if (!node) return null;

	const def = NODE_REGISTRY[node.data.kind];
	const Icon = def.icon;
	const effId = node.data.cloud_identity_id ?? core;
	const gated = def.classification === "core" && !!core && effId !== core;

	return (
		<div
			className={cn(
				"min-w-[196px] border bg-card text-card-foreground rounded-none",
				selected ? "border-foreground shadow-sm" : "border-border",
			)}
		>
			{handles.target && (
				<Handle type="target" position={Position.Top} className={HANDLE_CLASS} />
			)}

			<div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
				<Icon className="h-3.5 w-3.5 text-muted-foreground" />
				<span className="vx-eyebrow">{def.eyebrow}</span>
				<span
					className={cn(
						"vx-status ml-auto",
						gated ? "vx-status--disabled" : "vx-status--idle",
					)}
					title={gated ? "Cross-cloud — can't provision yet" : "Configured"}
				>
					<span className="vx-status__dot" />
				</span>
			</div>

			<div className="space-y-1.5 px-3 py-2">
				<div className="truncate text-sm font-medium">{title}</div>

				{def.cloudScoped &&
					(identity ? (
						<Badge
							variant="outline"
							className="gap-1 rounded-none font-mono text-[10px] font-normal"
						>
							<ProviderIcon
								provider={identity.provider}
								size={12}
								className="shrink-0"
							/>
							<span className="truncate">{identity.displayId}</span>
						</Badge>
					) : (
						<span className="font-mono text-[10px] text-muted-foreground">
							{node.data.kind === "project" ? "no cloud account" : "inherits core"}
						</span>
					))}

				{children}
			</div>

			{handles.source && (
				<Handle type="source" position={Position.Bottom} className={HANDLE_CLASS} />
			)}
		</div>
	);
}
