"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The bring-your-own Helm chart canvas node (design "BYO Helm Chart" spec, Section C): a hairline
// squared card carrying the chart id, repo·path·ref, and an ArgoCD status dot read by shape
// (SYNCED / PROGRESSING / DEGRADED / PENDING). Chart nodes are out-of-band (project_addons), so
// this reads its config straight off the store node and detaches via the server action + a context
// refresh — it does not participate in the form graph or the Pending Changes diff.

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useState } from "react";
import { GitBranch, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@repo/ui/utils";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { detachByoChart } from "@/app/server/actions/byo-charts";
import type { CanvasNode } from "../graph/types";
import { useByoChartCanvas } from "@/components/design-project/byo/byo-chart-canvas-context";

const HANDLE_CLASS = "!h-2 !w-2 !rounded-none !border !border-border !bg-background";

type ChartStatus = "synced" | "progressing" | "degraded" | "pending";

/** Maps the persisted status/health onto one of the four canvas states (read by dot shape). */
function chartStatus(health?: string | null, status?: string): ChartStatus {
	if (health === "Healthy") return "synced";
	if (health === "Progressing" || status === "CREATING") return "progressing";
	if (health === "Degraded" || health === "Missing" || status === "FAILED") return "degraded";
	return "pending";
}

const STATUS_META: Record<ChartStatus, { label: string; dot: string }> = {
	synced: { label: "SYNCED", dot: "bg-foreground" },
	progressing: { label: "PROGRESSING", dot: "bg-muted-foreground animate-pulse" },
	degraded: { label: "DEGRADED", dot: "border border-muted-foreground bg-transparent" },
	pending: { label: "PENDING", dot: "bg-muted-foreground/50" },
};

/** React Flow node renderer for a `chart` kind. */
export function ChartNode({ id, selected }: NodeProps<CanvasNode<"chart">>) {
	const node = useCanvasStore((s) => s.nodes.find((n) => n.id === id)) as
		| CanvasNode<"chart">
		| undefined;
	const ctx = useByoChartCanvas();
	const [detaching, setDetaching] = useState(false);
	if (!node) return null;
	const c = node.data.config;
	const st = STATUS_META[chartStatus(c.health, c.status)];

	const detach = async () => {
		if (!ctx) return;
		setDetaching(true);
		try {
			await detachByoChart({ projectId: ctx.projectId, environmentId: ctx.environmentId, id: c.id });
			toast.success(`Chart "${c.id}" detached.`);
			ctx.refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Could not detach the chart.");
			setDetaching(false);
		}
	};

	return (
		<div
			className={cn(
				"min-w-[220px] rounded-none border bg-card text-card-foreground transition-shadow",
				selected
					? "border-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
					: "border-border hover:border-border-strong",
			)}
		>
			<Handle type="target" position={Position.Top} className={HANDLE_CLASS} />

			<div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
				<GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
				<span className="vx-eyebrow">Helm chart</span>
				<span className="ml-auto flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
					<span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", st.dot)} />
					{st.label}
				</span>
			</div>

			<div className="flex flex-col gap-2 px-3 py-2.5">
				<div className="text-sm font-semibold text-foreground">{c.id}</div>
				<div className="flex items-center gap-1.5 self-start border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground">
					<GitBranch className="h-3 w-3" />
					{c.repoUrl.replace(/^https?:\/\/(www\.)?/, "").replace(/\.git$/, "")}
				</div>
				<div className="flex gap-3 font-mono text-[10px] text-muted-foreground">
					<span>
						path <span className="text-foreground/80">/{c.chartPath.replace(/^\/+/, "")}</span>
					</span>
					<span>
						ref <span className="text-foreground/80">{c.ref}</span>
					</span>
				</div>
				<div className="flex items-center gap-2 border-t border-border/60 pt-2">
					<span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
						<RefreshCw className="h-3 w-3" /> manual sync · ns {c.namespace}
					</span>
					{ctx && (
						<button
							type="button"
							onClick={detach}
							disabled={detaching}
							title="Detach chart"
							className="ml-auto grid h-6 w-6 place-items-center rounded-none border border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
						>
							<X className="h-3 w-3" />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
