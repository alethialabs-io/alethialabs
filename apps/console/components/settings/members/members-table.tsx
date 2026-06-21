"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Members — a faithful port of the authored claude.ai/design panel (stats +
// toolbar + table), wired to our stack: real members (getMembers, with team names) +
// pending invitations (getInvitations); inline role change, remove, invite, cancel.
// Tabs / search / role-filter are client-side. Suspended status + last-active are
// dropped (no backend); bulk = Remove only.

import { formatDistanceToNow } from "date-fns";
import { MoreHorizontal, Plus, Search, Shield } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	getInvitations,
	getMembers,
	type InvitationRow,
	type MemberRow,
} from "@/app/server/actions/members";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import { InviteMemberDialog } from "@/components/settings/members/invite-member-dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { authClient } from "@/lib/auth/client";
import { toOrgRole } from "@/lib/authz/org-access-control";
import styles from "@/components/settings/settings-design.module.css";

const ROLE_OPTIONS = ["admin", "operator", "viewer"] as const;
type Tab = "all" | "active" | "pending";

interface RowView {
	key: string;
	kind: "member" | "invite";
	refId: string;
	name: string;
	meta: string;
	avatar: string;
	role: string;
	teams: string[];
	status: "active" | "pending";
	joined: string;
	isYou: boolean;
}

function initials(s: string): string {
	return s.slice(0, 2).toUpperCase();
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
			status: "active",
			joined: formatDistanceToNow(new Date(m.joinedAt), { addSuffix: true }),
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
			joined: "— invited",
			isYou: false,
		}));
		return [...memberRows, ...inviteRows];
	}, [members, invites, myId]);

	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		return rows.filter((r) => {
			if (tab === "active" && r.status !== "active") return false;
			if (tab === "pending" && r.status !== "pending") return false;
			if (roleFilter !== "all" && r.role !== roleFilter) return false;
			if (q && !`${r.name} ${r.meta}`.toLowerCase().includes(q)) return false;
			return true;
		});
	}, [rows, tab, roleFilter, search]);

	const activeCount = members?.length ?? 0;
	const pendingCount = invites.length;

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
			<div className={styles.pageHead}>
				<span className="vx-eyebrow">Members</span>
				<h1>Members</h1>
				<p>
					People with access to this organization. Each member holds a built-in
					role; fine-grained grants are managed under Access.
				</p>
			</div>

			{/* stats */}
			<div className={styles.mStats}>
				<div className={styles.mStat}>
					<div className={styles.k}>Seats</div>
					<div className={styles.v}>
						<span className={styles.big}>{activeCount + pendingCount}</span>
						<span className={styles.sub}>used</span>
					</div>
				</div>
				<div className={styles.mStat}>
					<div className={styles.k}>Active</div>
					<div className={styles.v}>
						<span className={styles.big}>{activeCount}</span>
						<span className={styles.sub}>members</span>
					</div>
				</div>
				<div className={styles.mStat}>
					<div className={styles.k}>Pending invites</div>
					<div className={styles.v}>
						<span className={styles.big}>{pendingCount}</span>
						<span className={styles.sub}>awaiting</span>
					</div>
				</div>
			</div>

			{/* toolbar */}
			<div className={styles.mToolbar}>
				<div className={styles.tabs}>
					{(["all", "active", "pending"] as Tab[]).map((t) => (
						<button
							type="button"
							key={t}
							className={tab === t ? styles.on : undefined}
							onClick={() => setTab(t)}
						>
							<span className="capitalize">{t}</span>
							<span className={styles.ct}>
								{t === "all"
									? activeCount + pendingCount
									: t === "active"
										? activeCount
										: pendingCount}
							</span>
						</button>
					))}
				</div>
				<div className={styles.tools}>
					<div className={styles.search}>
						<Search size={15} />
						<input
							placeholder="Search name or email"
							autoComplete="off"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
						/>
					</div>
					<select
						className={`${styles.control} ${styles.mroleFilter} ${styles.mono}`}
						style={{ fontSize: "12px" }}
						value={roleFilter}
						onChange={(e) => setRoleFilter(e.target.value)}
					>
						<option value="all">All roles</option>
						<option value="owner">Owner</option>
						<option value="admin">Admin</option>
						<option value="operator">Operator</option>
						<option value="viewer">Viewer</option>
					</select>
					{canManage && (
						<InviteMemberDialog
							onInvited={load}
							trigger={
								<button
									type="button"
									className={`${styles.btn} ${styles.primary} ${styles.sm}`}
								>
									<Plus size={13} />
									Invite member
								</button>
							}
						/>
					)}
				</div>
			</div>

			{/* bulk bar */}
			{canManage && selected.size > 0 && (
				<div className={styles.bulkbar}>
					<div className={styles.l}>
						<span>
							<b style={{ fontWeight: 600 }}>{selected.size}</b> selected
						</span>
						<span
							className={styles.clr}
							onClick={() => setSelected(new Set())}
							onKeyDown={() => setSelected(new Set())}
						>
							Clear
						</span>
					</div>
					<div className={styles.r}>
						<button
							type="button"
							className={`${styles.btn} ${styles.sm} ${styles.ghost}`}
							onClick={() => void bulkRemove()}
						>
							Remove
						</button>
					</div>
				</div>
			)}

			{/* table */}
			<div className={`${styles.card} ${styles.mtable}`}>
				<div className={styles.scrollX}>
					<table className={styles.members}>
						<thead>
							<tr>
								{canManage && <th className={styles.checkcell} />}
								<th>Member</th>
								<th>Role</th>
								<th>Teams</th>
								<th>Status</th>
								<th>Joined</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{filtered.map((r) => (
								<tr key={r.key}>
									{canManage && (
										<td className={styles.checkcell}>
											<input
												type="checkbox"
												className={styles.cbx}
												aria-label="Select"
												checked={selected.has(r.key)}
												onChange={() => toggle(r.key)}
											/>
										</td>
									)}
									<td>
										<div className={styles.member}>
											<span className={styles.av}>{r.avatar}</span>
											<div className={styles.who}>
												<span className={styles.nm}>
													{r.name}
													{r.isYou && <span className={styles.me}>You</span>}
												</span>
												<span className={styles.em}>{r.meta}</span>
											</div>
										</div>
									</td>
									<td>
										{r.kind === "member" && r.role === "owner" ? (
											<span className={styles.roleStatic}>
												<Shield size={13} />
												Owner
											</span>
										) : r.kind === "member" && canManage ? (
											<select
												className={styles.roleSel}
												aria-label="Role"
												value={r.role}
												onChange={(e) => void changeRole(r.refId, e.target.value)}
											>
												{ROLE_OPTIONS.map((ro) => (
													<option key={ro} value={ro} className="capitalize">
														{ro[0].toUpperCase() + ro.slice(1)}
													</option>
												))}
											</select>
										) : (
											<span className={`${styles.roleStatic} capitalize`}>
												{r.role}
											</span>
										)}
									</td>
									<td>
										<div className={styles.teamChips}>
											{r.teams.length > 0 ? (
												r.teams.map((t) => (
													<span key={t} className={styles.chip}>
														{t}
													</span>
												))
											) : (
												<span className={`${styles.chip} ${styles.none}`}>
													No team
												</span>
											)}
										</div>
									</td>
									<td>
										<span className={`${styles.mstatus} ${styles[r.status]}`}>
											<span className={styles.s} />
											<span className="capitalize">{r.status}</span>
										</span>
									</td>
									<td className={styles.last}>{r.joined}</td>
									<td>
										{canManage && !(r.kind === "member" && r.role === "owner") && (
											<DropdownMenu>
												<DropdownMenuTrigger asChild>
													<button
														type="button"
														className={styles.kebab}
														aria-label="Manage"
													>
														<MoreHorizontal size={16} />
													</button>
												</DropdownMenuTrigger>
												<DropdownMenuContent align="end" className="w-44">
													{r.kind === "member" ? (
														<DropdownMenuItem
															className="text-destructive focus:text-destructive"
															onClick={() => void removeMember(r.refId)}
														>
															Remove from organization
														</DropdownMenuItem>
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
				</div>
				{filtered.length === 0 && (
					<div className={styles.empty}>No members match these filters.</div>
				)}
				<div className={styles.mfoot}>
					<span className={styles.count}>
						Showing <b style={{ color: "var(--text-secondary)", fontWeight: 500 }}>
							{filtered.length}
						</b>{" "}
						of {rows.length}
					</span>
				</div>
			</div>
		</div>
	);
}
