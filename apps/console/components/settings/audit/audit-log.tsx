"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Audit Log — a filter bar (search / category / result / range / export)
// above the shared DataTable (sortable + paginated). Every PDF access decision the PDP
// recorded; client-side filters over the loaded slice; CSV export is Enterprise-gated.
// The design's Source/IP column and friendly resource names aren't stored — omitted.

import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { Download } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	type AuditRow,
	getAuditExportCsv,
	getAuditLog,
} from "@/app/server/actions/audit";
import { DataTable } from "@/components/data-table";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import {
	SettingsSearch,
	SettingsSelect,
} from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const DAY = 86_400_000;

/** A coarse event category derived from the resource the decision was about. */
function categoryOf(resourceType: string): string {
	switch (resourceType) {
		case "spec":
		case "job":
		case "runner":
			return "Deploy";
		case "member":
		case "invitation":
			return "Member";
		case "cloud_identity":
			return "Identity";
		case "billing":
			return "Billing";
		case "grant":
		case "role":
		case "org":
		case "team":
			return "Access";
		case "connector":
			return "Integration";
		default:
			return resourceType
				? resourceType[0].toUpperCase() + resourceType.slice(1)
				: "Event";
	}
}
function initials(name: string | null, email: string | null): string {
	return (name?.trim() || email || "?").slice(0, 2).toUpperCase();
}

const columns: ColumnDef<AuditRow>[] = [
	{
		accessorKey: "ts",
		header: "Time",
		cell: ({ row }) => (
			<span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
				{formatDistanceToNow(new Date(row.original.ts), { addSuffix: true })}
			</span>
		),
	},
	{
		id: "actor",
		header: "Actor",
		enableSorting: false,
		cell: ({ row }) => {
			const e = row.original;
			return (
				<div className="flex items-center gap-2.5">
					<span className="flex size-7 shrink-0 items-center justify-center rounded-full border bg-muted font-mono text-[10px] text-muted-foreground">
						{initials(e.actorName, e.actorEmail)}
					</span>
					<span className="truncate text-foreground">
						{e.actorName ?? e.actorEmail ?? `${e.actorId.slice(0, 8)}…`}
					</span>
				</div>
			);
		},
	},
	{
		id: "event",
		header: "Event",
		enableSorting: false,
		cell: ({ row }) => (
			<div className="flex flex-col gap-0.5">
				<span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
					{categoryOf(row.original.resourceType)}
				</span>
				<span className="capitalize text-foreground">
					{row.original.action.replace(/_/g, " ")}
				</span>
			</div>
		),
	},
	{
		accessorKey: "resourceType",
		header: "Resource",
		cell: ({ row }) => (
			<span className="font-mono text-xs text-muted-foreground">
				{row.original.resourceType}
				{row.original.resourceId ? ` · ${row.original.resourceId.slice(0, 8)}` : ""}
			</span>
		),
	},
	{
		accessorKey: "decision",
		header: "Result",
		cell: ({ row }) => (
			<span
				className={cn(
					"vx-status",
					row.original.decision ? "vx-status--active" : "vx-status--failed",
				)}
			>
				<span className="vx-status__dot" />
				{row.original.decision ? "Allowed" : "Denied"}
			</span>
		),
	},
];

export function AuditLog() {
	const canExport = useEntitlement("auditExport");
	const [events, setEvents] = useState<AuditRow[] | null>(null);
	const [loadedAt, setLoadedAt] = useState(0);
	const [search, setSearch] = useState("");
	const [category, setCategory] = useState("all");
	const [result, setResult] = useState("all");
	const [range, setRange] = useState("30");
	const [exporting, setExporting] = useState(false);

	const load = useCallback(() => {
		getAuditLog()
			.then((rows) => {
				setEvents(rows);
				setLoadedAt(Date.now());
			})
			.catch(() => {
				setEvents([]);
				setLoadedAt(Date.now());
			});
	}, []);
	useEffect(() => {
		load();
	}, [load]);

	async function onExport() {
		setExporting(true);
		try {
			const csv = await getAuditExportCsv();
			const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = "audit-log.csv";
			a.click();
			URL.revokeObjectURL(url);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Export failed");
		} finally {
			setExporting(false);
		}
	}

	const filtered = useMemo(() => {
		const list = events ?? [];
		const q = search.trim().toLowerCase();
		const cutoff = loadedAt - Number(range) * DAY;
		return list.filter((e) => {
			if (result !== "all" && (result === "allow") !== e.decision) return false;
			if (category !== "all" && categoryOf(e.resourceType).toLowerCase() !== category)
				return false;
			if (loadedAt && new Date(e.ts).getTime() < cutoff) return false;
			if (
				q &&
				!`${e.actorName ?? ""} ${e.actorEmail ?? ""} ${e.action} ${e.resourceType}`
					.toLowerCase()
					.includes(q)
			)
				return false;
			return true;
		});
	}, [events, search, category, result, range, loadedAt]);

	if (events === null) {
		return (
			<div className="space-y-4">
				<Skeleton className="h-10 w-full" />
				<Skeleton className="h-64 w-full" />
			</div>
		);
	}

	return (
		<div>
			{/* filter bar */}
			<div className="mb-3 flex flex-wrap items-center gap-2.5">
				<SettingsSearch
					value={search}
					onChange={setSearch}
					placeholder="Search actor, action or resource"
					className="w-[260px] flex-1"
				/>
				<SettingsSelect
					aria-label="Category"
					className="w-[150px]"
					value={category}
					onChange={setCategory}
					options={[
						{ value: "all", label: "All events" },
						{ value: "deploy", label: "Deploy" },
						{ value: "access", label: "Access" },
						{ value: "member", label: "Member" },
						{ value: "identity", label: "Identity" },
						{ value: "billing", label: "Billing" },
					]}
				/>
				<SettingsSelect
					aria-label="Result"
					className="w-[130px]"
					value={result}
					onChange={setResult}
					options={[
						{ value: "all", label: "All results" },
						{ value: "allow", label: "Allowed" },
						{ value: "deny", label: "Denied" },
					]}
				/>
				<SettingsSelect
					aria-label="Range"
					className="w-[140px]"
					value={range}
					onChange={setRange}
					options={[
						{ value: "7", label: "Last 7 days" },
						{ value: "30", label: "Last 30 days" },
						{ value: "90", label: "Last 90 days" },
					]}
				/>
				<Button
					variant="outline"
					size="sm"
					disabled={!canExport || exporting}
					title={canExport ? undefined : "Audit export requires Enterprise"}
					onClick={() => void onExport()}
				>
					<Download size={13} />
					Export CSV
				</Button>
			</div>

			<DataTable columns={columns} data={filtered} pageSize={15} />
		</div>
	);
}
