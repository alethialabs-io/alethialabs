"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The IaC-safety scan card — surfaces the IAC_SCAN report over a bring-your-own OpenTofu root
// module: static iacsafety findings (grouped by severity), the providers + module sources the scan
// discovered, and the ok / not-ok verdict (a not-ok scan clears the deploy pin, keeping provisioning
// locked). Mirrors the chart-scan card's grayscale tone language (verdict header + severity groups +
// finding cards) so the product speaks one security-report dialect. Reads the persisted report off
// the project_iac_sources row; a `scanning` status shows a spinner, `failed` shows the error state.
//
// A docked card on the workspace rail (opened from the IaC source card's scan chip), not a modal
// Sheet: the findings read beside the external cards they are about.

import { Boxes, Layers, Loader2, Package, RotateCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { cn } from "@repo/ui/utils";
import { scanIacSource } from "@/app/server/actions/byo-iac";
import { useIacSourceCanvas } from "@/components/design-project/byo/iac-source-canvas-context";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { SheetCard } from "./sheet-card";
import { EvIcon, type IconKey, TONE_TEXT } from "@/components/evidence/evidence-status";
import type { Tone } from "@/components/evidence/evidence-derive";
import type { IacScanFinding, IacScanReport } from "@/types/jsonb.types";

/** Normalizes a free-form finding severity onto a tone + icon + display order. */
const SEVERITY_META: Record<string, { tone: Tone; icon: IconKey; order: number }> = {
	critical: { tone: "bad", icon: "shield-alert", order: 0 },
	high: { tone: "bad", icon: "shield-alert", order: 1 },
	medium: { tone: "warn", icon: "triangle-alert", order: 2 },
	low: { tone: "warn", icon: "triangle-alert", order: 3 },
	info: { tone: "unknown", icon: "shield-question", order: 4 },
};

/** The tone/icon/order for a severity string (unknown severities sort last, muted). */
function severityMeta(severity: string): { tone: Tone; icon: IconKey; order: number } {
	return SEVERITY_META[severity.toLowerCase()] ?? { tone: "muted", icon: "minus", order: 5 };
}

/** One finding card — severity mark + rule id, file:line coord, and the detail message. */
function FindingCard({ finding }: { finding: IacScanFinding }) {
	const meta = severityMeta(finding.severity);
	return (
		<div className="overflow-hidden rounded-md border bg-surface">
			<div className="flex items-center gap-2.5 px-3 py-2.5">
				<EvIcon name={meta.icon} size={15} className={cn("shrink-0", TONE_TEXT[meta.tone])} />
				<div className="flex min-w-0 flex-1 items-baseline gap-2">
					<span className="font-mono text-ui-xs text-text-primary">{finding.rule}</span>
				</div>
				<span className="shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-ui-3xs uppercase tracking-wide text-text-tertiary">
					{finding.severity}
				</span>
			</div>
			<div className="flex flex-col gap-1.5 px-3 pb-3">
				<div className="border-l-2 border-border-strong pl-2.5">
					<div className="font-mono text-ui-xs text-text-primary">
						{finding.file}
						{typeof finding.line === "number" ? `:${finding.line}` : ""}
					</div>
					<div className="mt-0.5 text-ui-xs leading-relaxed text-text-tertiary">
						{finding.detail}
					</div>
				</div>
			</div>
		</div>
	);
}

/** A per-severity count pill in the summary row. */
function SummaryPill({ label, count, tone }: { label: string; count: number; tone: Tone }) {
	return (
		<div className="flex items-baseline gap-1.5 rounded-md border bg-surface px-2.5 py-1.5">
			<span className={cn("font-mono text-ui-md tabular-nums", TONE_TEXT[tone])}>{count}</span>
			<span className="text-ui-2xs uppercase tracking-wide text-text-tertiary">{label}</span>
		</div>
	);
}

/** A labeled list of discovered inventory (providers / module sources), collapsed when empty. */
function InventoryList({
	title,
	icon: Icon,
	items,
}: {
	title: string;
	icon: typeof Package;
	items: string[];
}) {
	if (items.length === 0) return null;
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-1.5">
				<Icon className="size-3.5 text-text-tertiary" />
				<span className="font-mono text-ui-2xs uppercase tracking-[0.14em] text-text-tertiary">
					{title}
				</span>
				<span className="font-mono text-ui-2xs text-text-tertiary">({items.length})</span>
			</div>
			<div className="flex flex-col gap-1">
				{items.map((it) => (
					<span
						key={it}
						className="truncate rounded-xs bg-surface-sunken px-2 py-1 font-mono text-ui-xs text-text-secondary"
					>
						{it}
					</span>
				))}
			</div>
		</div>
	);
}

/**
 * The IaC-scan card for the environment's attached source, read from the canvas's IaC-source
 * context (one source per environment, so it needs no id). Re-runs the scan through that context.
 */
export function IacScanCard() {
	const closeCard = useCanvasStore((s) => s.closeCard);
	const ctx = useIacSourceCanvas();
	const source = ctx?.source ?? null;

	if (!ctx || !source) {
		return (
			<SheetCard title="IaC safety scan" eyebrow="External IaC" onClose={closeCard}>
				<EmptyState
					title="No IaC source is attached to this environment"
					description="Attach a bring-your-own OpenTofu module from the command palette to scan it."
				/>
			</SheetCard>
		);
	}

	/** Queue a (re)scan and nudge the source refresh as the runner finishes (best-effort, no socket). */
	const rescan = async () => {
		try {
			await scanIacSource({ projectId: ctx.projectId, environmentId: ctx.environmentId });
			toast.message("Scanning module…");
			ctx.refresh();
			setTimeout(ctx.refresh, 4000);
			setTimeout(ctx.refresh, 10000);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Could not start the scan.");
		}
	};

	return (
		<IacScanBody
			repoUrl={source.repoUrl}
			path={source.path}
			scanRef={source.ref ?? "HEAD"}
			scanStatus={source.scanStatus}
			report={source.scanReport}
			scanning={source.scanStatus === "scanning"}
			onRescan={rescan}
			onClose={closeCard}
		/>
	);
}

export interface IacScanBodyProps {
	onClose: () => void;
	repoUrl: string;
	path: string;
	scanRef: string;
	scanStatus: string;
	report: IacScanReport | null;
	scanning: boolean;
	/** Kick off (or re-run) the scan. */
	onRescan: () => void;
}

/** The scan card's body: header (module coords) → verdict + severity summary + finding cards +
 * inventory, or a scanning / unscanned / failed empty state. Props-driven so it renders from the
 * attached source or a fixture. */
export function IacScanBody({
	onClose,
	repoUrl,
	path,
	scanRef,
	scanStatus,
	report,
	scanning,
	onRescan,
}: IacScanBodyProps) {
	// Findings worst-first (severity order), so the risky checks sit at the top.
	const findings = report
		? [...report.findings].sort((a, b) => severityMeta(a.severity).order - severityMeta(b.severity).order)
		: [];
	// Per-severity counts for the summary row.
	const counts = findings.reduce<Record<string, number>>((acc, f) => {
		const key = f.severity.toLowerCase();
		acc[key] = (acc[key] ?? 0) + 1;
		return acc;
	}, {});
	const verdict: { icon: IconKey; label: string; tone: Tone } =
		report && report.ok
			? { icon: "shield-check", label: "No blocking issues found", tone: "good" }
			: {
					icon: "shield-alert",
					label: "Issues found — resolve before deploying",
					tone: "bad",
				};

	return (
		<SheetCard
			eyebrow="IaC safety scan"
			icon={<Boxes className="h-4 w-4" />}
			title={repoUrl.replace(/^https?:\/\/(www\.)?/, "").replace(/\.git$/, "")}
			description={
				<span className="font-mono">
					/{path.replace(/^\/+/, "") || "(root)"} · {scanRef}
				</span>
			}
			onClose={onClose}
		>
			<div>
					{scanning || scanStatus === "scanning" ? (
						<EmptyState
							className="px-0 py-16 md:px-0 md:py-16"
							icon={<Loader2 className="animate-spin" />}
							title="Scanning the module…"
							description={
								<>
									Cloning the repo, pinning the commit, inventorying providers + modules, and
									running
									<code className="mx-1">tofu validate</code> plus the iacsafety static checks.
								</>
							}
						/>
					) : report ? (
						<div className="flex flex-col gap-4">
							{/* Verdict + rescan */}
							<div className="flex items-center gap-2.5">
								<EvIcon
									name={verdict.icon}
									size={17}
									className={cn("shrink-0", TONE_TEXT[verdict.tone])}
								/>
								<span className={cn("text-ui-md font-medium", TONE_TEXT[verdict.tone])}>
									{verdict.label}
								</span>
								<Button
									variant="ghost"
									size="sm"
									className="ml-auto h-7 gap-1.5 px-2 text-ui-xs"
									onClick={onRescan}
								>
									<RotateCw className="size-3" /> Rescan
								</Button>
							</div>

							{/* validate status + severity summary */}
							<div className="flex flex-wrap gap-2">
								<SummaryPill
									label="tofu validate"
									count={report.validated ? 1 : 0}
									tone={report.validated ? "good" : "bad"}
								/>
								{counts.critical ? (
									<SummaryPill label="critical" count={counts.critical} tone="bad" />
								) : null}
								{counts.high ? <SummaryPill label="high" count={counts.high} tone="bad" /> : null}
								{counts.medium ? (
									<SummaryPill label="medium" count={counts.medium} tone="warn" />
								) : null}
								{counts.low ? <SummaryPill label="low" count={counts.low} tone="warn" /> : null}
								{counts.info ? (
									<SummaryPill label="info" count={counts.info} tone="unknown" />
								) : null}
							</div>

							{/* Findings, worst-first */}
							{findings.length > 0 ? (
								<div className="flex flex-col gap-2">
									{findings.map((f, i) => (
										<FindingCard key={`${f.rule}-${f.file}-${i}`} finding={f} />
									))}
								</div>
							) : (
								<div className="rounded-md border border-dashed border-border-strong bg-surface-sunken px-3 py-4 text-center text-ui-sm text-text-secondary">
									No static findings. The module passed the iacsafety checks.
								</div>
							)}

							{/* Discovered inventory */}
							<div className="flex flex-col gap-3 border-t border-border-faint pt-4">
								<InventoryList title="Providers" icon={Package} items={report.providers} />
								<InventoryList title="Modules" icon={Layers} items={report.modules} />
							</div>

							<p className="pt-1 text-ui-xs leading-relaxed text-text-tertiary">
								A not-ok scan clears the deploy pin — provisioning stays locked until a clean re-scan.
								The plan-time verify verdict (keyless / least-privilege / OIDC-sub) is attached to each
								deploy&apos;s Plan tab.
							</p>
						</div>
					) : (
						/* Unscanned / failed empty state */
						<EmptyState
							className="px-0 py-16 md:px-0 md:py-16"
							icon={
								<EvIcon
									name={scanStatus === "failed" ? "triangle-alert" : "shield-question"}
									className={scanStatus === "failed" ? TONE_TEXT.bad : TONE_TEXT.muted}
								/>
							}
							title={
								scanStatus === "failed"
									? "The last scan failed"
									: "This module hasn't been scanned yet"
							}
							action={
								<Button size="sm" className="gap-1.5" onClick={onRescan}>
									<ShieldCheck className="size-3.5" />
									{scanStatus === "failed" ? "Retry scan" : "Scan module"}
								</Button>
							}
						/>
					)}
			</div>
		</SheetCard>
	);
}
