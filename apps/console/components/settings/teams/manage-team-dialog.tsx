"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { getMembers, type MemberRow } from "@/app/server/actions/members";
import { Combobox } from "@/components/settings/access/combobox";
import { Button } from "@repo/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import { authClient } from "@/lib/auth/client";

/** Add/remove org members on a team (Enterprise). */
export function ManageTeamDialog({
	teamId,
	teamName,
	open,
	onOpenChange,
	onChanged,
}: {
	teamId: string;
	teamName: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onChanged?: () => void;
}) {
	const [members, setMembers] = useState<MemberRow[]>([]);
	const [teamUserIds, setTeamUserIds] = useState<string[]>([]);
	const [selected, setSelected] = useState<string>("");

	const load = useCallback(async () => {
		const [orgMembers, res] = await Promise.all([
			getMembers(),
			authClient.organization.listTeamMembers({ query: { teamId } }),
		]);
		setMembers(orgMembers);
		setTeamUserIds((res.data ?? []).map((m) => m.userId));
	}, [teamId]);
	useEffect(() => {
		if (open) void load();
	}, [open, load]);

	const add = async () => {
		if (!selected) return;
		const { error } = await authClient.organization.addTeamMember({
			teamId,
			userId: selected,
		});
		if (error) {
			toast.error(error.message ?? "Couldn't add member");
			return;
		}
		setSelected("");
		await load();
		onChanged?.();
	};

	const remove = async (userId: string) => {
		const { error } = await authClient.organization.removeTeamMember({
			teamId,
			userId,
		});
		if (error) {
			toast.error(error.message ?? "Couldn't remove member");
			return;
		}
		await load();
		onChanged?.();
	};

	const nameFor = (userId: string) => {
		const m = members.find((x) => x.userId === userId);
		return m ? (m.name ?? m.email) : `${userId.slice(0, 8)}…`;
	};
	const addable = members
		.filter((m) => !teamUserIds.includes(m.userId))
		.map((m) => ({ value: m.userId, label: m.name ?? m.email }));

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{teamName} · members</DialogTitle>
					<DialogDescription>
						Add or remove organization members. Team-scoped grants reach everyone on
						the team.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-3">
					<div className="flex gap-2">
						<div className="flex-1">
							<Combobox
								options={addable}
								value={selected}
								onChange={setSelected}
								placeholder="Add a member…"
							/>
						</div>
						<Button size="sm" onClick={() => void add()} disabled={!selected}>
							Add
						</Button>
					</div>
					<div className="space-y-1">
						{teamUserIds.length === 0 ? (
							<p className="px-1 py-4 text-center text-sm text-muted-foreground">
								No members yet.
							</p>
						) : (
							teamUserIds.map((uid) => (
								<div
									key={uid}
									className="flex items-center justify-between rounded-md border border-border/40 px-3 py-2"
								>
									<span className="text-sm text-foreground">{nameFor(uid)}</span>
									<Button
										variant="ghost"
										size="icon"
										className="h-7 w-7 text-destructive"
										onClick={() => void remove(uid)}
									>
										<X className="h-4 w-4" />
										<span className="sr-only">Remove</span>
									</Button>
								</div>
							))
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
