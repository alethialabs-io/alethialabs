"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
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

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

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
}: DataTableProps<TData, TValue>) {
	const [sorting, setSorting] = useState<SortingState>([]);
	const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(
		externalFilters ?? [],
	);

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
			...(externalPageIndex !== undefined && {
				pagination: { pageIndex: externalPageIndex, pageSize },
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
							No results.
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

			{table.getPageCount() > 1 && (
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
							Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
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
