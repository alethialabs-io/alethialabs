"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The custom-role editor Sheet: an AccordionForm (Identity → Permissions → Classification →
// Review) with a persistent footer submit. Mirrors the alerts policy-sheet chrome. Sub-editors
// are form-driven (PermissionMatrix via form.setValue) so collapsing a section never loses state.
//
// #6129: the save goes through `useActionMutation` (pending, one toast policy, field errors under
// their fields, every members read invalidated). The sheet TRACKS DIRTY STATE: an edit with no
// change cannot be saved, and closing it with unsaved changes asks first instead of dropping them.

import { zodResolver } from "@hookform/resolvers/zod";
import { ShieldPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import {
	createRole,
	type RoleRow,
	updateRole,
} from "@/app/server/actions/roles";
import { ConfirmDialog } from "@/components/alerts/confirm-dialog";
import { ClassificationControl } from "@/components/classification/classification-control";
import {
	AccordionForm,
	type FormSectionDef,
} from "@/components/forms/accordion-form";
import type { ActionResult, FieldErrors } from "@/lib/actions/result";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { roleDisplayName } from "@/lib/authz/registry";
import { orpc } from "@/lib/rpc/client";
import { type RoleInput, roleInputSchema } from "@/lib/validations/roles";
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
import { Textarea } from "@repo/ui/textarea";
import { PermissionMatrix } from "./permission-matrix";

interface RoleSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The role being edited, or null to create a new one. */
	role: RoleRow | null;
	/** Built-in roles offered as "start from a template" when creating. */
	templates: RoleRow[];
	canManage: boolean;
}

const BLANK: RoleInput = { name: "", description: "", permissionKeys: [] };

/** What one save sends: the form's values, and the role it rewrites (absent when creating). */
interface RoleSave {
	id: string | null;
	values: RoleInput;
}

/** Creates or rewrites the role, answering in the one `ActionResult` shape either way. */
async function saveRole({ id, values }: RoleSave): Promise<ActionResult<{ id: string }>> {
	const fields = {
		name: values.name,
		permissionKeys: values.permissionKeys,
		description: values.description,
	};
	if (id) return updateRole({ id, ...fields });
	const created = await createRole(fields);
	return created.ok ? { ok: true, data: { id: created.data.id } } : created;
}

/** The fields a server validation result may name, narrowed to this form's own. */
const ROLE_FIELDS = ["name", "description", "permissionKeys"] as const;

/** Create or edit a custom role. */
export function RoleSheet({
	open,
	onOpenChange,
	role,
	templates,
	canManage,
}: RoleSheetProps) {
	const [openSection, setOpenSection] = useState("identity");
	// Asked when the sheet is closed with unsaved changes: discard them, or keep editing.
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const isEdit = role != null;

	const form = useForm<RoleInput>({
		resolver: zodResolver(roleInputSchema),
		defaultValues: BLANK,
		mode: "onChange",
	});

	// Reset only on the closed→open transition, seeding from the edited role.
	const wasOpen = useRef(false);
	useEffect(() => {
		if (open && !wasOpen.current) {
			form.reset(
				role
					? {
							name: role.name,
							description: role.description ?? "",
							permissionKeys: role.permissionKeys,
						}
					: BLANK,
			);
			setOpenSection("identity");
		}
		wasOpen.current = open;
	}, [open, role, form]);

	const save = useActionMutation(saveRole, {
		invalidates: [orpc.members.key()],
		successMessage: () => (isEdit ? "Role updated" : "Role created"),
		onValidationError: (fields: FieldErrors) => {
			for (const name of ROLE_FIELDS) {
				const message = fields[name]?.[0];
				if (message) form.setError(name, { type: "server", message });
			}
		},
		onSuccess: () => {
			form.reset(form.getValues());
			onOpenChange(false);
		},
	});

	function onSubmit(values: RoleInput) {
		if (save.isPending) return;
		save.mutate({ id: role?.id ?? null, values });
	}

	const dirty = form.formState.isDirty;
	/** Closing asks first when there is something to lose; a pristine sheet just closes. */
	function requestOpenChange(next: boolean) {
		if (!next && dirty && !save.isPending) {
			setConfirmDiscard(true);
			return;
		}
		onOpenChange(next);
	}

	const errors = form.formState.errors;

	const sections: FormSectionDef<RoleInput>[] = [
		{
			id: "identity",
			title: "Identity",
			hint: "Name the role and describe what it's for.",
			fields: ["name"],
			summary: (v) => v.name,
			body: () => (
				<div className="space-y-3">
					<Input
						aria-label="Role name"
						placeholder="project-deployer"
						autoComplete="off"
						disabled={!canManage}
						{...form.register("name")}
					/>
					{errors.name && (
						<p className="text-destructive text-xs">{errors.name.message}</p>
					)}
					<Textarea
						aria-label="Role description"
						placeholder="What this role is for (optional)"
						rows={2}
						disabled={!canManage}
						{...form.register("description")}
					/>
					{!isEdit && templates.length > 0 && (
						<div className="space-y-1.5">
							<p className="font-mono text-ui-2xs uppercase tracking-wider text-text-tertiary">
								Start from
							</p>
							<div className="flex flex-wrap gap-1.5">
								{templates.map((t) => (
									<button
										key={t.id}
										type="button"
										disabled={!canManage}
										onClick={() =>
											form.setValue("permissionKeys", [...t.permissionKeys], {
												shouldValidate: true,
											})
										}
										className="rounded-md border border-border px-2 py-1 text-ui-xs text-text-secondary transition-colors hover:border-border-strong"
									>
										{roleDisplayName(t.name, t.builtin)}
									</button>
								))}
							</div>
						</div>
					)}
				</div>
			),
		},
		{
			id: "permissions",
			title: "Permissions",
			hint: "Grant only what this role needs.",
			fields: ["permissionKeys"],
			summary: (v) => `${v.permissionKeys.length} selected`,
			body: (v) => (
				<>
					<PermissionMatrix
						value={v.permissionKeys}
						onChange={
							canManage
								? (keys) =>
										form.setValue("permissionKeys", keys, { shouldValidate: true })
								: undefined
						}
						readOnly={!canManage}
					/>
					{errors.permissionKeys && (
						<p className="mt-2 text-destructive text-xs">
							{errors.permissionKeys.message}
						</p>
					)}
				</>
			),
		},
		{
			id: "classification",
			title: "Classification",
			hint: "Tag this role for governance.",
			fields: [],
			complete: () => true,
			hidden: () => !isEdit, // classification assignments need a persisted role id
			summary: () => "",
			body: () =>
				role ? (
					<ClassificationControl kind="role" id={role.id} canEdit={canManage} />
				) : null,
		},
		{
			id: "review",
			title: "Review",
			fields: [],
			terminal: true,
			complete: () => true,
			summary: () => "",
			body: (v) => (
				<div className="space-y-1.5 text-ui-sm text-text-secondary">
					<div>
						<span className="text-text-tertiary">Name:</span> {v.name || "—"}
					</div>
					{v.description && (
						<div>
							<span className="text-text-tertiary">Description:</span> {v.description}
						</div>
					)}
					<div>
						<span className="text-text-tertiary">Permissions:</span>{" "}
						{v.permissionKeys.length}
					</div>
				</div>
			),
		},
	];

	return (
		<>
		<Sheet open={open} onOpenChange={requestOpenChange}>
			<SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
				<SheetHeader className="gap-3 border-b border-border/60 p-5">
					<div className="flex items-center gap-3">
						<span className="flex size-10 items-center justify-center rounded-lg border border-border/60 bg-muted/30">
							<ShieldPlus size={18} className="text-text-secondary" />
						</span>
						<div>
							<SheetTitle className="font-display text-base">
								{isEdit ? "Edit role" : "New role"}
							</SheetTitle>
							<SheetDescription className="text-xs">
								{isEdit
									? role.name
									: "Define a custom role with a specific permission set."}
							</SheetDescription>
						</div>
					</div>
				</SheetHeader>
				<FormProvider {...form}>
					<div className="flex-1 overflow-y-auto p-5">
						<AccordionForm
							sections={sections}
							open={openSection}
							onOpenChange={setOpenSection}
						/>
					</div>
					<SheetFooter className="flex-row items-center justify-between border-t border-border/60 p-4">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => requestOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="button"
							size="sm"
							// An edit with nothing changed has nothing to save; a create always does.
							disabled={!canManage || save.isPending || (isEdit && !dirty)}
							onClick={() => void form.handleSubmit(onSubmit)()}
						>
							{save.isPending ? "Saving…" : isEdit ? "Save changes" : "Create role"}
						</Button>
					</SheetFooter>
				</FormProvider>
			</SheetContent>
		</Sheet>
		<ConfirmDialog
			open={confirmDiscard}
			onOpenChange={setConfirmDiscard}
			title="Discard your changes?"
			description={
				isEdit
					? "The changes to this role are not saved. Closing the editor drops them."
					: "This role is not created yet. Closing the editor drops what you entered."
			}
			confirmLabel="Discard changes"
			onConfirm={() => {
				form.reset();
				onOpenChange(false);
			}}
		/>
		</>
	);
}
