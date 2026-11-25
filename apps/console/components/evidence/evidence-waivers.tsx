"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The recorded-waivers panel — the org-wide log of authorized, time-boxed control
// overrides that let a fail-closed apply proceed deliberately. Read-only; produced when a
// DEPLOY carries a jobs.verify_override.
//
// SHELL. Like the posture table, this was a hand-rolled CSS grid — four columns held in a
// `grid-cols-[…]` string with no header row at all, so the columns were unlabelled and a
// screen reader read the log as an undifferentiated stack of text. It now renders through the
// shared `@repo/ui/table` primitives with real column headers.
//
// PAGING (#7488). The log is its own read, `evidence.waivers`, on the console paging contract:
// `useKeysetList` walks the server's keyset pages and `ListFooter` pulls the next one (scroll
// sentinel + a visible "Load more"). It used to arrive inside the roll-up capped at 100 rows and be
// paged here with a client `.slice` — so waiver 101 and later were unreachable, on a compliance
// record. No count pill and no "Showing the N most recent": the console carries no list counts
// (lib/query/README.md → "Counts"). Not `DataTable`: the cells are prose, never sorted client-side.

import Link from "next/link";
import { Button } from "@repo/ui/button";
import { SectionHeading } from "@repo/ui/section-heading";
import { EmptyState } from "@repo/ui/empty";
import { FieldHelp } from "@repo/ui/field-help";
import { Skeleton } from "@repo/ui/skeleton";
import { StatusBadge } from "@repo/ui/status-badge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@repo/ui/table";
import { cn } from "@repo/ui/utils";
import { RegionError } from "@/components/errors/region-error";
import { ListFooter } from "@/components/list/list-footer";
import type { EvidenceWaiverRow } from "@/lib/queries/evidence";
import { useKeysetList } from "@/lib/query/use-keyset-list";
import { orpc } from "@/lib/rpc/client";
import { RelativeClock } from "./evidence-clock";
import { EVIDENCE_HELP } from "./evidence-help";
import { EvIcon } from "./evidence-status";

/** The list's query: no filters (the panel has no bar), so one stable object — the whole key. */
const WAIVERS_QUERY: Record<never, never> = {};

/** Cell padding — matches the posture table so the two panels read as one surface. */
const CELL = "px-3 py-3.5 align-top first:pl-4 last:pr-4";

/** The header cell treatment — mono micro-caps, shared with the posture table. */
const HEAD = cn(
	CELL,
	"h-auto py-2.5 font-mono text-ui-3xs font-normal uppercase tracking-[0.13em] text-text-tertiary",
);

/** One waiver row: what was waived, why, who recorded it and when, and whether it is in force. */
function WaiverRow({ org, w }: { org: string; w: EvidenceWaiverRow }) {
	return (
		<TableRow className="border-border-faint hover:bg-transparent">
			<TableCell className={cn(CELL, "whitespace-normal")}>
				<div className="flex min-w-0 flex-col gap-1.5">
					<div className="text-ui-sm font-medium text-text-primary">
						{w.projectName ?? "—"}
						{w.environmentName ? (
							<span className="text-text-tertiary">
								{" · "}
								{w.environmentName}
							</span>
						) : null}
					</div>
					<div className="flex flex-wrap gap-1">
						{w.controls.map((c) => (
							<span
								key={c}
								className="rounded-xs border bg-surface-sunken px-1.5 py-0.5 font-mono text-ui-2xs text-text-secondary"
							>
								{c}
							</span>
						))}
					</div>
				</div>
			</TableCell>
			<TableCell
				className={cn(
					CELL,
					"whitespace-normal text-ui-sm leading-relaxed text-text-secondary",
				)}
			>
				{w.reason}
			</TableCell>
			<TableCell className={CELL}>
				<div className="flex flex-col gap-0.5 font-mono text-ui-2xs text-text-tertiary">
					<span className="text-text-secondary">{w.by}</span>
					<RelativeClock at={w.createdAt} />
					<Link
						href={`/${org}/~/jobs/${w.jobId}`}
						className="w-fit underline-offset-2 hover:text-text-primary hover:underline"
					>
						View job
					</Link>
				</div>
			</TableCell>
			<TableCell className={CELL}>
				<div className="flex flex-col items-start gap-1">
					<StatusBadge
						status={w.active ? "active" : "expired"}
						tier={w.active ? "active" : "disabled"}
						label={w.active ? "Active" : "Expired"}
						className="text-ui-3xs"
					/>
					{/*
					  * The expiry line under the pill. An EXPIRED waiver is not
					  * a disabled control — the word the row exists to deliver
					  * is "No expiry", and that is the loudest of the three
					  * things this cell can say, not the quietest. #4612.
					  */}
					<span className="font-mono text-ui-2xs text-text-tertiary">
						{w.expiry ? <RelativeClock at={w.expiry} prefix="Expires " /> : "No expiry"}
					</span>
				</div>
			</TableCell>
		</TableRow>
	);
}

/** The panel body while the first page is in flight: two placeholder lines, like the skeleton's. */
function WaiversPending() {
	return (
		<div data-slot="waivers-pending" className="flex flex-col items-center gap-3 px-4 py-10">
			<Skeleton className="h-4 w-28" />
			<Skeleton className="h-3 w-64 max-w-full" />
		</div>
	);
}

/** The recorded-waivers panel below the posture table: every waiver, newest first, page by page. */
export function EvidenceWaivers({ org }: { org: string }) {
	const list = useKeysetList(orpc.evidence.waivers, WAIVERS_QUERY);
	const { rows, query } = list;
	return (
		<div className="overflow-hidden rounded-lg border bg-surface shadow-sm">
			<div className="flex items-center gap-2.5 border-b px-4 py-3.5">
				<EvIcon name="scroll" size={15} className="text-text-secondary" />
				<SectionHeading level={3} title="Recorded waivers" />
				<FieldHelp
					title={EVIDENCE_HELP.waiver.title}
					docsHref={EVIDENCE_HELP.waiver.docsHref}
					side="bottom"
					// Same active control, same tier, same reason as the table's header help. #4612.
					className="text-text-tertiary hover:text-text-secondary"
				>
					{EVIDENCE_HELP.waiver.body}
				</FieldHelp>
			</div>
			{list.isPending ? (
				<WaiversPending />
			) : query.isError && rows.length === 0 ? (
				<RegionError
					title="Couldn't load the waivers"
					description="The recorded waivers could not be read."
					onRetry={() => void query.refetch()}
				/>
			) : rows.length === 0 ? (
				<EmptyState
					className="px-4 py-10 md:p-10"
					title="No waivers"
					description="Every apply cleared the gate without an override."
				/>
			) : (
				<>
					{query.isError && (
						// A refresh failed behind loaded rows: the rows stay, and say they may be stale.
						<div
							role="status"
							className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-1.5 text-ui-sm text-text-secondary"
						>
							{"Couldn't refresh — showing earlier waivers"}
							<Button variant="ghost" size="xs" onClick={() => void query.refetch()}>
								Try again
							</Button>
						</div>
					)}
					<Table className="min-w-[720px]">
						{/* Auto layout: the two prose columns breathe, so these widths are hints. They sit
						    on the HEADER cells, not in a `<colgroup>` — the shared row's hover marks lay
						    out as a leading anonymous cell in Chrome, and an explicit column list hands
						    that phantom cell the first width (evidence-table.tsx, #6126). Reason carries
						    no width: it takes what is left, which would otherwise go to the phantom. */}
						<TableHeader className="bg-surface-sunken">
							<TableRow className="hover:bg-transparent">
								<TableHead className={cn(HEAD, "w-[24%]")}>Waived</TableHead>
								<TableHead className={HEAD}>Reason</TableHead>
								<TableHead className={cn(HEAD, "w-[170px]")}>Recorded</TableHead>
								<TableHead className={cn(HEAD, "w-[128px]")}>Status</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((w) => (
								<WaiverRow key={w.id} org={org} w={w} />
							))}
						</TableBody>
					</Table>
					<div className="border-t px-4 pb-2.5 pt-1.5 empty:hidden">
						<ListFooter list={list} />
					</div>
				</>
			)}
		</div>
	);
}
