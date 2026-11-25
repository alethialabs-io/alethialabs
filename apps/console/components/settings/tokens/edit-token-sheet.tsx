"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// "Edit <token>" (AGT-L2 design §4, state "Edit environments"): the one thing about a token that can
// change after it is minted is the list of environments it deploys to without a person. Its name,
// scopes and projects are shown read-only, because no write exists for them — "To change what it
// can do, create a new token." The token itself does not change, so pipelines using it keep working.

import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { updateServiceTokenAutoApprove } from "@/app/server/actions/agents/service-tokens";
import { FormRootError } from "@/components/forms/form-root-error";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import type { ServiceTokenListItem } from "@/lib/queries/service-tokens";
import { Button } from "@repo/ui/button";
import { DetailSheet } from "@repo/ui/detail-sheet";
import { StatusBadge } from "@repo/ui/status-badge";
import { CircleAlert } from "lucide-react";
import { AutoApprovePicker } from "./auto-approve-picker";
import { TokenNotice } from "./token-parts";
import { autoApprovableIds, SERVICE_TOKEN_READS, useTokenEnvironments } from "./token-reads";
import { scopeWords, TOKEN_STATUS } from "./token-vocab";

/** The edit form's schema: the environment list alone. */
const editTokenFormSchema = z.object({ autoApprove: z.array(z.string()) });

/** The edit form's values. */
type EditTokenForm = z.infer<typeof editTokenFormSchema>;

/** The edit sheet's inputs. */
export interface EditTokenSheetProps {
	/** The token being edited; null while the sheet is closed. */
	token: ServiceTokenListItem | null;
	onOpenChange: (open: boolean) => void;
	/** The viewer holds `org:manage_agents`: the picker is editable and the sheet can save. */
	canManageAgents: boolean;
}

/**
 * The "Edit <token>" sheet. It keeps showing the last token while it slides closed, and starts a
 * fresh form for each token opened (the body is keyed on the token's id), so one token's unsaved
 * choices never carry over to the next.
 */
export function EditTokenSheet({ token, onOpenChange, canManageAgents }: EditTokenSheetProps) {
	const [shown, setShown] = useState(token);
	if (token !== null && token !== shown) setShown(token);
	return (
		<EditTokenSheetBody
			key={shown?.id ?? "none"}
			token={shown}
			open={token !== null}
			onOpenChange={onOpenChange}
			canManageAgents={canManageAgents}
		/>
	);
}

/** The sheet itself, for one token. */
function EditTokenSheetBody({
	token,
	open,
	onOpenChange,
	canManageAgents,
}: {
	token: ServiceTokenListItem | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	canManageAgents: boolean;
}) {
	const [refusal, setRefusal] = useState<string | null>(null);
	const form = useForm<EditTokenForm>({
		resolver: zodResolver(editTokenFormSchema),
		defaultValues: { autoApprove: token?.autoApproveEnvironmentIds ?? [] },
	});
	const { choices } = useTokenEnvironments(token?.projectIds ?? null, open);

	const save = useActionMutation(updateServiceTokenAutoApprove, {
		invalidates: SERVICE_TOKEN_READS,
		form: { instance: form, fields: [] },
		onRefusal: (error) => setRefusal(error.message),
		successMessage: "Saved. Recorded in Activity.",
		closes: (next) => onOpenChange(next),
	});

	const submit = form.handleSubmit((values) => {
		if (!token) return;
		setRefusal(null);
		const offered = autoApprovableIds(choices);
		save.submit({ tokenId: token.id, environmentIds: values.autoApprove.filter((id) => offered.has(id)) });
	});

	/** Closes the sheet, unless a save is in flight. */
	const handleOpenChange = (next: boolean) => {
		if (!next && save.isPending) return;
		onOpenChange(next);
	};

	const canDeploy = token?.scopes.includes("apply") ?? false;
	const canSave = canManageAgents && canDeploy;
	const status = token ? TOKEN_STATUS[token.status] : null;

	return (
		<DetailSheet
			open={open}
			onOpenChange={handleOpenChange}
			className="w-full sm:max-w-[640px]"
			title={token ? `Edit ${token.name}` : "Edit token"}
			description="The token itself doesn't change. Pipelines using it keep working."
			badge={token && status ? <StatusBadge status={token.status} tier={status.tier} label={status.label} /> : undefined}
			footer={
				<div className="flex w-full flex-col gap-3">
					{refusal ? (
						<div role="alert">
							<TokenNotice icon={<CircleAlert />} title="Nothing was changed">
								{refusal}
							</TokenNotice>
						</div>
					) : null}
					<FormRootError form={form} />
					<div className="flex justify-end gap-2">
						{canSave ? (
							<>
								<Button type="button" variant="ghost" size="sm" disabled={save.isPending} onClick={() => handleOpenChange(false)}>
									Cancel
								</Button>
								<Button type="submit" form="edit-service-token" size="sm" disabled={save.isPending} aria-busy={save.isPending}>
									{save.isPending ? "Saving…" : "Save changes"}
								</Button>
							</>
						) : (
							<Button type="button" variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
								Done
							</Button>
						)}
					</div>
				</div>
			}
		>
			{token ? (
				<form id="edit-service-token" noValidate onSubmit={(e) => void submit(e)} className="grid gap-6">
					<dl className="grid gap-3 text-ui-md sm:grid-cols-[140px_1fr]">
						<dt className="text-text-tertiary">Token</dt>
						<dd className="font-mono text-text-primary">{token.tokenPrefix}…</dd>
						<dt className="text-text-tertiary">What it can do</dt>
						<dd className="text-text-primary">{scopeWords(token.scopes)}</dd>
						<dt className="text-text-tertiary">Projects</dt>
						<dd className="text-text-primary">
							{token.projects === null ? "All projects" : token.projects.map((p) => p.name).join(", ") || "—"}
						</dd>
					</dl>
					<p className="-mt-3 text-ui-sm text-text-tertiary">To change what it can do, create a new token.</p>
					<Controller
						control={form.control}
						name="autoApprove"
						render={({ field }) => (
							<AutoApprovePicker
								choices={choices}
								value={field.value}
								onChange={field.onChange}
								canDeploy={canDeploy}
								canManageAgents={canManageAgents}
								editing
							/>
						)}
					/>
				</form>
			) : null}
		</DetailSheet>
	);
}
