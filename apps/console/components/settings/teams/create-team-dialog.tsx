"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Create one team (R6 E-20). A one-field form, so a dialog — the shape Rename team, Invite member
// and every other short create in Settings takes. It used to be an inline panel that pushed the
// table down, the only "create" on its sibling pages that was. Same schema as Rename; the write is
// Better Auth's `createTeam` through `useActionMutation`, so a refusal shows beside the field and
// the dialog closes only once the team exists.

import { zodResolver } from "@hookform/resolvers/zod";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
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
import { type TeamNameInput, teamNameSchema } from "./rename-team-dialog";

/** Every read that lists teams: the teams page and the member lists' team chips. */
const TEAM_READS = [orpc.members.key()];

/** The Create team dialog, opened and closed by its caller. */
export function CreateTeamDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const nameId = useId();
	const errorId = useId();
	const [refusal, setRefusal] = useState<string | null>(null);
	const form = useForm<TeamNameInput>({
		resolver: zodResolver(teamNameSchema),
		defaultValues: { name: "" },
	});

	const create = useActionMutation(
		({ name }: TeamNameInput) => viaAuth(() => authClient.organization.createTeam({ name })),
		{
			invalidates: TEAM_READS,
			successMessage: "Team created",
			closes: (next) => {
				form.reset({ name: "" });
				onOpenChange(next);
			},
			onRefusal: (error) => setRefusal(error.message),
		},
	);

	const submit = form.handleSubmit((values) => {
		setRefusal(null);
		create.submit(values);
	});

	const fieldError = form.formState.errors.name?.message ?? refusal ?? undefined;

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next && create.isPending) return;
				if (!next) {
					setRefusal(null);
					form.reset({ name: "" });
				}
				onOpenChange(next);
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Create team</DialogTitle>
					<DialogDescription>
						Grant access to a group of members at once. Add members after it is created.
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
							placeholder="e.g. Networking"
							autoComplete="off"
							aria-invalid={fieldError ? true : undefined}
							aria-describedby={fieldError ? errorId : undefined}
							disabled={create.isPending}
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
							disabled={create.isPending}
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button type="submit" size="sm" disabled={create.isPending} aria-busy={create.isPending}>
							{create.isPending ? "Creating…" : "Create team"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
