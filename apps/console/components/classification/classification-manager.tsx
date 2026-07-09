"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Classification — author the org's classification taxonomy (dimensions = axes ×
// their allowed values) and see how it is actually used. A master/detail: the dimension rail
// selects, the detail edits values (drag-reorder, color, usage drill), and a stat strip +
// coverage panels surface adoption. Read-only without `org:edit`. Reads/writes through the
// classification server actions via TanStack Query (shared cache with every picker).

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@repo/ui/alert-dialog";
import { Button } from "@repo/ui/button";
import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";
import { useQueryClient } from "@tanstack/react-query";
import { Lock, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type {
	DimensionDTO,
	ValueDTO,
} from "@/app/server/actions/classification/dimensions";
import {
	createDimensionWithValues,
	createValue,
	deleteDimension,
	deleteValue,
	reorderDimensions,
	reorderValues,
	updateDimension,
} from "@/app/server/actions/classification/dimensions";
import { qk } from "@/lib/query/keys";
import {
	useCanEditClassification,
	useDimensionsQuery,
} from "@/lib/query/use-classification-query";
import {
	CLASSIFICATION_TEMPLATES,
	type ClassificationTemplate,
} from "./classification-templates";
import { DimensionDetail } from "./dimension-detail";
import { DimensionDialog } from "./dimension-dialog";
import { DimensionRail } from "./dimension-rail";
import { ValueDrillDrawer } from "./value-drill-drawer";
import { ValueEditor } from "./value-editor";

/** Lowercases + hyphenates a label into a slug candidate. */
function slugify(input: string): string {
	return input
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

type DimDialog =
	| { mode: "create" }
	| { mode: "edit"; dimension: DimensionDTO }
	| null;
type DeleteTarget =
	| { kind: "dimension" | "value"; id: string; title: string; message: string }
	| null;

/** The Settings · Classification page body. */
export function ClassificationManager() {
	const qc = useQueryClient();
	const { data: dimensions, isPending } = useDimensionsQuery();
	const { data: canEdit = false } = useCanEditClassification();

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [dimDialog, setDimDialog] = useState<DimDialog>(null);
	const [valueEditor, setValueEditor] = useState<{
		dimensionId: string;
		dimensionLabel: string;
		value?: ValueDTO;
	} | null>(null);
	const [drill, setDrill] = useState<{
		value: ValueDTO;
		dimensionLabel: string;
	} | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);

	const refresh = () =>
		qc.invalidateQueries({ queryKey: qk.classificationDimensions() });

	const dims = useMemo(() => dimensions ?? [], [dimensions]);

	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		if (!q) return dims;
		return dims.filter(
			(d) =>
				d.label.toLowerCase().includes(q) ||
				d.key.toLowerCase().includes(q) ||
				d.values.some(
					(v) =>
						v.label.toLowerCase().includes(q) ||
						v.value.toLowerCase().includes(q),
				),
		);
	}, [dims, search]);

	const selectedDim =
		filtered.find((d) => d.id === selectedId) ?? filtered[0] ?? null;

	const stats = useMemo(() => {
		const values = dims.flatMap((d) => d.values);
		const used = values.filter((v) => v.assignmentCount > 0).length;
		return {
			dims: dims.length,
			values: values.length,
			assignments: values.reduce((n, v) => n + v.assignmentCount, 0),
			unused: values.length - used,
			coverage: values.length > 0 ? Math.round((used / values.length) * 100) : 0,
		};
	}, [dims]);

	/** Optimistically reorder cached dimensions, then persist. */
	const onReorderDims = (ids: string[]) => {
		qc.setQueryData<DimensionDTO[]>(qk.classificationDimensions(), (old) =>
			old ? [...old].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)) : old,
		);
		reorderDimensions(ids)
			.then(refresh)
			.catch((e) => {
				refresh();
				toast.error(e instanceof Error ? e.message : "Couldn't reorder.");
			});
	};

	/** Optimistically reorder a dimension's cached values, then persist. */
	const onReorderVals = (dimId: string, ids: string[]) => {
		qc.setQueryData<DimensionDTO[]>(qk.classificationDimensions(), (old) =>
			old?.map((d) =>
				d.id === dimId
					? {
							...d,
							values: [...d.values].sort(
								(a, b) => ids.indexOf(a.id) - ids.indexOf(b.id),
							),
						}
					: d,
			),
		);
		reorderValues(ids)
			.then(refresh)
			.catch((e) => {
				refresh();
				toast.error(e instanceof Error ? e.message : "Couldn't reorder.");
			});
	};

	/** Quick-add a value to a dimension from the inline input. */
	const onAddValue = (dim: DimensionDTO, label: string) => {
		createValue(dim.id, {
			value: slugify(label),
			label,
			color: undefined,
			position: dim.values.length,
		})
			.then(refresh)
			.catch((e) =>
				toast.error(e instanceof Error ? e.message : "Couldn't add value."),
			);
	};

	/** Flip a dimension's single/multi mode. */
	const onToggleMulti = (dim: DimensionDTO) => {
		updateDimension(dim.id, {
			key: dim.key,
			label: dim.label,
			description: dim.description ?? undefined,
			multi: !dim.multi,
			position: dim.position,
		})
			.then(refresh)
			.catch((e) =>
				toast.error(e instanceof Error ? e.message : "Couldn't update."),
			);
	};

	/** Seed a dimension + values from a starter template. */
	const applyTemplate = (t: ClassificationTemplate) => {
		createDimensionWithValues(
			{ key: t.key, label: t.label, description: t.description, multi: t.multi },
			t.values,
		)
			.then(({ id }) => {
				setSelectedId(id);
				refresh();
				toast.success(`Added “${t.label}”.`);
			})
			.catch((e) =>
				toast.error(
					e instanceof Error ? e.message : `Couldn't add “${t.label}”.`,
				),
			);
	};

	/** Confirm-and-delete the pending dimension or value. */
	const confirmDelete = async () => {
		if (!deleteTarget) return;
		try {
			if (deleteTarget.kind === "dimension") {
				await deleteDimension(deleteTarget.id);
			} else {
				await deleteValue(deleteTarget.id);
			}
			toast.success("Deleted.");
			setDeleteTarget(null);
			refresh();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't delete.");
		}
	};

	return (
		<div>
			{/* page header */}
			<header className="mb-5">
				<div className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-text-tertiary">
					Governance · Taxonomy
				</div>
				<h1 className="m-0 font-display text-[26px] font-semibold tracking-tight text-text-primary">
					Classification
				</h1>
				<p className="m-0 mt-2 max-w-[64ch] text-[13.5px] leading-relaxed text-text-secondary">
					Define the axes and allowed values every resource is classified by.
					Authored once here — consumed across connectors, projects, clusters,
					runners, members and more.
				</p>
			</header>

			{!canEdit && (
				<div className="mb-[18px] flex items-center gap-3 rounded-[3px] border border-border-strong bg-surface-sunken px-3.5 py-3">
					<Lock className="size-[15px] shrink-0 text-text-tertiary" />
					<span className="text-[12.5px] text-text-secondary">
						Read-only. You need the{" "}
						<b className="font-semibold text-text-primary">Editor</b> role (
						<span className="font-mono text-[11.5px]">org:edit</span>) to change the
						taxonomy.
					</span>
				</div>
			)}

			{isPending ? (
				<div className="space-y-3">
					<Skeleton className="h-16 w-full rounded-lg" />
					<Skeleton className="h-72 w-full rounded-lg" />
				</div>
			) : dims.length === 0 ? (
				<EmptyState
					canEdit={canEdit}
					onTemplate={applyTemplate}
					onCreate={() => setDimDialog({ mode: "create" })}
				/>
			) : (
				<div>
					{/* stat strip */}
					<div className="mb-[18px] flex overflow-hidden rounded-lg border bg-surface shadow-sm">
						<Stat label="Dimensions" value={stats.dims} unit="axes" />
						<Stat label="Values" value={stats.values} unit="allowed" />
						<Stat label="Assignments" value={stats.assignments} unit="pinned" />
						<Stat
							label="Coverage"
							value={`${stats.coverage}%`}
							unit="of values used"
							bar={stats.coverage}
						/>
						<Stat label="Unused" value={stats.unused} unit="values" last />
					</div>

					{/* toolbar */}
					<div className="mb-3.5 flex items-center gap-3">
						<div className="flex h-[34px] w-[250px] items-center gap-2 rounded-[2px] border border-border-strong bg-surface-sunken px-[11px]">
							<Search className="size-[15px] shrink-0 text-text-tertiary" />
							<input
								value={search}
								onChange={(e) => setSearch(e.target.value)}
								placeholder="Search dimensions & values"
								className="w-full border-none bg-transparent text-[13px] text-text-primary outline-none"
							/>
						</div>
						<span className="font-mono text-[11px] text-text-tertiary">
							{filtered.length === dims.length
								? `${dims.length} dimension${dims.length === 1 ? "" : "s"}`
								: `${filtered.length} of ${dims.length}`}
						</span>
						<div className="flex-1" />
						{canEdit && (
							<Button
								size="sm"
								className="gap-1.5"
								onClick={() => setDimDialog({ mode: "create" })}
							>
								<Plus className="size-3.5" />
								New dimension
							</Button>
						)}
					</div>

					{/* master-detail */}
					<div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[296px_1fr]">
						<DimensionRail
							dims={filtered}
							selectedId={selectedDim?.id ?? null}
							onSelect={setSelectedId}
							canEdit={canEdit}
							onReorder={onReorderDims}
						/>
						{selectedDim ? (
							<DimensionDetail
								dim={selectedDim}
								canEdit={canEdit}
								onEditDimension={() =>
									setDimDialog({ mode: "edit", dimension: selectedDim })
								}
								onDeleteDimension={() =>
									setDeleteTarget({
										kind: "dimension",
										id: selectedDim.id,
										title: `Delete “${selectedDim.label}”?`,
										message:
											"This removes the dimension, its values, and every assignment of those values across all resources. This cannot be undone.",
									})
								}
								onToggleMulti={() => onToggleMulti(selectedDim)}
								onReorderValues={(ids) => onReorderVals(selectedDim.id, ids)}
								onAddValue={(label) => onAddValue(selectedDim, label)}
								onEditValue={(value) =>
									setValueEditor({
										dimensionId: selectedDim.id,
										dimensionLabel: selectedDim.label,
										value,
									})
								}
								onDeleteValue={(value) =>
									setDeleteTarget({
										kind: "value",
										id: value.id,
										title: `Delete “${value.label}”?`,
										message:
											"This removes the value and clears it from every resource it was assigned to.",
									})
								}
								onDrill={(value) =>
									setDrill({ value, dimensionLabel: selectedDim.label })
								}
							/>
						) : (
							<div className="rounded-lg border border-dashed p-10 text-center font-mono text-[12px] text-text-tertiary">
								No dimensions match “{search}”.
							</div>
						)}
					</div>
				</div>
			)}

			{/* overlays */}
			<DimensionDialog
				open={Boolean(dimDialog)}
				onOpenChange={(o) => !o && setDimDialog(null)}
				dimension={dimDialog?.mode === "edit" ? dimDialog.dimension : undefined}
				onSaved={refresh}
			/>
			{valueEditor && (
				<ValueEditor
					open
					onOpenChange={(o) => !o && setValueEditor(null)}
					dimensionId={valueEditor.dimensionId}
					dimensionLabel={valueEditor.dimensionLabel}
					value={valueEditor.value}
					onSaved={refresh}
				/>
			)}
			<ValueDrillDrawer
				value={drill?.value ?? null}
				dimensionLabel={drill?.dimensionLabel ?? ""}
				onClose={() => setDrill(null)}
			/>
			<AlertDialog
				open={Boolean(deleteTarget)}
				onOpenChange={(o) => !o && setDeleteTarget(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{deleteTarget?.title}</AlertDialogTitle>
						<AlertDialogDescription>
							{deleteTarget?.message}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction onClick={confirmDelete}>Delete</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

/** One cell of the stat strip. */
function Stat({
	label,
	value,
	unit,
	bar,
	last,
}: {
	label: string;
	value: number | string;
	unit: string;
	bar?: number;
	last?: boolean;
}) {
	return (
		<div className={cn("flex-1 px-[18px] py-3.5", !last && "border-r")}>
			<div className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-text-tertiary">
				{label}
			</div>
			<div className="mt-[7px] font-display text-[22px] font-semibold tracking-tight">
				{value}
				<span className="ml-[7px] font-mono text-[11px] font-normal text-text-tertiary">
					{unit}
				</span>
			</div>
			{typeof bar === "number" && (
				<div className="mt-2.5 h-1 overflow-hidden rounded-full border bg-surface-sunken">
					<div
						className="h-full rounded-full bg-text-tertiary"
						style={{ width: `${bar}%` }}
					/>
				</div>
			)}
		</div>
	);
}

/** The blank-slate: starter templates + create-from-scratch. */
function EmptyState({
	canEdit,
	onTemplate,
	onCreate,
}: {
	canEdit: boolean;
	onTemplate: (t: ClassificationTemplate) => void;
	onCreate: () => void;
}) {
	return (
		<div className="rounded-md border border-dashed border-border-strong bg-surface px-[30px] py-[34px]">
			<div className="max-w-[60ch]">
				<div className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-text-tertiary">
					No dimensions yet
				</div>
				<h2 className="m-0 mb-[7px] font-display text-[19px] font-semibold tracking-tight">
					Start your taxonomy
				</h2>
				<p className="m-0 mb-[22px] text-[13px] leading-relaxed text-text-secondary">
					A classification is a set of named axes (dimensions) and their allowed
					values. Begin from a common template — everything stays editable — or
					author one from scratch.
				</p>
			</div>
			{canEdit && (
				<>
					<div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
						{CLASSIFICATION_TEMPLATES.map((t) => (
							<div
								key={t.key}
								className="flex flex-col gap-2.5 rounded-[4px] border bg-surface-sunken px-4 py-[15px]"
							>
								<div className="flex items-baseline justify-between gap-2.5">
									<span className="text-[13.5px] font-semibold text-text-primary">
										{t.label}
									</span>
									<span className="rounded-full border border-border-strong px-[7px] py-0.5 font-mono text-[9px] uppercase tracking-wide text-text-tertiary">
										{t.multi ? "multi" : "single"}
									</span>
								</div>
								<div className="min-h-[34px] text-[11.5px] leading-relaxed text-text-tertiary">
									{t.description}
								</div>
								<div className="flex items-center justify-between gap-2.5">
									<span className="font-mono text-[10.5px] text-text-tertiary">
										{t.values.map((v) => v.label).join(" · ")}
									</span>
									<Button
										size="sm"
										variant="outline"
										onClick={() => onTemplate(t)}
									>
										Use template
									</Button>
								</div>
							</div>
						))}
					</div>
					<Button className="gap-1.5" onClick={onCreate}>
						<Plus className="size-3.5" />
						Create a dimension
					</Button>
				</>
			)}
		</div>
	);
}
