"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Classification — CRUD the org's classification taxonomy: dimensions (axes) and
// their allowed values. One panel per dimension; values render as squared chips with an
// inline add-value form and per-value delete. Reads/writes via the classification server
// actions through TanStack Query (shared cache with every picker).

import { zodResolver } from "@hookform/resolvers/zod";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@repo/ui/alert-dialog";
import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { Skeleton } from "@repo/ui/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Tags, Trash2, X } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import type {
	DimensionDTO,
	ValueDTO,
} from "@/app/server/actions/classification/dimensions";
import {
	createValue,
	deleteDimension,
	deleteValue,
} from "@/app/server/actions/classification/dimensions";
import { qk } from "@/lib/query/keys";
import { useDimensionsQuery } from "@/lib/query/use-classification-query";
import { type ValueInput, valueInputSchema } from "@/lib/validations/classification";
import { DimensionDialog } from "./dimension-dialog";

/** Slugifies a value label into its `value` slug candidate. */
function slugify(input: string): string {
	return input
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

/** A single value chip with a delete affordance. */
function ValueChip({ value, onDeleted }: { value: ValueDTO; onDeleted: () => void }) {
	return (
		<Badge variant="outline" className="gap-1.5 font-normal">
			{value.color ? (
				<span
					aria-hidden
					className="size-1.5 shrink-0 rounded-full"
					style={{ backgroundColor: value.color }}
				/>
			) : null}
			<span className="text-foreground">{value.label}</span>
			<span className="font-mono text-[10px] text-muted-foreground">
				{value.value}
			</span>
			<button
				type="button"
				aria-label={`Delete ${value.label}`}
				className="text-muted-foreground transition-colors hover:text-foreground"
				onClick={async () => {
					try {
						await deleteValue(value.id);
						onDeleted();
					} catch (e) {
						toast.error(e instanceof Error ? e.message : "Couldn't delete value.");
					}
				}}
			>
				<X className="size-3" />
			</button>
		</Badge>
	);
}

/** Inline "add a value" form for a dimension. */
function AddValueForm({
	dimensionId,
	onAdded,
}: {
	dimensionId: string;
	onAdded: () => void;
}) {
	const form = useForm<ValueInput>({
		resolver: zodResolver(valueInputSchema),
		defaultValues: { value: "", label: "", color: undefined, position: 0 },
	});

	const onSubmit = async (data: ValueInput) => {
		try {
			await createValue(dimensionId, {
				...data,
				value: data.value || slugify(data.label),
			});
			form.reset({ value: "", label: "", color: undefined, position: 0 });
			onAdded();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't add value.");
		}
	};

	return (
		<form
			onSubmit={form.handleSubmit(onSubmit)}
			className="flex items-center gap-2"
		>
			<Input
				placeholder="Value label (e.g. Production)"
				className="h-8 max-w-[220px] text-xs"
				{...form.register("label")}
			/>
			<Input
				placeholder="#888 (optional)"
				className="h-8 w-28 font-mono text-xs"
				{...form.register("color")}
			/>
			<Button
				type="submit"
				size="sm"
				variant="outline"
				disabled={form.formState.isSubmitting || !form.watch("label")}
				className="h-8 gap-1"
			>
				<Plus className="size-3.5" />
				Add
			</Button>
		</form>
	);
}

/** A dimension panel: header (label/key/mode + edit/delete) and its values. */
function DimensionPanel({
	dimension,
	onChanged,
}: {
	dimension: DimensionDTO;
	onChanged: () => void;
}) {
	return (
		<div className="rounded-lg border bg-surface p-4 shadow-sm">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<span className="font-display text-[14px] font-semibold text-foreground">
							{dimension.label}
						</span>
						<span className="font-mono text-[11px] text-muted-foreground">
							{dimension.key}
						</span>
						<Badge
							variant="outline"
							className="h-4 px-1 text-[10px] font-normal text-muted-foreground"
						>
							{dimension.multi ? "multi" : "single"}
						</Badge>
					</div>
					{dimension.description ? (
						<p className="mt-1 text-[12px] text-muted-foreground">
							{dimension.description}
						</p>
					) : null}
				</div>
				<div className="flex shrink-0 items-center gap-1">
					<DimensionDialog
						dimension={dimension}
						onSaved={onChanged}
						trigger={
							<Button variant="ghost" size="icon" aria-label="Edit dimension" className="size-8">
								<Pencil className="size-3.5" />
							</Button>
						}
					/>
					<AlertDialog>
						<AlertDialogTrigger asChild>
							<Button variant="ghost" size="icon" aria-label="Delete dimension" className="size-8">
								<Trash2 className="size-3.5 text-muted-foreground" />
							</Button>
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>Delete “{dimension.label}”?</AlertDialogTitle>
								<AlertDialogDescription>
									This removes the dimension, its values, and every assignment of
									those values across all resources. This cannot be undone.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>Cancel</AlertDialogCancel>
								<AlertDialogAction
									onClick={async () => {
										try {
											await deleteDimension(dimension.id);
											toast.success("Dimension deleted.");
											onChanged();
										} catch (e) {
											toast.error(
												e instanceof Error ? e.message : "Couldn't delete.",
											);
										}
									}}
								>
									Delete
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				</div>
			</div>

			<div className="mt-3 flex flex-wrap items-center gap-1.5">
				{dimension.values.length === 0 ? (
					<span className="text-[12px] text-muted-foreground">
						No values yet.
					</span>
				) : (
					dimension.values.map((v) => (
						<ValueChip key={v.id} value={v} onDeleted={onChanged} />
					))
				)}
			</div>

			<div className="mt-3 border-t border-border/60 pt-3">
				<AddValueForm dimensionId={dimension.id} onAdded={onChanged} />
			</div>
		</div>
	);
}

/** The Settings · Classification page body. */
export function ClassificationManager() {
	const qc = useQueryClient();
	const { data: dimensions, isPending } = useDimensionsQuery();

	/** Refetch the taxonomy after any mutation (shared cache for the pickers too). */
	const refresh = () =>
		qc.invalidateQueries({ queryKey: qk.classificationDimensions() });

	return (
		<div>
			<div className="mb-5 flex flex-wrap items-start justify-between gap-4">
				<div>
					<h1 className="font-display text-[19px] font-semibold tracking-[-0.01em] text-text-primary">
						Classification
					</h1>
					<p className="mt-1 max-w-xl text-[13px] text-muted-foreground">
						Define the axes (dimensions) and allowed values used to classify
						resources across your organization.
					</p>
				</div>
				<DimensionDialog
					onSaved={refresh}
					trigger={
						<Button size="sm" className="gap-1.5">
							<Plus className="size-3.5" />
							New dimension
						</Button>
					}
				/>
			</div>

			{isPending ? (
				<div className="space-y-3">
					<Skeleton className="h-28 w-full" />
					<Skeleton className="h-28 w-full" />
				</div>
			) : !dimensions || dimensions.length === 0 ? (
				<div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-14 text-center">
					<Tags className="size-6 text-muted-foreground" />
					<div>
						<p className="text-sm font-medium text-foreground">
							No dimensions yet
						</p>
						<p className="mt-1 text-[12.5px] text-muted-foreground">
							Create your first axis (e.g. Environment, Team, Data
							classification).
						</p>
					</div>
					<DimensionDialog
						onSaved={refresh}
						trigger={
							<Button size="sm" variant="outline" className="gap-1.5">
								<Plus className="size-3.5" />
								New dimension
							</Button>
						}
					/>
				</div>
			) : (
				<div className="space-y-3">
					{dimensions.map((d) => (
						<DimensionPanel key={d.id} dimension={d} onChanged={refresh} />
					))}
				</div>
			)}
		</div>
	);
}
