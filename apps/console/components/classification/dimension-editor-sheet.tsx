"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Create / edit a classification dimension in a side sheet. Create mode offers an optional
// "start from a template" step that pre-fills the fields and stages a set of values — nothing is
// written until Save (then createDimensionWithValues). Edit mode updates the dimension only.
//
// #6129: the save goes through `useActionMutation` — pending disables Save and Cancel (the
// double-submit guard), a server field refusal (a key another dimension uses) lands under its field,
// and every classification read is invalidated. The sheet TRACKS DIRTY STATE: an edit with no change
// cannot be saved, and closing it with unsaved changes asks first instead of dropping them.

import { typedEntries } from "@/lib/typed-object";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@repo/ui/sheet";
import { Switch } from "@repo/ui/switch";
import { Textarea } from "@repo/ui/textarea";
import { cn } from "@repo/ui/utils";
import { Plus, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import type { DimensionDTO } from "@/app/server/actions/classification/dimensions";
import {
	createDimension,
	createDimensionWithValues,
	type SeedValue,
	updateDimension,
} from "@/app/server/actions/classification/dimensions";
import { DiscardPrompt, useUnsavedGuard } from "@/components/confirm/use-unsaved-guard";
import { FormRootError } from "@/components/forms/form-root-error";
import type { ActionResult, FieldErrors } from "@/lib/actions/result";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { classificationReadKeys } from "@/lib/query/use-classification-query";
import {
	type DimensionInput,
	dimensionInputSchema,
} from "@/lib/validations/classification";
import type { ResourceKind } from "@/lib/db/schema/enums";
import {
	CLASSIFICATION_TEMPLATES,
	type ClassificationTemplate,
} from "./classification-templates";
import { slugifyOrEmpty } from "@/lib/utils/slugify";
import { InfoHint } from "./classification-ui";
import { RESOURCE_KIND_LABELS } from "./resource-kind-labels";

/** The blank dimension a create starts from. */
const BLANK_DIMENSION: DimensionInput = {
	key: "",
	label: "",
	description: "",
	multi: false,
	applies_to: [],
	position: 0,
};

/** The form values a template seeds (its values are staged separately). */
function templateFormValues(t: ClassificationTemplate): DimensionInput {
	return { key: t.key, label: t.label, description: t.description, multi: t.multi, applies_to: [], position: 0 };
}

/** The fields the sheet renders from. */
const WATCHED = ["multi", "applies_to", "label"] as const;

/** The fields that show a message of their own; every other server message goes to the root. */
const DIMENSION_FIELDS = ["key", "label", "description"] as const;

/**
 * Rewrites the field keys of a template create's validation result into the form's own names.
 *
 * That action takes `{ dimension, values }`, so the server names its fields `dimension.key` and
 * `values.2.value` — keys no field of this form has. A `dimension.*` message is moved under the
 * field it is about, and a `values.N.*` message names the staged value it is about, so the root
 * error says which one to fix. Any other result passes through unchanged.
 */
function withFormFieldKeys<T>(
	result: ActionResult<T>,
	staged: readonly SeedValue[],
): ActionResult<T> {
	if (result.ok || result.error.kind !== "validation") return result;
	const fields: FieldErrors = {};
	for (const [key, messages] of Object.entries(result.error.fields)) {
		if (!messages) continue;
		const value = /^values\.(\d+)\./.exec(key);
		if (key.startsWith("dimension.")) {
			fields[key.slice("dimension.".length)] = messages;
		} else if (value) {
			const label = staged[Number(value[1])]?.label ?? "A staged value";
			fields[key] = messages.map((m) => `“${label}”: ${m}`);
		} else {
			fields[key] = messages;
		}
	}
	return { ok: false, error: { ...result.error, fields } };
}

/** Whether two staged value lists hold the same values in the same order. */
function sameStaged(a: readonly SeedValue[], b: readonly SeedValue[]): boolean {
	return a.length === b.length && a.every((v, i) => v.value === b[i]?.value && v.label === b[i]?.label);
}

/**
 * The submit button's label. At rest it names the action; in flight it names the write that
 * `saveDimension` is actually making — an update, a create with its staged values, or a bare
 * create — so the button never says "Saving…" for something that is not one.
 */
function submittingLabel(isEdit: boolean, stagedCount: number, submitting: boolean): string {
	if (!submitting) return isEdit ? "Save changes" : "Create dimension";
	if (isEdit) return "Updating dimension…";
	return stagedCount > 0 ? "Creating dimension and values…" : "Creating dimension…";
}

/** Create / edit a dimension. Controlled via `open` / `onOpenChange`. */
export function DimensionEditorSheet({
	dimension,
	initialTemplateKey,
	open,
	onOpenChange,
}: {
	dimension?: DimensionDTO;
	/** Preselect a template when opening in create mode (from an empty-state card). */
	initialTemplateKey?: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const isEdit = Boolean(dimension);
	const [staged, setStaged] = useState<SeedValue[]>([]);
	const [templateKey, setTemplateKey] = useState<string | null>(null);
	const [addLabel, setAddLabel] = useState("");
	// The switch is named by its visible row title, by reference (#4352).
	const multiLabelId = useId();
	const labelFieldId = useId();
	const keyFieldId = useId();
	const descriptionFieldId = useId();
	const addErrorId = useId();

	const form = useForm<DimensionInput>({
		resolver: zodResolver(dimensionInputSchema),
		defaultValues: BLANK_DIMENSION,
	});

	// Apply a template's fields + stage its values (create mode only).
	const applyTemplate = (t: ClassificationTemplate) => {
		form.reset(templateFormValues(t));
		setStaged(t.values);
		setTemplateKey(t.key);
	};

	// Deselect the active template, back to a blank form.
	const clearTemplate = () => {
		form.reset(BLANK_DIMENSION);
		setStaged([]);
		setTemplateKey(null);
	};

	// Reset when (re)opening, or when what the sheet was opened for changes while it is open. The
	// sheet's own state is reset during render, against the props it was last reset for; the form
	// is an external store, so its reset stays in an effect.
	const openTemplate = !dimension && initialTemplateKey
		? CLASSIFICATION_TEMPLATES.find((x) => x.key === initialTemplateKey)
		: undefined;
	// Keyed by the dimension's ID, not the object: a refetch that hands the open sheet a new object for
	// the same row must not wipe what is being typed.
	const dimensionId = dimension?.id;
	const [resetFor, setResetFor] = useState<{ dimensionId?: string; templateKey?: string } | null>(null);
	if (!open && resetFor !== null) setResetFor(null);
	if (open && (resetFor === null || resetFor.dimensionId !== dimensionId || resetFor.templateKey !== initialTemplateKey)) {
		setResetFor({ dimensionId, templateKey: initialTemplateKey });
		setStaged(openTemplate ? openTemplate.values : []);
		setTemplateKey(openTemplate ? openTemplate.key : null);
		setAddLabel("");
	}
	useEffect(() => {
		if (!open) return;
		if (dimension) {
			form.reset({
				key: dimension.key,
				label: dimension.label,
				description: dimension.description ?? "",
				multi: dimension.multi,
				applies_to: dimension.appliesTo,
				position: dimension.position,
			});
		} else if (openTemplate) {
			form.reset(templateFormValues(openTemplate));
		} else {
			form.reset(BLANK_DIMENSION);
		}
		// Keyed like the state reset above: by the dimension's ID. `openTemplate` is derived from
		// `initialTemplateKey`, and `form` is stable for the sheet's life.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, dimensionId, initialTemplateKey]);

	const [multi, watchedAppliesTo, watchedLabel] = useWatch({ control: form.control, name: WATCHED });
	const appliesTo = watchedAppliesTo ?? [];
	const toggleKind = (kind: ResourceKind) => {
		const set = new Set(appliesTo);
		if (set.has(kind)) set.delete(kind);
		else set.add(kind);
		form.setValue("applies_to", [...set], { shouldDirty: true });
	};
	const KIND_ENTRIES = typedEntries(RESOURCE_KIND_LABELS);

	// Why the typed value was not staged; cleared as soon as the text changes.
	const [addError, setAddError] = useState<string | null>(null);
	const addStaged = () => {
		const label = addLabel.trim();
		if (!label) return;
		const value = slugifyOrEmpty(label);
		// A label with no letter or digit ("!!!") has no slug, and a value without one is refused
		// on Save — say so here, beside the box, instead of staging a value that cannot be saved.
		if (!value) {
			setAddError("A value needs at least one letter or number.");
			return;
		}
		if (staged.some((s) => s.value === value)) {
			setAddLabel("");
			return;
		}
		setStaged((s) => [...s, { value, label }]);
		setAddLabel("");
	};

	/** The edit, the template create (dimension + staged values) or the plain create. */
	async function saveDimension(data: DimensionInput): Promise<ActionResult<unknown>> {
		if (dimension) return updateDimension({ ...data, id: dimension.id });
		if (staged.length > 0) {
			return withFormFieldKeys(
				await createDimensionWithValues({ dimension: data, values: staged }),
				staged,
			);
		}
		return createDimension(data);
	}

	const save = useActionMutation(saveDimension, {
		invalidates: classificationReadKeys(),
		successMessage: (): string => {
			if (isEdit) return "Dimension updated.";
			return staged.length > 0
				? `Created “${form.getValues("label")}” with ${staged.length} values.`
				: "Dimension created.";
		},
		// Each message under the field it is about; a message about anything the sheet does not
		// render as a field (a staged value, the form as a whole) in the root error above the
		// footer. The old handler mapped three names and dropped the rest, so Save did nothing
		// (#6825, F-13).
		form: { instance: form, fields: DIMENSION_FIELDS },
		onSuccess: () => {
			form.reset(form.getValues());
			onOpenChange(false);
		},
	});

	const onSubmit = (data: DimensionInput) => {
		if (save.isPending) return;
		save.mutate(data);
	};

	// Asked when the sheet is closed with unsaved changes: discard them, or keep editing. The
	// sheet's own state counts as much as the form's: a template picked (whose fields the form was
	// RESET to, so the form alone reads pristine) and values staged or removed are work that closing
	// would drop just the same (F-15).
	const stagedChanged =
		templateKey !== (openTemplate?.key ?? null) || !sameStaged(staged, openTemplate?.values ?? []);
	const unsaved = useUnsavedGuard(form.formState.isDirty || stagedChanged);
	const dirty = unsaved.dirty;
	/** Closing asks first when there is something to lose; a pristine sheet just closes. */
	function requestOpenChange(next: boolean) {
		if (!next && dirty && !save.isPending) {
			unsaved.guard(() => {
				form.reset();
				onOpenChange(false);
			});
			return;
		}
		onOpenChange(next);
	}

	const submitting = save.isPending;

	return (
		<>
		<Sheet open={open} onOpenChange={requestOpenChange}>
			<SheetContent
				side="right"
				className="flex w-[min(480px,96vw)] flex-col gap-0 p-0 sm:max-w-none"
			>
				<SheetHeader className="border-b p-5">
					<SheetTitle className="font-display text-ui-xl font-semibold tracking-tight">
						{isEdit ? "Edit dimension" : "New dimension"}
					</SheetTitle>
					<SheetDescription className="text-ui-sm">
						A named axis (e.g. Environment, Team) with a set of allowed values.
					</SheetDescription>
				</SheetHeader>

				<form
					onSubmit={form.handleSubmit(onSubmit)}
					className="flex min-h-0 flex-1 flex-col"
				>
					<div className="flex-1 space-y-5 overflow-y-auto p-5">
						{/* optional: start from a template (create only) */}
						{!isEdit && (
							<div>
								<div className="mb-2 font-mono text-ui-3xs uppercase tracking-[0.14em] text-text-tertiary">
									Start from a template
									<span className="ml-1.5 normal-case tracking-normal text-text-disabled">
										optional
									</span>
								</div>
								{/* Named as a group: a template and an "Applies to" kind can share a label
								    ("Environment"), and the group is what tells them apart to a screen reader. */}
								<div role="group" aria-label="Start from a template" className="flex flex-wrap gap-1.5">
									{CLASSIFICATION_TEMPLATES.map((t) => (
										<button
											key={t.key}
											type="button"
											aria-pressed={templateKey === t.key}
											onClick={() =>
												templateKey === t.key ? clearTemplate() : applyTemplate(t)
											}
											className={cn(
												"rounded-[2px] border px-2.5 py-1 text-ui-sm transition-colors",
												templateKey === t.key
													? "border-ring bg-surface-muted text-text-primary"
													: "border-border-strong text-text-secondary hover:bg-surface-muted",
											)}
										>
											{t.label}
										</button>
									))}
								</div>
							</div>
						)}

						<div>
							<label htmlFor={labelFieldId} className="mb-1.5 block text-xs font-medium">
								Label
							</label>
							<Input
								id={labelFieldId}
								autoFocus
								placeholder="Environment"
								{...form.register("label")}
								onChange={(e) => {
									form.setValue("label", e.target.value, { shouldDirty: true });
									if (!isEdit && !form.formState.dirtyFields.key) {
										form.setValue("key", slugifyOrEmpty(e.target.value));
									}
								}}
							/>
							{form.formState.errors.label?.message && (
								<p className="mt-1 text-ui-xs text-destructive">{form.formState.errors.label.message}</p>
							)}
						</div>

						<div>
							<label
								htmlFor={keyFieldId}
								className="mb-1.5 flex items-center gap-1.5 text-xs font-medium"
							>
								Key
								<InfoHint>
									The stable, URL/wire-safe identifier. It{"'"}s fixed after creation so
									existing assignments never break — the label stays editable.
								</InfoHint>
							</label>
							<Input
								id={keyFieldId}
								placeholder="environment"
								className="font-mono text-xs"
								disabled={isEdit}
								{...form.register("key")}
							/>
							{form.formState.errors.key?.message && (
								<p className="mt-1 text-ui-xs text-destructive">{form.formState.errors.key.message}</p>
							)}
						</div>

						<div>
							<label htmlFor={descriptionFieldId} className="mb-1.5 block text-xs font-medium">
								Description{" "}
								<span className="font-normal text-text-tertiary">— optional</span>
							</label>
							<Textarea
								id={descriptionFieldId}
								rows={2}
								placeholder="What this axis means."
								{...form.register("description")}
							/>
							{/* It is in DIMENSION_FIELDS, so a message about it lands here — a field
							    whose error had nowhere to render was the same silence as an unmapped one. */}
							{form.formState.errors.description?.message && (
								<p className="mt-1 text-ui-xs text-destructive">{form.formState.errors.description.message}</p>
							)}
						</div>

						<div className="flex items-center justify-between gap-4 rounded-md border p-3">
							<div className="flex items-center gap-1.5">
								<div id={multiLabelId} className="text-ui-sm font-medium">
									Allow multiple values
								</div>
								<InfoHint>
									Off: a resource holds one value on this axis (assigning a new one
									replaces the old). On: a resource may carry several (e.g. a service
									owned by two teams).
								</InfoHint>
							</div>
							<Switch
								aria-labelledby={multiLabelId}
								checked={multi}
								onCheckedChange={(v) => form.setValue("multi", v, { shouldDirty: true })}
							/>
						</div>

						{/* applies-to scope */}
						<div>
							<div className="mb-1.5 flex items-center gap-1.5">
								<label className="text-xs font-medium">Applies to</label>
								<InfoHint>
									Which resource kinds can carry this dimension. Leave all unchecked to
									apply everywhere; otherwise it only appears on the kinds you pick.
								</InfoHint>
								<span className="ml-auto font-mono text-ui-2xs text-text-tertiary">
									{appliesTo.length === 0 ? "All resources" : `${appliesTo.length} kinds`}
								</span>
							</div>
							<div className="flex flex-wrap gap-1.5">
								{KIND_ENTRIES.map(([kind, label]) => {
									const on = appliesTo.includes(kind);
									return (
										<button
											key={kind}
											type="button"
											onClick={() => toggleKind(kind)}
											className={cn(
												"rounded-[2px] border px-2 py-1 text-ui-xs transition-colors",
												on
													? "border-ring bg-surface-muted text-text-primary"
													: "border-border-strong text-text-tertiary hover:bg-surface-muted",
											)}
										>
											{label}
										</button>
									);
								})}
							</div>
						</div>

						{/* staged values (create only) */}
						{!isEdit && (
							<div>
								<div className="mb-2 font-mono text-ui-3xs uppercase tracking-[0.14em] text-text-tertiary">
									Values
									<span className="ml-1.5 normal-case tracking-normal text-text-disabled">
										{staged.length === 0 ? "add now or after" : `${staged.length} staged`}
									</span>
								</div>
								{staged.length > 0 && (
									<div className="mb-2 flex flex-wrap gap-1.5">
										{staged.map((v) => (
											<span
												key={v.value}
												className="inline-flex items-center gap-1.5 rounded-[2px] border bg-surface-sunken px-2 py-1 text-ui-sm"
											>
												{v.label}
												<button
													type="button"
													aria-label={`Remove ${v.label}`}
													onClick={() =>
														setStaged((s) => s.filter((x) => x.value !== v.value))
													}
													className="text-text-tertiary hover:text-text-primary"
												>
													<X className="size-3" />
												</button>
											</span>
										))}
									</div>
								)}
								<div className="flex items-center gap-2">
									<Input
										aria-label="New value label"
										value={addLabel}
										aria-invalid={addError ? true : undefined}
										aria-describedby={addError ? addErrorId : undefined}
										onChange={(e) => {
											setAddLabel(e.target.value);
											setAddError(null);
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												e.preventDefault();
												addStaged();
											}
										}}
										placeholder="Add a value — press Enter"
										className="h-8 text-ui-sm"
									/>
									<Button
										type="button"
										variant="outline"
										size="sm"
										className="h-8 gap-1"
										disabled={!addLabel.trim()}
										onClick={addStaged}
									>
										<Plus className="size-3.5" />
										Add
									</Button>
								</div>
								{addError && (
									<p id={addErrorId} role="alert" className="mt-1 text-ui-xs text-destructive">
										{addError}
									</p>
								)}
								<p className="mt-2 text-ui-xs text-text-tertiary">
									You can edit and reorder values after creating.
								</p>
							</div>
						)}
					</div>

					{/* What the server said about no field the sheet renders — a staged value, the
					    form as a whole. Beside the button that was pressed, so Save never fails
					    silently. */}
					<FormRootError form={form} className="mx-5 mb-4" />
					<SheetFooter className="flex-row justify-end gap-2 border-t p-4">
						<Button
							type="button"
							variant="outline"
							onClick={() => requestOpenChange(false)}
							disabled={submitting}
						>
							Cancel
						</Button>
						{/* An edit with nothing changed has nothing to save; a create always does. */}
						<Button
							type="submit"
							pending={submitting}
							disabled={!watchedLabel || (isEdit && !dirty)}
						>
							{submittingLabel(isEdit, staged.length, submitting)}
						</Button>
					</SheetFooter>
				</form>
			</SheetContent>
		</Sheet>
		<DiscardPrompt
			{...unsaved.prompt}
			title="Discard your changes?"
			description={
				isEdit
					? "The changes to this dimension are not saved. Closing the editor drops them."
					: "This dimension is not created yet. Closing the editor drops what you entered."
			}
			confirmLabel="Discard changes"
		/>
		</>
	);
}
