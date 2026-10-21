// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// No "use client", deliberately. A route's `loading.tsx` is a server component, and it imports
// `DataTableSkeleton` from here. `DataTable` is a client module, and a server component that
// imports a plain string from a "use client" file gets a client reference, not the string. So the
// classes the two share live HERE and `DataTable` imports them, not the other way round.

import { Skeleton } from "@repo/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@repo/ui/table";

/** The bordered frame `DataTable` draws around its table. Shared so the skeleton cannot drift. */
export const DATA_TABLE_FRAME = "rounded-md border overflow-hidden";

/** How many placeholder rows a pending table shows when the caller does not say. */
export const DEFAULT_SKELETON_ROWS = 6;

/**
 * One placeholder bar, in a box exactly one body line tall.
 *
 * A table cell's text is `text-sm`, whose line is 20px (`h-5`), so a bar drawn in an `h-5` box
 * gives the row the height a one-line text row will have. Rows whose cells hold something taller
 * (an avatar, a two-line cell) are still taller when they land, which is why a page with such
 * rows should prefer its own skeleton over this one.
 */
function SkeletonBar() {
	return (
		<div className="flex h-5 items-center">
			<Skeleton className="h-3 w-full max-w-24" />
		</div>
	);
}

/**
 * Placeholder BODY rows for a table whose header is already on screen: `rows` rows of `columns`
 * cells, drawn with the real `@repo/ui/table` row and cell, so the padding and the borders are
 * the table's own. `DataTable` renders these while `isPending`.
 */
export function DataTableSkeletonRows({
	columns,
	rows = DEFAULT_SKELETON_ROWS,
}: {
	/** Number of cells per row: the real table's column count. */
	columns: number;
	/** Number of placeholder rows. */
	rows?: number;
}) {
	return (
		<>
			{Array.from({ length: rows }, (_, r) => (
				<TableRow key={r} data-slot="data-table-skeleton-row" className="hover:bg-transparent">
					{Array.from({ length: columns }, (_, c) => (
						<TableCell key={c}>
							<SkeletonBar />
						</TableCell>
					))}
				</TableRow>
			))}
		</>
	);
}

/**
 * The loading form of `DataTable`, for when the columns are not on screen yet: a route's
 * `loading.tsx`, or a region whose table has not mounted.
 *
 * It is drawn with the same frame and the same `@repo/ui/table` header, row and cell as
 * `DataTable`, so the table does not move when it lands. Pass the real table's column count.
 * Once `DataTable` itself is mounted, do not use this: pass `isPending` to `DataTable` instead,
 * which keeps the real header and draws `DataTableSkeletonRows` beneath it.
 *
 * @example
 * <DataTableSkeleton columns={5} rows={8} />
 */
export function DataTableSkeleton({
	columns = 4,
	rows = DEFAULT_SKELETON_ROWS,
	scrollHeight,
}: {
	/** The real table's column count. */
	columns?: number;
	/** Number of placeholder body rows. */
	rows?: number;
	/** The same Tailwind height class the real `DataTable` takes, when it takes one. */
	scrollHeight?: string;
}) {
	return (
		<div data-slot="data-table-skeleton" aria-hidden className="space-y-3">
			<div className={scrollHeight ? `${DATA_TABLE_FRAME} ${scrollHeight}` : DATA_TABLE_FRAME}>
				<Table>
					<TableHeader>
						<TableRow className="hover:bg-transparent">
							{Array.from({ length: columns }, (_, c) => (
								<TableHead key={c}>
									<Skeleton className="h-3 w-16" />
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						<DataTableSkeletonRows columns={columns} rows={rows} />
					</TableBody>
				</Table>
			</div>
		</div>
	);
}
