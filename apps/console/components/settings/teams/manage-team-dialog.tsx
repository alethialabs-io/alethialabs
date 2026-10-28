"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The roster of one team (#6129). Who is ON the team comes from the team's own row in the teams
// list (`members.teams`, which the page already holds and which a `members` hint refreshes), and
// who can be ADDED from the org's member list (`members.list`) — both GET reads, so the dialog no
// longer fetches into local state on open. Adding and removing go to Better Auth's organization
// endpoints through `useActionMutation`: each is pending while in flight, and every members read
// is invalidated when it settles, which is what refreshes the row this dialog renders from.

import { X } from "lucide-react";
import { useState } from "react";
import type { TeamRow } from "@/app/server/actions/teams";
import { Combobox } from "@/components/settings/access/combobox";
import { ConfirmDialog } from "@/components/alerts/confirm-dialog";
import { viaAuth } from "@/components/settings/members/auth-action";
import { Button } from "@repo/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { authClient } from "@/lib/auth/client";
import { useMembersQuery } from "@/lib/query/use-activity-query";
import { orpc } from "@/lib/rpc/client";

/** Every read a roster change shows in: the teams list, the members table's team chips. */
const ROSTER_READS = [orpc.members.key()];

/** Add/remove org members on a team (Enterprise). */
export function ManageTeamDialog({
	team,
	open,
	onOpenChange,
}: {
	/** The team, as the teams list currently holds it (its members included). */
	team: TeamRow;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { data: members = [] } = useMembersQuery();
	const [selected, setSelected] = useState<string>("");
	// The user whose removal from this team has been asked for but not yet confirmed. Removing a
	// team member drops every team-scoped grant that reached them through it, so the row's X opens
	// a confirmation rather than the mutation (registry: `teams.member.remove`).
	const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
	// The name the confirmation is RENDERING, which outlives `pendingRemoval` by one close: the
	// dialog stays mounted and is driven by `open`, so it still renders for the length of its exit
	// transition, and a description derived from the cleared id would blank out mid-fade.
	const [pendingName, setPendingName] = useState<string>("");

	const add = useActionMutation(
		({ userId }: { userId: string }) =>
			viaAuth(() => authClient.organization.addTeamMember({ teamId: team.id, userId })),
		{ invalidates: ROSTER_READS, onSuccess: () => setSelected("") },
	);
	const remove = useActionMutation(
		({ userId }: { userId: string }) =>
			viaAuth(() => authClient.organization.removeTeamMember({ teamId: team.id, userId })),
		{ invalidates: ROSTER_READS, successMessage: "Removed from the team" },
	);
	const removingUserId = remove.isPending ? remove.variables?.userId : undefined;

	const teamUserIds = team.members.map((m) => m.userId);
	const nameFor = (userId: string) => {
		const m = members.find((x) => x.userId === userId);
		if (m) return m.name ?? m.email;
		return team.members.find((x) => x.userId === userId)?.name ?? `${userId.slice(0, 8)}…`;
	};

	/** Ask before removing: records who, and the copy the confirmation will keep through its close. */
	const askToRemove = (userId: string) => {
		setPendingName(nameFor(userId));
		setPendingRemoval(userId);
	};
	const addable = members
		.filter((m) => !teamUserIds.includes(m.userId))
		.map((m) => ({ value: m.userId, label: m.name ?? m.email }));
	const teamName = team.name;

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
		    moment the confirmation is answered either way (the removal invalidates the teams list the roster is read from,
		    so the list it returns to is the one the answer produced). */}
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
						<Button
							size="sm"
							onClick={() => add.mutate({ userId: selected })}
							disabled={!selected || add.isPending}
						>
							{add.isPending ? "Adding…" : "Add"}
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
										disabled={removingUserId === uid}
										aria-busy={removingUserId === uid || undefined}
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
				if (pendingRemoval) remove.mutate({ userId: pendingRemoval });
			}}
		/>
		</>
	);
}
