"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Create/edit a classification value — label + slug (auto-derived from the label until edited).
// react-hook-form + the shared valueInputSchema; wires createValue / updateValue through
// `useActionMutation` (#6129): pending disables Save (the double-submit guard), a server field
// refusal (a slug the dimension already has) lands under its field, and every classification read is
// invalidated. An edit with nothing changed cannot be saved. Grayscale: no color accent (the design
// system carries no hue).

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
import { Input } from "@repo/ui/input";
import { Switch } from "@repo/ui/switch";
import { Check, ShieldCheck } from "lucide-react";
import { useEffect, useId } from "react";
import { useForm, useWatch } from "react-hook-form";
import { DiscardPrompt, useUnsavedGuard } from "@/components/confirm/use-unsaved-guard";
import { z } from "zod";
import type { ValueDTO } from "@/app/server/actions/classification/dimensions";
import { FormRootError } from "@/components/forms/form-root-error";
import {
	createValue,
	updateValue,
} from "@/app/server/actions/classification/dimensions";
import type { ActionResult } from "@/lib/actions/result";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { classificationReadKeys } from "@/lib/query/use-classification-query";
import {
	enforcementSchema,
	slugSchema,
	type ValueInput,
	valueInputSchema,
} from "@/lib/validations/classification";
import { slugifyOrEmpty } from "@/lib/utils/slugify";
import { InfoHint, Spinner } from "./classification-ui";

/** The minimum-approvals message: the one thing the number field can be wrong about. */
const MIN_APPROVALS_MESSAGE = "Enter a whole number from 1 to 10.";

/**
 * The shared value rule with the dialog's own words where zod's default would show ("Too small:
 * expected string to have >=1 characters"). Every other rule — the slug's format, the lengths — is
 * the shared schema's, so the server and this form still refuse the same input.
 */
const valueFormSchema = valueInputSchema.extend({
	label: z.string().trim().min(1, "Enter a label.").max(80, "Keep the label to 80 characters."),
	value: z.string().min(1, "Enter a slug, or type a label to derive one.").pipe(slugSchema),
	enforcement: enforcementSchema
		.extend({
			min_approvals: z
				.number({ error: MIN_APPROVALS_MESSAGE })
				.int(MIN_APPROVALS_MESSAGE)
				.min(1, MIN_APPROVALS_MESSAGE)
				.max(10, MIN_APPROVALS_MESSAGE),
		})
		.nullable()
		.optional(),
});

/** The fields the editor renders from. */
const WATCHED = ["label", "enforcement"] as const;

/** The fields that show a message of their own; every other server message goes to the root. */
const VALUE_FIELDS = ["value", "label"] as const;

/**
 * The value editor dialog. Pass an existing `value` to edit, or omit it to create one on
 * `dimensionId`. Closes itself after a successful write.
 */
export function ValueEditor({
	dimensionId,
	dimensionLabel,
	value,
	open,
	onOpenChange,
}: {
	dimensionId: string;
	dimensionLabel: string;
	value?: ValueDTO;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const isEdit = Boolean(value);
	// Each switch is named by its visible row title, by reference (#4352). The title's `<span>`
	// stops short of the `InfoHint` beside it, so the hint's trigger is not read into the name.
	const enforceLabelId = useId();
	const approvalLabelId = useId();
	const verifyLabelId = useId();
	const labelFieldId = useId();
	const slugFieldId = useId();
	const minApprovalsId = useId();
	const labelErrorId = useId();
	const slugErrorId = useId();
	const minApprovalsErrorId = useId();
	const form = useForm<ValueInput>({
		resolver: zodResolver(valueFormSchema),
		defaultValues: {
			value: value?.value ?? "",
			label: value?.label ?? "",
			enforcement: value?.enforcement ?? null,
			position: value?.position ?? 0,
		},
	});

	useEffect(() => {
		if (open) {
			form.reset({
				value: value?.value ?? "",
				label: value?.label ?? "",
				enforcement: value?.enforcement ?? null,
				position: value?.position ?? 0,
			});
		}
	}, [open, value, form]);

	const [label, enforcement] = useWatch({ control: form.control, name: WATCHED });
	const enforceOn = Boolean(enforcement);

	/** Toggles the enforcement policy on/off, seeding a sensible default (require approval). */
	const setEnforce = (on: boolean) => {
		form.setValue(
			"enforcement",
			on
				? { require_approval: true, require_verify_pass: false, min_approvals: 1 }
				: null,
			{ shouldDirty: true },
		);
	};

	/** The edit or the create for these values. */
	function saveValue(payload: ValueInput): Promise<ActionResult<unknown>> {
		return value ? updateValue({ ...payload, id: value.id }) : createValue({ ...payload, dimensionId });
	}

	const save = useActionMutation(saveValue, {
		invalidates: classificationReadKeys(),
		successMessage: () => (isEdit ? "Value updated." : "Value added."),
		// The slug and the label show their own message; anything else the server says — the
		// colour this grayscale dialog has no field for, the enforcement policy, the form as a
		// whole — goes to the root error above the footer instead of being dropped (#6825, F-13).
		form: { instance: form, fields: VALUE_FIELDS },
		onSuccess: () => onOpenChange(false),
	});

	const onSubmit = (data: ValueInput) => {
		if (save.isPending) return;
		save.mutate({ ...data, value: data.value || slugifyOrEmpty(data.label) });
	};
	const dirty = form.formState.isDirty;
	// A typed label or a set policy is not dropped by a stray Escape, an outside click or Cancel
	// (R6 F-16): closing a dirty editor asks first, with the console's one discard question — the
	// one the dimension sheet beside this dialog asks.
	const { guard, prompt } = useUnsavedGuard(form);
	/** Closes the editor, asking first while there are unsaved edits; held while a save is in flight. */
	const requestClose = () => {
		if (save.isPending) return;
		guard(() => onOpenChange(false));
	};
	const minApprovalsError = form.formState.errors.enforcement?.min_approvals?.message;

	return (
		<>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (next) onOpenChange(true);
					else requestClose();
				}}
			>
				<DialogContent className="sm:max-w-[440px]">
					<DialogHeader>
						<DialogDescription className="font-mono text-ui-3xs uppercase tracking-[0.14em] text-text-tertiary">
							Value · {dimensionLabel}
						</DialogDescription>
						<DialogTitle className="font-display text-ui-xl">
							{isEdit ? "Edit value" : "New value"}
						</DialogTitle>
					</DialogHeader>

					{/* noValidate: the number field's native min/max would otherwise stop the submit with the
					    browser's own bubble before the schema runs, so the field's message never showed (F-17). */}
					<form noValidate onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
						<div className="flex gap-3">
							<div className="flex-1">
								<label htmlFor={labelFieldId} className="mb-1.5 block text-xs font-medium">
									Label
								</label>
								<Input
									id={labelFieldId}
									autoFocus
									placeholder="Production"
									aria-invalid={form.formState.errors.label ? true : undefined}
									aria-describedby={form.formState.errors.label ? labelErrorId : undefined}
									{...form.register("label")}
									onChange={(e) => {
										form.setValue("label", e.target.value, { shouldDirty: true });
										if (!isEdit && !form.formState.dirtyFields.value) {
											form.setValue("value", slugifyOrEmpty(e.target.value));
										}
									}}
								/>
								{form.formState.errors.label?.message && (
									<p id={labelErrorId} className="mt-1 text-ui-xs text-destructive">{form.formState.errors.label.message}</p>
								)}
							</div>
							<div className="flex-1">
								<label htmlFor={slugFieldId} className="mb-1.5 block text-xs font-medium">
									Slug
								</label>
								<Input
									id={slugFieldId}
									placeholder="prod"
									aria-invalid={form.formState.errors.value ? true : undefined}
									aria-describedby={form.formState.errors.value ? slugErrorId : undefined}
									className="font-mono text-xs"
									{...form.register("value")}
								/>
								{form.formState.errors.value?.message && (
									<p id={slugErrorId} className="mt-1 text-ui-xs text-destructive">{form.formState.errors.value.message}</p>
								)}
							</div>
						</div>

						{/* Promotion enforcement — the label drives policy. */}
						<div className="rounded-md border">
							<div className="flex items-center justify-between gap-4 p-3">
								<div className="flex items-start gap-2">
									<ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" />
									<div>
										<div className="flex items-center gap-1.5 text-ui-sm font-medium">
											<span id={enforceLabelId}>Enforce promotion gates</span>
											<InfoHint>
												When an environment is tagged with this value, promotions{" "}
												<em>into</em> that environment require these gates — on top of the
												environment{"'"}s own protection rules. The classification becomes
												the policy.
											</InfoHint>
										</div>
										<p className="mt-0.5 text-ui-xs text-text-tertiary">
											Applies to any environment carrying this value.
										</p>
									</div>
								</div>
								<Switch
									aria-labelledby={enforceLabelId}
									checked={enforceOn}
									onCheckedChange={setEnforce}
								/>
							</div>

							{enforceOn && enforcement && (
								<div className="space-y-3 border-t p-3">
									<div className="flex items-center justify-between gap-4">
										<div id={approvalLabelId} className="text-ui-sm">
											Require manual approval
										</div>
										<Switch
											aria-labelledby={approvalLabelId}
											checked={enforcement.require_approval}
											onCheckedChange={(v) =>
												form.setValue("enforcement.require_approval", v, {
													shouldDirty: true,
												})
											}
										/>
									</div>
									<div className="flex items-center justify-between gap-4">
										<div className="flex items-center gap-1.5 text-ui-sm">
											<span id={verifyLabelId}>Require verify pass</span>
											<InfoHint>
												The elench verify gate must pass on the promotion{"'"}s plan (no
												unwaived hard control failures).
											</InfoHint>
										</div>
										<Switch
											aria-labelledby={verifyLabelId}
											checked={enforcement.require_verify_pass}
											onCheckedChange={(v) =>
												form.setValue("enforcement.require_verify_pass", v, {
													shouldDirty: true,
												})
											}
										/>
									</div>
									{enforcement.require_approval && (
										<div>
											<div className="flex items-center justify-between gap-4">
												<label htmlFor={minApprovalsId} className="text-ui-sm">
													Minimum approvals
												</label>
												<Input
													id={minApprovalsId}
													type="number"
													min={1}
													max={10}
													className="h-8 w-16 text-center text-ui-sm"
													aria-invalid={minApprovalsError ? true : undefined}
													aria-describedby={minApprovalsError ? minApprovalsErrorId : undefined}
													{...form.register("enforcement.min_approvals", {
														valueAsNumber: true,
													})}
												/>
											</div>
											{minApprovalsError && (
												<p id={minApprovalsErrorId} className="mt-1 text-right text-ui-xs text-destructive">
													{minApprovalsError}
												</p>
											)}
										</div>
									)}
								</div>
							)}
						</div>

						<FormRootError form={form} />
						<DialogFooter>
							{/* Held while the save is in flight, as the dimension sheet's is: closing
							    mid-save would leave a toast about a dialog that is gone. */}
							<Button
								type="button"
								variant="outline"
								onClick={requestClose}
								disabled={save.isPending}
							>
								Cancel
							</Button>
							{/* An edit with nothing changed has nothing to save; a new value always does. */}
							<Button type="submit" disabled={save.isPending || !label || (isEdit && !dirty)}>
								{save.isPending ? <Spinner /> : <Check className="size-3.5" />}
								Save value
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
			<DiscardPrompt
				{...prompt}
				title={isEdit ? "Discard changes to this value?" : "Discard this value?"}
				description="Your edits have not been saved. Closing drops them."
				confirmLabel="Discard"
			/>
		</>
	);
}
