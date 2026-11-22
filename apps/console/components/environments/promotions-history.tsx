"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The project's promotions, newest first, as a table: source → target, status, when it started and,
// for one that stopped, why. The in-flight one — the promotion the page's detail overlay shows — has
// a View into that overlay; no other row offers a View that would open something else (R6 D-29). Every promotion
// the read returned is reachable — the table pages — where this used to show the newest eight and
// say nothing about the rest.

import type { ColumnDef } from "@tanstack/react-table";
import { Button } from "@repo/ui/button";
import { StatusBadge } from "@repo/ui/status-badge";
import { useMemo } from "react";
import { DataTable } from "@/components/data-table";
import type { PromotionRowView } from "@/lib/rpc/procedures/environments";
import { promoStatus, RelativeStamp } from "./env-ui";

/** Promotions per page. */
export const PROMOTIONS_PAGE_SIZE = 8;

/**
 * The promotions table. `envName` resolves an environment id to its name. `activeId` is the
 * promotion the detail overlay shows (the project's in-flight one), or null; only its row has a
 * View, and `onView` opens that overlay.
 */
export function PromotionsHistory({
	promotions,
	envName,
	activeId,
	onView,
}: {
	promotions: PromotionRowView[];
	envName: (id: string) => string;
	activeId: string | null;
	onView: () => void;
}) {
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
	return <DataTable columns={columns} data={promotions} pageSize={PROMOTIONS_PAGE_SIZE} />;
}
