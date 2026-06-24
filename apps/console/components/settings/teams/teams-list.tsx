"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Teams — the authored claude.ai/design card grid, composed from the shared
// settings primitives. Wired to the real backend: getTeams (name + members) + better-auth
// createTeam/removeTeam + ManageTeamDialog (add/remove members). The design's per-team
// description, stored slug, zone-access chips and role-tag have no backend yet — omitted
// and tracked in dataroom/spec/features/settings-design-port.md.

import { MoreHorizontal, Plus, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { getTeams, type TeamRow } from "@/app/server/actions/teams";
import {
	SettingsSearch,
	settingsControl,
	settingsControlSize,
	StatCell,
	StatStrip,
} from "@/components/settings/settings-ui";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { authClient } from "@/lib/auth/client";
import { cn } from "@/lib/utils";
import { ManageTeamDialog } from "./manage-team-dialog";

function monogram(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (!parts.length) return "TM";
	return ((parts[0][0] ?? "") + (parts[1]?.[0] ?? parts[0][1] ?? "")).toUpperCase();
}
function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function TeamsList() {
	const [teams, setTeams] = useState<TeamRow[] | null>(null);
	const [creating, setCreating] = useState(false);
	const [name, setName] = useState("");
	const [search, setSearch] = useState("");
	const [manage, setManage] = useState<TeamRow | null>(null);
	const [deleting, setDeleting] = useState<TeamRow | null>(null);

	const load = useCallback(() => {
		getTeams()
			.then(setTeams)
			.catch(() => setTeams([]));
	}, []);
	useEffect(() => {
		load();
	}, [load]);

	const create = async () => {
		if (!name.trim()) return;
		const { error } = await authClient.organization.createTeam({ name: name.trim() });
		if (error) {
			toast.error(error.message ?? "Couldn't create team");
			return;
		}
		toast.success("Team created");
		setName("");
		setCreating(false);
		load();
	};

	const remove = async (t: TeamRow) => {
		const { error } = await authClient.organization.removeTeam({ teamId: t.id });
		if (error) {
			toast.error(error.message ?? "Couldn't delete team");
			return;
		}
		toast.success("Team deleted");
		setDeleting(null);
		load();
	};

	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		return (teams ?? []).filter((t) => t.name.toLowerCase().includes(q));
	}, [teams, search]);

	const stats = useMemo(() => {
		const list = teams ?? [];
		const distinct = new Set(list.flatMap((t) => t.members.map((m) => m.userId)));
		const largest = list.reduce<TeamRow | null>(
			(a, b) => (a && a.memberCount >= b.memberCount ? a : b),
			null,
		);
		return { count: list.length, grouped: distinct.size, largest };
	}, [teams]);

	if (teams === null) {
		return (
			<div className="space-y-4">
				<Skeleton className="h-20 w-full" />
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}

	return (
		<div>
			{teams.length > 0 && (
				<StatStrip>
					<StatCell label="Teams" value={stats.count} sub="active" />
					<StatCell label="Members grouped" value={stats.grouped} sub="across teams" />
					<StatCell
						label="Largest team"
						value={stats.largest?.memberCount ?? 0}
						sub={stats.largest?.name}
					/>
				</StatStrip>
			)}

			{/* toolbar */}
			<div className="mb-[14px] flex flex-wrap items-center justify-between gap-4">
				<SettingsSearch
					value={search}
					onChange={setSearch}
					placeholder="Search teams"
					className="w-[240px]"
				/>
				<Button size="sm" onClick={() => setCreating((v) => !v)}>
					<Plus size={13} />
					Create team
				</Button>
			</div>

			{/* inline create panel */}
			{creating && (
				<div className="mb-4 rounded-lg border border-border bg-surface p-4 shadow-sm">
					<p className="mb-3 text-[13px] font-medium text-text-primary">New team</p>
					<div className="flex flex-col gap-3 sm:flex-row sm:items-end">
						<div className="flex-1">
							<label
								htmlFor="team-name"
								className="mb-1.5 block text-[11.5px] text-text-tertiary"
							>
								Team name
							</label>
							<input
								id="team-name"
								className={cn(settingsControl, settingsControlSize)}
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="e.g. Networking"
								autoComplete="off"
								autoFocus
							/>
						</div>
						<div className="flex gap-2">
							<Button
								variant="ghost"
								size="sm"
								onClick={() => {
									setCreating(false);
									setName("");
								}}
							>
								Cancel
							</Button>
							<Button size="sm" disabled={!name.trim()} onClick={() => void create()}>
								Create team
							</Button>
						</div>
					</div>
				</div>
			)}

			{/* grid */}
			{filtered.length === 0 ? (
				<div className="rounded-lg border border-dashed border-border bg-surface-sunken px-6 py-12 text-center">
					<Users className="mx-auto mb-3 size-5 text-text-tertiary" />
					<p className="text-[13px] text-text-tertiary">
						{teams.length === 0
							? "No teams yet. Create one to grant access to a group of members at once."
							: "No teams match your search."}
					</p>
				</div>
			) : (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{filtered.map((t) => (
						<div
							key={t.id}
							className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-sm"
						>
							<div className="flex items-start justify-between gap-2">
								<div className="flex min-w-0 items-center gap-3">
									<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-ink font-display text-[13px] font-semibold text-ink-foreground">
										{monogram(t.name)}
									</span>
									<div className="flex min-w-0 flex-col">
										<span className="truncate text-[14px] font-medium text-text-primary">
											{t.name}
										</span>
										<span className="font-mono text-[10.5px] text-text-tertiary">
											{slugify(t.name)}
										</span>
									</div>
								</div>
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<button
											type="button"
											aria-label="Manage team"
											className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-text-disabled transition-colors hover:bg-surface-muted hover:text-text-primary"
										>
											<MoreHorizontal size={16} />
										</button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="w-44">
										<DropdownMenuItem onClick={() => setManage(t)}>
											Manage members
										</DropdownMenuItem>
										<DropdownMenuItem
											className="text-destructive focus:text-destructive"
											onClick={() => setDeleting(t)}
										>
											Delete team
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							</div>

							<div className="flex items-center gap-3">
								{t.members.length > 0 ? (
									<div className="flex -space-x-2">
										{t.members.slice(0, 4).map((m) => (
											<span
												key={m.userId}
												className="flex size-7 items-center justify-center rounded-full border-2 border-surface bg-surface-muted font-mono text-[10px] text-text-secondary"
											>
												{m.initials}
											</span>
										))}
										{t.members.length > 4 && (
											<span className="flex size-7 items-center justify-center rounded-full border-2 border-surface bg-surface-sunken font-mono text-[10px] text-text-tertiary">
												+{t.members.length - 4}
											</span>
										)}
									</div>
								) : (
									<span className="font-mono text-[11px] text-text-disabled">
										No members yet
									</span>
								)}
							</div>

							<div className="mt-auto flex items-center justify-between border-t border-border pt-3">
								<span className="font-mono text-[11px] text-text-tertiary">
									{t.memberCount} member{t.memberCount === 1 ? "" : "s"}
								</span>
								<Button variant="outline" size="sm" onClick={() => setManage(t)}>
									Manage
								</Button>
							</div>
						</div>
					))}
				</div>
			)}

			{manage && (
				<ManageTeamDialog
					teamId={manage.id}
					teamName={manage.name}
					open={manage !== null}
					onOpenChange={(o) => !o && setManage(null)}
					onChanged={load}
				/>
			)}

			<AlertDialog
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete this team?</AlertDialogTitle>
						<AlertDialogDescription>
							This removes the team and its membership. Grants made to the team are
							revoked. Members keep their own roles. This cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => deleting && void remove(deleting)}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							Delete team
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
