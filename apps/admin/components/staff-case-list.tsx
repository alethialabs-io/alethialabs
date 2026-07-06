"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@repo/ui/empty";
import { Input } from "@repo/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@repo/ui/tabs";
import { cn } from "@repo/ui/utils";
import { useQuery } from "@tanstack/react-query";
import { Inbox, Search, UserCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
	type SupportCaseSeverity,
	type SupportCaseStatus,
	supportCaseSeverity,
	supportCaseStatus,
} from "@repo/support/enums";
import {
	SUPPORT_SEVERITY_LABELS,
	SUPPORT_STATUS_LABELS,
} from "@repo/support/validations";
import { listStaffCases, type StaffListInput } from "@/app/actions";
import { StaffCaseListItem } from "./staff-case-list-item";

/** The status tab value — "all" maps to no server-side status constraint. */
type StatusTab = "all" | SupportCaseStatus;
/** The severity select value — "all" maps to no server-side severity constraint. */
type SeverityFilter = "all" | SupportCaseSeverity;

/**
 * The staff cross-tenant case list. Reads the server-prefetched `listStaffCases` cache and
 * exposes a filter bar — status tabs (All + every lifecycle status), a severity select, an
 * "Assigned to me" toggle, and a ~300ms-debounced search. Each distinct filter is its own
 * query key (`["admin","cases",filter]`) so switching is instant once cached; the
 * empty-filter key matches the page's prefetch. Renders one `StaffCaseListItem` per row.
 */
export function StaffCaseList() {
	const [statusTab, setStatusTab] = useState<StatusTab>("all");
	const [severity, setSeverity] = useState<SeverityFilter>("all");
	const [mine, setMine] = useState(false);
	const [searchInput, setSearchInput] = useState("");
	const [search, setSearch] = useState("");

	// Debounce the search box (~300ms) before it feeds the query key / server filter.
	useEffect(() => {
		const t = setTimeout(() => setSearch(searchInput.trim()), 300);
		return () => clearTimeout(t);
	}, [searchInput]);

	// Only include keys that are actually set, so the no-filter object serializes to `{}`
	// and matches the page-level prefetch key exactly.
	const filter = useMemo<StaffListInput>(() => {
		const f: StaffListInput = {};
		if (statusTab !== "all") f.status = statusTab;
		if (severity !== "all") f.severity = severity;
		if (mine) f.mine = true;
		if (search) f.search = search;
		return f;
	}, [statusTab, severity, mine, search]);

	const { data: cases = [], isPending } = useQuery({
		queryKey: ["admin", "cases", filter],
		queryFn: () => listStaffCases(filter),
	});

	return (
		<div className="space-y-4">
			<Tabs
				value={statusTab}
				onValueChange={(v) => setStatusTab(v as StatusTab)}
			>
				<TabsList>
					<TabsTrigger value="all">All</TabsTrigger>
					{supportCaseStatus.enumValues.map((status) => (
						<TabsTrigger key={status} value={status}>
							{SUPPORT_STATUS_LABELS[status]}
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>

			<div className="flex flex-wrap items-center gap-2">
				<div className="relative flex-1 sm:min-w-56 sm:flex-none">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						value={searchInput}
						onChange={(e) => setSearchInput(e.target.value)}
						placeholder="Search subject or case number…"
						className="pl-8"
					/>
				</div>

				<Select
					value={severity}
					onValueChange={(v) => setSeverity(v as SeverityFilter)}
				>
					<SelectTrigger className="w-40">
						<SelectValue placeholder="Severity" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All severities</SelectItem>
						{supportCaseSeverity.enumValues.map((s) => (
							<SelectItem key={s} value={s}>
								{SUPPORT_SEVERITY_LABELS[s]}
							</SelectItem>
						))}
					</SelectContent>
				</Select>

				<Button
					type="button"
					variant={mine ? "default" : "outline"}
					size="sm"
					aria-pressed={mine}
					onClick={() => setMine((m) => !m)}
				>
					<UserCheck className="size-4" />
					Assigned to me
				</Button>
			</div>

			{cases.length === 0 && !isPending ? (
				<Empty className="rounded-md border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<Inbox />
						</EmptyMedia>
						<EmptyTitle>No cases match</EmptyTitle>
						<EmptyDescription>
							No support cases match the current filters.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<div
					className={cn(
						"overflow-hidden rounded-md border",
						isPending && "opacity-60",
					)}
				>
					{cases.map((item) => (
						<StaffCaseListItem key={item.id} item={item} />
					))}
				</div>
			)}
		</div>
	);
}
