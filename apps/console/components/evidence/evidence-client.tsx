"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Evidence surface — the org-wide "keep proving it" roll-up. One fetched roll-up drives
// three distribution meters, a triage strip, a search/group/sort/stage toolbar, a single
// grouped environment-posture table (with an inline peek + full detail drawer), and the
// recorded-waivers panel. Read-only: the data is produced by the PLAN/DEPLOY + DETECT_DRIFT
// jobs — this page never mutates anything.

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Skeleton } from "@repo/ui/skeleton";
import {
	buildMeters,
	buildTriage,
	deriveGroups,
	stageLabel,
	type EvidenceEnvRow,
	type GroupMode,
	type SortKey,
	type TriageKey,
} from "./evidence-derive";
import { EvidenceDrawer } from "./evidence-drawer";
import { EvidenceMeters } from "./evidence-meters";
import { EvIcon } from "./evidence-status";
import { EvidenceTable } from "./evidence-table";
import { EvidenceToolbar, type StagePill } from "./evidence-toolbar";
import { EvidenceTriage } from "./evidence-triage";
import { EvidenceWaivers } from "./evidence-waivers";
import { downloadReceipt } from "./receipt-download";
import { useEvidenceQuery } from "@/lib/query/use-evidence-query";
import type { OrgEvidence } from "@/lib/queries/evidence";

const STAGE_ORDER = ["production", "staging", "development"];

/** The default drawer tab for a row — Report if verified, else Receipt, else Drift. */
function defaultTab(row: EvidenceEnvRow): string {
	if (row.verify?.report) return "report";
	if (row.verify?.receipt) return "receipt";
	return "drift";
}

/** The Evidence page body once data has loaded. */
function EvidenceLoaded({ data, org }: { data: OrgEvidence; org: string }) {
	const [search, setSearch] = useState("");
	const [group, setGroup] = useState<GroupMode>("triage");
	const [sort, setSort] = useState<SortKey>("worst");
	const [stage, setStage] = useState("all");
	const [triage, setTriage] = useState<TriageKey>("all");
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [drawerId, setDrawerId] = useState<string | null>(null);
	const [drawerTab, setDrawerTab] = useState("report");
	const [toast, setToast] = useState("");

	useEffect(() => {
		if (!toast) return;
		const t = setTimeout(() => setToast(""), 2400);
		return () => clearTimeout(t);
	}, [toast]);

	const meters = useMemo(() => buildMeters(data), [data]);
	const triageClusters = useMemo(
		() => buildTriage(data.summary),
		[data.summary],
	);
	const { groups, resultCount } = useMemo(
		() => deriveGroups(data, { search, stage, triage, group, sort }),
		[data, search, stage, triage, group, sort],
	);

	const stages: StagePill[] = useMemo(() => {
		const counts = new Map<string, number>();
		for (const r of data.rows) counts.set(r.stage, (counts.get(r.stage) ?? 0) + 1);
		const present = [...counts.keys()].sort(
			(a, b) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b),
		);
		return [
			{ key: "all", label: "All stages", count: data.rows.length },
			...present.map((s) => ({
				key: s,
				label: stageLabel(s),
				count: counts.get(s) ?? 0,
			})),
		];
	}, [data.rows]);

	const projectCount = useMemo(
		() => new Set(data.rows.map((r) => r.projectId)).size,
		[data.rows],
	);

	const drawerRow =
		data.rows.find((r) => r.environmentId === drawerId) ?? null;
	const filtered = search !== "" || stage !== "all" || triage !== "all";

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

	const resetFilters = () => {
		setSearch("");
		setStage("all");
		setTriage("all");
	};

	return (
		<div className="pb-20">
			{/* identity line */}
			<div className="mb-5 flex items-center gap-3">
				<EvIcon name="shield-check" size={17} className="text-text-primary" />
				<span className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-text-tertiary">
					Org evidence
				</span>
				<span className="h-3 w-px bg-border-strong" />
				<span className="font-mono text-[11px] text-text-secondary">{org}</span>
				<span className="font-mono text-[11px] text-text-disabled">
					· {data.summary.environments} environments · {projectCount} projects
				</span>
				<span className="flex-1" />
				<span className="hidden font-mono text-[10px] uppercase tracking-wide text-text-disabled sm:inline">
					Read-only · Keep proving it
				</span>
			</div>

			<div className="flex flex-col gap-3.5">
				<EvidenceMeters meters={meters} />
				<EvidenceTriage
					clusters={triageClusters}
					active={triage}
					onSelect={setTriage}
				/>
			</div>

			<div className="mt-5 flex flex-col gap-3.5">
				<EvidenceToolbar
					search={search}
					onSearch={setSearch}
					group={group}
					onGroup={setGroup}
					sort={sort}
					onSort={setSort}
					stage={stage}
					onStage={setStage}
					stages={stages}
					resultCount={resultCount}
					total={data.summary.environments}
					filtered={filtered}
					onReset={resetFilters}
				/>
				<EvidenceTable
					groups={groups}
					expandedId={expandedId}
					onToggle={(id) =>
						setExpandedId((cur) => (cur === id ? null : id))
					}
					onOpen={openDrawer}
					onDownload={download}
				/>
			</div>

			<div className="mt-6">
				<EvidenceWaivers waivers={data.waivers} />
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

/** The Evidence page: loading skeleton until the roll-up hydrates, then the full surface. */
export function EvidenceClient() {
	const { org } = useParams<{ org: string }>();
	const { data, isPending } = useEvidenceQuery();

	if (isPending || !data) {
		return (
			<div className="space-y-4">
				<Skeleton className="h-4 w-64" />
				<Skeleton className="h-28 w-full rounded-lg" />
				<Skeleton className="h-20 w-full rounded-lg" />
				<Skeleton className="h-72 w-full rounded-lg" />
			</div>
		);
	}

	return <EvidenceLoaded data={data} org={org} />;
}
