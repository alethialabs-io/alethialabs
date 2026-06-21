"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Members — the authored claude.ai/design panel (stats + toolbar + table),
// composed from the shared settings primitives (shadcn + Tailwind tokens; no CSS module).
// Real members (getMembers, with team names) + pending invitations (getInvitations);
// inline role change, suspend/reactivate (real PDP grant revoke), remove, invite, cancel.
// Tabs / search / role-filter are client-side. Last-active = real session activity.

import { formatDistanceToNow } from "date-fns";
import { ChevronDown, MoreHorizontal, Plus, Shield } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	getInvitations,
	getMembers,
	type InvitationRow,
	type MemberRow,
	setMemberSuspended,
} from "@/app/server/actions/members";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import { InviteMemberDialog } from "@/components/settings/members/invite-member-dialog";
import {
	SettingsSearch,
	SettingsSelect,
	SettingsTableCard,
	SettingsTableFoot,
	SettingsTabs,
	settingsTableRows,
	settingsTd,
	settingsTh,
	StatCell,
	StatStrip,
} from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { authClient } from "@/lib/auth/client";
import { toOrgRole } from "@/lib/authz/org-access-control";
import { cn } from "@/lib/utils";

const ROLE_OPTIONS = ["admin", "operator", "viewer"] as const;
type Tab = "all" | "active" | "pending" | "suspended";

interface RowView {
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

/** An inline, borderless pill `<select>` for a member's role. */
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
		<div className="relative inline-flex">
			<select
				aria-label="Role"
				disabled={disabled}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="cursor-pointer appearance-none rounded-full border border-transparent bg-transparent py-[5px] pl-[10px] pr-6 text-[12px] font-medium text-text-primary transition-colors hover:border-border-strong hover:bg-surface-muted disabled:cursor-default disabled:opacity-50"
			>
				{ROLE_OPTIONS.map((ro) => (
					<option key={ro} value={ro}>
						{ro[0].toUpperCase() + ro.slice(1)}
					</option>
				))}
			</select>
			<ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-[11px] -translate-y-1/2 text-text-tertiary" />
		</div>
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

	function toggle(key: string) {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}

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
				<div className="mb-3 flex items-center justify-between gap-4 rounded-md border border-text-primary bg-surface-muted py-[9px] pl-4 pr-[14px]">
					<div className="flex items-center gap-3 text-[12.5px] text-text-primary">
						<span>
							<b className="font-semibold">{selected.size}</b> selected
						</span>
						<button
							type="button"
							className="font-mono text-[11px] text-text-tertiary hover:text-text-primary"
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

			{/* table */}
			<SettingsTableCard
				foot={
					<SettingsTableFoot>
						<span>
							Showing{" "}
							<b className="font-medium text-text-secondary">{filtered.length}</b> of{" "}
							{rows.length}
						</span>
					</SettingsTableFoot>
				}
			>
				<table className={settingsTableRows}>
					<thead>
						<tr>
							{canManage && <th className={cn(settingsTh, "w-[18px]")} />}
							<th className={settingsTh}>Member</th>
							<th className={settingsTh}>Role</th>
							<th className={settingsTh}>Teams</th>
							<th className={settingsTh}>Status</th>
							<th className={settingsTh}>Last active</th>
							<th className={settingsTh} />
						</tr>
					</thead>
					<tbody>
						{filtered.map((r) => (
							<tr key={r.key}>
								{canManage && (
									<td className={cn(settingsTd, "w-[18px]")}>
										<input
											type="checkbox"
											aria-label="Select"
											className="size-4 cursor-pointer accent-ink align-middle"
											checked={selected.has(r.key)}
											onChange={() => toggle(r.key)}
										/>
									</td>
								)}
								<td className={settingsTd}>
									<div className="flex items-center gap-[11px]">
										<span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface-muted font-mono text-[11px] text-text-secondary">
											{r.avatar}
										</span>
										<div className="flex min-w-0 flex-col gap-0.5">
											<span className="flex items-center gap-[7px] text-[13px] text-text-primary">
												{r.name}
												{r.isYou && (
													<span className="rounded-full border border-border px-[5px] py-px font-mono text-[8.5px] uppercase tracking-[0.08em] text-text-tertiary">
														You
													</span>
												)}
											</span>
											<span className="font-mono text-[10.5px] text-text-tertiary">
												{r.meta}
											</span>
										</div>
									</div>
								</td>
								<td className={settingsTd}>
									{r.kind === "member" && r.role === "owner" ? (
										<span className="inline-flex items-center gap-[7px] px-[10px] py-[5px] text-[12px] font-medium text-text-primary">
											<Shield size={13} className="text-text-tertiary" />
											Owner
										</span>
									) : r.kind === "member" && canManage ? (
										<RoleSelect
											value={r.role}
											disabled={r.status === "suspended"}
											onChange={(v) => void changeRole(r.refId, v)}
										/>
									) : (
										<span className="px-[10px] py-[5px] text-[12px] font-medium capitalize text-text-primary">
											{r.role}
										</span>
									)}
								</td>
								<td className={settingsTd}>
									<div className="flex flex-wrap gap-[5px]">
										{r.teams.length > 0 ? (
											r.teams.map((t) => (
												<span
													key={t}
													className="whitespace-nowrap rounded-full border border-border px-[7px] py-0.5 font-mono text-[10px] text-text-secondary"
												>
													{t}
												</span>
											))
										) : (
											<span className="rounded-full border border-dashed border-border px-[7px] py-0.5 font-mono text-[10px] text-text-disabled">
												No team
											</span>
										)}
									</div>
								</td>
								<td className={settingsTd}>
									<StatusBadge status={r.status} />
								</td>
								<td
									className={cn(
										settingsTd,
										"whitespace-nowrap font-mono text-[11px] text-text-tertiary",
									)}
								>
									{r.activity}
								</td>
								<td className={settingsTd}>
									{canManage && !(r.kind === "member" && r.role === "owner") && (
										<DropdownMenu>
											<DropdownMenuTrigger asChild>
												<button
													type="button"
													aria-label="Manage"
													className="inline-flex size-7 items-center justify-center rounded-sm text-text-disabled transition-colors hover:bg-surface-muted hover:text-text-primary"
												>
													<MoreHorizontal size={16} />
												</button>
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end" className="w-44">
												{r.kind === "member" ? (
													<>
														{r.status === "suspended" ? (
															<DropdownMenuItem
																onClick={() => void suspend(r.refId, false)}
															>
																Reactivate
															</DropdownMenuItem>
														) : (
															<DropdownMenuItem
																onClick={() => void suspend(r.refId, true)}
															>
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
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
				{filtered.length === 0 && (
					<div className="px-5 py-10 text-center text-[13px] text-text-tertiary">
						No members match these filters.
					</div>
				)}
			</SettingsTableCard>
		</div>
	);
}
