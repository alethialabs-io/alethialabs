// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The expanded peek beneath a table row. Always renders all three evidence signals —
// Verify / Drift / Security — each showing either its data or an honest empty state
// ("Never verified", "No drift scan yet", …), so an expanded row is never blank.
// "Open full report" appears only when the row carries at least one signal (the
// drawer can then always show something); a zero-signal row links to its project.

import Link from "next/link";
import { cn } from "@repo/ui/utils";
import type { EvidenceEnvRow } from "./evidence-derive";
import { hasAnySignal, relTime } from "./evidence-derive";
import { EvIcon, kindTone, TONE_BAR, TONE_TEXT } from "./evidence-status";

/** A tiny segmented bar (verify or security distribution). */
export function MiniBar({
	segments,
}: {
	segments: { key: string; count: number; tone: keyof typeof TONE_BAR }[];
}) {
	const total = segments.reduce((n, s) => n + s.count, 0);
	return (
		<div className="flex h-[7px] gap-0.5 overflow-hidden rounded-full bg-canvas">
			{total === 0 && <div className="flex-1 bg-border" />}
			{segments.map((s) =>
				s.count > 0 ? (
					<div
						key={s.key}
						className={cn("min-w-[3px]", TONE_BAR[s.tone])}
						style={{ flexGrow: s.count }}
					/>
				) : null,
			)}
		</div>
	);
}

/** The mono uppercase heading of one peek signal column. */
function PeekHeading({ children }: { children: React.ReactNode }) {
	return (
		<div className="font-mono text-[9px] uppercase tracking-[0.13em] text-text-disabled">
			{children}
		</div>
	);
}

/** An honest per-signal empty state: what's missing and (optionally) why/how. */
function PeekEmpty({ label, hint }: { label: string; hint?: string }) {
	return (
		<div className="max-w-[34ch] text-[12px] text-text-tertiary">
			{label}
			{hint && (
				<span className="mt-0.5 block font-mono text-[10px] text-text-disabled">
					{hint}
				</span>
			)}
		</div>
	);
}

/** The Verify signal: control distribution + notable failures, or "never verified". */
function VerifySection({ row }: { row: EvidenceEnvRow }) {
	const report = row.verify?.report ?? null;
	if (!report) {
		return (
			<PeekEmpty
				label="Never verified."
				hint="Run a plan to generate evidence for this environment."
			/>
		);
	}
	const notable = report.controls.filter((c) => c.status !== "pass").slice(0, 2);
	return (
		<>
			<MiniBar
				segments={[
					{ key: "pass", count: report.summary.pass, tone: "good" },
					{ key: "warn", count: report.summary.warn, tone: "warn" },
					{ key: "fail", count: report.summary.fail, tone: "bad" },
					{ key: "ne", count: report.summary.not_evaluable, tone: "unknown" },
				]}
			/>
			<div className="flex flex-col gap-1">
				{notable.map((c) => (
					<div key={c.id} className="flex items-baseline gap-2 text-text-secondary">
						<span className="font-mono text-[10.5px]">{c.id}</span>
						<span className="truncate text-[11.5px]">{c.title}</span>
					</div>
				))}
				{notable.length === 0 && (
					<div className="font-mono text-[11px] text-text-tertiary">
						All {report.controls.length} controls passed
					</div>
				)}
			</div>
		</>
	);
}

/** The Drift signal: divergence chips, in-sync freshness, or "no scan yet". */
function DriftSection({ row }: { row: EvidenceEnvRow }) {
	const drift = row.drift;
	if (!drift) return <PeekEmpty label="No drift scan yet." />;
	if (drift.inSync) {
		return (
			<PeekEmpty label={`In sync — scanned ${relTime(drift.scannedAt)}.`} />
		);
	}
	const chips = drift.details.slice(0, 3);
	const more = Math.max(0, drift.details.length - 3);
	return (
		<div className="flex flex-wrap gap-1.5">
			{chips.map((d) => (
				<span
					key={d.address}
					className="inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-1 font-mono text-[10.5px] text-text-secondary"
				>
					<span
						className={cn(
							"text-[8px] uppercase tracking-wide",
							TONE_TEXT[kindTone(d.kind)],
						)}
					>
						{d.kind}
					</span>
					{d.address}
				</span>
			))}
			{more > 0 && (
				<span className="self-center font-mono text-[10.5px] text-text-disabled">
					+{more} more
				</span>
			)}
		</div>
	);
}

/** The Security signal: severity distribution, or "no scan". */
function SecuritySection({ row }: { row: EvidenceEnvRow }) {
	const sec = row.security;
	if (!sec?.scanned) {
		return (
			<PeekEmpty
				label="No security scan."
				hint="Trivy Operator not detected on this cluster."
			/>
		);
	}
	return (
		<>
			<MiniBar
				segments={[
					{ key: "c", count: sec.critical, tone: "bad" },
					{ key: "h", count: sec.high, tone: "warn" },
					{ key: "m", count: sec.medium, tone: "unknown" },
					{ key: "l", count: sec.low, tone: "muted" },
				]}
			/>
			<div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-text-tertiary">
				<span>
					Crit <b className="font-semibold text-text-primary">{sec.critical}</b>
				</span>
				<span>
					High <b className="font-semibold text-text-primary">{sec.high}</b>
				</span>
				<span>
					Med <b className="font-semibold text-text-primary">{sec.medium}</b>
				</span>
				<span>
					Low <b className="font-semibold text-text-primary">{sec.low}</b>
				</span>
			</div>
		</>
	);
}

/** The expanded peek: the three signals + the actions row. */
export function RowPeek({
	org,
	row,
	onOpen,
	onDownload,
}: {
	org: string;
	row: EvidenceEnvRow;
	onOpen: (row: EvidenceEnvRow) => void;
	onDownload: (row: EvidenceEnvRow) => void;
}) {
	const receipt = row.verify?.receipt ?? null;
	const withSignal = hasAnySignal(row);
	const report = row.verify?.report ?? null;
	// Verify · v0.4.1 when a report exists; plain heading otherwise.
	const verifyHeading = report ? `Verify · ${report.catalog_version}` : "Verify";
	const driftHeading =
		row.drift && !row.drift.inSync
			? `Drift · ${row.drift.drifted} resources`
			: "Drift";
	const securityHeading = row.security?.scanned
		? `Security · ${row.security.reportCount} reports`
		: "Security";

	return (
		<div className="px-4 pb-4">
			<div className="rounded-md border bg-surface-sunken px-4 py-3.5">
				<div className="flex flex-wrap gap-x-6 gap-y-3.5">
					<div className="flex min-w-[210px] flex-1 flex-col gap-2">
						<PeekHeading>{verifyHeading}</PeekHeading>
						<VerifySection row={row} />
					</div>
					<div className="flex min-w-[190px] flex-1 flex-col gap-2">
						<PeekHeading>{driftHeading}</PeekHeading>
						<DriftSection row={row} />
					</div>
					<div className="flex min-w-[190px] flex-1 flex-col gap-2">
						<PeekHeading>{securityHeading}</PeekHeading>
						<SecuritySection row={row} />
					</div>
				</div>

				<div className="mt-3.5 flex flex-wrap items-center justify-end gap-2.5">
					<span className="mr-auto font-mono text-[10.5px] text-text-tertiary">
						{receipt
							? receipt.algorithm === "ed25519"
								? `Signed · ${receipt.key_id ?? "ed25519"}`
								: "Unsigned receipt"
							: withSignal
								? ""
								: "No evidence recorded for this environment"}
					</span>
					{receipt && (
						<button
							type="button"
							onClick={() => onDownload(row)}
							className="inline-flex h-[30px] items-center gap-1.5 rounded-sm border border-border-strong px-3 text-[12px] text-text-secondary transition-colors hover:bg-surface-muted hover:text-text-primary"
						>
							<EvIcon name="download" size={13} />
							Receipt
						</button>
					)}
					{withSignal ? (
						<button
							type="button"
							onClick={() => onOpen(row)}
							className="inline-flex h-[30px] items-center gap-1.5 rounded-sm border border-ink bg-ink px-3 text-[12px] font-medium text-ink-foreground transition-colors hover:bg-ink-hover"
						>
							Open full report
							<EvIcon name="arrow-right" size={13} />
						</button>
					) : (
						<Link
							href={row.projectSlug ? `/${org}/${row.projectSlug}` : `/${org}`}
							className="inline-flex h-[30px] items-center gap-1.5 border-b border-border-strong text-[12px] font-medium text-text-primary transition-colors hover:border-text-primary"
						>
							Open project
							<EvIcon name="arrow-right" size={13} />
						</Link>
					)}
				</div>
			</div>
		</div>
	);
}
