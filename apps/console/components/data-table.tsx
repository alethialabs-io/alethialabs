"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import {
	type ColumnDef,
	type ColumnFiltersState,
	type PaginationState,
	type SortingState,
	type Updater,
	flexRender,
	getCoreRowModel,
	getFilteredRowModel,
	getPaginationRowModel,
	getSortedRowModel,
	useReactTable,
} from "@tanstack/react-table";
import {
	ArrowDown,
	ArrowUp,
	ArrowUpDown,
	ChevronLeft,
	ChevronRight,
	CircleAlert,
} from "lucide-react";
import { type KeyboardEvent, useState } from "react";

import { RegionError } from "@/components/errors/region-error";
import {
	DATA_TABLE_FRAME,
	DEFAULT_SKELETON_ROWS,
	DataTableSkeletonRows,
} from "@/components/skeletons/data-table-skeleton";
import { useInfiniteScrollSentinel } from "@/lib/query/use-infinite-scroll";
import { Button } from "@repo/ui/button";
import { ScrollArea } from "@repo/ui/scroll-area";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@repo/ui/table";
import { cn } from "@repo/ui/utils";

/**
 * The keyboard half of a clickable table row: Enter or Space pressed ON the row runs `activate`.
 * A key pressed on a control inside the row belongs to that control, so it is left alone. Pair it
 * with `tabIndex={0}` so the row can be reached at all; `role="row"` states the role the `<tr>`
 * already has, keeping the table a table for a screen reader instead of turning a row of cells
 * into one opaque button.
 */
export function rowKeyActivation(activate: () => void) {
	return (e: KeyboardEvent<HTMLTableRowElement>) => {
		if (e.target !== e.currentTarget) return;
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			activate();
		}
	};
}

/**
 * The slice of a TanStack Query result `DataTable` reads. A `UseQueryResult` or
 * `UseInfiniteQueryResult` satisfies it as-is, which is the point: pass the result, not fields
 * you picked out of it.
 *
 * Why not separate `isPending` / `error` / `onRetry` props: each one has a wrong-but-plausible
 * value. `isPending` is TRUE FOREVER for a disabled query with no data (TanStack v5: status
 * `pending`, fetchStatus `idle`), which is an endless skeleton. An `error` without a retry draws
 * a dead end. And `error` alone cannot tell a failed first load from a failed background refetch
 * behind rows that are still worth showing. Reading the result answers all three once:
 *
 * - loading  = `isLoading` (pending AND fetching), so a disabled query settles to the empty row;
 * - failed   = `isError` with no `data`: the full region error, with a retry;
 * - stale    = `isError` WITH `data`: the rows stay, under a one-line "couldn't refresh" notice;
 * - retry    = `refetch`, always present, so there is never an error with nothing to press.
 */
export interface DataTableQuery {
	/** Pending AND fetching. False for a disabled query, which is what keeps it from spinning. */
	isLoading: boolean;
	isError: boolean;
	/** The query's data, read only for presence: present means a failure is a stale refresh. */
	data?: unknown;
	refetch: () => unknown;
}

interface DataTableProps<TData extends { id?: string }, TValue> {
	columns: ColumnDef<TData, TValue>[];
	data: TData[];
	onRowClick?: (row: TData) => void;
	selectedRowId?: string;
	className?: string;
	pageSize?: number;
	columnFilters?: ColumnFiltersState;
	pageIndex?: number;
	onPageIndexChange?: (index: number) => void;
	/** Tailwind height class (e.g. "h-[70vh]"). When set, wraps the table in a ScrollArea and makes the header sticky. */
	scrollHeight?: string;
	/**
	 * Message shown in the empty-state row when `data` is empty (default "No results."). It is
	 * NEVER shown while the read is loading or has failed: an empty table and a table still
	 * loading are different answers, and showing the first for the second is a lie about the
	 * data (F004).
	 */
	emptyMessage?: string;
	/**
	 * The read behind `data`. Pass the TanStack query result itself — `query={jobsQuery}` — and
	 * the table derives its loading, error and stale states from it. See {@link DataTableQuery}.
	 * Omit it only for rows that are not read from anywhere (a constant list, a computed one).
	 */
	query?: DataTableQuery;
	/** Placeholder rows to draw while the first load runs (default 6). Match the usual row count. */
	skeletonRows?: number;
	/**
	 * Opt into a "Show more" footer (like the Activity log) instead of page-number controls. The
	 * caller grows the visible window itself — pass `pageSize` as the current visible count and
	 * `onLoadMore` to extend it. Pagination is pinned to the first page (page 0) in this mode.
	 */
	loadMore?: { hasMore: boolean; onLoadMore: () => void };
}

/**
 * The notice a table shows when a refetch failed behind rows it already has: the rows are still
 * the last good answer, so they stay, and this line says they may be out of date. With
 * live-by-default invalidation every update is a refetch, so this is the COMMON failure, and
 * replacing a good table with a full error for it would be worse than the failure.
 *
 * Built from what the table already uses (its border, a ghost `Button`, a named ink tier), so it
 * adds no colour of its own. Polite (`role="status"`): nothing the viewer had has gone away.
 */
function StaleRefreshNotice({ onRetry }: { onRetry: () => void }) {
	return (
		<div
			data-slot="data-table-stale"
			role="status"
			className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-1.5 text-ui-sm text-text-secondary"
		>
			<span className="flex items-center gap-2">
				<CircleAlert className="size-3.5 shrink-0" aria-hidden />
				{"Couldn't refresh — showing earlier data"}
			</span>
			<Button variant="ghost" size="xs" onClick={onRetry}>
				Try again
			</Button>
		</div>
	);
}

/**
 * THE console table shell.
 *
 * There were three. This one (TanStack-powered), the raw `@repo/ui/table` primitives, and a
 * hand-rolled CSS-grid table with its own column-template constant and sticky header inside
 * `components/evidence/`. Three shells meant three row heights, three header treatments and
 * three answers to "what does an empty table look like" — and the grid one was not a `<table>`
 * at all, so a screen reader read it as a stack of buttons.
 *
 * The convergence is a layer, not a single component:
 *
 * - **`DataTable` (this file)** is the default. Reach for it whenever the rows are a flat list
 *   the client can hold in memory: it brings sorting, client filtering, pagination or a
 *   "Show more" window, an empty row, and one row-click contract.
 * - **The `@repo/ui/table` primitives** are the shell underneath — `DataTable` renders through
 *   them, so a table built on them directly inherits the same padding, borders, hover and
 *   selected states. Compose them directly only for the shapes TanStack's flat row model cannot
 *   express: interleaved group header rows, or server-side filtering that must not be re-run
 *   client-side. `components/evidence/evidence-table.tsx` is the worked example and says why.
 * - **A `<div className="grid">` is not a table.** There is no third option.
 *
 * It renders four distinct bodies, and a page reaches every one of them by passing its query
 * (`query={q}`) rather than by swapping the table out: rows; the empty row (`emptyMessage`);
 * placeholder rows under the real header (first load); and `RegionError` with a retry (the read
 * failed with nothing to show). A refetch that fails behind rows keeps the rows and adds a
 * one-line notice with its own retry. Before this, a table that had not loaded yet said
 * "No results." (#6117, F004).
 */
export function DataTable<TData extends { id?: string }, TValue>({
	columns,
	data,
	onRowClick,
	selectedRowId,
	className,
	pageSize = 20,
	columnFilters: externalFilters,
	pageIndex: externalPageIndex,
	onPageIndexChange,
	scrollHeight,
	emptyMessage = "No results.",
	query,
	skeletonRows = DEFAULT_SKELETON_ROWS,
	loadMore,
}: DataTableProps<TData, TValue>) {
	// One status for the body, decided once (see `DataTableQuery`). A failure with data is NOT
	// an error body: the rows stay and `staleRefresh` adds a notice above them.
	const hasData = query?.data !== undefined;
	const bodyState = query?.isError && !hasData ? "error" : query?.isLoading ? "pending" : "ready";
	const staleRefresh = Boolean(query?.isError && hasData);
	const retry = () => {
		void query?.refetch();
	};
	const [sorting, setSorting] = useState<SortingState>([]);
	const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(
		externalFilters ?? [],
	);

	// In "Show more" mode the visible window is `pageSize` rows of page 0 (the caller grows
	// `pageSize`); otherwise honor the external page index.
	const effectivePageIndex = loadMore ? 0 : externalPageIndex;

	const table = useReactTable({
		data,
		columns,
		// A ROW'S IDENTITY IS ITS `id`, NOT ITS POSITION.
		//
		// TanStack's default row id is the row's INDEX, and `row.id` is what this file keys both
		// `<TableRow>` and `<TableCell>` on. So when `data` is re-fetched in a different order — or
		// a row is inserted anywhere but the end — React reconciles position against position: the
		// cell at index 3 keeps its component instance and is handed a different row's data, and a
		// cell that renders `null` for one row kind (the owner's in `members-table.tsx`) unmounts
		// the cell that moved into its place. Anything living inside a cell dies with it, and an
		// open popup is the case that costs: the console's row menus are Base UI menus rendered by
		// the cell, so a re-order silently closes one mid-interaction.
		//
		// `TData extends { id?: string }` was already this component's contract, and `selectedRowId`
		// already compares against `row.original.id` — so the id was the identity everywhere except
		// the place that decides what React keeps. The index fallback is for the callers whose rows
		// carry none; those keep exactly the old behaviour.
		//
		// #4852 is the bill: `members.suspend` withheld on a promotion run with its menu shut, and
		// `apps/console/e2e/audit/destructive.spec.ts` could only report it as "not rendered … for
		// this persona".
		getRowId: (row, index) => row.id ?? String(index),
		getCoreRowModel: getCoreRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getPaginationRowModel: getPaginationRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		onSortingChange: setSorting,
		onColumnFiltersChange: setColumnFilters,
		state: {
			sorting,
			columnFilters: externalFilters ?? columnFilters,
			...(effectivePageIndex !== undefined && {
				pagination: { pageIndex: effectivePageIndex, pageSize },
			}),
		},
		...(onPageIndexChange && {
			onPaginationChange: (updater: Updater<PaginationState>) => {
				const next =
					typeof updater === "function"
						? updater({ pageIndex: externalPageIndex ?? 0, pageSize })
						: updater;
				onPageIndexChange(next.pageIndex);
			},
		}),
		initialState: {
			pagination: { pageSize },
		},
	});
	// The header's real width in cells. `columns.length` counts top-level defs, so a grouped def
	// (one def, several leaf columns) or a hidden column would put a full-width row out of step.
	const leafColumnCount = table.getVisibleLeafColumns().length;

	// Auto-grow the "Show more" window as the footer scrolls into view (the button stays as an
	// explicit fallback). Windowing is synchronous, so re-arm the observer on the rendered count.
	const visibleRowCount = table.getRowModel().rows.length;
	const loadMoreSentinelRef = useInfiniteScrollSentinel<HTMLDivElement>({
		hasMore: loadMore?.hasMore ?? false,
		loading: false,
		onLoadMore: () => loadMore?.onLoadMore(),
		resetKey: visibleRowCount,
	});

	// `--z-raised` IS the 10 the sticky header used to hardcode (packages/brand/src/tokens.css).
	// Naming the layer is deliberately not the moment to move it.
	const tableEl = (
		<Table>
			<TableHeader
				className={
					scrollHeight ? "sticky top-0 z-[var(--z-raised)] bg-background" : undefined
				}
			>
				{table.getHeaderGroups().map((headerGroup) => (
					<TableRow key={headerGroup.id}>
						{headerGroup.headers.map((header) => (
							<TableHead
								key={header.id}
								aria-sort={
									header.column.getIsSorted() === "asc"
										? "ascending"
										: header.column.getIsSorted() === "desc"
											? "descending"
											: undefined
								}
							>
								{header.isPlaceholder ? null : header.column.getCanSort() ? (
									// The sort toggle is a real button, so it is announced and reached by Tab; it
									// used to be an `onClick` on the `<th>`, which was neither.
									<button
										type="button"
										onClick={header.column.getToggleSortingHandler()}
										className="flex cursor-pointer select-none items-center gap-1 text-left"
									>
										{flexRender(header.column.columnDef.header, header.getContext())}
										<span className="ml-1">
											{header.column.getIsSorted() === "asc" ? (
												<ArrowUp className="h-3.5 w-3.5" />
											) : header.column.getIsSorted() === "desc" ? (
												<ArrowDown className="h-3.5 w-3.5" />
											) : (
												<ArrowUpDown className="h-3.5 w-3.5 text-text-tertiary" />
											)}
										</span>
									</button>
								) : (
									<div className="flex items-center gap-1">
										{flexRender(header.column.columnDef.header, header.getContext())}
									</div>
								)}
							</TableHead>
						))}
					</TableRow>
				))}
			</TableHeader>
			<TableBody aria-busy={bodyState === "pending" || undefined}>
				{bodyState === "error" ? (
					<TableRow className="hover:bg-transparent">
						<TableCell colSpan={leafColumnCount} className="whitespace-normal p-0">
							<RegionError onRetry={retry} />
						</TableCell>
					</TableRow>
				) : bodyState === "pending" ? (
					<DataTableSkeletonRows columns={leafColumnCount} rows={skeletonRows} />
				) : table.getRowModel().rows?.length ? (
					table.getRowModel().rows.map((row) => (
						<TableRow
							key={row.id}
							data-state={
								(selectedRowId && row.original.id === selectedRowId) || row.getIsSelected()
									? "selected"
									: undefined
							}
							className={cn(onRowClick && "cursor-pointer")}
							role="row"
							tabIndex={onRowClick ? 0 : undefined}
							onClick={onRowClick ? () => onRowClick(row.original) : undefined}
							onKeyDown={onRowClick ? rowKeyActivation(() => onRowClick(row.original)) : undefined}
						>
							{row.getVisibleCells().map((cell) => (
								<TableCell key={cell.id}>
									{flexRender(cell.column.columnDef.cell, cell.getContext())}
								</TableCell>
							))}
						</TableRow>
					))
				) : (
					<TableRow>
						<TableCell colSpan={leafColumnCount} className="h-24 text-center text-muted-foreground">
							{emptyMessage}
						</TableCell>
					</TableRow>
				)}
			</TableBody>
		</Table>
	);

	return (
		<div className={cn("space-y-3", className)}>
			<div className={DATA_TABLE_FRAME} data-state={bodyState}>
				{staleRefresh ? <StaleRefreshNotice onRetry={retry} /> : null}
				{scrollHeight ? (
					<ScrollArea className={scrollHeight}>{tableEl}</ScrollArea>
				) : (
					tableEl
				)}
			</div>

			{bodyState !== "ready"
				? null
				: loadMore
				? (table.getFilteredRowModel().rows.length > 0 && (
						<div className="flex flex-col items-center gap-2 px-1">
							<p className="text-xs text-muted-foreground tabular-nums">
								Showing {table.getRowModel().rows.length} of{" "}
								{table.getFilteredRowModel().rows.length}
							</p>
							{loadMore.hasMore && (
								<>
									{/* Invisible tail sentinel that drives the auto-load-on-scroll. */}
									<div
										ref={loadMoreSentinelRef}
										aria-hidden
										className="h-px w-px"
									/>
									<Button
										variant="outline"
										size="sm"
										onClick={loadMore.onLoadMore}
									>
										Show more
									</Button>
								</>
							)}
						</div>
					))
				: table.getPageCount() > 1 && (
						<div className="flex items-center justify-between px-1">
							<p className="text-xs text-muted-foreground">
								{table.getFilteredRowModel().rows.length} total
							</p>
							<div className="flex items-center gap-4">
								<div className="flex items-center gap-2">
									<p className="text-xs text-muted-foreground">Rows</p>
									<Select
										value={String(table.getState().pagination.pageSize)}
										onValueChange={(value) => table.setPageSize(Number(value))}
									>
										<SelectTrigger className="h-7 w-16 text-xs">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="10">10</SelectItem>
											<SelectItem value="20">20</SelectItem>
											<SelectItem value="50">50</SelectItem>
										</SelectContent>
									</Select>
								</div>
								<p className="text-xs text-muted-foreground tabular-nums">
									Page {table.getState().pagination.pageIndex + 1} of{" "}
									{table.getPageCount()}
								</p>
								<div className="flex items-center gap-1">
									<Button
										variant="outline"
										size="icon"
										className="h-7 w-7"
										onClick={() => table.previousPage()}
										disabled={!table.getCanPreviousPage()}
										aria-label="Previous page"
									>
										<ChevronLeft className="h-3.5 w-3.5" />
									</Button>
									<Button
										variant="outline"
										size="icon"
										className="h-7 w-7"
										onClick={() => table.nextPage()}
										disabled={!table.getCanNextPage()}
										aria-label="Next page"
									>
										<ChevronRight className="h-3.5 w-3.5" />
									</Button>
								</div>
							</div>
						</div>
					)}
		</div>
	);
}
