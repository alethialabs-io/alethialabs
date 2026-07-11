"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Create/edit a classification value — label + slug (auto-derived from the label until edited).
// react-hook-form + the shared valueInputSchema; wires createValue / updateValue. Grayscale: no
// color accent (the design system carries no hue).

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
import { Check } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import type { ValueDTO } from "@/app/server/actions/classification/dimensions";
import {
	createValue,
	updateValue,
} from "@/app/server/actions/classification/dimensions";
import { type ValueInput, valueInputSchema } from "@/lib/validations/classification";
import { Spinner } from "./classification-ui";

/** Lowercases + hyphenates a label into a slug candidate. */
function slugify(input: string): string {
	return input
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

/**
 * The value editor dialog. Pass an existing `value` to edit, or omit it to create one on
 * `dimensionId`. Calls `onSaved` after a successful write.
 */
export function ValueEditor({
	dimensionId,
	dimensionLabel,
	value,
	open,
	onOpenChange,
	onSaved,
}: {
	dimensionId: string;
	dimensionLabel: string;
	value?: ValueDTO;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSaved: () => void;
}) {
	const isEdit = Boolean(value);
	const form = useForm<ValueInput>({
		resolver: zodResolver(valueInputSchema),
		defaultValues: {
			value: value?.value ?? "",
			label: value?.label ?? "",
			position: value?.position ?? 0,
		},
	});

	useEffect(() => {
		if (open) {
			form.reset({
				value: value?.value ?? "",
				label: value?.label ?? "",
				position: value?.position ?? 0,
			});
		}
	}, [open, value, form]);

	const label = form.watch("label");

	const onSubmit = async (data: ValueInput) => {
		try {
			const payload = { ...data, value: data.value || slugify(data.label) };
			if (value) {
				await updateValue(value.id, payload);
				toast.success("Value updated.");
			} else {
				await createValue(dimensionId, payload);
				toast.success("Value added.");
			}
			onOpenChange(false);
			onSaved();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't save the value.");
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[440px]">
				<DialogHeader>
					<DialogDescription className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-text-tertiary">
						Value · {dimensionLabel}
					</DialogDescription>
					<DialogTitle className="font-display text-[17px]">
						{isEdit ? "Edit value" : "New value"}
					</DialogTitle>
				</DialogHeader>

				<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
					<div className="flex gap-3">
						<div className="flex-1">
							<label className="mb-1.5 block text-xs font-medium">Label</label>
							<Input
								autoFocus
								placeholder="Production"
								{...form.register("label")}
								onChange={(e) => {
									form.setValue("label", e.target.value);
									if (!isEdit && !form.formState.dirtyFields.value) {
										form.setValue("value", slugify(e.target.value));
									}
								}}
							/>
						</div>
						<div className="flex-1">
							<label className="mb-1.5 block text-xs font-medium">Slug</label>
							<Input
								placeholder="prod"
								className="font-mono text-xs"
								{...form.register("value")}
							/>
						</div>
					</div>

					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" disabled={form.formState.isSubmitting || !label}>
							{form.formState.isSubmitting ? <Spinner /> : <Check className="size-3.5" />}
							Save value
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
