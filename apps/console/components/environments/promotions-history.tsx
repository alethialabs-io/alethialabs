"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The project's promotions, newest first, as a table: source → target, status, when it started and,
// for one that stopped, why. The in-flight one — the promotion the page's detail overlay shows — has
// a View into that overlay; no other row offers a View that would open something else (R6 D-29).
//
// PAGED BY KEYSET (LST-3 #7485). The history is its own read, `environments.promotions`: one SQL
// keyset page at a time (lib/queries/promotions.ts), through `useKeysetList` + `<DataTable keyset>`
// and its `ListFooter`. It used to be an unbounded read of every promotion the project had run,
// carried in the page's overview and paged eight at a time in the browser. The section heading
// carries no count (lib/query/README.md → "Counts"); a project that has never promoted renders no
// section at all, which the first page's `universeEmpty` decides. LIVE through the overview's
// topic: a promotion changing is an `environments` hint, and `orpc.environments.key()` is a prefix
// of this list's infinite key (lib/query/topics.ts).

import type { ColumnDef } from "@tanstack/react-table";
import { Button } from "@repo/ui/button";
import { SectionHeading } from "@repo/ui/section-heading";
import { StatusBadge } from "@repo/ui/status-badge";
import { useMemo } from "react";
import { DataTable } from "@/components/data-table";
import { RegionError } from "@/components/errors/region-error";
import { useKeysetList } from "@/lib/query/use-keyset-list";
import { orpc } from "@/lib/rpc/client";
import type { PromotionRowView } from "@/lib/rpc/procedures/environments";
import { promoStatus, RelativeStamp } from "./env-ui";

/**
 * The Promotions section of the project `project` (its slug): a heading and the history table, or
 * nothing while the first page is pending or when the project has never promoted. `envName`
 * resolves an environment id to its name. `activeId` is the promotion the detail overlay shows (the
 * project's in-flight one), or null; only its row has a View, and `onView` opens that overlay.
 */
export function PromotionsHistory({
	project,
	envName,
	activeId,
	onView,
}: {
	project: string;
	envName: (id: string) => string;
	activeId: string | null;
	onView: () => void;
}) {
	const query = useMemo(() => ({ project }), [project]);
	const list = useKeysetList(orpc.environments.promotions, query);
	const columns = useMemo<ColumnDef<PromotionRowView>[]>(
		() => [
			{
				id: "promotion",
				header: "Promotion",
				enableSorting: false,
				cell: ({ row }) => (
					<span className="font-mono text-ui-md text-text-primary">
						{envName(row.original.source_environment_id)} <span aria-hidden>→</span>
						<span className="sr-only"> to </span> {envName(row.original.target_environment_id)}
					</span>
				),
			},
			{
				id: "status",
				header: "Status",
				enableSorting: false,
				cell: ({ row }) => {
					const status = promoStatus(row.original.status);
					return <StatusBadge status={row.original.status} tier={status.tier} label={status.label} />;
				},
			},
			{
				id: "started",
				header: "Started",
				enableSorting: false,
				cell: ({ row }) => <RelativeStamp at={row.original.created_at} />,
			},
			{
				id: "reason",
				header: "Reason",
				enableSorting: false,
				cell: ({ row }) =>
					row.original.error_message ? (
						<span className="whitespace-normal text-ui-sm text-text-secondary">{row.original.error_message}</span>
					) : (
						<span className="text-text-tertiary">—</span>
					),
			},
			{
				id: "actions",
				header: () => <span className="sr-only">Actions</span>,
				enableSorting: false,
				cell: ({ row }) =>
					row.original.id === activeId ? (
						<div className="text-right">
							<Button variant="ghost" size="sm" onClick={onView}>
								View
							</Button>
						</div>
					) : null,
			},
		],
		[envName, activeId, onView],
	);

	// A failed FIRST page is the region error with a retry — never an absent section, which would
	// read as "this project has never promoted". A failed refresh behind rows is the table's stale
	// notice; a failed later page is the footer's retry line (both inside `DataTable keyset`).
	const firstPageFailed = list.query.isError && list.query.data === undefined;
	if (!firstPageFailed && list.universeEmpty !== false) return null;

	return (
		<section>
			<SectionHeading className="mb-3" level={2} title="Promotions" />
			{firstPageFailed ? (
				<RegionError
					title="Couldn't load promotions"
					description="Something went wrong fetching this project's promotions. Check your connection and try again."
					onRetry={() => void list.query.refetch()}
				/>
			) : (
				<DataTable columns={columns} keyset={list} />
			)}
		</section>
	);
}
