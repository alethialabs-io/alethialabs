"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Node, NodeProps } from "@xyflow/react";
import { Network, Server } from "lucide-react";
import { cn } from "@repo/ui/utils";
import type { ZoneNodeData } from "@/lib/canvas/zones";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

const ZONE_META = {
	network: { label: "VPC", Icon: Network },
	cluster: { label: "Cluster", Icon: Server },
} as const;

/**
 * A zone — the VPC, and the cluster nested inside it.
 *
 * Purely a background region: not draggable, not selectable, painted behind every card. It's derived
 * from where its members are, so dragging a resource simply re-bounds the region around it. The
 * cards on top do all the work; this just tells you which region you're looking at.
 */
export function ZoneNode({ data }: NodeProps<Node<ZoneNodeData>>) {
	const { label, Icon } = ZONE_META[data.zone];

	// The zone's own summary comes from the card that anchors it (the network / cluster node), so the
	// region header can say `10.0.0.0/16` or `EKS · 1.31` without duplicating the card's logic.
	const anchor = useCanvasStore((s) =>
		s.nodes.find((n) => n.data.kind === data.zone),
	);
	const meta = anchor ? summarize(data.zone, anchor.data.config) : null;

	return (
		<div
			className={cn(
				"pointer-events-none h-full w-full rounded-none border",
				// The nested region is drawn a shade lighter so the containment reads at a glance.
				data.depth === 0
					? "border-border-strong bg-foreground/[0.012]"
					: "border-border bg-foreground/[0.012]",
			)}
		>
			<div className="flex items-center gap-2 border-b border-border bg-card/80 px-2.5 py-1.5">
				<span className="grid h-5 w-5 shrink-0 place-items-center border border-border bg-surface-sunken">
					<Icon className="h-3 w-3 text-muted-foreground" />
				</span>
				<span className="vx-eyebrow">{label}</span>
				{meta && (
					<span className="truncate font-mono text-[10px] text-muted-foreground">
						{meta}
					</span>
				)}
			</div>
		</div>
	);
}

/** The one-line summary a zone header shows, read from its anchor card's config. */
function summarize(zone: "network" | "cluster", config: unknown): string | null {
	const c = config as Record<string, unknown>;
	if (zone === "network") {
		if (c.provision_network === false) {
			return typeof c.network_id === "string" ? c.network_id : "existing network";
		}
		return typeof c.cidr_block === "string" ? c.cidr_block : null;
	}
	const version = typeof c.cluster_version === "string" ? c.cluster_version : null;
	const min = c.node_min_size;
	const max = c.node_max_size;
	const nodes =
		typeof min === "number" && typeof max === "number" ? `${min}–${max} nodes` : null;
	return [version && `k8s ${version}`, nodes].filter(Boolean).join(" · ") || null;
}
