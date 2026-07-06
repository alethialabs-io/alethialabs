"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Handle, Position } from "@xyflow/react";
import type { ReactNode } from "react";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { Badge } from "@repo/ui/badge";
import { cn } from "@repo/ui/utils";
import { NODE_REGISTRY } from "../graph/node-registry";
import { NODE_STATUS_META, useNodeReadiness } from "@/lib/canvas/node-status";
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
	const readiness = useNodeReadiness(id);
	if (!node) return null;

	const def = NODE_REGISTRY[node.data.kind];
	const Icon = def.icon;
	const status = NODE_STATUS_META[readiness.state];
	// The canvas stays calm when everything's fine: the nominal "ready" state shows only its dot;
	// states that want attention (needs-setup / gated, and Phase-2 provisioning states) carry a label.
	const showLabel = readiness.state !== "ready";

	return (
		<div
			className={cn(
				"min-w-[200px] rounded-none border bg-card text-card-foreground transition-shadow",
				selected
					? "border-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
					: "border-border hover:border-border-strong",
			)}
		>
			{handles.target && (
				<Handle type="target" position={Position.Top} className={HANDLE_CLASS} />
			)}

			<div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
				<Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
				<span className="vx-eyebrow">{def.eyebrow}</span>
				{/* Status is derived from the client store (persist/sessionStorage), so SSR and the first
				    client paint can differ. Keep the DOM structure STABLE across hydration — always render
				    the label span (hidden when nominal) rather than conditionally mounting it, and suppress
				    the benign text/attr mismatch — so a store rehydration never throws a hydration error. */}
				<span
					className={cn("vx-status ml-auto min-w-0", `vx-status--${status.vx}`)}
					title={readiness.issue ?? status.label}
					suppressHydrationWarning
				>
					<span className="vx-status__dot" />
					<span className={cn("truncate", !showLabel && "hidden")}>
						{status.label}
					</span>
				</span>
			</div>

			<div className="space-y-2 px-3 py-2.5">
				<div className="truncate text-sm font-medium leading-tight">{title}</div>

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
