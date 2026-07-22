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
} from "lucide-react";
import { useState } from "react";

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
	/** Message shown in the empty-state row when `data` is empty (default "No results."). */
	emptyMessage?: string;
	/**
	 * Opt into a "Show more" footer (like the Activity log) instead of page-number controls. The
	 * caller grows the visible window itself — pass `pageSize` as the current visible count and
	 * `onLoadMore` to extend it. Pagination is pinned to the first page (page 0) in this mode.
	 */
	loadMore?: { hasMore: boolean; onLoadMore: () => void };
}

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
	loadMore,
}: DataTableProps<TData, TValue>) {
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

	// Auto-grow the "Show more" window as the footer scrolls into view (the button stays as an
	// explicit fallback). Windowing is synchronous, so re-arm the observer on the rendered count.
	const visibleRowCount = table.getRowModel().rows.length;
	const loadMoreSentinelRef = useInfiniteScrollSentinel<HTMLDivElement>({
		hasMore: loadMore?.hasMore ?? false,
		loading: false,
		onLoadMore: () => loadMore?.onLoadMore(),
		resetKey: visibleRowCount,
	});

	const tableEl = (
		<Table>
			<TableHeader className={scrollHeight ? "sticky top-0 z-10 bg-background" : undefined}>
				{table.getHeaderGroups().map((headerGroup) => (
					<TableRow key={headerGroup.id}>
						{headerGroup.headers.map((header) => (
							<TableHead
								key={header.id}
								className={cn(
									header.column.getCanSort() && "cursor-pointer select-none",
								)}
								onClick={header.column.getToggleSortingHandler()}
							>
								{header.isPlaceholder ? null : (
									<div className="flex items-center gap-1">
										{flexRender(header.column.columnDef.header, header.getContext())}
										{header.column.getCanSort() && (
											<span className="ml-1">
												{header.column.getIsSorted() === "asc" ? (
													<ArrowUp className="h-3.5 w-3.5" />
												) : header.column.getIsSorted() === "desc" ? (
													<ArrowDown className="h-3.5 w-3.5" />
												) : (
													<ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground/50" />
												)}
											</span>
										)}
									</div>
								)}
							</TableHead>
						))}
					</TableRow>
				))}
			</TableHeader>
			<TableBody>
				{table.getRowModel().rows?.length ? (
					table.getRowModel().rows.map((row) => (
						<TableRow
							key={row.id}
							data-state={
								(selectedRowId && row.original.id === selectedRowId) || row.getIsSelected()
									? "selected"
									: undefined
							}
							className={cn(onRowClick && "cursor-pointer")}
							onClick={() => onRowClick?.(row.original)}
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
						<TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
							{emptyMessage}
						</TableCell>
					</TableRow>
				)}
			</TableBody>
		</Table>
	);

	return (
		<div className={cn("space-y-3", className)}>
			<div className="rounded-md border overflow-hidden">
				{scrollHeight ? (
					<ScrollArea className={scrollHeight}>{tableEl}</ScrollArea>
				) : (
					tableEl
				)}
			</div>

			{loadMore
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
									>
										<ChevronLeft className="h-3.5 w-3.5" />
									</Button>
									<Button
										variant="outline"
										size="icon"
										className="h-7 w-7"
										onClick={() => table.nextPage()}
										disabled={!table.getCanNextPage()}
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
