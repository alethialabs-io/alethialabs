"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE APPROVALS LIST (AGT-L2 spec §1.3) — the home of every request waiting for a person, plus their
// history, for one org. On the console list standard end to end (lib/query/README.md): a filter
// store mirrored into the URL, the normalized query as the key, server-side filtering with facet
// counts over the unfiltered universe (`approvals.list`), keyset paging through `useKeysetList` and
// `<DataTable keyset>` (an invisible scroll sentinel plus a visible "Load more"), the previous rows
// kept and dimmed while a new filter loads, and no count anywhere — not on the toolbar, not in the
// sidebar (§1.5, maintainer ruling 2).
//
// A row opens the decision sheet over the list; the open request is in the URL (`?selected=<id>`),
// so a link, a refresh and Back reproduce it. The sheet reads the approval by id, so a request the
// loaded pages do not reach opens all the same.

import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { cn } from "@repo/ui/utils";
import { CircleCheck, SearchX, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useRef } from "react";
import { DataTable } from "@/components/data-table";
import { RegionError } from "@/components/errors/region-error";
import { RegionRefusal } from "@/components/errors/region-refusal";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import type { ApprovalListItem } from "@/lib/queries/approvals";
import { useKeysetList } from "@/lib/query/use-keyset-list";
import {
	FILTER_DEPENDENT_PARAMS,
	hrefWithParamPatch,
	selectionFromUrl,
	selectionPatch,
} from "@/lib/query/view-url-params";
import { orpc } from "@/lib/rpc/client";
import { readRefusalOf } from "@/lib/rpc/refusal";
import { useApprovalsFilters } from "@/lib/stores/use-approvals-filters";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { buildApprovalColumns } from "./approval-columns";
import { ApprovalSheet } from "./approval-sheet";
import { ApprovalsFilterBar } from "./approvals-filter-bar";
import { ApprovalsPhoneList } from "./approvals-phone-list";
import {
	CLEARED_APPROVALS_FILTERS,
	DEFAULT_APPROVALS_FILTERS,
	isDefaultApprovalsView,
	normalizeApprovalsQuery,
} from "./approvals-query";

/** The toolbar's description (spec §1.3, Copy). */
const APPROVALS_DESCRIPTION =
	"Requests from the Alethia CLI, connected agents and service tokens to deploy or destroy. Each one needs a person.";

/** The minimum height of the list's whole-region states, so a state change does not jump the page. */
const REGION = "min-h-[60vh]";

/**
 * The approvals list and its decision sheet. States, one each: first page pending (the table's
 * placeholder rows), first page refused or failed, an org with no requests at all, nothing waiting
 * (the default view, empty), no request matching the filters, and the rows — with a failed later page
 * told under them by the footer, and a failed refresh by the table's stale notice.
 */
export function ApprovalsList() {
	const orgSlug = useActiveOrgSlug();
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();

	const filters = useApprovalsFilters((s) => s.filters);
	const set = useApprovalsFilters((s) => s.set);
	const replace = useApprovalsFilters((s) => s.replace);
	const reset = useApprovalsFilters((s) => s.reset);
	// A filter change drops `?selected=`: the open request was chosen under the old filters.
	const urlRead = useFilterUrlSync(useApprovalsFilters, DEFAULT_APPROVALS_FILTERS, undefined, {
		resetParams: FILTER_DEPENDENT_PARAMS,
	});
	// Only TYPING waits: a search the link carried lands in the key at once (`urlRead`).
	const debouncedSearch = useDebouncedValue(filters.search, 250, { urlRead });
	const view = useMemo(() => ({ ...filters, search: debouncedSearch }), [filters, debouncedSearch]);
	const query = useMemo(() => normalizeApprovalsQuery(view), [view]);
	const list = useKeysetList(orpc.approvals.list, query);

	const selectedId = selectionFromUrl(searchParams);
	// The element that opened the sheet, so focus goes back to it on close (spec §1.4, accessibility).
	const opener = useRef<HTMLElement | null>(null);

	/** Writes one view param, leaving the filters and every other param alone. */
	const patchUrl = (patch: Record<string, string | null>) => {
		router.replace(hrefWithParamPatch(pathname, searchParams.toString(), patch), { scroll: false });
	};
	const openRow = (row: ApprovalListItem, from?: HTMLElement | null) => {
		opener.current = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
		patchUrl(selectionPatch(row.id));
	};
	const columns = useMemo(() => buildApprovalColumns(), []);

	const firstPageFailed = list.query.isError && list.query.data === undefined;
	const refusal = firstPageFailed ? readRefusalOf(list.query.error) : null;
	const firstRun = !list.isPending && list.universeEmpty === true;
	const noMatch = !list.isPending && list.universeEmpty === false && list.rows.length === 0;
	const busy = !urlRead || list.isPending || list.isPlaceholderData || filters.search !== debouncedSearch;

	const sheet = (
		<ApprovalSheet
			approvalId={selectedId}
			orgSlug={orgSlug}
			onClose={() => patchUrl(selectionPatch(null))}
			returnFocus={opener}
		/>
	);

	if (refusal) {
		return (
			<>
				<RegionRefusal className={REGION} refusal={refusal} subject="approval requests" />
				{sheet}
			</>
		);
	}
	if (firstPageFailed) {
		return (
			<>
				<RegionError
					className={REGION}
					title="Couldn't load approvals"
					description="Something went wrong on our side. Requests are safe and nothing was decided."
					onRetry={() => void list.query.refetch()}
				/>
				{sheet}
			</>
		);
	}
	if (firstRun) {
		return (
			<>
				<PageToolbar description={APPROVALS_DESCRIPTION} />
				<EmptyState
					className={REGION}
					data-state="first-run"
					icon={<ShieldCheck />}
					level={2}
					title="No approval requests yet"
					description="When an agent, the Alethia CLI or a service token asks to deploy or destroy, the request waits here for a person."
					action={
						<span className="flex flex-wrap items-center justify-center gap-3">
							{/* Settings → Connected agents (#7625): every app Alethia knows, with its setup guide. */}
							<Button size="sm" nativeButton={false} render={<Link href={`/${orgSlug}/~/settings/connected`} />}>
								Connect an agent
							</Button>
							<code className="rounded border px-2 py-1 font-mono text-ui-sm text-text-primary">alethia agent setup</code>
						</span>
					}
				/>
				{sheet}
			</>
		);
	}

	return (
		<div className="space-y-6" aria-busy={busy}>
			{/* No count: the list standard carries no list sizes; totals live only in the facet options. */}
			<PageToolbar description={APPROVALS_DESCRIPTION} />
			<ApprovalsFilterBar filters={filters} onFilter={set} onReset={reset} facets={list.facets ?? undefined} />
			{noMatch ? (
				isDefaultApprovalsView(filters) ? (
					<EmptyState
						className="min-h-[40vh]"
						data-state="nothing-waiting"
						icon={<CircleCheck />}
						level={2}
						title="Nothing is waiting for a decision"
						description="Every request has been decided, used, replaced or has expired."
						action={
							<Button variant="outline" size="sm" onClick={() => replace(CLEARED_APPROVALS_FILTERS)}>
								Show all requests
							</Button>
						}
					/>
				) : (
					<EmptyState
						className="min-h-[40vh]"
						data-state="no-match"
						icon={<SearchX />}
						level={2}
						title="No requests match these filters"
						description="Try a different status, operation or environment, or clear the filters."
						action={
							<Button variant="outline" size="sm" onClick={() => replace(CLEARED_APPROVALS_FILTERS)}>
								Clear filters
							</Button>
						}
					/>
				)
			) : (
				<div className={cn("transition-opacity", list.isPlaceholderData && "opacity-60")}>
					<div className="hidden md:block">
						<DataTable
							columns={columns}
							keyset={list}
							onRowClick={(row) => openRow(row)}
							selectedRowId={selectedId ?? undefined}
						/>
					</div>
					<ApprovalsPhoneList list={list} onOpen={openRow} />
				</div>
			)}
			{sheet}
		</div>
	);
}
