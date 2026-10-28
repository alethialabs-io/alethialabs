// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Evidence page's loading form — the route's `loading.tsx` and the client's pending render both
// draw THIS, so the two cannot disagree with each other or with the page. No "use client": the
// route's `loading.tsx` is a server component.
//
// It is the loaded page's own geometry, not a sketch of it: the filter bar (search + funnel), the
// "Environments" heading with its count pill, the posture table drawn with the table's real header
// cells and column widths (`evidence-layout.ts`) — one project group header and its environment
// rows, two text lines each like the real ones — and the waivers panel below it.

import { Skeleton } from "@repo/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@repo/ui/table";
import { cn } from "@repo/ui/utils";
import {
	EVIDENCE_CARD,
	EVIDENCE_CELL,
	EVIDENCE_COLUMN_COUNT,
	EVIDENCE_COLUMNS,
	EVIDENCE_HEAD,
	EVIDENCE_TABLE_MIN,
} from "./evidence-layout";

/** The posture columns after the environment one, in table order. */
const POSTURE_COLUMNS = [
	EVIDENCE_COLUMNS.verify,
	EVIDENCE_COLUMNS.drift,
	EVIDENCE_COLUMNS.security,
	EVIDENCE_COLUMNS.receipt,
] as const;

/** One placeholder environment row: name + region, four postures, the checked time, the arrow. */
function RowSkeleton() {
	return (
		<TableRow className="border-border-faint hover:bg-transparent">
			<TableCell className={EVIDENCE_CELL}>
				<div className="flex w-0 min-w-full items-center gap-2.5">
					<div className="flex min-w-0 flex-col gap-1.5 py-0.5">
						<Skeleton className="h-3.5 w-32 max-w-full" />
						<Skeleton className="h-2.5 w-20 max-w-full" />
					</div>
					<Skeleton className="h-4 w-10 shrink-0 rounded-full" />
				</div>
			</TableCell>
			{POSTURE_COLUMNS.map((width) => (
				<TableCell key={width} className={EVIDENCE_CELL}>
					<Skeleton className="h-3 w-16" />
				</TableCell>
			))}
			<TableCell className={EVIDENCE_CELL}>
				<Skeleton className="ml-auto h-3 w-16" />
			</TableCell>
			<TableCell className={EVIDENCE_CELL} />
		</TableRow>
	);
}

/**
 * The Evidence page while its read has not answered.
 *
 * @param rows placeholder environment rows (default 3).
 */
export function EvidenceSkeleton({ rows = 3 }: { rows?: number }) {
	return (
		<div data-slot="evidence-skeleton" aria-hidden className="pb-20">
			{/* FilterBar: the search field and the funnel trigger. */}
			<div className="mb-4 flex flex-wrap items-center gap-2.5">
				<Skeleton className="h-9 w-[240px] max-w-[380px] flex-1 rounded-sm" />
				<Skeleton className="size-10 rounded-md" />
			</div>

			{/* "Environments" + its count pill. */}
			<div className="mb-2.5 flex items-center gap-2">
				<Skeleton className="h-5 w-28" />
				<Skeleton className="h-5 w-7 rounded-full" />
			</div>

			<div className={EVIDENCE_CARD}>
				<Table className={EVIDENCE_TABLE_MIN}>
					<TableHeader className="bg-surface-sunken">
						<TableRow className="hover:bg-transparent">
							<TableHead className={cn(EVIDENCE_HEAD, EVIDENCE_COLUMNS.environment)}>
								<Skeleton className="h-2.5 w-20" />
							</TableHead>
							{POSTURE_COLUMNS.map((width) => (
								<TableHead key={width} className={cn(EVIDENCE_HEAD, width)}>
									<Skeleton className="h-2.5 w-14" />
								</TableHead>
							))}
							<TableHead className={cn(EVIDENCE_HEAD, EVIDENCE_COLUMNS.checked)}>
								<Skeleton className="ml-auto h-2.5 w-14" />
							</TableHead>
							<TableHead className={cn(EVIDENCE_HEAD, EVIDENCE_COLUMNS.open)} />
						</TableRow>
					</TableHeader>
					<TableBody>
						<TableRow className="border-border-faint hover:bg-transparent">
							<TableCell colSpan={EVIDENCE_COLUMN_COUNT} className="px-4 pb-2 pt-3.5">
								<div className="flex items-center gap-2.5">
									<Skeleton className="size-[17px] rounded-sm" />
									<Skeleton className="h-4 w-36" />
								</div>
							</TableCell>
						</TableRow>
						{Array.from({ length: rows }, (_, i) => (
							<RowSkeleton key={i} />
						))}
					</TableBody>
				</Table>
			</div>

			{/* The recorded-waivers panel: its heading row, then its body. */}
			<div className="mt-6">
				<div className={EVIDENCE_CARD}>
					<div className="flex items-center gap-2.5 border-b px-4 py-3.5">
						<Skeleton className="size-[15px] rounded-sm" />
						<Skeleton className="h-4 w-36" />
					</div>
					<div className="flex flex-col items-center gap-3 px-4 py-10">
						<Skeleton className="h-4 w-28" />
						<Skeleton className="h-3 w-64 max-w-full" />
					</div>
				</div>
			</div>
		</div>
	);
}
