// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The org posture table — one row per environment under the fixed triage groups, with
// a plain-text Stage column (no chip next to "{env} · {region}"), the four postures
// (Verify / Drift / Security / Receipt), freshness, and the always-populated expanded
// peek (evidence-row-peek). Grayscale-first; the eye lands on destructive marks.

import { cn } from "@repo/ui/utils";
import { ProviderIcon } from "@repo/ui/provider-icon";
import type { EvidenceEnvRow, RowGroup } from "./evidence-derive";
import { isStale, lastChecked, relTime, stageShort } from "./evidence-derive";
import { RowPeek } from "./evidence-row-peek";
import {
	driftMark,
	EvIcon,
	isKnownCloud,
	type Mark,
	receiptMark,
	securityMark,
	stageTextClass,
	TONE_TEXT,
	verifyMark,
} from "./evidence-status";

const GRID =
	"grid grid-cols-[minmax(200px,1.6fr)_64px_128px_116px_150px_104px_minmax(90px,1fr)_28px] gap-3 items-center";

/** The row's cloud logo — a provider mark for a known cloud, else a "layers" (mixed) glyph. */
function RowProvider({ provider }: { provider: string | null }) {
	if (isKnownCloud(provider)) {
		return <ProviderIcon provider={provider} size={16} className="shrink-0" />;
	}
	return (
		<EvIcon name="layers" size={15} className="shrink-0 text-text-tertiary" />
	);
}

/** A single posture cell: tone-colored icon + short label. */
function PostureCell({ mark }: { mark: Mark }) {
	return (
		<div
			className={cn(
				"inline-flex min-w-0 items-center gap-1.5",
				TONE_TEXT[mark.tone],
			)}
		>
			<EvIcon name={mark.iconKey} size={14} className="shrink-0" />
			<span className="truncate text-[12.5px]">{mark.label}</span>
		</div>
	);
}

/** One environment row + its expanded peek. */
function EnvRow({
	org,
	row,
	expanded,
	onToggle,
	onOpen,
	onDownload,
}: {
	org: string;
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
				</div>
				<span
					className={cn(
						"font-mono text-[9.5px] uppercase tracking-[0.12em]",
						stageTextClass(row.stage),
					)}
				>
					{stageShort(row.stage)}
				</span>
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
				<RowPeek org={org} row={row} onOpen={onOpen} onDownload={onDownload} />
			)}
		</div>
	);
}

/** The grouped posture table (fixed triage groups, worst-first rows). */
export function EvidenceTable({
	org,
	groups,
	expandedId,
	onToggle,
	onOpen,
	onDownload,
}: {
	org: string;
	groups: RowGroup[];
	expandedId: string | null;
	onToggle: (id: string) => void;
	onOpen: (row: EvidenceEnvRow) => void;
	onDownload: (row: EvidenceEnvRow) => void;
}) {
	return (
		<div className="overflow-hidden rounded-lg border bg-surface shadow-sm">
			<div className="overflow-x-auto">
				<div className="min-w-[880px]">
					<div
						className={cn(
							GRID,
							"sticky top-0 z-[6] border-b bg-surface-sunken px-4 py-2.5 font-mono text-[9px] uppercase tracking-[0.13em] text-text-tertiary",
						)}
					>
						<span>Environment</span>
						<span>Stage</span>
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
									name={g.iconKey}
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
									org={org}
									row={row}
									expanded={expandedId === row.environmentId}
									onToggle={onToggle}
									onOpen={onOpen}
									onDownload={onDownload}
								/>
							))}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
