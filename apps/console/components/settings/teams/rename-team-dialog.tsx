"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Rename one team (R6 E-14). A short form, so a dialog — the Create team panel's one field, with
// the same schema. The write is Better Auth's `updateTeam`, through `useActionMutation`: pending
// while in flight (the double-submit guard), a refusal shown in the dialog beside the field rather
// than in a toast that is gone while the name is still in the box, and every members read
// invalidated when it settles. The dialog closes only once the rename has succeeded.

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useId, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import type { TeamRow } from "@/app/server/actions/teams";
import { viaAuth } from "@/components/settings/members/auth-action";
import { settingsControl, settingsControlSize } from "@/components/settings/settings-ui";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { authClient } from "@/lib/auth/client";
import { orpc } from "@/lib/rpc/client";
import { Button } from "@repo/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import { cn } from "@repo/ui/utils";

/** A team's name: what Create team and Rename team both validate. */
export const teamNameSchema = z.object({
	name: z.string().trim().min(1, "Name the team").max(120, "Use 120 characters or fewer"),
});
export type TeamNameInput = z.infer<typeof teamNameSchema>;

/** Every read that shows a team's name: the teams page and the member lists' team chips. */
const TEAM_READS = [orpc.members.key()];

/** The rename dialog for `team`; `team` null means closed. */
export function RenameTeamDialog({
	team,
	onOpenChange,
}: {
	team: TeamRow | null;
	onOpenChange: (open: boolean) => void;
}) {
	const nameId = useId();
	const errorId = useId();
	const [refusal, setRefusal] = useState<string | null>(null);
	const form = useForm<TeamNameInput>({
		resolver: zodResolver(teamNameSchema),
		defaultValues: { name: team?.name ?? "" },
	});

	// Each opening starts from the team's current name and no stale refusal.
	const teamId = team?.id ?? null;
	const teamName = team?.name ?? "";
	useEffect(() => {
		if (teamId !== null) form.reset({ name: teamName });
	}, [teamId, teamName, form]);

	const rename = useActionMutation(
		({ id, name }: { id: string; name: string }) =>
			viaAuth(() => authClient.organization.updateTeam({ teamId: id, data: { name } })),
		{
			invalidates: TEAM_READS,
			successMessage: "Team renamed",
			closes: onOpenChange,
			onRefusal: (error) => setRefusal(error.message),
		},
	);

	const submit = form.handleSubmit(({ name }) => {
		if (!team) return;
		setRefusal(null);
		// Nothing changed: there is nothing to send, and closing is the honest answer.
		if (name === team.name) {
			onOpenChange(false);
			return;
		}
		rename.submit({ id: team.id, name });
	});

	const fieldError = form.formState.errors.name?.message ?? refusal ?? undefined;

	return (
		<Dialog
			open={team !== null}
			onOpenChange={(next) => {
				if (!next && rename.isPending) return;
				if (!next) setRefusal(null);
				onOpenChange(next);
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Rename team</DialogTitle>
					<DialogDescription>
						Grants made to the team stay with it; only the name people see changes.
					</DialogDescription>
				</DialogHeader>
				<form noValidate onSubmit={(e) => void submit(e)} className="grid gap-4">
					<div className="grid gap-1.5">
						<label htmlFor={nameId} className="text-ui-xs text-text-tertiary">
							Team name
						</label>
						<input
							id={nameId}
							className={cn(settingsControl, settingsControlSize)}
							autoComplete="off"
							aria-invalid={fieldError ? true : undefined}
							aria-describedby={fieldError ? errorId : undefined}
							disabled={rename.isPending}
							{...form.register("name")}
						/>
						{fieldError && (
							<p id={errorId} role="alert" className="text-ui-xs text-destructive">
								{fieldError}
							</p>
						)}
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={rename.isPending}
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button type="submit" size="sm" disabled={rename.isPending} aria-busy={rename.isPending}>
							{rename.isPending ? "Saving…" : "Save name"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
