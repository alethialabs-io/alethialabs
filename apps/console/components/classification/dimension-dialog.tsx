"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Create/edit a classification dimension (a named axis). react-hook-form + the shared
// dimensionInputSchema; single-vs-multi is a switch. Slugifies the key from the label on
// create so the author rarely types it by hand.

import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@repo/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@repo/ui/dialog";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@repo/ui/form";
import { Input } from "@repo/ui/input";
import { Switch } from "@repo/ui/switch";
import { Textarea } from "@repo/ui/textarea";
import { type ReactNode, useEffect, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { toast } from "sonner";
import type { DimensionDTO } from "@/app/server/actions/classification/dimensions";
import {
	createDimension,
	updateDimension,
} from "@/app/server/actions/classification/dimensions";
import {
	type DimensionInput,
	dimensionInputSchema,
} from "@/lib/validations/classification";

/** Lowercases + hyphenates a label into a slug candidate for the `key` field. */
function slugify(input: string): string {
	return input
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

/**
 * The dimension editor dialog. Pass an existing `dimension` to edit, or omit it to create.
 * Works uncontrolled (via `trigger`) or controlled (via `open` / `onOpenChange`). Calls
 * `onSaved` after a successful write so the manager can refetch.
 */
export function DimensionDialog({
	dimension,
	trigger,
	open: controlledOpen,
	onOpenChange,
	onSaved,
}: {
	dimension?: DimensionDTO;
	trigger?: ReactNode;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	onSaved: () => void;
}) {
	const [internalOpen, setInternalOpen] = useState(false);
	const open = controlledOpen ?? internalOpen;
	const setOpen = onOpenChange ?? setInternalOpen;
	const isEdit = Boolean(dimension);

	const form = useForm<DimensionInput>({
		resolver: zodResolver(dimensionInputSchema),
		defaultValues: {
			key: dimension?.key ?? "",
			label: dimension?.label ?? "",
			description: dimension?.description ?? "",
			multi: dimension?.multi ?? false,
			position: dimension?.position ?? 0,
		},
	});

	// Reset the form to the (possibly changed) source whenever the dialog opens.
	useEffect(() => {
		if (open) {
			form.reset({
				key: dimension?.key ?? "",
				label: dimension?.label ?? "",
				description: dimension?.description ?? "",
				multi: dimension?.multi ?? false,
				position: dimension?.position ?? 0,
			});
		}
	}, [open, dimension, form]);

	const onSubmit = async (data: DimensionInput) => {
		try {
			if (dimension) {
				await updateDimension(dimension.id, data);
				toast.success("Dimension updated.");
			} else {
				await createDimension(data);
				toast.success("Dimension created.");
			}
			setOpen(false);
			onSaved();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't save the dimension.");
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			{trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{isEdit ? "Edit dimension" : "New dimension"}</DialogTitle>
					<DialogDescription>
						A named axis (e.g. Environment, Team) with a set of allowed values.
					</DialogDescription>
				</DialogHeader>

				<FormProvider {...form}>
					<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
						<FormField
							control={form.control}
							name="label"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Label</FormLabel>
									<FormControl>
										<Input
											placeholder="Environment"
											autoFocus
											{...field}
											onChange={(e) => {
												field.onChange(e);
												// Auto-fill the key from the label until the user edits it.
												if (!isEdit && !form.formState.dirtyFields.key) {
													form.setValue("key", slugify(e.target.value));
												}
											}}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="key"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Key</FormLabel>
									<FormControl>
										<Input
											placeholder="environment"
											className="font-mono text-xs"
											disabled={isEdit}
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="description"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Description</FormLabel>
									<FormControl>
										<Textarea
											rows={2}
											placeholder="Optional — what this axis means."
											{...field}
											value={field.value ?? ""}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="multi"
							render={({ field }) => (
								<FormItem className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5">
									<div className="space-y-0.5">
										<FormLabel>Allow multiple values</FormLabel>
										<p className="text-[11.5px] text-muted-foreground">
											Off — a resource holds at most one value on this axis.
										</p>
									</div>
									<FormControl>
										<Switch
											checked={field.value}
											onCheckedChange={field.onChange}
										/>
									</FormControl>
								</FormItem>
							)}
						/>

						<DialogFooter>
							<Button type="submit" disabled={form.formState.isSubmitting}>
								{isEdit ? "Save changes" : "Create dimension"}
							</Button>
						</DialogFooter>
					</form>
				</FormProvider>
			</DialogContent>
		</Dialog>
	);
}
