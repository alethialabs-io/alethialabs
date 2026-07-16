"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Evidence surface — the org-wide "keep proving it" roll-up, and the reference
// implementation of the console filter standard: a URL-synced zustand filter store
// feeds a filter-in-key TanStack query (server-side filtering), the table dims while
// a refetch is in flight, and the count pill next to the Environments heading carries
// the result count. Read-only: the data is produced by the PLAN/DEPLOY + drift jobs.

import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { DEFAULT_EVIDENCE_FILTERS } from "@/components/evidence/evidence-query";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { useEvidenceQuery } from "@/lib/query/use-evidence-query";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useEvidenceFilters } from "@/lib/stores/use-evidence-filters";
import { EvidenceDrawer } from "./drawer/evidence-drawer";
import { type EvidenceEnvRow, hasAnySignal } from "./evidence-derive";
import { EvidenceNoMatch, EvidenceOnboarding } from "./evidence-empty";
import { EvidenceFilterBar } from "./evidence-filter-bar";
import { EvIcon } from "./evidence-status";
import { EvidenceTable } from "./evidence-table";
import { EvidenceWaivers } from "./evidence-waivers";
import { downloadReceipt } from "./receipt-download";

/** The default drawer tab for a row — Report if verified, else Receipt, else Drift. */
function defaultTab(row: EvidenceEnvRow): string {
	if (row.verify?.report) return "report";
	if (row.verify?.receipt) return "receipt";
	return "drift";
}

/** The Evidence page client (data comes hydrated from the route's prefetch). */
export function EvidenceClient() {
	const { org } = useParams<{ org: string }>();
	const filters = useEvidenceFilters((s) => s.filters);
	const reset = useEvidenceFilters((s) => s.reset);
	useFilterUrlSync(useEvidenceFilters, DEFAULT_EVIDENCE_FILTERS);
	const { data: result, isPlaceholderData } = useEvidenceQuery();

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

	// The drawer opens only on a currently-visible row, so it's always in the grouped set.
	const drawerRow = useMemo(() => {
		for (const g of result?.groups ?? []) {
			const row = g.rows.find((r) => r.environmentId === drawerId);
			if (row) return row;
		}
		return null;
	}, [result?.groups, drawerId]);

	/** Opens the detail drawer on a valid default tab (rows with ≥1 signal only). */
	const openDrawer = (row: EvidenceEnvRow) => {
		if (!hasAnySignal(row)) return;
		setDrawerTab(defaultTab(row));
		setDrawerId(row.environmentId);
	};

	/** Downloads the row's signed receipt and shows a confirmation toast. */
	const download = (row: EvidenceEnvRow) => {
		if (!row.verify?.receipt) return;
		setToast(downloadReceipt(row.verify.receipt, row.verify.jobId));
	};

	// Persisted-session filters can miss the prefetched key on a return visit —
	// nothing to render for exactly one frame while the refetch lands.
	if (!result) return null;

	const filtersActive =
		countActiveFilters(filters, DEFAULT_EVIDENCE_FILTERS) > 0;
	const onboarding = result.summary.environments === 0;

	return (
		<div className="pb-20">
			{onboarding ? (
				<EvidenceOnboarding org={org} />
			) : (
				<>
					<EvidenceFilterBar
						statusOptions={result.statusOptions}
						stageOptions={result.stageOptions}
						providerOptions={result.providerOptions}
					/>

					<div
						className={
							isPlaceholderData
								? "opacity-60 transition-opacity"
								: "transition-opacity"
						}
					>
						<div className="mb-2.5 flex items-center gap-2.5">
							<h2 className="font-display text-[15px] font-semibold tracking-tight text-text-primary">
								Environments
							</h2>
							<span className="rounded-full border px-2 py-0.5 font-mono text-[10.5px] tabular-nums text-text-secondary">
								{result.resultCount}
							</span>
						</div>

						{result.resultCount === 0 && filtersActive ? (
							<EvidenceNoMatch onClear={reset} />
						) : (
							<EvidenceTable
								org={org}
								groups={result.groups}
								expandedId={expandedId}
								onToggle={(id) =>
									setExpandedId((cur) => (cur === id ? null : id))
								}
								onOpen={openDrawer}
								onDownload={download}
							/>
						)}

						<div className="mt-6">
							<EvidenceWaivers org={org} waivers={result.waivers} />
						</div>
					</div>
				</>
			)}

			<EvidenceDrawer
				org={org}
				row={drawerRow}
				waivers={result.waivers}
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
