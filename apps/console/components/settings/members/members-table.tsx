"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { MoreHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getMembers, type MemberRow } from "@/app/server/actions/members";
import { DataTable } from "@/components/data-table";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { authClient } from "@/lib/auth/client";
import { ORG_ROLES, toOrgRole } from "@/lib/authz/org-access-control";

const ROLE_OPTIONS = ORG_ROLES;

function initials(name: string | null, email: string): string {
	const base = name?.trim() || email;
	return base.slice(0, 2).toUpperCase();
}

export function MembersTable() {
	const canManage = useEntitlement("organizations");
	const [members, setMembers] = useState<MemberRow[] | null>(null);

	const load = useCallback(() => {
		getMembers()
			.then(setMembers)
			.catch(() => setMembers([]));
	}, []);
	useEffect(() => {
		load();
	}, [load]);

	const changeRole = useCallback(
		async (m: MemberRow, role: string) => {
			const next = toOrgRole(role);
			if (!next || next === m.role) return;
			await authClient.organization.updateMemberRole({
				memberId: m.id,
				role: next,
			});
			load();
		},
		[load],
	);

	const removeMember = useCallback(
		async (m: MemberRow) => {
			await authClient.organization.removeMember({ memberIdOrEmail: m.id });
			load();
		},
		[load],
	);

	const columns = useMemo<ColumnDef<MemberRow>[]>(
		() => [
			{
				accessorKey: "email",
				header: "Member",
				cell: ({ row }) => {
					const m = row.original;
					return (
						<div className="flex items-center gap-3">
							<Avatar className="h-8 w-8">
								<AvatarImage src={m.image ?? undefined} alt={m.email} />
								<AvatarFallback className="bg-muted text-xs text-muted-foreground">
									{initials(m.name, m.email)}
								</AvatarFallback>
							</Avatar>
							<div className="min-w-0">
								{m.name && (
									<p className="truncate text-sm font-medium text-foreground">
										{m.name}
									</p>
								)}
								<p className="truncate text-xs text-muted-foreground">{m.email}</p>
							</div>
						</div>
					);
				},
			},
			{
				accessorKey: "role",
				header: "Role",
				cell: ({ row }) => (
					<Badge variant="secondary" className="capitalize">
						{row.original.role}
					</Badge>
				),
			},
			{
				accessorKey: "joinedAt",
				header: "Joined",
				cell: ({ row }) => (
					<span className="text-xs text-muted-foreground">
						{formatDistanceToNow(new Date(row.original.joinedAt), {
							addSuffix: true,
						})}
					</span>
				),
			},
			{
				id: "actions",
				header: "",
				cell: ({ row }) => {
					if (!canManage) return null;
					const m = row.original;
					return (
						<div className="flex justify-end">
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button variant="ghost" size="icon" className="h-8 w-8">
										<MoreHorizontal className="h-4 w-4" />
										<span className="sr-only">Member actions</span>
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end" className="w-44">
									<DropdownMenuLabel className="text-xs">Role</DropdownMenuLabel>
									<DropdownMenuRadioGroup
										value={m.role}
										onValueChange={(v) => void changeRole(m, v)}
									>
										{ROLE_OPTIONS.map((r) => (
											<DropdownMenuRadioItem
												key={r}
												value={r}
												className="capitalize"
											>
												{r}
											</DropdownMenuRadioItem>
										))}
									</DropdownMenuRadioGroup>
									<DropdownMenuSeparator />
									<DropdownMenuItem
										className="text-destructive focus:text-destructive"
										onClick={() => void removeMember(m)}
									>
										Remove from organization
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
					);
				},
			},
		],
		[canManage, changeRole, removeMember],
	);

	if (members === null) {
		return (
			<div className="space-y-3">
				{[0, 1, 2].map((i) => (
					<Skeleton key={i} className="h-14 w-full" />
				))}
			</div>
		);
	}

	return <DataTable columns={columns} data={members} pageSize={20} />;
}
