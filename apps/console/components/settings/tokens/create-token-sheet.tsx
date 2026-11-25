"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// "Create a service token" (AGT-L2 design §4): name, expiry, what it can do, its projects, and the
// environments it may deploy to without a person. A sheet over the list, as every manage flow in the
// console is. The token's plaintext exists once, in the action's answer, and is handed straight to
// the created dialog; nothing here keeps it.

import { zodResolver } from "@hookform/resolvers/zod";
import { useId, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { type CreatedServiceToken, createConsoleServiceToken } from "@/app/server/actions/agents/service-tokens";
import { FormRootError } from "@/components/forms/form-root-error";
import { settingsControl, settingsControlSize, SettingsSelect } from "@/components/settings/settings-ui";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { AGENT_SCOPES } from "@/lib/approvals/types";
import type { ServiceTokenEnvironmentRef } from "@/lib/queries/service-tokens";
import { Button } from "@repo/ui/button";
import { Checkbox } from "@repo/ui/checkbox";
import { DetailSheet } from "@repo/ui/detail-sheet";
import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";
import { CircleAlert } from "lucide-react";
import { AutoApprovePicker, type PickerChoices } from "./auto-approve-picker";
import { TokenNotice } from "./token-parts";
import { autoApprovableIds, SERVICE_TOKEN_READS, useTokenEnvironments } from "./token-reads";
import { DEFAULT_SCOPES, EXPIRY_CHOICES, expiryDays, SCOPE_TEXT } from "./token-vocab";

/** The create form's schema: what a person can submit, with the sentence each refusal reads as. */
const createTokenFormSchema = z
	.object({
		name: z.string().trim().min(1, "A token needs a name.").max(120, "Keep the name to 120 characters."),
		expires: z.enum(["30", "90", "365", "never"]),
		scopes: z.array(z.enum(AGENT_SCOPES)).min(1, "Choose at least one thing it can do."),
		projectMode: z.enum(["all", "some"]),
		projectIds: z.array(z.string()),
		autoApprove: z.array(z.string()),
	})
	.superRefine((value, ctx) => {
		if (value.projectMode === "some" && value.projectIds.length === 0) {
			ctx.addIssue({ code: "custom", path: ["projectIds"], message: "Choose at least one project." });
		}
	});

/** The create form's values. */
type CreateTokenForm = z.infer<typeof createTokenFormSchema>;

/** A fresh form: a token that can read, plan and ask to deploy, every project, 90 days. */
const BLANK: CreateTokenForm = {
	name: "",
	expires: "90",
	scopes: DEFAULT_SCOPES,
	projectMode: "all",
	projectIds: [],
	autoApprove: [],
};

/** The environments `ids` names, from the picker's choices, in project then environment order. */
function namedEnvironments(choices: PickerChoices, ids: readonly string[]): ServiceTokenEnvironmentRef[] {
	if (choices.state !== "ready" || ids.length === 0) return [];
	const wanted = new Set(ids);
	return choices.projects.flatMap((p) =>
		p.environments
			.filter((e) => wanted.has(e.id))
			.map((e) => ({ id: e.id, name: e.name, projectId: p.projectId, projectName: p.projectName, stage: e.stage })),
	);
}

/** The create sheet's inputs. */
export interface CreateTokenSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The viewer holds `org:manage_agents`: the picker is editable. */
	canManageAgents: boolean;
	/** Called once, after it is created, with the new token and its auto-approve environments named. */
	onCreated: (token: CreatedServiceToken, autoApprove: ServiceTokenEnvironmentRef[]) => void;
}

/** The "Create a service token" sheet. */
export function CreateTokenSheet({ open, onOpenChange, canManageAgents, onCreated }: CreateTokenSheetProps) {
	const ids = { name: useId(), nameHint: useId(), nameError: useId(), scope: useId(), scopesError: useId(), projectsError: useId() };
	const [refusal, setRefusal] = useState<string | null>(null);
	const form = useForm<CreateTokenForm>({ resolver: zodResolver(createTokenFormSchema), defaultValues: BLANK });
	const [scopes, projectMode, projectIds] = useWatch({ control: form.control, name: ["scopes", "projectMode", "projectIds"] });
	const canDeploy = scopes.includes("apply");
	const limitedTo = projectMode === "all" ? null : projectIds;
	const { choices, projects } = useTokenEnvironments(limitedTo, open);

	const create = useActionMutation(createConsoleServiceToken, {
		invalidates: SERVICE_TOKEN_READS,
		form: { instance: form, fields: ["name"] },
		onRefusal: (error) => setRefusal(error.message),
		closes: (next) => {
			form.reset(BLANK);
			onOpenChange(next);
		},
		onSuccess: (token) => onCreated(token, namedEnvironments(choices, token.autoApproveEnvironmentIds)),
	});

	const submit = form.handleSubmit((values) => {
		setRefusal(null);
		// Only what the picker could have produced: non-production environments of the chosen
		// projects, on a token that can Deploy, chosen by someone who manages agents. The server
		// checks all of it again.
		const offered = autoApprovableIds(choices);
		const autoApprove =
			canManageAgents && values.scopes.includes("apply") ? values.autoApprove.filter((id) => offered.has(id)) : [];
		create.submit({
			name: values.name,
			scopes: values.scopes,
			projectIds: values.projectMode === "all" ? null : values.projectIds,
			expiresInDays: expiryDays(values.expires),
			autoApproveEnvironmentIds: autoApprove,
		});
	});

	/** Closes the sheet, unless a create is in flight; a closed sheet forgets what was typed. */
	const handleOpenChange = (next: boolean) => {
		if (!next && create.isPending) return;
		if (!next) {
			setRefusal(null);
			form.reset(BLANK);
		}
		onOpenChange(next);
	};

	const errors = form.formState.errors;
	const nameError = errors.name?.message;

	return (
		<DetailSheet
			open={open}
			onOpenChange={handleOpenChange}
			className="w-full sm:max-w-[640px]"
			title="Create a service token"
			description="You'll see the token once, right after you create it."
			footer={
				<div className="flex w-full flex-col gap-3">
					{refusal ? (
						<div role="alert">
							<TokenNotice icon={<CircleAlert />} title="The token wasn't created">
								{refusal}
							</TokenNotice>
						</div>
					) : null}
					<FormRootError form={form} />
					<div className="flex justify-end gap-2">
						<Button type="button" variant="ghost" size="sm" disabled={create.isPending} onClick={() => handleOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" form="create-service-token" size="sm" disabled={create.isPending} aria-busy={create.isPending}>
							{create.isPending ? "Creating…" : "Create token"}
						</Button>
					</div>
				</div>
			}
		>
			<form id="create-service-token" noValidate onSubmit={(e) => void submit(e)} className="grid gap-6">
				<div className="grid gap-1.5">
					<label htmlFor={ids.name} className="text-ui-sm font-medium text-text-primary">
						Name
					</label>
					<input
						id={ids.name}
						className={cn(settingsControl, settingsControlSize)}
						placeholder="e.g. ci-deploy"
						autoComplete="off"
						aria-invalid={nameError ? true : undefined}
						aria-describedby={nameError ? `${ids.nameHint} ${ids.nameError}` : ids.nameHint}
						disabled={create.isPending}
						{...form.register("name")}
					/>
					<p id={ids.nameHint} className="text-ui-sm text-text-tertiary">
						Say what uses it, so a list of tokens reads as a list of purposes.
					</p>
					{nameError ? (
						<p id={ids.nameError} role="alert" className="text-ui-sm text-destructive">
							{nameError}
						</p>
					) : null}
				</div>

				<div className="grid gap-1.5">
					<span className="text-ui-sm font-medium text-text-primary" aria-hidden>
						Expires
					</span>
					<Controller
						control={form.control}
						name="expires"
						render={({ field }) => (
							<SettingsSelect
								aria-label="Expires"
								value={field.value}
								onChange={(v) => {
									const choice = EXPIRY_CHOICES.find((c) => c.value === v);
									if (choice) field.onChange(choice.value);
								}}
								options={EXPIRY_CHOICES.map((c) => ({ value: c.value, label: c.label }))}
							/>
						)}
					/>
				</div>

				<Controller
					control={form.control}
					name="scopes"
					render={({ field }) => (
						<fieldset className="grid gap-2" aria-describedby={errors.scopes ? ids.scopesError : undefined}>
							<legend className="mb-1 text-ui-sm font-medium text-text-primary">What it can do</legend>
							<ul className="overflow-hidden rounded-sm border border-border">
								{AGENT_SCOPES.map((scope) => {
									const labelId = `${ids.scope}-${scope}`;
									return (
										<li key={scope} className="border-b border-border last:border-b-0">
											<label className="flex cursor-pointer items-start gap-2.5 px-3 py-2.5">
												<Checkbox
													className="mt-0.5"
													checked={field.value.includes(scope)}
													aria-labelledby={labelId}
													aria-describedby={`${labelId}-why`}
													onCheckedChange={(next) => {
														const on = next === true;
														field.onChange(on ? [...field.value.filter((s) => s !== scope), scope] : field.value.filter((s) => s !== scope));
														// A token that cannot ask to deploy has no environments to deploy to.
														if (scope === "apply" && !on) form.setValue("autoApprove", []);
													}}
												/>
												<span className="min-w-0">
													<span id={labelId} className="block text-ui-md font-medium text-text-primary">
														{SCOPE_TEXT[scope].label}
													</span>
													<span id={`${labelId}-why`} className="block text-ui-sm text-text-tertiary">
														{SCOPE_TEXT[scope].description}
													</span>
												</span>
											</label>
										</li>
									);
								})}
							</ul>
							{errors.scopes?.message ? (
								<p id={ids.scopesError} role="alert" className="text-ui-sm text-destructive">
									{errors.scopes.message}
								</p>
							) : null}
						</fieldset>
					)}
				/>

				<fieldset className="grid gap-2" aria-describedby={errors.projectIds ? ids.projectsError : undefined}>
					<legend className="mb-1 text-ui-sm font-medium text-text-primary">Projects</legend>
					<div className="overflow-hidden rounded-sm border border-border">
						<label className="flex cursor-pointer items-start gap-2.5 border-b border-border px-3 py-2.5">
							<input
								type="radio"
								value="all"
								className="mt-1 size-3.5 accent-[var(--ink)]"
								{...form.register("projectMode")}
							/>
							<span>
								<span className="block text-ui-md font-medium text-text-primary">All projects</span>
								<span className="block text-ui-sm text-text-tertiary">Including projects created later.</span>
							</span>
						</label>
						<div className="px-3 py-2.5">
							<label className="flex cursor-pointer items-start gap-2.5">
								<input
									type="radio"
									value="some"
									className="mt-1 size-3.5 accent-[var(--ink)]"
									{...form.register("projectMode")}
								/>
								<span className="block text-ui-md font-medium text-text-primary">Only these projects</span>
							</label>
							{projectMode === "some" ? (
								<Controller
									control={form.control}
									name="projectIds"
									render={({ field }) =>
										projects === null ? (
											<div className="mt-2 flex gap-2 pl-6" aria-busy="true" aria-label="Loading projects">
												<Skeleton className="h-6 w-20" />
												<Skeleton className="h-6 w-24" />
											</div>
										) : projects.length === 0 ? (
											<p className="mt-2 pl-6 text-ui-sm text-text-tertiary">This organization has no projects yet.</p>
										) : (
											<ul className="mt-2 flex flex-wrap gap-2 pl-6" aria-label="Projects this token can use">
												{projects.map((project) => {
													const checked = field.value.includes(project.id);
													return (
														<li key={project.id}>
															<label className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-sm border border-border-strong px-2 text-ui-sm text-text-primary">
																<input
																	type="checkbox"
																	className="size-3.5 accent-[var(--ink)]"
																	checked={checked}
																	onChange={(e) => {
																		const next = e.target.checked
																			? [...field.value.filter((id) => id !== project.id), project.id]
																			: field.value.filter((id) => id !== project.id);
																		field.onChange(next);
																		// Unticking a project removes its environments from the selection.
																		if (!e.target.checked && choices.state === "ready") {
																			const gone = new Set(
																				choices.projects
																					.find((p) => p.projectId === project.id)
																					?.environments.map((env) => env.id) ?? [],
																			);
																			form.setValue(
																				"autoApprove",
																				form.getValues("autoApprove").filter((id) => !gone.has(id)),
																			);
																		}
																	}}
																/>
																{project.name}
															</label>
														</li>
													);
												})}
											</ul>
										)
									}
								/>
							) : null}
						</div>
					</div>
					{errors.projectIds?.message ? (
						<p id={ids.projectsError} role="alert" className="text-ui-sm text-destructive">
							{errors.projectIds.message}
						</p>
					) : null}
				</fieldset>

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
							noProjectChosen={projectMode === "some" && projectIds.length === 0}
						/>
					)}
				/>
			</form>
		</DetailSheet>
	);
}
