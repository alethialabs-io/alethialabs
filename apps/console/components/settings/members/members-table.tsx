"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Members — stats + toolbar (tabs / search / role filter / invite) + a bulk
// bar, over the shared DataTable (sortable + paginated). Real members (getMembers, with
// team names) + pending invitations (getInvitations); inline role change, suspend/
// reactivate (real PDP grant revoke), remove, invite, cancel. The page header + gate
// live in members/page.tsx.

import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { MoreHorizontal, Plus, Shield } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	getInvitations,
	getMembers,
	type InvitationRow,
	type MemberRow,
	setMemberSuspended,
} from "@/app/server/actions/members";
import { DataTable } from "@/components/data-table";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import { InviteMemberDialog } from "@/components/settings/members/invite-member-dialog";
import {
	SettingsSearch,
	SettingsSelect,
	SettingsTabs,
	StatCell,
	StatStrip,
} from "@/components/settings/settings-ui";
import { Button } from "@repo/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { Skeleton } from "@repo/ui/skeleton";
import { authClient } from "@/lib/auth/client";
import { toOrgRole } from "@/lib/authz/org-access-control";
import { cn } from "@repo/ui/utils";

const ROLE_OPTIONS = ["admin", "operator", "viewer"] as const;
type Tab = "all" | "active" | "pending" | "suspended";

interface RowView {
	/** Unique row id (= key) — satisfies DataTable's `{ id?: string }` constraint. */
	id: string;
	key: string;
	kind: "member" | "invite";
	refId: string;
	name: string;
	meta: string;
	avatar: string;
	role: string;
	teams: string[];
	status: "active" | "pending" | "suspended";
	activity: string;
	isYou: boolean;
}

function initials(s: string): string {
	return s.slice(0, 2).toUpperCase();
}

/** The status dot+label, mapped onto the global `.vx-status` device. */
function StatusBadge({ status }: { status: RowView["status"] }) {
	const variant =
		status === "active"
			? "vx-status--active"
			: status === "pending"
				? "vx-status--pending"
				: "vx-status--idle";
	return (
		<span className={cn("vx-status", variant)}>
			<span className="vx-status__dot" />
			<span className="capitalize">{status}</span>
		</span>
	);
}

/** A compact, borderless shadcn Select for a member's role. */
function RoleSelect({
	value,
	disabled,
	onChange,
}: {
	value: string;
	disabled?: boolean;
	onChange: (value: string) => void;
}) {
	return (
		<Select value={value} onValueChange={onChange} disabled={disabled}>
			<SelectTrigger
				size="sm"
				aria-label="Role"
				className="h-7 w-auto gap-1 border-0 bg-transparent px-2 text-xs font-medium capitalize shadow-none hover:bg-muted focus-visible:ring-0"
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{ROLE_OPTIONS.map((ro) => (
					<SelectItem key={ro} value={ro} className="text-xs capitalize">
						{ro}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

export function MembersTable() {
	const canManage = useEntitlement("organizations");
	const { data: session } = authClient.useSession();
	const myId = session?.user?.id;

	const [members, setMembers] = useState<MemberRow[] | null>(null);
	const [invites, setInvites] = useState<InvitationRow[]>([]);
	const [tab, setTab] = useState<Tab>("all");
	const [search, setSearch] = useState("");
	const [roleFilter, setRoleFilter] = useState("all");
	const [selected, setSelected] = useState<Set<string>>(new Set());

	const load = useCallback(() => {
		getMembers()
			.then(setMembers)
			.catch(() => setMembers([]));
		getInvitations()
			.then(setInvites)
			.catch(() => setInvites([]));
	}, []);
	useEffect(() => {
		load();
	}, [load]);

	const changeRole = useCallback(
		async (memberId: string, value: string) => {
			const next = toOrgRole(value);
			if (!next) return;
			await authClient.organization.updateMemberRole({ memberId, role: next });
			load();
		},
		[load],
	);
	const removeMember = useCallback(
		async (memberId: string) => {
			await authClient.organization.removeMember({ memberIdOrEmail: memberId });
			load();
		},
		[load],
	);
	const cancelInvite = useCallback(
		async (invitationId: string) => {
			await authClient.organization.cancelInvitation({ invitationId });
			load();
		},
		[load],
	);
	const suspend = useCallback(
		async (memberId: string, next: boolean) => {
			try {
				await setMemberSuspended(memberId, next);
				load();
			} catch (e) {
				toast.error(e instanceof Error ? e.message : "Couldn't update the member.");
			}
		},
		[load],
	);

	const rows = useMemo<RowView[]>(() => {
		if (!members) return [];
		const memberRows: RowView[] = members.map((m) => ({
			id: `m:${m.id}`,
			key: `m:${m.id}`,
			kind: "member",
			refId: m.id,
			name: m.name?.trim() || m.email,
			meta: m.email,
			avatar: initials(m.name?.trim() || m.email),
			role: m.role,
			teams: m.teams,
			status: m.status === "suspended" ? "suspended" : "active",
			activity: m.lastActiveAt
				? formatDistanceToNow(new Date(m.lastActiveAt), { addSuffix: true })
				: "—",
			isYou: m.userId === myId,
		}));
		const inviteRows: RowView[] = invites.map((i) => ({
			id: `i:${i.id}`,
			key: `i:${i.id}`,
			kind: "invite",
			refId: i.id,
			name: i.email,
			meta: `invited by ${i.inviterName}`,
			avatar: initials(i.email),
			role: i.role,
			teams: [],
			status: "pending",
			activity: "— invited",
			isYou: false,
		}));
		return [...memberRows, ...inviteRows];
	}, [members, invites, myId]);

	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		return rows.filter((r) => {
			if (tab !== "all" && r.status !== tab) return false;
			if (roleFilter !== "all" && r.role !== roleFilter) return false;
			if (q && !`${r.name} ${r.meta}`.toLowerCase().includes(q)) return false;
			return true;
		});
	}, [rows, tab, roleFilter, search]);

	const activeCount = members?.filter((m) => m.status !== "suspended").length ?? 0;
	const suspendedCount =
		members?.filter((m) => m.status === "suspended").length ?? 0;
	const pendingCount = invites.length;
	const seatCount = (members?.length ?? 0) + pendingCount;

	const toggle = useCallback((key: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	async function bulkRemove() {
		for (const r of filtered.filter((x) => selected.has(x.key))) {
			try {
				if (r.kind === "member") {
					if (r.role === "owner") continue;
					await authClient.organization.removeMember({ memberIdOrEmail: r.refId });
				} else {
					await authClient.organization.cancelInvitation({ invitationId: r.refId });
				}
			} catch {
				/* best-effort */
			}
		}
		setSelected(new Set());
		load();
	}

	async function bulkSuspend() {
		for (const r of filtered.filter((x) => selected.has(x.key))) {
			if (r.kind === "member" && r.role !== "owner" && r.status === "active") {
				try {
					await setMemberSuspended(r.refId, true);
				} catch {
					/* best-effort */
				}
			}
		}
		setSelected(new Set());
		load();
	}

	const selectCols: ColumnDef<RowView>[] = canManage
		? [
				{
					id: "select",
					header: "",
					enableSorting: false,
					cell: ({ row }) => (
						<input
							type="checkbox"
							aria-label="Select"
							className="size-4 cursor-pointer accent-ink align-middle"
							checked={selected.has(row.original.key)}
							onChange={() => toggle(row.original.key)}
						/>
					),
				},
			]
		: [];
	const actionCols: ColumnDef<RowView>[] = canManage
		? [
				{
					id: "actions",
					header: "",
					enableSorting: false,
					cell: ({ row }) => {
						const r = row.original;
						if (r.kind === "member" && r.role === "owner") return null;
						return (
							<div className="text-right">
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button
											variant="ghost"
											size="icon"
											className="size-7"
											aria-label="Manage"
										>
											<MoreHorizontal size={16} />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="w-44">
										{r.kind === "member" ? (
											<>
												{r.status === "suspended" ? (
													<DropdownMenuItem onClick={() => void suspend(r.refId, false)}>
														Reactivate
													</DropdownMenuItem>
												) : (
													<DropdownMenuItem onClick={() => void suspend(r.refId, true)}>
														Suspend
													</DropdownMenuItem>
												)}
												<DropdownMenuItem
													className="text-destructive focus:text-destructive"
													onClick={() => void removeMember(r.refId)}
												>
													Remove from organization
												</DropdownMenuItem>
											</>
										) : (
											<DropdownMenuItem
												className="text-destructive focus:text-destructive"
												onClick={() => void cancelInvite(r.refId)}
											>
												Cancel invitation
											</DropdownMenuItem>
										)}
									</DropdownMenuContent>
								</DropdownMenu>
							</div>
						);
					},
				},
			]
		: [];

	const columns: ColumnDef<RowView>[] = [
		...selectCols,
		{
			id: "member",
			header: "Member",
			enableSorting: false,
			cell: ({ row }) => {
				const r = row.original;
				return (
					<div className="flex items-center gap-2.5">
						<span className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-muted font-mono text-[11px] text-muted-foreground">
							{r.avatar}
						</span>
						<div className="flex min-w-0 flex-col">
							<span className="flex items-center gap-1.5 text-foreground">
								{r.name}
								{r.isYou && (
									<span className="rounded-full border px-1.5 py-px font-mono text-[8.5px] uppercase tracking-wide text-muted-foreground">
										You
									</span>
								)}
							</span>
							<span className="font-mono text-[10.5px] text-muted-foreground">
								{r.meta}
							</span>
						</div>
					</div>
				);
			},
		},
		{
			id: "role",
			header: "Role",
			enableSorting: false,
			cell: ({ row }) => {
				const r = row.original;
				if (r.kind === "member" && r.role === "owner") {
					return (
						<span className="inline-flex items-center gap-1.5 px-2 text-xs font-medium text-foreground">
							<Shield size={13} className="text-muted-foreground" />
							Owner
						</span>
					);
				}
				if (r.kind === "member" && canManage) {
					return (
						<RoleSelect
							value={r.role}
							disabled={r.status === "suspended"}
							onChange={(v) => void changeRole(r.refId, v)}
						/>
					);
				}
				return (
					<span className="px-2 text-xs font-medium capitalize text-foreground">
						{r.role}
					</span>
				);
			},
		},
		{
			id: "teams",
			header: "Teams",
			enableSorting: false,
			cell: ({ row }) => (
				<div className="flex flex-wrap gap-1.5">
					{row.original.teams.length > 0 ? (
						row.original.teams.map((t) => (
							<span
								key={t}
								className="whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
							>
								{t}
							</span>
						))
					) : (
						<span className="rounded-full border border-dashed px-2 py-0.5 font-mono text-[10px] text-muted-foreground/60">
							No team
						</span>
					)}
				</div>
			),
		},
		{
			accessorKey: "status",
			header: "Status",
			cell: ({ row }) => <StatusBadge status={row.original.status} />,
		},
		{
			accessorKey: "activity",
			header: "Last active",
			enableSorting: false,
			cell: ({ row }) => (
				<span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
					{row.original.activity}
				</span>
			),
		},
		...actionCols,
	];

	if (members === null) {
		return (
			<div className="space-y-4">
				<Skeleton className="h-20 w-full" />
				<Skeleton className="h-64 w-full" />
			</div>
		);
	}

	return (
		<div>
			{/* stats */}
			<StatStrip>
				<StatCell label="Seats" value={seatCount} sub="used" />
				<StatCell label="Active" value={activeCount} sub="members" />
				<StatCell label="Pending invites" value={pendingCount} sub="awaiting" />
				<StatCell label="Suspended" value={suspendedCount} sub="no access" />
			</StatStrip>

			{/* toolbar */}
			<div className="mb-[14px] flex flex-wrap items-center justify-between gap-4">
				<SettingsTabs
					value={tab}
					onChange={setTab}
					tabs={[
						{ value: "all", label: "All", count: seatCount },
						{ value: "active", label: "Active", count: activeCount },
						{ value: "pending", label: "Pending", count: pendingCount },
						{ value: "suspended", label: "Suspended", count: suspendedCount },
					]}
				/>
				<div className="flex items-center gap-[10px]">
					<SettingsSearch
						value={search}
						onChange={setSearch}
						placeholder="Search name or email"
						className="w-[218px]"
					/>
					<SettingsSelect
						aria-label="Filter by role"
						className="w-[130px]"
						value={roleFilter}
						onChange={setRoleFilter}
						options={[
							{ value: "all", label: "All roles" },
							{ value: "owner", label: "Owner" },
							{ value: "admin", label: "Admin" },
							{ value: "operator", label: "Operator" },
							{ value: "viewer", label: "Viewer" },
						]}
					/>
					{canManage && (
						<InviteMemberDialog
							onInvited={load}
							trigger={
								<Button size="sm">
									<Plus size={13} />
									Invite member
								</Button>
							}
						/>
					)}
				</div>
			</div>

			{/* bulk bar */}
			{canManage && selected.size > 0 && (
				<div className="mb-3 flex items-center justify-between gap-4 rounded-md border border-foreground bg-muted py-[9px] pl-4 pr-[14px]">
					<div className="flex items-center gap-3 text-[12.5px] text-foreground">
						<span>
							<b className="font-semibold">{selected.size}</b> selected
						</span>
						<button
							type="button"
							className="font-mono text-[11px] text-muted-foreground hover:text-foreground"
							onClick={() => setSelected(new Set())}
						>
							Clear
						</button>
					</div>
					<div className="flex gap-2">
						<Button variant="outline" size="sm" onClick={() => void bulkSuspend()}>
							Suspend
						</Button>
						<Button variant="ghost" size="sm" onClick={() => void bulkRemove()}>
							Remove
						</Button>
					</div>
				</div>
			)}

			<DataTable columns={columns} data={filtered} pageSize={20} />
		</div>
	);
}
