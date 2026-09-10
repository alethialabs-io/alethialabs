"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { getMembers, type MemberRow } from "@/app/server/actions/members";
import { Combobox } from "@/components/settings/access/combobox";
import { ConfirmDialog } from "@/components/alerts/confirm-dialog";
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
	// The user whose removal from this team has been asked for but not yet confirmed. Removing a
	// team member drops every team-scoped grant that reached them through it, so the row’s X opens
	// a confirmation rather than the mutation (registry: `teams.member.remove`).
	const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
	// The name the confirmation is RENDERING, which outlives `pendingRemoval` by one close: the
	// dialog stays mounted and is driven by `open`, so it still renders for the length of its exit
	// transition, and a description derived from the cleared id would blank out mid-fade.
	const [pendingName, setPendingName] = useState<string>("");

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

	/** Ask before removing: records who, and the copy the confirmation will keep through its close. */
	const askToRemove = (userId: string) => {
		setPendingName(nameFor(userId));
		setPendingRemoval(userId);
	};
	const addable = members
		.filter((m) => !teamUserIds.includes(m.userId))
		.map((m) => ({ value: m.userId, label: m.name ?? m.email }));

	return (
		<>
		{/* THE TEAM DIALOG CLOSES WHILE THE CONFIRMATION IS UP, and that is the whole mechanism.
		    An earlier version of this file moved the `ConfirmDialog` from a JSX child of `<Dialog>`
		    to its sibling and claimed that fixed which popup a `[role=dialog]`-style lookup binds.
		    It does not: base-ui's `Dialog.Portal` and `AlertDialog.Portal` each append their
		    container to `document.body` at mount, a CSS selector list returns matches in DOCUMENT
		    order, and the team dialog mounts first either way — so `.first()` still landed on the
		    OUTER dialog and `e2e/audit/destructive.spec.ts` would have looked for "Remove from team"
		    inside a dialog that only holds the row's "Remove". Re-parenting in JSX changes nothing
		    about portal order; not being open at the same time does.
		    It is also the better of the two shapes on its own merits — one modal at a time, with the
		    question that needs answering the only thing on screen — and the team dialog comes back the
		    moment the confirmation is answered either way (`remove` reloads the roster itself, so the
		    list it returns to is the one the answer produced). */}
		<Dialog open={open && pendingRemoval === null} onOpenChange={onOpenChange}>
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
										onClick={() => askToRemove(uid)}
									>
										<X className="h-4 w-4" />
										<span className="sr-only">Remove {nameFor(uid)}</span>
									</Button>
								</div>
							))
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
		{/* MOUNTED, and driven by `open` — the shape the console's other six `ConfirmDialog` call
		    sites use. The pending user id is still the single source of open state; what conditional
		    mounting cost was the close, because `onOpenChange(false)` clears it in the same tick and
		    the base-ui `AlertDialog.Root` was then torn out while still `open`: no exit transition,
		    and focus with nothing to return to.
		    `confirmLabel` is "Remove from team", not "Remove": the row’s own button is already called
		    that, and a confirm button repeating its trigger’s label leaves the destructive-action
		    spec with two matches on one page and therefore no attributable verdict. */}
		<ConfirmDialog
			open={pendingRemoval !== null}
			onOpenChange={(next) => {
				if (!next) setPendingRemoval(null);
			}}
			title="Remove this team member?"
			description={`${pendingName} leaves ${teamName}. Every grant that reached them through this team stops applying; their organization membership and role are untouched.`}
			confirmLabel="Remove from team"
			onConfirm={() => {
				if (pendingRemoval) void remove(pendingRemoval);
			}}
		/>
		</>
	);
}
