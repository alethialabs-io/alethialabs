"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The bring-your-own Helm chart canvas node (design "BYO Helm Chart" spec, Section C): a hairline
// squared card carrying the chart id, repo·path·ref, and an ArgoCD status dot read by shape
// (SYNCED / PROGRESSING / DEGRADED / PENDING). Chart nodes are out-of-band (project_addons), so
// this reads its config straight off the store node and detaches through the mutation contract, which
// re-reads the board's charts — it does not participate in the form graph or the Pending Changes diff.

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useState } from "react";
import { GitBranch, RefreshCw, X } from "lucide-react";
import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";
import { cn } from "@repo/ui/utils";
import { ConfirmAction } from "@/components/confirm/confirm-action";
import { useBoard } from "@/lib/canvas/store/canvas-store-provider";
import { useAnyNode } from "@/lib/canvas/store/use-board";
import { detachByoChartAction } from "@/app/server/actions/byo-charts";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { orpc } from "@/lib/rpc/client";
import { type CanvasNode, nodeOfKind } from "../graph/types";
import type { VerifyReport } from "@/types/jsonb.types";
import { useByoChartCanvas } from "@/components/design-project/byo/byo-chart-canvas-context";
import { CardDescription, useBoardMarks } from "./card-marks";

/**
 * A chart's handles anchor the edges to its described workloads and nothing else: no connection is
 * drawn to or from a chart, so they are not drawn and take no pointer.
 */
const HANDLE_CLASS = "!h-2 !w-2 !border-0 !bg-transparent !opacity-0 !pointer-events-none";

/**
 * The chart's scan-status chip — a label plus a StatusBadge tier, derived from the persisted scan
 * lifecycle and the verify verdict. State is read through the dot's shape and the mono label, never
 * hue: a scan in flight is `pending` (the haloed dot), a failing control or a failed run is
 * `failed`, a chart with no failing control is `active` (its label still counts any warnings), and
 * a chart with no scan yet is `idle`.
 */
function scanChip(
	scanStatus?: string,
	report?: VerifyReport | null,
): { label: string; tier: StatusTier } {
	// Both chart sources scan: the runner resolves a git chart by cloning and an OCI chart by pulling
	// it from the registry (#1300), so the chip is driven purely by the scan lifecycle.
	if (scanStatus === "scanning") return { label: "Scanning…", tier: "pending" };
	if (scanStatus === "failed") return { label: "Scan failed", tier: "failed" };
	if (scanStatus === "done" && report) {
		const issues = report.summary.fail + report.summary.warn;
		if (issues === 0) return { label: "Clean", tier: "active" };
		return {
			label: `${issues} issue${issues > 1 ? "s" : ""}`,
			tier: report.summary.fail > 0 ? "failed" : "active",
		};
	}
	return { label: "Not scanned", tier: "idle" };
}

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
	const raw = useAnyNode(id);
	const node = nodeOfKind(raw, "chart");
	const ctx = useByoChartCanvas();
	const board = useBoard();
	const [confirmDetach, setConfirmDetach] = useState(false);
	// Pending while in flight, and held after it lands: the node leaves the board when the chart
	// read settles, and until then a second press would detach a chart that is already gone.
	const detachChart = useActionMutation(detachByoChartAction, {
		invalidates: [orpc.canvas.byoCharts.key(), orpc.canvas.chartWorkloads.key()],
		successMessage: (data) => `Chart "${data.id}" detached.`,
	});
	const detaching = detachChart.isPending || detachChart.isSuccess;
	const marks = useBoardMarks();
	if (!node) return null;
	const c = node.data.config;
	const st = STATUS_META[chartStatus(c.health, c.status)];
	const chip = scanChip(c.scanStatus, c.scanReport);
	// Same contract as every other card (`nodes/node-name.ts`): the board's cards are named, so the
	// audit can score them and a journey can reach THIS chart rather than "the first
	// `.react-flow__node-chart`". A chart's own name is its release id; the name sits on the element
	// a keyboard lands on, React Flow's wrapper (`boardCardName`), and this element stays unnamed.

	// The detach is reached ONLY through the confirmation below — `detachByoChart` deletes the
	// ArgoCD Application and the `project_addons` row, and a chart is attached by pasting a repo
	// URL, a path and a ref, so an accidental 24x24 `×` costs the user all three. Every other
	// detach in the console (`byo.iac.detach`) already asks; this one was the registry's last
	// `confirm: none` on the canvas (#4279).

	return (
		<div
			className={cn(
				"min-w-[220px] cursor-pointer rounded-none border bg-card text-card-foreground transition-colors",
				selected
					? "border-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
					: "border-border hover:border-border-strong",
			)}
		>
			<CardDescription
				nodeId={id}
				facts={{
					// The words the card prints, in sentence case: the sync state and the scan verdict.
					status: `${st.label.charAt(0)}${st.label.slice(1).toLowerCase()}`,
					notes: [`Chart safety scan: ${chip.label}`],
					connections: marks.connections.get(id),
				}}
			/>
			<Handle
				type="target"
				position={Position.Top}
				className={HANDLE_CLASS}
				isConnectable={false}
			/>
			{/* Sources the described chart-workload children (W5 Path A). */}
			<Handle
				type="source"
				position={Position.Bottom}
				className={HANDLE_CLASS}
				isConnectable={false}
			/>

			<div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
				<GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
				<span className="vx-eyebrow">Helm chart</span>
				<span className="ml-auto flex items-center gap-1.5 font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground">
					<span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", st.dot)} />
					{st.label}
				</span>
			</div>

			<div className="flex flex-col gap-2 px-3 py-2.5">
				<div className="text-sm font-semibold text-foreground">{c.id}</div>
				<div className="flex items-center gap-1.5 self-start border border-border px-2 py-1 font-mono text-ui-2xs text-muted-foreground">
					<GitBranch className="h-3 w-3" />
					{c.repoUrl.replace(/^https?:\/\/(www\.)?/, "").replace(/\.git$/, "")}
				</div>
				<div className="flex gap-3 font-mono text-ui-2xs text-muted-foreground">
					<span>
						path <span className="text-foreground">/{c.chartPath.replace(/^\/+/, "")}</span>
					</span>
					<span>
						ref <span className="text-foreground">{c.ref}</span>
					</span>
				</div>
				{/* Chart-safety scan chip — opens the findings card on the workspace rail. */}
				<button
					type="button"
					onClick={() => board.view.getState().openCard({ kind: "chart-scan", chartId: c.id })}
					title="Chart safety scan"
					className="flex items-center self-start rounded-none border border-border px-2 py-1 transition-colors hover:bg-muted"
				>
					<StatusBadge status={c.scanStatus ?? "unscanned"} tier={chip.tier} label={chip.label} />
				</button>
				<div className="flex items-center gap-2 border-t border-border/60 pt-2">
					<span className="flex items-center gap-1.5 font-mono text-ui-2xs text-muted-foreground">
						<RefreshCw className="h-3 w-3" /> manual sync · ns {c.namespace}
					</span>
					{ctx && (
						<button
							type="button"
							onClick={() => setConfirmDetach(true)}
							disabled={detaching}
							title="Detach chart"
							aria-label="Detach chart"
							className="ml-auto grid h-6 w-6 place-items-center rounded-none border border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
						>
							<X className="h-3 w-3" />
						</button>
					)}
				</div>
			</div>

			{/* `confirmLabel` is "Detach", NOT "Detach chart": that second string is the TRIGGER's
			    accessible name, and two buttons sharing one name make
			    `getByRole("button", { name: "Detach chart" })` ambiguous the moment the dialog is open.
			    The destructive-action registry reaches the trigger by `control.name` and the confirm by
			    `confirm_action`, so the two must not collide. */}
			<ConfirmAction
				open={confirmDetach}
				onOpenChange={setConfirmDetach}
				title="Detach this chart?"
				description="The chart's ArgoCD Application and everything it deployed are removed from the cluster. Re-attaching means entering the repository, path and ref again."
				confirmLabel="Detach"
				pendingLabel="Detaching…"
				severity={{ level: "confirm" }}
				mutation={detachChart}
				variables={
					ctx ? { projectId: ctx.projectId, environmentId: ctx.environmentId, id: c.id } : null
				}
			/>
		</div>
	);
}
