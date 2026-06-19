"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { ScrollText } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getAuditLog, type AuditRow } from "@/app/server/actions/audit";
import { DataTable } from "@/components/data-table";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type Filter = "all" | "denied" | "allowed";
const FILTERS: { key: Filter; label: string }[] = [
	{ key: "all", label: "All" },
	{ key: "denied", label: "Denied" },
	{ key: "allowed", label: "Allowed" },
];

function initials(name: string | null, email: string | null): string {
	return (name?.trim() || email || "?").slice(0, 2).toUpperCase();
}

const columns: ColumnDef<AuditRow>[] = [
	{
		accessorKey: "actorEmail",
		header: "Actor",
		cell: ({ row }) => {
			const r = row.original;
			return (
				<div className="flex items-center gap-2.5">
					<Avatar className="h-7 w-7">
						<AvatarImage src={r.actorImage ?? undefined} alt={r.actorEmail ?? ""} />
						<AvatarFallback className="bg-muted text-[10px] text-muted-foreground">
							{initials(r.actorName, r.actorEmail)}
						</AvatarFallback>
					</Avatar>
					<span className="truncate text-xs text-muted-foreground">
						{r.actorEmail ?? `${r.actorId.slice(0, 8)}…`}
					</span>
				</div>
			);
		},
	},
	{
		accessorKey: "action",
		header: "Action",
		cell: ({ row }) => (
			<code className="font-mono text-xs text-foreground">{row.original.action}</code>
		),
	},
	{
		accessorKey: "resourceType",
		header: "Resource",
		cell: ({ row }) => {
			const r = row.original;
			return (
				<span className="font-mono text-xs text-muted-foreground">
					{r.resourceType}
					{r.resourceId ? ` #${r.resourceId.slice(0, 8)}` : ""}
				</span>
			);
		},
	},
	{
		accessorKey: "decision",
		header: "Decision",
		cell: ({ row }) =>
			row.original.decision ? (
				<Badge variant="secondary">Allowed</Badge>
			) : (
				<Badge variant="destructive">Denied</Badge>
			),
	},
	{
		accessorKey: "reason",
		header: "Reason",
		cell: ({ row }) => (
			<span className="truncate text-xs text-muted-foreground">
				{row.original.reason ?? "—"}
			</span>
		),
	},
	{
		accessorKey: "ts",
		header: "When",
		cell: ({ row }) => (
			<span className="whitespace-nowrap text-xs text-muted-foreground">
				{formatDistanceToNow(new Date(row.original.ts), { addSuffix: true })}
			</span>
		),
	},
];

/** The access-events log table: community-real, with an All/Denied/Allowed filter. */
export function AuditLog() {
	const [events, setEvents] = useState<AuditRow[] | null>(null);
	const [filter, setFilter] = useState<Filter>("all");

	const load = useCallback(() => {
		getAuditLog()
			.then(setEvents)
			.catch(() => setEvents([]));
	}, []);
	useEffect(() => {
		load();
	}, [load]);

	const filtered = useMemo(() => {
		if (!events) return [];
		if (filter === "all") return events;
		const want = filter === "allowed";
		return events.filter((e) => e.decision === want);
	}, [events, filter]);

	if (events === null) {
		return (
			<div className="space-y-3">
				{[0, 1, 2, 3].map((i) => (
					<Skeleton key={i} className="h-12 w-full" />
				))}
			</div>
		);
	}

	if (events.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/60 bg-muted/10 px-6 py-16 text-center">
				<div className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
					<ScrollText className="h-5 w-5" />
				</div>
				<h3 className="mt-4 text-sm font-semibold text-foreground">
					No access events yet
				</h3>
				<p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
					Denied attempts and sensitive actions (destroy, manage members, identities,
					integrations, billing) appear here as they happen.
				</p>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-1">
				{FILTERS.map((f) => (
					<Button
						key={f.key}
						size="sm"
						variant={filter === f.key ? "secondary" : "ghost"}
						className={cn("h-8 px-3 text-xs", filter !== f.key && "text-muted-foreground")}
						onClick={() => setFilter(f.key)}
					>
						{f.label}
					</Button>
				))}
			</div>
			<DataTable columns={columns} data={filtered} pageSize={25} />
		</div>
	);
}
