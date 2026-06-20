"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Plus, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { getTeams, type TeamRow } from "@/app/server/actions/teams";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { authClient } from "@/lib/auth/client";
import { ManageTeamDialog } from "./manage-team-dialog";

export function TeamsList() {
	const [teams, setTeams] = useState<TeamRow[] | null>(null);
	const [creating, setCreating] = useState(false);
	const [name, setName] = useState("");
	const [manage, setManage] = useState<TeamRow | null>(null);

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
		load();
	};

	return (
		<div className="space-y-3">
			<div className="flex justify-end">
				<Dialog open={creating} onOpenChange={setCreating}>
					<DialogTrigger asChild>
						<Button size="sm" className="gap-2">
							<Plus className="h-4 w-4" />
							New team
						</Button>
					</DialogTrigger>
					<DialogContent className="sm:max-w-sm">
						<DialogHeader>
							<DialogTitle>New team</DialogTitle>
							<DialogDescription>
								Group members so you can grant access to the whole team at once.
							</DialogDescription>
						</DialogHeader>
						<div className="space-y-1.5">
							<Label className="text-sm">Team name</Label>
							<Input
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="platform-team"
								autoFocus
							/>
						</div>
						<DialogFooter>
							<Button onClick={() => void create()} disabled={!name.trim()}>
								Create team
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</div>

			{teams === null ? (
				<Skeleton className="h-16 w-full" />
			) : teams.length === 0 ? (
				<p className="rounded-lg border border-dashed border-border/60 bg-muted/10 px-4 py-8 text-center text-sm text-muted-foreground">
					No teams yet. Create one to grant access to a group of members at once.
				</p>
			) : (
				<div className="space-y-2">
					{teams.map((t) => (
						<div
							key={t.id}
							className="flex items-center justify-between rounded-lg border border-border/50 bg-card px-4 py-3"
						>
							<div className="flex items-center gap-3">
								<div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
									<Users className="h-4 w-4" />
								</div>
								<div>
									<p className="text-sm font-medium text-foreground">{t.name}</p>
									<Badge variant="secondary" className="text-[10px]">
										{t.memberCount} member{t.memberCount === 1 ? "" : "s"}
									</Badge>
								</div>
							</div>
							<div className="flex items-center gap-1">
								<Button variant="outline" size="sm" onClick={() => setManage(t)}>
									Manage
								</Button>
								<Button
									variant="ghost"
									size="icon"
									className="h-8 w-8 text-destructive"
									onClick={() => void remove(t)}
								>
									<Trash2 className="h-4 w-4" />
									<span className="sr-only">Delete {t.name}</span>
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
		</div>
	);
}
