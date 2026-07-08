"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Create/edit a classification value — label, slug (auto-derived from the label until edited),
// and an optional color accent picked from the muted swatch palette, cleared, or set to a custom
// color. react-hook-form + the shared valueInputSchema; wires createValue / updateValue.

import { zodResolver } from "@hookform/resolvers/zod";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import { Input } from "@repo/ui/input";
import { Button } from "@repo/ui/button";
import { cn } from "@repo/ui/utils";
import { Ban, Check, Pipette } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import type { ValueDTO } from "@/app/server/actions/classification/dimensions";
import {
	createValue,
	updateValue,
} from "@/app/server/actions/classification/dimensions";
import { type ValueInput, valueInputSchema } from "@/lib/validations/classification";
import { SWATCHES } from "./classification-templates";

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
			color: value?.color ?? undefined,
			position: value?.position ?? 0,
		},
	});

	useEffect(() => {
		if (open) {
			form.reset({
				value: value?.value ?? "",
				label: value?.label ?? "",
				color: value?.color ?? undefined,
				position: value?.position ?? 0,
			});
		}
	}, [open, value, form]);

	const color = form.watch("color");
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

					<div>
						<div className="mb-2 flex items-center justify-between">
							<label className="text-xs font-medium">Color accent</label>
							<span className="font-mono text-[10.5px] text-text-tertiary">
								{color ?? "neutral"}
							</span>
						</div>
						<div className="flex flex-wrap items-center gap-2">
							<button
								type="button"
								title="Neutral (no accent)"
								onClick={() => form.setValue("color", undefined)}
								className={cn(
									"grid size-[26px] place-items-center rounded-[3px] border transition-colors",
									!color
										? "border-ring bg-surface-muted"
										: "border-border-strong bg-surface-sunken",
								)}
							>
								<Ban className="size-3.5 text-text-tertiary" />
							</button>
							{SWATCHES.map((sw) => (
								<button
									key={sw}
									type="button"
									onClick={() => form.setValue("color", sw)}
									style={{ backgroundColor: sw }}
									className={cn(
										"size-[26px] rounded-[3px] border transition-transform hover:scale-110",
										color === sw
											? "border-text-primary ring-2 ring-ring/40"
											: "border-black/10",
									)}
								/>
							))}
							<label
								title="Custom color"
								className="relative grid size-[26px] cursor-pointer place-items-center overflow-hidden rounded-[3px] border border-border-strong bg-surface-sunken"
							>
								<Pipette className="size-3.5 text-text-secondary" />
								<input
									type="color"
									value={typeof color === "string" && color.startsWith("#") ? color : "#5c6b7a"}
									onChange={(e) => form.setValue("color", e.target.value)}
									className="absolute inset-0 cursor-pointer opacity-0"
								/>
							</label>
							<span className="flex-1" />
							<div className="inline-flex items-center gap-1.5 rounded-[2px] border bg-surface-sunken px-2.5 py-1">
								<span
									className="size-2.5 rounded-full"
									style={{
										background: color ?? "transparent",
										border: color ? undefined : "1.5px solid var(--border-strong)",
									}}
								/>
								<span className="text-[11.5px] text-text-secondary">
									{label || "Preview"}
								</span>
							</div>
						</div>
					</div>

					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={form.formState.isSubmitting || !label}>
							<Check className="size-3.5" />
							Save value
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
