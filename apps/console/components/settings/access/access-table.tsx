"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { Trash2 } from "lucide-react";
import { useMemo } from "react";
import type { AccessGrantRow } from "@/app/server/actions/grants";
import { DataTable } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/** The grants list — principal · effect · role/permission · scope · revoke. */
export function AccessTable({
	grants,
	resourceLabel,
	onRevoke,
}: {
	grants: AccessGrantRow[];
	resourceLabel: (type: string, id: string | null) => string;
	onRevoke: (id: string) => void;
}) {
	const columns = useMemo<ColumnDef<AccessGrantRow>[]>(
		() => [
			{
				accessorKey: "principalLabel",
				header: "Principal",
				cell: ({ row }) => (
					<span className="text-sm text-foreground">{row.original.principalLabel}</span>
				),
			},
			{
				accessorKey: "effect",
				header: "Effect",
				cell: ({ row }) =>
					row.original.effect === "deny" ? (
						<Badge variant="destructive">Deny</Badge>
					) : (
						<Badge variant="secondary">Allow</Badge>
					),
			},
			{
				id: "what",
				header: "Permission",
				cell: ({ row }) => {
					const r = row.original;
					return r.roleName ? (
						<Badge variant="outline" className="capitalize">
							{r.roleName}
						</Badge>
					) : (
						<code className="font-mono text-xs text-foreground">
							{r.permissionKey ?? "—"}
						</code>
					);
				},
			},
			{
				id: "scope",
				header: "Scope",
				cell: ({ row }) => {
					const r = row.original;
					return (
						<span className="text-xs text-muted-foreground">
							{r.resourceType === "org"
								? "Organization"
								: `${r.resourceType} · ${resourceLabel(r.resourceType, r.resourceId)}`}
						</span>
					);
				},
			},
			{
				accessorKey: "createdAt",
				header: "Granted",
				cell: ({ row }) => (
					<span className="whitespace-nowrap text-xs text-muted-foreground">
						{formatDistanceToNow(new Date(row.original.createdAt), { addSuffix: true })}
					</span>
				),
			},
			{
				id: "actions",
				header: "",
				cell: ({ row }) => (
					<div className="flex justify-end">
						<Button
							variant="ghost"
							size="icon"
							className="h-8 w-8 text-destructive"
							onClick={() => onRevoke(row.original.id)}
						>
							<Trash2 className="h-4 w-4" />
							<span className="sr-only">Revoke</span>
						</Button>
					</div>
				),
			},
		],
		[resourceLabel, onRevoke],
	);

	return <DataTable columns={columns} data={grants} pageSize={20} />;
}
