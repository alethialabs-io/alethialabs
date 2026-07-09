// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The org posture table — one row per environment, grouped, with the four postures
// (Verify / Drift / Security / Receipt) as columns, a freshness column, and an inline
// "peek" that expands on click before the full drawer. Grayscale-first; the eye lands on
// destructive marks. Horizontally scrolls on narrow viewports to keep the dense columns.

import { cn } from "@repo/ui/utils";
import { ProviderIcon } from "@repo/ui/provider-icon";
import type { EvidenceEnvRow, RowGroup } from "./evidence-derive";
import { relTime, isStale, lastChecked } from "./evidence-derive";
import {
	driftMark,
	EvIcon,
	type IconKey,
	type Mark,
	kindTone,
	receiptMark,
	securityMark,
	stageChipClass,
	TONE_BAR,
	TONE_TEXT,
	verifyMark,
} from "./evidence-status";

const GRID =
	"grid grid-cols-[minmax(210px,1.6fr)_128px_116px_150px_104px_minmax(90px,1fr)_28px] gap-3 items-center";

const KNOWN_CLOUDS = new Set([
	"aws",
	"gcp",
	"azure",
	"alibaba",
	"digitalocean",
	"hetzner",
	"civo",
]);

/** The row's cloud logo — a provider mark for a known cloud, else a "layers" (mixed) glyph. */
function RowProvider({ provider }: { provider: string | null }) {
	if (provider && KNOWN_CLOUDS.has(provider)) {
		return <ProviderIcon provider={provider} size={16} className="shrink-0" />;
	}
	return <EvIcon name="layers" size={15} className="shrink-0 text-text-tertiary" />;
}

/** A single posture cell: tone-colored icon + short label. */
function PostureCell({ mark }: { mark: Mark }) {
	return (
		<div className={cn("inline-flex min-w-0 items-center gap-1.5", TONE_TEXT[mark.tone])}>
			<EvIcon name={mark.iconKey} size={14} className="shrink-0" />
			<span className="truncate text-[12.5px]">{mark.label}</span>
		</div>
	);
}

/** A tiny segmented bar (verify or security distribution) used inside the peek. */
function MiniBar({
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

/** The expanded peek beneath a row — verify controls, drift chips, security bar, actions. */
function RowPeek({
	row,
	onOpen,
	onDownload,
}: {
	row: EvidenceEnvRow;
	onOpen: (row: EvidenceEnvRow) => void;
	onDownload: (row: EvidenceEnvRow) => void;
}) {
	const report = row.verify?.report ?? null;
	const notablecontrols =
		report?.controls.filter((c) => c.status !== "pass").slice(0, 2) ?? [];
	const driftChips = row.drift?.details.slice(0, 3) ?? [];
	const moreDrift = Math.max(0, (row.drift?.details.length ?? 0) - 3);
	const receipt = row.verify?.receipt ?? null;

	return (
		<div className="px-4 pb-4">
			<div className="flex flex-wrap gap-3.5 rounded-md border bg-surface-sunken px-4 py-3.5">
				{report && (
					<div className="flex min-w-[210px] flex-1 flex-col gap-2">
						<div className="font-mono text-[9px] uppercase tracking-[0.13em] text-text-disabled">
							Verify · {report.catalog_version}
						</div>
						<MiniBar
							segments={[
								{ key: "pass", count: report.summary.pass, tone: "good" },
								{ key: "warn", count: report.summary.warn, tone: "warn" },
								{ key: "fail", count: report.summary.fail, tone: "bad" },
								{
									key: "ne",
									count: report.summary.not_evaluable,
									tone: "unknown",
								},
							]}
						/>
						<div className="flex flex-col gap-1">
							{notablecontrols.map((c) => (
								<div
									key={c.id}
									className="flex items-baseline gap-2 text-text-secondary"
								>
									<span className="font-mono text-[10.5px]">{c.id}</span>
									<span className="truncate text-[11.5px]">{c.title}</span>
								</div>
							))}
							{notablecontrols.length === 0 && (
								<div className="font-mono text-[11px] text-text-tertiary">
									All {report.controls.length} controls passed
								</div>
							)}
						</div>
					</div>
				)}

				{row.drift && !row.drift.inSync && driftChips.length > 0 && (
					<div className="flex min-w-[190px] flex-1 flex-col gap-2">
						<div className="font-mono text-[9px] uppercase tracking-[0.13em] text-text-disabled">
							Drift · {row.drift.drifted} resources
						</div>
						<div className="flex flex-wrap gap-1.5">
							{driftChips.map((d) => (
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
							{moreDrift > 0 && (
								<span className="self-center font-mono text-[10.5px] text-text-disabled">
									+{moreDrift} more
								</span>
							)}
						</div>
					</div>
				)}

				{row.security?.scanned && (
					<div className="flex min-w-[190px] flex-1 flex-col gap-2">
						<div className="font-mono text-[9px] uppercase tracking-[0.13em] text-text-disabled">
							Security · {row.security.reportCount} reports
						</div>
						<MiniBar
							segments={[
								{ key: "c", count: row.security.critical, tone: "bad" },
								{ key: "h", count: row.security.high, tone: "warn" },
								{ key: "m", count: row.security.medium, tone: "unknown" },
								{ key: "l", count: row.security.low, tone: "muted" },
							]}
						/>
						<div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-text-tertiary">
							<span>
								Crit{" "}
								<b className="font-semibold text-text-primary">
									{row.security.critical}
								</b>
							</span>
							<span>
								High{" "}
								<b className="font-semibold text-text-primary">
									{row.security.high}
								</b>
							</span>
							<span>
								Med{" "}
								<b className="font-semibold text-text-primary">
									{row.security.medium}
								</b>
							</span>
							<span>
								Low{" "}
								<b className="font-semibold text-text-primary">
									{row.security.low}
								</b>
							</span>
						</div>
					</div>
				)}

				<div className="ml-auto flex flex-col items-end justify-between gap-2.5">
					{receipt && (
						<div className="text-right font-mono text-[10.5px] text-text-tertiary">
							{receipt.algorithm === "ed25519"
								? `Signed · ${receipt.key_id ?? "ed25519"}`
								: "Unsigned receipt"}
						</div>
					)}
					<div className="flex gap-2">
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
						<button
							type="button"
							onClick={() => onOpen(row)}
							className="inline-flex h-[30px] items-center gap-1.5 rounded-sm border border-ink bg-ink px-3 text-[12px] font-medium text-ink-foreground transition-colors hover:bg-ink-hover"
						>
							Open full report
							<EvIcon name="arrow-right" size={13} />
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

/** One environment row + its (conditional) expanded peek. */
function EnvRow({
	row,
	expanded,
	onToggle,
	onOpen,
	onDownload,
}: {
	row: EvidenceEnvRow;
	expanded: boolean;
	onToggle: (id: string) => void;
	onOpen: (row: EvidenceEnvRow) => void;
	onDownload: (row: EvidenceEnvRow) => void;
}) {
	const stale = isStale(row);
	return (
		<div className="border-b border-border-faint last:border-0">
			<button
				type="button"
				onClick={() => onToggle(row.environmentId)}
				className={cn(
					GRID,
					"w-full cursor-pointer px-4 py-2.5 text-left transition-colors hover:bg-surface-muted",
					expanded && "bg-surface-muted",
				)}
			>
				<div className="flex min-w-0 items-center gap-2.5">
					<RowProvider provider={row.provider} />
					<div className="min-w-0">
						<div className="truncate text-[13px] font-medium text-text-primary">
							{row.projectName}
						</div>
						<div className="truncate font-mono text-[10px] text-text-tertiary">
							{row.environmentName} · {row.region}
						</div>
					</div>
					<span
						className={cn(
							"shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-wider",
							stageChipClass(row.stage),
						)}
					>
						{row.stage}
					</span>
				</div>
				<PostureCell mark={verifyMark(row.verify)} />
				<PostureCell mark={driftMark(row.drift)} />
				<PostureCell mark={securityMark(row.security)} />
				<PostureCell mark={receiptMark(row.verify)} />
				<div
					className={cn(
						"inline-flex items-center justify-end gap-1.5 font-mono text-[11px]",
						stale ? "text-text-tertiary" : "text-text-disabled",
					)}
				>
					{stale && <EvIcon name="clock" size={11} className="shrink-0" />}
					{relTime(lastChecked(row))}
				</div>
				<div
					className={cn(
						"grid place-items-center text-text-tertiary transition-transform",
						expanded && "rotate-180",
					)}
				>
					<EvIcon name="chevron-down" size={15} />
				</div>
			</button>
			{expanded && (
				<RowPeek row={row} onOpen={onOpen} onDownload={onDownload} />
			)}
		</div>
	);
}

/** The grouped posture table. */
export function EvidenceTable({
	groups,
	expandedId,
	onToggle,
	onOpen,
	onDownload,
}: {
	groups: RowGroup[];
	expandedId: string | null;
	onToggle: (id: string) => void;
	onOpen: (row: EvidenceEnvRow) => void;
	onDownload: (row: EvidenceEnvRow) => void;
}) {
	return (
		<div className="overflow-hidden rounded-lg border bg-surface shadow-sm">
			<div className="overflow-x-auto">
				<div className="min-w-[820px]">
					<div
						className={cn(
							GRID,
							"sticky top-0 z-[6] border-b bg-surface-sunken px-4 py-2.5 font-mono text-[9px] uppercase tracking-[0.13em] text-text-tertiary",
						)}
					>
						<span>Environment</span>
						<span>Verify</span>
						<span>Drift</span>
						<span>Security</span>
						<span>Receipt</span>
						<span className="text-right">Checked</span>
						<span />
					</div>
					{groups.map((g) => (
						<div key={g.key}>
							<div className="flex items-center gap-2.5 border-b border-border-faint px-4 pb-2 pt-3.5">
								<EvIcon
									name={g.iconKey as IconKey}
									size={14}
									className={TONE_TEXT[g.tone]}
								/>
								<span className="font-display text-[13.5px] font-semibold tracking-tight text-text-primary">
									{g.label}
								</span>
								<span className="rounded-full border px-2 py-px font-mono text-[10px] text-text-tertiary">
									{g.rows.length}
								</span>
							</div>
							{g.rows.map((row) => (
								<EnvRow
									key={row.environmentId}
									row={row}
									expanded={expandedId === row.environmentId}
									onToggle={onToggle}
									onOpen={onOpen}
									onDownload={onDownload}
								/>
							))}
						</div>
					))}
					{groups.length === 0 && (
						<div className="p-14 text-center font-mono text-[12px] text-text-disabled">
							No environments match these filters.
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
