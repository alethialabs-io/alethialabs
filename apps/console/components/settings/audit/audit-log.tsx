"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Audit Log — the authored design (filter bar + access-events table),
// composed from the shared settings primitives. Every PDP access decision is recorded;
// this shows the most recent slice with client-side search / category / result / range
// filters and a server-gated CSV export. The design's Source/IP column and friendly
// resource names aren't stored — omitted (tracked in the gap log).

import { formatDistanceToNow } from "date-fns";
import { Download, ScrollText } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	type AuditRow,
	getAuditExportCsv,
	getAuditLog,
} from "@/app/server/actions/audit";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import {
	SettingsPageHead,
	SettingsSearch,
	SettingsSelect,
	SettingsTableCard,
	SettingsTableFoot,
	settingsTableRows,
	settingsTd,
	settingsTh,
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
			<SettingsPageHead
				eyebrow="Audit Log"
				title="Audit Log"
				description="Every access decision is recorded by the policy engine — it can't be forgotten at a call site. Each entry is the actor, the action, the resource and the outcome."
			/>

			{/* filter bar */}
			<div className="mb-[14px] flex flex-wrap items-center gap-2.5">
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

			{/* table */}
			<SettingsTableCard
				foot={
					<SettingsTableFoot>
						<span>
							Showing{" "}
							<b className="font-medium text-text-secondary">{filtered.length}</b> of{" "}
							{events.length}
						</span>
					</SettingsTableFoot>
				}
			>
				<table className={settingsTableRows}>
					<thead>
						<tr>
							<th className={settingsTh}>Time</th>
							<th className={settingsTh}>Actor</th>
							<th className={settingsTh}>Event</th>
							<th className={settingsTh}>Resource</th>
							<th className={settingsTh}>Result</th>
						</tr>
					</thead>
					<tbody>
						{filtered.map((e) => (
							<tr key={e.id}>
								<td
									className={cn(
										settingsTd,
										"whitespace-nowrap font-mono text-[11px] text-text-tertiary",
									)}
								>
									{formatDistanceToNow(new Date(e.ts), { addSuffix: true })}
								</td>
								<td className={settingsTd}>
									<div className="flex items-center gap-2.5">
										<span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface-muted font-mono text-[10px] text-text-secondary">
											{initials(e.actorName, e.actorEmail)}
										</span>
										<span className="truncate text-[13px] text-text-primary">
											{e.actorName ?? e.actorEmail ?? `${e.actorId.slice(0, 8)}…`}
										</span>
									</div>
								</td>
								<td className={settingsTd}>
									<div className="flex flex-col gap-0.5">
										<span className="font-mono text-[10px] uppercase tracking-[0.08em] text-text-tertiary">
											{categoryOf(e.resourceType)}
										</span>
										<span className="text-[13px] capitalize text-text-primary">
											{e.action.replace(/_/g, " ")}
										</span>
									</div>
								</td>
								<td
									className={cn(settingsTd, "font-mono text-[11.5px] text-text-secondary")}
								>
									{e.resourceType}
									{e.resourceId ? (
										<span className="text-text-tertiary"> · {e.resourceId.slice(0, 8)}</span>
									) : null}
								</td>
								<td className={settingsTd}>
									<span
										className={cn(
											"vx-status",
											e.decision ? "vx-status--active" : "vx-status--failed",
										)}
									>
										<span className="vx-status__dot" />
										{e.decision ? "Allowed" : "Denied"}
									</span>
								</td>
							</tr>
						))}
					</tbody>
				</table>
				{filtered.length === 0 && (
					<div className="flex flex-col items-center px-6 py-14 text-center">
						<ScrollText className="mb-3 size-5 text-text-tertiary" />
						<p className="text-[13px] text-text-tertiary">
							{events.length === 0
								? "No access events yet. Denied attempts and sensitive actions appear here as they happen."
								: "No events match these filters."}
						</p>
					</div>
				)}
			</SettingsTableCard>
		</div>
	);
}
