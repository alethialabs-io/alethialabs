"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The org posture table — grouped by project, one row per environment (env-led, with a stage
// tier pill), the four postures (Verify / Drift / Security / Receipt), and freshness. Each
// posture header carries a "?" that defines the term and links to the docs. A row click opens
// the detail drawer (one detail surface — no inline peek). Grayscale-first; the eye lands on
// destructive marks. Horizontally scrolls on narrow viewports to keep the dense columns.

import { FieldHelp } from "@repo/ui/field-help";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { cn } from "@repo/ui/utils";
import type { EvidenceEnvRow, RowGroup } from "./evidence-derive";
import { isStale, lastChecked, relTime, stageShort } from "./evidence-derive";
import { EVIDENCE_HELP } from "./evidence-help";
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
	"grid grid-cols-[minmax(210px,1.6fr)_128px_116px_150px_104px_minmax(90px,1fr)_28px] gap-3 items-center";

/** The cloud logo — a provider mark for a known cloud, else a "layers" (mixed) glyph. */
function RowProvider({
	provider,
	size = 16,
}: {
	provider: string | null;
	size?: number;
}) {
	if (isKnownCloud(provider)) {
		return <ProviderIcon provider={provider} size={size} className="shrink-0" />;
	}
	return (
		<EvIcon name="layers" size={size - 1} className="shrink-0 text-text-tertiary" />
	);
}

/** The stage tier chip (production carries the most ink). */
function StageChip({ stage }: { stage: string }) {
	return (
		<span
			className={cn(
				"shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-wider",
				stageTextClass(stage),
			)}
		>
			{stageShort(stage)}
		</span>
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

/** A posture column header with its "?" explainer + docs link. */
function HeaderCol({
	label,
	help,
}: {
	label: string;
	help: keyof typeof EVIDENCE_HELP;
}) {
	const h = EVIDENCE_HELP[help];
	return (
		<span className="inline-flex items-center gap-1">
			{label}
			<FieldHelp
				title={h.title}
				docsHref={h.docsHref}
				side="bottom"
				className="text-text-disabled hover:text-text-secondary"
			>
				{h.body}
			</FieldHelp>
		</span>
	);
}

/** One environment row — a button that opens the detail drawer. */
function EnvRow({
	row,
	onOpen,
}: {
	row: EvidenceEnvRow;
	onOpen: (row: EvidenceEnvRow) => void;
}) {
	const stale = isStale(row);
	return (
		<div className="group/row border-b border-border-faint last:border-0">
			<button
				type="button"
				onClick={() => onOpen(row)}
				className={cn(
					GRID,
					"w-full cursor-pointer px-4 py-2.5 text-left transition-colors hover:bg-surface-muted",
				)}
			>
				<div className="flex min-w-0 items-center gap-2.5">
					<div className="min-w-0">
						<div className="truncate text-[13px] font-medium text-text-primary">
							{row.environmentName}
						</div>
						<div className="truncate font-mono text-[10px] text-text-tertiary">
							{row.region}
						</div>
					</div>
					<StageChip stage={row.stage} />
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
				<div className="grid place-items-center text-text-disabled opacity-0 transition-opacity group-hover/row:opacity-100">
					<EvIcon name="arrow-right" size={14} />
				</div>
			</button>
		</div>
	);
}

/** The project-grouped posture table. */
export function EvidenceTable({
	groups,
	onOpen,
}: {
	org: string;
	groups: RowGroup[];
	onOpen: (row: EvidenceEnvRow) => void;
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
						<HeaderCol label="Verify" help="verify" />
						<HeaderCol label="Drift" help="drift" />
						<HeaderCol label="Security" help="security" />
						<HeaderCol label="Receipt" help="receipt" />
						<span className="text-right">Checked</span>
						<span />
					</div>
					{groups.map((g) => (
						<div key={g.key}>
							<div className="flex items-center gap-2.5 border-b border-border-faint px-4 pb-2 pt-3.5">
								<RowProvider provider={g.provider} size={17} />
								<span className="font-display text-[13.5px] font-semibold tracking-tight text-text-primary">
									{g.label}
								</span>
							</div>
							{g.rows.map((row) => (
								<EnvRow key={row.environmentId} row={row} onOpen={onOpen} />
							))}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
