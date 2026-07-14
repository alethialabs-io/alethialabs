"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Handle, Position } from "@xyflow/react";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { cn } from "@repo/ui/utils";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { NODE_REGISTRY, type NodeFact } from "../graph/node-registry";
import { configName } from "../graph/node-config";
import type { NodeConfig } from "../graph/types";
import { NODE_STATUS_META, useNodeStatus } from "@/lib/canvas/node-status";
import { useCanvasLod } from "@/lib/canvas/use-canvas-lod";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

/** Small squared connection nub — grayscale, no radius (design system). */
const HANDLE_CLASS = "!h-2 !w-2 !rounded-none !border !border-border !bg-background";

/**
 * The classification rule: a node's top border says what KIND of citizen it is. Grayscale-legal
 * structure doing the job colour would otherwise do.
 *   root      solid, full ink  — the project anchor
 *   core      solid, strong    — must colocate on the stack's cloud
 *   periphery hairline         — may diverge to another cloud
 *   external  dashed           — not owned by the design (BYO); the system's "not connected" idiom
 */
const RULE_CLASS: Record<string, string> = {
	root: "before:bg-foreground",
	core: "before:bg-border-strong",
	periphery: "before:bg-border",
	external: "before:bg-transparent before:border-t before:border-dashed before:border-border-strong",
};

interface BaseNodeProps {
	id: string;
	selected?: boolean;
}

/** Leaves are targets only; the registry overrides this for the network / cluster / project. */
const DEFAULT_HANDLES: { source?: boolean; target?: boolean } = { target: true };

/**
 * The canvas card — ONE renderer for every node kind, driven by the registry's `card.facts`.
 *
 * The design system is grayscale, so a service can't be told apart by hue. It's told apart by its
 * icon plate, its classification rule, and above all its FACTS — the two or three things that
 * matter for that kind (a database reads "PostgreSQL 16 · 0.5–4 · 7 d"; a bucket reads
 * "private · on · 2 origins"). Providers read from the brand glyph (the one sanctioned colour) and
 * status from dot fill/shape. Detail is shed by zoom (`useCanvasLod`) so a large architecture
 * stays legible.
 */
export function BaseNode({ id, selected }: BaseNodeProps) {
	const node = useCanvasStore((s) => s.nodes.find((n) => n.id === id));
	const identity = useCanvasStore((s) => s.getEffectiveIdentity(id));
	const provider = useCanvasStore((s) => s.getEffectiveProvider(id));
	const resolved = useNodeStatus(id);
	const lod = useCanvasLod();
	if (!node) return null;

	const def = NODE_REGISTRY[node.data.kind];
	const handles = def.card.handles ?? DEFAULT_HANDLES;
	const Icon = def.icon;
	const status = NODE_STATUS_META[resolved.state];
	const title = configName(node.data) || def.label;
	// The canvas stays calm when everything is fine: the two nominal states show only their dot;
	// every state that wants attention carries a label.
	const showLabel = resolved.state !== "ready" && resolved.state !== "live";
	const drifted = resolved.drift.length;

	// A node's `kind` discriminant and its registry entry are correlated at runtime, but TypeScript
	// can't prove it through the keyed lookup (the same discriminated-union limitation the canvas
	// store's `buildNodeData` documents). Assert the reunion once, here.
	const factsOf = def.card.facts as (ctx: {
		config: NodeConfig;
		provider: CloudProviderSlug | null;
	}) => NodeFact[];
	const facts = factsOf({ config: node.data.config, provider });

	// Status derives from the client store (sessionStorage-persisted), so SSR and the first client
	// paint can differ. Keep the DOM STABLE across hydration — always render the label span (hidden
	// when nominal) rather than conditionally mounting it, and suppress the benign text mismatch —
	// so a store rehydration never throws a hydration error.
	const statusEl = (
		<span
			className={cn("vx-status min-w-0", `vx-status--${status.vx}`)}
			title={resolved.message ?? status.label}
			suppressHydrationWarning
		>
			<span className="vx-status__dot" />
			<span className={cn("truncate", !showLabel && "hidden")}>{status.label}</span>
		</span>
	);

	// ── glyph tier — far out, a node is an icon, a name, and a pulse ────────
	if (lod === "glyph") {
		return (
			<div className="flex w-[76px] flex-col items-center gap-1.5">
				{handles.target && (
					<Handle type="target" position={Position.Top} className={HANDLE_CLASS} />
				)}
				<span
					className={cn(
						"grid h-11 w-11 place-items-center border bg-card",
						selected ? "border-foreground" : "border-border-strong",
						def.classification === "external" && "border-dashed",
					)}
				>
					<Icon className="h-5 w-5 text-muted-foreground" />
				</span>
				<span className="max-w-[76px] truncate font-mono text-[10px] text-muted-foreground">
					{title}
				</span>
				{statusEl}
				{handles.source && (
					<Handle type="source" position={Position.Bottom} className={HANDLE_CLASS} />
				)}
			</div>
		);
	}

	const compact = lod === "compact";

	return (
		<div
			className={cn(
				"relative rounded-none border bg-card text-card-foreground transition-colors",
				// the classification rule — a 2px band across the card's top edge
				"before:absolute before:-inset-x-px before:-top-px before:h-0.5 before:content-['']",
				RULE_CLASS[def.classification],
				def.classification === "external" && "border-dashed",
				compact ? "w-[176px]" : "w-[248px]",
				selected
					? "border-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
					: "border-border hover:border-border-strong",
			)}
		>
			{handles.target && (
				<Handle type="target" position={Position.Top} className={HANDLE_CLASS} />
			)}

			<div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-2">
				<span className="grid h-[22px] w-[22px] shrink-0 place-items-center border border-border bg-surface-sunken">
					<Icon className="h-3.5 w-3.5 text-muted-foreground" />
				</span>
				<span className="vx-eyebrow truncate">{def.eyebrow}</span>
				<span className="ml-auto min-w-0 shrink-0">{statusEl}</span>
			</div>

			<div className="space-y-2 px-2.5 py-2.5">
				<div
					className={cn(
						"truncate leading-tight",
						def.cardinality === "array"
							? "font-mono text-xs"
							: "text-sm font-medium",
					)}
				>
					{title}
				</div>

				{/* Provider chip — the brand mark is the only colour on the canvas. Dropped at the
				    compact tier: at that zoom the cloud is carried by the containing zone. */}
				{def.cloudScoped && !compact && (
					<span
						className={cn(
							"inline-flex max-w-full items-center gap-1.5 border px-1.5 py-0.5 font-mono text-[10px]",
							identity
								? "border-border text-muted-foreground"
								: "border-dashed border-border text-muted-foreground/70",
						)}
					>
						{identity ? (
							<>
								<ProviderIcon
									provider={identity.provider}
									size={12}
									className="shrink-0"
								/>
								<span className="truncate">{identity.displayId}</span>
							</>
						) : (
							<span className="truncate">
								{node.data.kind === "project" ? "no cloud account" : "inherits core"}
							</span>
						)}
					</span>
				)}

				<FactGrid facts={facts} compact={compact} />
			</div>

			{handles.source && (
				<Handle type="source" position={Position.Bottom} className={HANDLE_CLASS} />
			)}
		</div>
	);
}

/**
 * The per-service fact grid — the card's real differentiator. Hairline cells, mono throughout. An
 * empty value draws a muted dash rather than an empty cell, so an unconfigured resource reads as
 * unconfigured at a glance. The compact tier collapses to the single highest-priority fact.
 */
function FactGrid({
	facts,
	compact,
}: {
	facts: { label: string; value: string }[];
	compact: boolean;
}) {
	if (facts.length === 0) return null;

	if (compact) {
		const first = facts[0];
		return (
			<div
				className={cn(
					"truncate font-mono text-[10px]",
					first.value ? "text-muted-foreground" : "text-muted-foreground/60",
				)}
			>
				{first.value || "—"}
			</div>
		);
	}

	const shown = facts.slice(0, 3);
	return (
		<dl
			className="grid gap-px border border-border/60 bg-border/60"
			style={{ gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))` }}
		>
			{shown.map((f) => (
				<div key={f.label} className="min-w-0 bg-card px-1.5 py-1">
					<dt className="vx-eyebrow truncate text-[9px]">{f.label}</dt>
					<dd
						className={cn(
							"truncate font-mono text-[11px]",
							f.value ? "text-foreground" : "text-muted-foreground/60",
						)}
					>
						{f.value || "—"}
					</dd>
				</div>
			))}
		</dl>
	);
}
