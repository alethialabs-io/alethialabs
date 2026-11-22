"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@repo/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@repo/ui/form";
import { Input } from "@repo/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { cn } from "@repo/ui/utils";
import { Copy, FileStack } from "lucide-react";
import { useEffect, useId } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { addEnvironment, duplicateEnvironment } from "@/app/server/actions/projects";
import type { SwitcherEnv } from "@/app/server/actions/resolve";
import { FormRootError } from "@/components/forms/form-root-error";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { ENVIRONMENT_STAGES } from "@/lib/queries/environments";
import { orpc } from "@/lib/rpc/client";
import { stageLabel } from "./environment-status";
import { settleFieldRefusal } from "./settle-action";

/** Docs entry for the "Learn more" link in the dialog header. */
const ENV_DOCS_HREF = "/docs/concepts/domain-model#environments";

/**
 * What the dialog collects. A duplicate names its base and takes the base's stage; an empty
 * environment names its own stage — it used to be created as Development whatever it was called.
 */
export const newEnvironmentSchema = z
	.object({
		name: z.string().trim().min(1, "Environment name is required"),
		mode: z.enum(["duplicate", "empty"]),
		baseId: z.string(),
		stage: z.enum(ENVIRONMENT_STAGES),
	})
	.superRefine((value, ctx) => {
		if (value.mode === "duplicate" && value.baseId === "") {
			ctx.addIssue({ code: "custom", path: ["baseId"], message: "Pick an environment to duplicate" });
		}
	});

/** The dialog's form values. */
export type NewEnvironmentValues = z.infer<typeof newEnvironmentSchema>;

/**
 * The "New Environment" dialog, hosted by the Environments page and the env switcher. Collects a
 * name and a creation mode: **Duplicate** (copy an existing environment's services, variables and
 * configuration — choose the base) or **Empty** (a fresh environment with nothing in it, at a stage
 * you choose). On success it calls `onCreated` with the new environment's name so the caller can
 * navigate to it.
 *
 * A real form (react-hook-form + zod): Enter submits it, a missing name or base is said under its
 * field, and the create goes through the mutation contract (`useActionMutation`, ADR 0005 D4) — the
 * button is disabled while it is in flight (the double-submit guard), a name the server refuses
 * lands under the name field, and a created environment invalidates every read that lists
 * environments (the topbar switcher and the Environments page), so both show it at once.
 */
export function NewEnvironmentDialog({
	open,
	onOpenChange,
	projectId,
	envs,
	defaultBaseId,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	/** The project the new environment belongs to. */
	projectId: string;
	/** The project's existing environments — the Duplicate base options. */
	envs: SwitcherEnv[];
	/** When opened via an environment's "Duplicate" action, preselects it as the base. */
	defaultBaseId?: string;
	/** Called with the created environment's name after a successful create. */
	onCreated: (name: string) => void | Promise<void>;
}) {
	// `@repo/ui/select`'s trigger is a `<button role="combobox">`, so a label names it only if
	// something associates the two (#4630).
	const baseLabelId = useId();
	const stageLabelId = useId();
	const seedBaseId = defaultBaseId ?? (envs.find((e) => e.is_default) ?? envs[0])?.id ?? "";

	const form = useForm<NewEnvironmentValues>({
		resolver: zodResolver(newEnvironmentSchema),
		defaultValues: { name: "", mode: "duplicate", baseId: seedBaseId, stage: "development" },
	});
	const mode = useWatch({ control: form.control, name: "mode" });

	// Each opening starts from the defaults, seeded with the environment it was opened to duplicate.
	const { reset } = form;
	useEffect(() => {
		if (open) reset({ name: "", mode: "duplicate", baseId: seedBaseId, stage: "development" });
	}, [open, seedBaseId, reset]);

	const create = useActionMutation(
		(values: NewEnvironmentValues) =>
			settleFieldRefusal(async () => {
				const res =
					values.mode === "duplicate"
						? await duplicateEnvironment(projectId, values.baseId, values.name)
						: await addEnvironment(projectId, { name: values.name, stage: values.stage });
				if (!res.ok) return res;
				return { ok: true, value: res.environment.name };
			}, "name"),
		{
			invalidates: [orpc.workspace.environments.key(), orpc.environments.key()],
			form: { instance: form, fields: ["name"] },
			closes: onOpenChange,
			onSuccess: (createdName, values) => {
				toast.success(values.mode === "duplicate" ? "Environment duplicated" : "Environment created");
				void onCreated(createdName);
			},
		},
	);
	const submitting = create.isPending;

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				// A create in flight is not abandoned by Escape or a click outside.
				if (!next && submitting) return;
				onOpenChange(next);
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>New Environment</DialogTitle>
					<DialogDescription>
						Changes made in an environment stay in it until you promote them to another.{" "}
						<a
							href={ENV_DOCS_HREF}
							target="_blank"
							rel="noreferrer"
							className="font-medium text-foreground underline underline-offset-2"
						>
							Learn more
						</a>
					</DialogDescription>
				</DialogHeader>

				<Form {...form}>
					<form onSubmit={form.handleSubmit((values) => create.submit(values))} className="space-y-4" noValidate>
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Environment name</FormLabel>
									<FormControl>
										<Input placeholder="staging" autoComplete="off" autoFocus disabled={submitting} {...field} />
									</FormControl>
									<FormMessage role="alert" />
								</FormItem>
							)}
						/>

						<div className="space-y-2">
							<ModeCard
								icon={<Copy className="h-4 w-4" aria-hidden />}
								title="Duplicate Environment"
								description="Copy all the services, variables, and configuration from an existing environment."
								selected={mode === "duplicate"}
								disabled={submitting}
								onSelect={() => form.setValue("mode", "duplicate", { shouldValidate: form.formState.isSubmitted })}
							>
								{mode === "duplicate" && (
									<FormField
										control={form.control}
										name="baseId"
										render={({ field }) => (
											<FormItem className="mt-3">
												<FormLabel id={baseLabelId}>Base environment</FormLabel>
												<Select value={field.value} onValueChange={field.onChange} disabled={submitting}>
													<SelectTrigger aria-labelledby={baseLabelId} className="h-8 text-sm">
														<SelectValue placeholder="Select an environment" />
													</SelectTrigger>
													<SelectContent>
														{envs.map((e) => (
															<SelectItem key={e.id} value={e.id}>
																{e.name}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
												<FormMessage role="alert" />
											</FormItem>
										)}
									/>
								)}
							</ModeCard>

							<ModeCard
								icon={<FileStack className="h-4 w-4" aria-hidden />}
								title="Empty Environment"
								description="An empty environment with no services or variables included."
								selected={mode === "empty"}
								disabled={submitting}
								onSelect={() => form.setValue("mode", "empty", { shouldValidate: form.formState.isSubmitted })}
							>
								{mode === "empty" && (
									<FormField
										control={form.control}
										name="stage"
										render={({ field }) => (
											<FormItem className="mt-3">
												<FormLabel id={stageLabelId}>Stage</FormLabel>
												<Select value={field.value} onValueChange={field.onChange} disabled={submitting}>
													<SelectTrigger aria-labelledby={stageLabelId} className="h-8 text-sm">
														<SelectValue placeholder="Select a stage" />
													</SelectTrigger>
													<SelectContent>
														{ENVIRONMENT_STAGES.map((stage) => (
															<SelectItem key={stage} value={stage}>
																{stageLabel(stage)}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
												<FormMessage role="alert" />
											</FormItem>
										)}
									/>
								)}
							</ModeCard>
						</div>

						<FormRootError form={form} />

						<DialogFooter>
							<Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
								Cancel
							</Button>
							<Button type="submit" disabled={submitting} aria-busy={submitting}>
								{submitting ? "Creating…" : "Create environment"}
							</Button>
						</DialogFooter>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
}

/** A selectable option card for the creation mode (Duplicate / Empty). */
function ModeCard({
	icon,
	title,
	description,
	selected,
	disabled,
	onSelect,
	children,
}: {
	icon: React.ReactNode;
	title: string;
	description: string;
	selected: boolean;
	disabled: boolean;
	onSelect: () => void;
	children?: React.ReactNode;
}) {
	return (
		// A <div> (not a <button>) so interactive `children` (a Select, whose trigger is itself a
		// <button>) aren't nested inside the selection button — nested buttons are invalid HTML.
		<div
			className={cn(
				"w-full rounded-lg border transition-colors",
				selected ? "border-border-strong bg-surface-muted ring-1 ring-border-strong" : "border-border hover:bg-surface-muted",
			)}
		>
			<button
				type="button"
				onClick={onSelect}
				aria-pressed={selected}
				disabled={disabled}
				className="flex w-full items-start gap-2.5 rounded-lg p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
			>
				<span className="mt-0.5 text-text-tertiary">{icon}</span>
				<span className="min-w-0 flex-1">
					<span className="block text-sm font-medium text-text-primary">{title}</span>
					<span className="mt-0.5 block text-ui-sm text-text-tertiary">{description}</span>
				</span>
			</button>
			{children && <div className="pb-3 pl-[2.375rem] pr-3">{children}</div>}
		</div>
	);
}
