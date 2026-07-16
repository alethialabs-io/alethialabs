"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Handle, Position } from "@xyflow/react";
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
	/**
	 * Render the dense treatment — a card inside a container region. Set by canvas-flow via the render
	 * node's `insideContainer` flag. The compact zoom tier also renders dense. Default (isolated card,
	 * e.g. a unit test) is the full card.
	 */
	dense?: boolean;
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
export function BaseNode({ id, selected, dense: denseProp }: BaseNodeProps) {
	const node = useCanvasStore((s) => s.nodes.find((n) => n.id === id));
	// `provider` (the effective cloud) still drives the fact grid + zones; the visible cloud-account
	// chip is gone — the cloud is chosen once, at project creation, so repeating it on every card is
	// noise. (getEffectiveIdentity, which fed that chip, is no longer read here.)
	const provider = useCanvasStore((s) => s.getEffectiveProvider(id));
	const resolved = useNodeStatus(id);
	const lod = useCanvasLod();
	if (!node) return null;

	const def = NODE_REGISTRY[node.data.kind];
	const handles = def.card.handles ?? DEFAULT_HANDLES;
	const status = NODE_STATUS_META[resolved.state];

	// An EXTERNAL card is one kind's worth of a bring-your-own IaC module, so it reads through the
	// kind its resources MAP to — a customer module's `aws_eks_*` group wears the cluster glyph and
	// says CLUSTER. That is what makes a BYO environment read as an architecture rather than as a
	// pile of Terraform. It stays unmistakably external: the dashed rule + dashed border are the
	// design system's own idiom for "not owned by this design", and they still apply.
	// Its title is the Terraform module the resources live in — the honest "where in your code".
	const external = node.data.kind === "external" ? node.data.config : null;
	const mapped = external?.mappedKind ? NODE_REGISTRY[external.mappedKind] : null;
	const Icon = mapped?.icon ?? def.icon;
	const eyebrow = mapped?.eyebrow ?? def.eyebrow;
	const title = external
		? external.module || "root module"
		: configName(node.data) || def.label;
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
						"grid h-11 w-11 cursor-pointer place-items-center border bg-card transition-colors",
						selected
							? "border-foreground"
							: "border-border-strong hover:border-foreground",
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

	// A card is DENSE when it sits inside a container region (the At-Scale treatment) or when the board
	// is zoomed to the compact tier: a tight 158px node whose facts collapse to one footer line. The
	// full fact grid is one click away in the definition panel.
	const dense = denseProp || lod === "compact";
	const primaryFact = facts.find((f) => f.value)?.value ?? facts[0]?.value ?? "";

	// ── dense tier — the density the canvas runs at inside its containers ────
	if (dense) {
		return (
			<div
				className={cn(
					"relative w-[158px] cursor-pointer rounded-none border bg-card text-card-foreground transition-colors",
					"before:absolute before:-inset-x-px before:-top-px before:h-0.5 before:content-['']",
					RULE_CLASS[def.classification],
					def.classification === "external" && "border-dashed",
					selected
						? "border-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
						: "border-border hover:border-border-strong",
				)}
			>
				{handles.target && (
					<Handle type="target" position={Position.Top} className={HANDLE_CLASS} />
				)}

				{/* inline icon (no plate), kind eyebrow, and the status DOT only — the detail rides in the
				    footer, matching the At-Scale `.n` node. */}
				<div className="flex items-center gap-1.5 border-b border-border/60 px-2 py-1">
					<Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
					<span className="vx-eyebrow truncate text-[9px]">{eyebrow}</span>
					<span
						className={cn("vx-status ml-auto shrink-0", `vx-status--${status.vx}`)}
						title={resolved.message ?? status.label}
						suppressHydrationWarning
					>
						<span className="vx-status__dot" />
					</span>
				</div>

				<div className="space-y-1 px-2 py-1.5">
					<div className="truncate font-mono text-[11px] leading-tight text-foreground">
						{title}
					</div>
					{/* cost · primary fact  [Drift] — a fabricated $0 is never shown (honest silence). */}
					{(resolved.monthlyCost != null || primaryFact || drifted > 0) && (
						<div className="flex items-center gap-1.5 font-mono text-[9px] text-muted-foreground">
							{resolved.monthlyCost != null && (
								<span className="shrink-0 text-muted-foreground">
									{formatMonthly(resolved.monthlyCost)}
								</span>
							)}
							{resolved.monthlyCost != null && primaryFact && (
								<span className="shrink-0">·</span>
							)}
							{primaryFact && <span className="truncate">{primaryFact}</span>}
							{drifted > 0 && (
								<span className="ml-auto shrink-0 border border-border-strong px-1 text-[8px] uppercase tracking-wide text-foreground">
									Drift
								</span>
							)}
						</div>
					)}
				</div>

				{handles.source && (
					<Handle type="source" position={Position.Bottom} className={HANDLE_CLASS} />
				)}
			</div>
		);
	}

	// ── full tier — the anatomy: plate, name, the whole fact grid, cost footer ──
	return (
		<div
			className={cn(
				"relative w-[248px] cursor-pointer rounded-none border bg-card text-card-foreground transition-colors",
				// the classification rule — a 2px band across the card's top edge
				"before:absolute before:-inset-x-px before:-top-px before:h-0.5 before:content-['']",
				RULE_CLASS[def.classification],
				def.classification === "external" && "border-dashed",
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
				<span className="vx-eyebrow truncate">{eyebrow}</span>
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

				<FactGrid facts={facts} />
			</div>

			{/* What this resource costs, from the last PLAN's Infracost breakdown. Absent until the
			    environment has been planned — an honest silence rather than a fabricated $0. */}
			{resolved.monthlyCost != null && (
				<div className="flex items-center gap-2 border-t border-border/60 px-2.5 py-1.5">
					<span className="font-mono text-[10px] text-foreground">
						{formatMonthly(resolved.monthlyCost)}
					</span>
					{drifted > 0 && (
						<span className="ml-auto border border-border-strong px-1 font-mono text-[9px] uppercase tracking-wide">
							{drifted} drifted
						</span>
					)}
				</div>
			)}

			{handles.source && (
				<Handle type="source" position={Position.Bottom} className={HANDLE_CLASS} />
			)}
		</div>
	);
}

/** A monthly figure, in the terse mono the board speaks. Money is precise (the design system's rule). */
function formatMonthly(value: number): string {
	return `$${value.toFixed(2)}/mo`;
}

/**
 * The per-service fact grid — the card's real differentiator, shown on the full tier. Hairline cells,
 * mono throughout. An empty value draws a muted dash rather than an empty cell, so an unconfigured
 * resource reads as unconfigured at a glance. (The dense tier collapses this to one footer line.)
 */
function FactGrid({ facts }: { facts: { label: string; value: string }[] }) {
	if (facts.length === 0) return null;

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
