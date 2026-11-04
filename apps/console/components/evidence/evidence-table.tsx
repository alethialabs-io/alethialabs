"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The org posture table — grouped by project, one row per environment (env-led, with a stage
// tier pill), the four postures (Verify / Drift / Security / Receipt), and freshness. Each
// posture header carries a "?" that defines the term and links to the docs. A row click opens
// the detail drawer (one detail surface — no inline peek). Grayscale-first; the eye lands on
// destructive marks. Horizontally scrolls on narrow viewports to keep the dense columns.
//
// SHELL. This renders through the shared `@repo/ui/table` primitives — the same shell
// `components/data-table.tsx` renders through — rather than the CSS-grid table it used to be.
// It does NOT go through `DataTable` itself, for two reasons about this table's shape rather
// than about taste:
//
//   1. The rows are INTERLEAVED with project group headers, and each project is its own row
//      group. `DataTable` maps one flat `getRowModel().rows` list; expressing a group header
//      means feeding it a grouped row model plus a render hook — an API change on a component
//      with eight other consumers.
//   2. The filtering is SERVER-side (the filter standard: store -> key -> read procedure) and the
//      list is deliberately not paginated: every environment in the roll-up is meant to be on
//      screen. `DataTable` would layer a client filter + pagination row model on top of that,
//      and its default 20-row page would silently truncate the roll-up. A table whose job is
//      "here is everything you still have to prove" must not hide rows.
//
// COLUMN WIDTHS (#6126, F019). The six posture/freshness columns carry their widths on their
// HEADER cells (`EVIDENCE_COLUMNS`), the table lays out automatically, and the environment column
// takes whatever is left. It used to be a `<colgroup>` + `table-fixed`, and in Chrome that put
// every cell one column to the RIGHT of its width: the shared `TableRow` carries the `vx-clamp`
// hover marks, a positioned `::before` on the `<tr>`, and the browser lays that pseudo-element out
// as a leading anonymous cell. With an explicit column list the phantom cell took the first
// `<col>` — a blank ~274px column — the environment name got the Verify width (128px, "develo…"),
// Checked got the arrow's 36px and overprinted Receipt, and the arrow spilled into an eighth
// column. With no `<colgroup>` the phantom column has nothing to claim and no content, so it
// collapses to nothing. The environment cell's content is sized `w-0 min-w-full`: it contributes
// nothing to the column's width (a long name cannot widen the table) and fills what it is given,
// so the name truncates instead of overflowing.

import { FieldHelp } from "@repo/ui/field-help";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@repo/ui/table";
import { cn } from "@repo/ui/utils";
import type { EvidenceEnvRow, RowGroup } from "./evidence-derive";
import { isStale, lastChecked, stageShort } from "./evidence-derive";
import { RelativeClock } from "./evidence-clock";
import { EVIDENCE_HELP } from "./evidence-help";
import {
	EVIDENCE_CARD,
	EVIDENCE_CELL,
	EVIDENCE_COLUMN_COUNT,
	EVIDENCE_COLUMNS,
	EVIDENCE_HEAD,
	EVIDENCE_TABLE_MIN,
} from "./evidence-layout";
import {
	driftMark,
	EvIcon,
	isKnownCloud,
	type Mark,
	receiptMark,
	securityMark,
	TONE_TEXT,
	verifyMark,
} from "./evidence-status";


/**
 * Stage tier -> the shared status tier, ordered by ink weight: production carries the most,
 * development the least. Same ordering `stageTextClass` encodes for the drawer's plain-text
 * rendering (production `text-secondary` > staging `text-tertiary` > default `text-disabled`),
 * so the two surfaces cannot drift apart in opposite directions.
 */
function stageTier(stage: string): StatusTier {
	switch (stage) {
		case "production":
			return "active";
		case "staging":
			return "idle";
		default:
			return "disabled";
	}
}

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
			<span className="truncate text-ui-sm">{mark.label}</span>
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
				// An ACTIVE control, so WCAG 1.4.3's inactive-component exemption does not reach it
				// and neither does 1.4.11's for a decorative glyph. `text-text-disabled` was 1.95:1
				// at rest and a hover colour is not a resting state. #4612.
				className="text-text-tertiary hover:text-text-secondary"
			>
				{h.body}
			</FieldHelp>
		</span>
	);
}


/**
 * One environment row. The whole row is clickable as a convenience, and the environment name is
 * a real `<button>` so the drawer stays reachable from the keyboard — a bare `<tr onClick>` is
 * not, which is the one thing the row-sized `<button>` of the old CSS-grid table got right and
 * a naive table conversion would have silently dropped.
 */
function EnvRow({
	row,
	onOpen,
}: {
	row: EvidenceEnvRow;
	onOpen: (row: EvidenceEnvRow) => void;
}) {
	return (
		// `role="row"` restates the role the `<tr>` has: the row click is a pointer convenience,
		// and the keyboard route to the same drawer is the environment-name `<button>` below — a
		// `tabIndex` here would only add a second tab stop that does the same thing.
		<TableRow
			role="row"
			className="group/row cursor-pointer border-border-faint"
			onClick={() => onOpen(row)}
		>
			<TableCell className={EVIDENCE_CELL}>
				{/* `w-0 min-w-full`: fills the column without sizing it — see the header. */}
				<div className="flex w-0 min-w-full items-center gap-2.5">
					<div className="min-w-0">
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								onOpen(row);
							}}
							className="block max-w-full truncate text-left text-ui-md font-medium text-text-primary outline-none focus-visible:underline focus-visible:underline-offset-2"
						>
							{row.environmentName}
						</button>
						<div className="truncate font-mono text-ui-2xs text-text-tertiary">
							{row.region}
						</div>
					</div>
					<StatusBadge
						status={row.stage}
						tier={stageTier(row.stage)}
						label={stageShort(row.stage)}
						className="shrink-0 text-ui-3xs tracking-wider"
					/>
				</div>
			</TableCell>
			<TableCell className={EVIDENCE_CELL}>
				<PostureCell mark={verifyMark(row.verify)} />
			</TableCell>
			<TableCell className={EVIDENCE_CELL}>
				<PostureCell mark={driftMark(row.drift)} />
			</TableCell>
			<TableCell className={EVIDENCE_CELL}>
				<PostureCell mark={securityMark(row.security)} />
			</TableCell>
			<TableCell className={EVIDENCE_CELL}>
				<PostureCell mark={receiptMark(row.verify)} />
			</TableCell>
			<TableCell className={EVIDENCE_CELL}>
				{/*
				  * The Checked timestamp is ONE tier, not two. It was
				  * `stale ? "text-text-tertiary" : "text-text-disabled"` — the ordinary, FRESH row
				  * drawn at 1.95:1 and the exceptional one at 5.35:1, which is backwards on its own
				  * terms as well as illegible. Inverting it is not the fix either: `--text-disabled`
				  * fails 4.5:1 on every surface token in both themes (1.77–2.64:1), so whichever
				  * branch keeps it is the unreadable one, and the conditional's only legible
				  * assignment is tertiary on both. So it is DELETED rather than inverted: with both
				  * branches equal it is dead code, and giving one branch a different readable tier
				  * would be a NEW emphasis decision nobody has made — this issue is a decided rule
				  * being applied, not a design ruling.
				  *
				  * Nothing is lost by dropping it. The difference was carried by ink tier ALONE,
				  * which WCAG 1.4.1 already refuses as a sole signal; staleness is still said by the
				  * clock glyph and by the relative time the cell prints. #4612.
				  */}
				<div className="flex justify-end font-mono text-ui-xs text-text-tertiary">
					{/* Both the time and the staleness glyph read the clock: after hydration only. */}
					<RelativeClock at={lastChecked(row)} className="justify-items-end">
						{isStale(row) && <EvIcon name="clock" size={11} className="shrink-0" />}
					</RelativeClock>
				</div>
			</TableCell>
			<TableCell className={EVIDENCE_CELL}>
				{/*
				  * DELIBERATELY still `text-text-disabled`, and the only site in this file that is.
				  * This `→` is decorative: it is `opacity-0` at rest, it duplicates the row's own
				  * click target and the environment-name `<button>` beside it, and it carries no
				  * text. WCAG 1.4.3 and 1.4.11 both exempt it, so raising it would spend ink on the
				  * one mark on this row that says nothing. #4612 lists it for exactly this reason —
				  * so a sweep of the tier does not take it by accident.
				  */}
				<div className="grid place-items-center text-text-disabled opacity-0 transition-opacity group-hover/row:opacity-100">
					<EvIcon name="arrow-right" size={14} />
				</div>
			</TableCell>
		</TableRow>
	);
}

/** The project-grouped posture table. */
export function EvidenceTable({
	groups,
	onOpen,
}: {
	groups: RowGroup[];
	onOpen: (row: EvidenceEnvRow) => void;
}) {
	return (
		<div className={EVIDENCE_CARD}>
			<Table className={EVIDENCE_TABLE_MIN}>
				<TableHeader className="sticky top-0 z-[var(--z-sticky-head)] bg-surface-sunken">
					<TableRow className="hover:bg-transparent">
						<TableHead className={cn(EVIDENCE_HEAD, EVIDENCE_COLUMNS.environment)}>Environment</TableHead>
						<TableHead className={cn(EVIDENCE_HEAD, EVIDENCE_COLUMNS.verify)}>
							<HeaderCol label="Verify" help="verify" />
						</TableHead>
						<TableHead className={cn(EVIDENCE_HEAD, EVIDENCE_COLUMNS.drift)}>
							<HeaderCol label="Drift" help="drift" />
						</TableHead>
						<TableHead className={cn(EVIDENCE_HEAD, EVIDENCE_COLUMNS.security)}>
							<HeaderCol label="Security" help="security" />
						</TableHead>
						<TableHead className={cn(EVIDENCE_HEAD, EVIDENCE_COLUMNS.receipt)}>
							<HeaderCol label="Receipt" help="receipt" />
						</TableHead>
						<TableHead className={cn(EVIDENCE_HEAD, EVIDENCE_COLUMNS.checked, "text-right")}>Checked</TableHead>
						<TableHead className={cn(EVIDENCE_HEAD, EVIDENCE_COLUMNS.open)}>
							<span className="sr-only">Open detail</span>
						</TableHead>
					</TableRow>
				</TableHeader>
				{/* One <tbody> per project. Multiple bodies in one table is valid HTML and is the
				    semantic the grid version was faking: a project IS a row group. */}
				{groups.map((g) => (
					<TableBody key={g.key}>
						<TableRow className="border-border-faint hover:bg-transparent">
							<TableCell colSpan={EVIDENCE_COLUMN_COUNT} className="px-4 pb-2 pt-3.5">
								<div className="flex items-center gap-2.5">
									<RowProvider provider={g.provider} size={17} />
									<span className="font-display text-ui-md font-semibold tracking-tight text-text-primary">
										{g.label}
									</span>
								</div>
							</TableCell>
						</TableRow>
						{g.rows.map((row) => (
							<EnvRow key={row.environmentId} row={row} onOpen={onOpen} />
						))}
					</TableBody>
				))}
			</Table>
		</div>
	);
}
