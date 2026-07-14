"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Evidence surface — the org-wide "keep proving it" roll-up. A single Activity-style
// filter bar (search + Status/Stage facets + Group/Sort selects) drives a server-side
// re-fetch of the grouped environment-posture table (with an inline peek + full detail
// drawer) and the recorded-waivers panel. Read-only: the data is produced by the
// PLAN/DEPLOY + DETECT_DRIFT jobs — this page never mutates anything.

import { Layers, ShieldAlert } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { FacetFilter } from "@repo/ui/facet-filter";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import {
	type EvidenceResult,
	getOrgEvidence,
} from "@/app/server/actions/evidence";
import { SettingsSearch } from "@/components/settings/settings-ui";
import {
	type EvidenceEnvRow,
	type GroupMode,
	type SortKey,
	toGroupMode,
	toSortKey,
} from "./evidence-derive";
import { EvidenceDrawer } from "./evidence-drawer";
import { EvIcon } from "./evidence-status";
import { EvidenceTable } from "./evidence-table";
import { EvidenceWaivers } from "./evidence-waivers";
import { downloadReceipt } from "./receipt-download";

const SEARCH_DEBOUNCE = 300;

/** The default drawer tab for a row — Report if verified, else Receipt, else Drift. */
function defaultTab(row: EvidenceEnvRow): string {
	if (row.verify?.report) return "report";
	if (row.verify?.receipt) return "receipt";
	return "drift";
}

/**
 * The Evidence page. Seeded with the server-rendered default view, then re-fetches through
 * the same server action whenever a filter changes (all filtering is server-side).
 */
export function EvidenceClient({ initial }: { initial: EvidenceResult }) {
	const { org } = useParams<{ org: string }>();

	// Filters.
	const [search, setSearch] = useState("");
	const [debouncedSearch, setDebouncedSearch] = useState("");
	const [stages, setStages] = useState<string[]>([]);
	const [status, setStatus] = useState<string[]>([]);
	const [group, setGroup] = useState<GroupMode>("triage");
	const [sort, setSort] = useState<SortKey>("worst");

	// Server view (seeded from the route's first paint).
	const [result, setResult] = useState<EvidenceResult>(initial);
	const [loading, setLoading] = useState(false);

	// Row interaction.
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [drawerId, setDrawerId] = useState<string | null>(null);
	const [drawerTab, setDrawerTab] = useState("report");
	const [toast, setToast] = useState("");

	useEffect(() => {
		if (!toast) return;
		const t = setTimeout(() => setToast(""), 2400);
		return () => clearTimeout(t);
	}, [toast]);

	// Debounce the free-text search so it doesn't refetch on every keystroke.
	useEffect(() => {
		const id = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE);
		return () => clearTimeout(id);
	}, [search]);

	// Re-fetch the grouped view server-side whenever a filter changes. `initial` already
	// reflects the default query, so skip the redundant fetch on first mount.
	const firstRun = useRef(true);
	useEffect(() => {
		if (firstRun.current) {
			firstRun.current = false;
			return;
		}
		let cancelled = false;
		setLoading(true);
		getOrgEvidence({
			search: debouncedSearch.trim() || undefined,
			stages: stages.length ? stages : undefined,
			status: status.length ? status : undefined,
			group,
			sort,
		})
			.then((r) => {
				if (!cancelled) setResult(r);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [debouncedSearch, stages, status, group, sort]);

	const statusOptions = useMemo(
		() =>
			result.statusOptions.map((o) => ({
				value: o.value,
				label: o.label,
				hint: String(o.count),
			})),
		[result.statusOptions],
	);
	const stageOptions = useMemo(
		() =>
			result.stageOptions.map((o) => ({
				value: o.value,
				label: o.label,
				hint: String(o.count),
			})),
		[result.stageOptions],
	);

	// The drawer opens only on a currently-visible row, so it's always in the grouped set.
	const drawerRow = useMemo(() => {
		for (const g of result.groups) {
			const row = g.rows.find((r) => r.environmentId === drawerId);
			if (row) return row;
		}
		return null;
	}, [result.groups, drawerId]);

	/** Opens the detail drawer on a valid default tab for the row. */
	const openDrawer = (row: EvidenceEnvRow) => {
		setDrawerTab(defaultTab(row));
		setDrawerId(row.environmentId);
	};

	/** Downloads the row's signed receipt and shows a confirmation toast. */
	const download = (row: EvidenceEnvRow) => {
		if (!row.verify?.receipt) return;
		setToast(downloadReceipt(row.verify.receipt, row.verify.jobId));
	};

	return (
		<div className="pb-20">
			{/* filter bar — the app-wide filter language (see settings/activity) */}
			<div className="mb-4 flex flex-wrap items-center gap-2.5">
				<SettingsSearch
					value={search}
					onChange={setSearch}
					placeholder="Filter by project or environment…"
					className="w-[240px] flex-1"
				/>
				<FacetFilter
					label="Status"
					icon={ShieldAlert}
					options={statusOptions}
					value={status}
					onChange={setStatus}
					searchPlaceholder="Search statuses…"
					emptyText="No statuses."
				/>
				<FacetFilter
					label="Stage"
					icon={Layers}
					options={stageOptions}
					value={stages}
					onChange={setStages}
					searchPlaceholder="Search stages…"
					emptyText="No stages."
				/>
				<Select value={group} onValueChange={(v) => setGroup(toGroupMode(v))}>
					<SelectTrigger size="sm" className="w-auto gap-1.5">
						<span className="text-text-tertiary">Group</span>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="triage">Triage</SelectItem>
						<SelectItem value="project">Project</SelectItem>
						<SelectItem value="stage">Stage</SelectItem>
					</SelectContent>
				</Select>
				<Select value={sort} onValueChange={(v) => setSort(toSortKey(v))}>
					<SelectTrigger size="sm" className="w-auto gap-1.5">
						<span className="text-text-tertiary">Sort</span>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="worst">Worst</SelectItem>
						<SelectItem value="stale">Stale</SelectItem>
						<SelectItem value="name">Name</SelectItem>
					</SelectContent>
				</Select>
				<span className="ml-auto font-mono text-[11px] text-text-tertiary">
					<b className="font-semibold text-text-primary">
						{result.resultCount}
					</b>{" "}
					of {result.total} environments
				</span>
			</div>

			<div
				className={
					loading
						? "opacity-60 transition-opacity"
						: "transition-opacity"
				}
			>
				<EvidenceTable
					groups={result.groups}
					expandedId={expandedId}
					onToggle={(id) => setExpandedId((cur) => (cur === id ? null : id))}
					onOpen={openDrawer}
					onDownload={download}
				/>

				<div className="mt-6">
					<EvidenceWaivers waivers={result.waivers} />
				</div>
			</div>

			<EvidenceDrawer
				org={org}
				row={drawerRow}
				tab={drawerTab}
				onTab={setDrawerTab}
				onClose={() => setDrawerId(null)}
				onDownload={download}
			/>

			{toast && (
				<div className="fixed bottom-6 left-1/2 z-[95] flex -translate-x-1/2 items-center gap-2 rounded-sm bg-ink px-4 py-2.5 text-[12.5px] text-ink-foreground shadow-lg">
					<EvIcon name="check-circle" size={14} />
					{toast}
				</div>
			)}
		</div>
	);
}
