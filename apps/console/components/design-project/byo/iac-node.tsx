"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The external-IaC source card — the module's PROVENANCE, anchored on the board when the environment
// has a bring-your-own OpenTofu module attached. It carries the module coords (repo · ref · path),
// the commit the scan pinned (what a deploy applies), a scan-status chip that opens the findings
// sheet, and a deployed-commit indicator (live BYO state).
//
// It is NOT the architecture. The module's RESOURCES are their own read-only `external` cards on the
// board (lib/canvas/iac-inventory.ts); this card only says where they came from. The component
// palette stays disabled for a BYO env — the module, not the design, is the source of truth — but the
// board is still a board. (It used to sit alone inside a full-canvas overlay that dimmed everything.)
//
// Reads its source + refresh from IacSourceCanvasContext (single-per-env), detaches / rescans via the
// server actions.

import { useState } from "react";
import {
	Boxes,
	GitBranch,
	GitCommitHorizontal,
	Loader2,
	Rocket,
	ShieldAlert,
	ShieldCheck,
	ShieldQuestion,
	X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@repo/ui/utils";
import { detachIacSource, type IacSourceState } from "@/app/server/actions/byo-iac";
import { ConfirmDialog } from "@/components/alerts/confirm-dialog";
import { useIacSourceCanvas } from "@/components/design-project/byo/iac-source-canvas-context";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import type { IacScanReport } from "@/types/jsonb.types";

/** The scan-status chip — label + tone + icon, derived from the scan lifecycle + the report's
 * ok/finding count (a not-ok scan draws destructive ink; a clean module stays calm). */
function scanChip(
	scanStatus: string,
	report: IacScanReport | null,
): { label: string; cls: string; Icon: typeof ShieldCheck; spin?: boolean } {
	if (scanStatus === "scanning")
		return { label: "Scanning…", cls: "text-muted-foreground", Icon: Loader2, spin: true };
	if (scanStatus === "failed")
		return { label: "Scan failed", cls: "text-destructive", Icon: ShieldAlert };
	if (scanStatus === "done" && report) {
		const issues = report.findings.length;
		if (report.ok && issues === 0)
			return { label: "Clean", cls: "text-foreground", Icon: ShieldCheck };
		return {
			label: `${issues} finding${issues === 1 ? "" : "s"}`,
			cls: report.ok ? "text-muted-foreground" : "text-destructive",
			Icon: ShieldAlert,
		};
	}
	return { label: "Not scanned", cls: "text-text-tertiary", Icon: ShieldQuestion };
}

/** Short 7-char sha for display (git-style); empty string passes through. */
function shortSha(sha: string | null): string {
	return sha ? sha.slice(0, 7) : "";
}

/** The read-only external-IaC source card, driven by IacSourceCanvasContext. */
export function IacNode({ source }: { source: IacSourceState }) {
	const ctx = useIacSourceCanvas();
	const openCard = useCanvasStore((s) => s.openCard);
	const [detaching, setDetaching] = useState(false);
	// Detaching is not undoable from this card — the environment silently reverts to the built-in
	// template and the module's `external` cards leave the board — so the click OPENS a confirm
	// rather than firing the server action (#4281).
	const [confirmDetach, setConfirmDetach] = useState(false);

	// `detachIacSource` REFUSES a detach that would drop the handle to live BYO infra
	// (app/server/actions/byo-iac.ts): a source with a deployed commit, or an environment whose
	// status means template state exists or is in flight. The card can see the first of those —
	// it already renders it as DEPLOYED — so the trigger is gated on it rather than offering a
	// confirmation whose only possible outcome is an error toast (#4600 review). The env-status
	// half is not on this card, so the dialog's copy names the precondition too.
	const holdsDeployedState = source.deployedCommitSha !== null;
	const chip = scanChip(source.scanStatus, source.scanReport);
	const ChipIcon = chip.Icon;
	const repoLabel = source.repoUrl.replace(/^https?:\/\/(www\.)?/, "").replace(/\.git$/, "");
	const pinned = shortSha(source.commitSha);
	const deployed = shortSha(source.deployedCommitSha);

	const detach = async () => {
		if (!ctx) return;
		setDetaching(true);
		try {
			await detachIacSource({ projectId: ctx.projectId, environmentId: ctx.environmentId });
			toast.success("IaC source detached — this environment falls back to the built-in template.");
			ctx.refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Could not detach the IaC source.");
			setDetaching(false);
		}
	};

	return (
		<div className="min-w-[240px] rounded-none border border-border bg-card text-card-foreground">
			<div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
				<Boxes className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
				<span className="vx-eyebrow">External IaC</span>
				<span className="ml-auto flex items-center gap-1.5 font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground">
					<span
						className={cn(
							"h-1.5 w-1.5 shrink-0 rounded-full",
							source.deployedCommitSha ? "bg-foreground" : "bg-muted-foreground/50",
						)}
					/>
					{source.deployedCommitSha ? "DEPLOYED" : "NOT DEPLOYED"}
				</span>
			</div>

			<div className="flex flex-col gap-2 px-3 py-2.5">
				<div className="text-sm font-semibold text-foreground">{source.name}</div>
				<div className="flex items-center gap-1.5 self-start border border-border px-2 py-1 font-mono text-ui-2xs text-muted-foreground">
					<GitBranch className="h-3 w-3" />
					{repoLabel}
				</div>
				<div className="flex gap-3 font-mono text-ui-2xs text-muted-foreground">
					<span>
						path <span className="text-foreground">/{source.path.replace(/^\/+/, "") || ""}</span>
					</span>
					<span>
						ref <span className="text-foreground">{source.ref ?? "HEAD"}</span>
					</span>
				</div>

				{/* Pinned + deployed commits */}
				<div className="flex flex-wrap gap-2 font-mono text-ui-2xs text-muted-foreground">
					<span className="flex items-center gap-1.5">
						<GitCommitHorizontal className="h-3 w-3" />
						pinned <span className="text-foreground">{pinned || "—"}</span>
					</span>
					{deployed && (
						<span className="flex items-center gap-1.5">
							<Rocket className="h-3 w-3" />
							deployed <span className="text-foreground">{deployed}</span>
						</span>
					)}
				</div>

				{/* Scan chip — opens the findings card on the workspace rail. */}
				<button
					type="button"
					onClick={() => openCard({ kind: "iac-scan" })}
					title="IaC safety scan"
					className="flex items-center gap-1.5 self-start rounded-none border border-border px-2 py-1 font-mono text-ui-2xs transition-colors hover:bg-muted"
				>
					<ChipIcon className={cn("h-3 w-3", chip.cls, chip.spin && "animate-spin")} />
					<span className={chip.cls}>{chip.label}</span>
				</button>

				{ctx && (
					<div className="flex flex-col gap-1.5 border-t border-border/60 pt-2">
						<div className="flex items-center gap-2">
							<span className="font-mono text-ui-2xs text-muted-foreground">replace mode</span>
							{/* `title` is this button's ACCESSIBLE NAME (the label is an icon), and the
							    destructive-action registry locates it by that name — so it stays the same
							    string in both states, and the reason for a disabled X is a visible line
							    below rather than a swapped title. */}
							<button
								type="button"
								onClick={() => setConfirmDetach(true)}
								disabled={detaching || holdsDeployedState}
								title="Detach IaC source"
								className="ml-auto grid h-6 w-6 place-items-center rounded-none border border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
							>
								<X className="h-3 w-3" />
							</button>
						</div>
						{holdsDeployedState && (
							<p className="text-ui-2xs text-muted-foreground">
								Destroy this environment before detaching — it has infrastructure deployed
								from this source.
							</p>
						)}
					</div>
				)}
			</div>

			<ConfirmDialog
				open={confirmDetach}
				onOpenChange={setConfirmDetach}
				title="Detach this IaC source?"
				description="This environment falls back to the built-in template and the module's resources leave the board. The module itself is untouched, and the next deploy applies the template rather than your module. Detaching is refused while the environment holds live infrastructure — destroy it first."
				confirmLabel="Detach source"
				onConfirm={() => {
					void detach();
				}}
			/>
		</div>
	);
}
