"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Classification — author the org's classification taxonomy (dimensions = axes ×
// their allowed values) and see how it is actually used. A master/detail: the dimension rail
// selects, the detail edits values (drag- or arrow-reorder, usage drill). Search is server-side.
// The search and the selected dimension are URL state (`?search=`, `?selected=`), so a link or a
// refresh reproduces the view (F-28). Read-only without `org:edit`: the create button stays on
// screen, disabled with its reason, and the blank slate says who sets the taxonomy up (F-27). The
// section title lives in the settings sidebar, so this page
// leads straight into a toolbar (no in-page header). Reads are the `classification.*` GET
// procedures (the route prefetches the taxonomy, the edit decision and the first dimension's
// coverage, so the page paints with them); every write goes through `useActionMutation` — pending
// state, one toast policy, and every classification read invalidated (#6129). A change another
// member makes arrives as a `classification` hint (lib/query/topics.ts) — no poll, no reload.

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
import { DisabledReason } from "@repo/ui/disabled-reason";
import { EmptyState } from "@repo/ui/empty";
import { SectionHeading } from "@repo/ui/section-heading";
import { TooltipProvider } from "@repo/ui/tooltip";
import { BookOpen, Plus } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type {
	DimensionDTO,
	ValueDTO,
} from "@/app/server/actions/classification/dimensions";
import {
	createValue,
	deleteDimension,
	deleteValue,
	reorderDimensions,
	reorderValues,
	updateDimension,
} from "@/app/server/actions/classification/dimensions";
import { MANAGE_DENIED_REASON, MANAGE_PENDING_REASON } from "@/components/errors/manage-gate";
import { RegionError } from "@/components/errors/region-error";
import { SettingsSearch } from "@/components/settings/settings-ui";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
	classificationReadKeys,
	dimensionsInput,
	useCanEditClassification,
	useDimensionsQuery,
} from "@/lib/query/use-classification-query";
import {
	hrefWithParamPatch,
	type ParamPatch,
	selectionFromUrl,
	selectionPatch,
} from "@/lib/query/view-url-params";
import { orpc } from "@/lib/rpc/client";
import { readRefusalOf } from "@/lib/rpc/refusal";
import {
	CLASSIFICATION_TEMPLATES,
	type ClassificationTemplate,
} from "./classification-templates";
import { ClassificationBodySkeleton } from "./classification-skeleton";
import { Spinner } from "./classification-ui";
import { DimensionDetail } from "./dimension-detail";
import { DimensionEditorSheet } from "./dimension-editor-sheet";
import { slugifyOrEmpty } from "@/lib/utils/slugify";
import { DimensionRail } from "./dimension-rail";
import { ValueDrillDrawer } from "./value-drill-drawer";
import { ValueEditor } from "./value-editor";
import { ClassificationNoAccess } from "./classification-no-access";

type Sheet =
	| { mode: "create"; templateKey?: string }
	| { mode: "edit"; dimension: DimensionDTO }
	| null;
type DeleteTarget =
	| { kind: "dimension" | "value"; id: string; title: string; message: string }
	| null;

/** The param carrying the taxonomy search. */
const SEARCH_PARAM = "search";

/** Reorders a cached taxonomy by `ids` (an optimistic patch; `ids` is the full new order). */
function reorderedDims(current: unknown, ids: string[]): unknown {
	if (!isTaxonomy(current)) return current;
	return [...current].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
}

/** Narrows a cached value to the taxonomy the reorder patches read (every entry has an id). */
function isTaxonomy(value: unknown): value is DimensionDTO[] {
	return (
		Array.isArray(value) &&
		value.every((d: unknown) => typeof d === "object" && d !== null && "id" in d && "values" in d && Array.isArray(d.values))
	);
}

/** Reorders one dimension's cached values by `ids` (an optimistic patch). */
function reorderedValues(current: unknown, dimId: string, ids: string[]): unknown {
	if (!isTaxonomy(current)) return current;
	return current.map((d) =>
		d.id === dimId
			? { ...d, values: [...d.values].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)) }
			: d,
	);
}

/** The Settings · Classification page body. */
export function ClassificationManager() {
	const searchParams = useSearchParams();
	const urlSearch = (searchParams.get(SEARCH_PARAM) ?? "").trim();
	const urlSelectedId = selectionFromUrl(searchParams);

	/**
	 * Applies a param patch to the address bar, in place. `history.replaceState`, not
	 * `router.replace`: the router's version is a navigation that re-renders the server route for a
	 * change only this component reads; Next keeps `useSearchParams` in step with the native call.
	 */
	const patchUrl = (patch: ParamPatch) =>
		window.history.replaceState(
			null,
			"",
			hrefWithParamPatch(window.location.pathname, window.location.search, patch),
		);

	// The box starts from the link's search, and a search the link carried lands at once; only
	// typing is debounced (`urlRead`, #5861).
	const [searchInput, setSearchInput] = useState(urlSearch);
	const search = useDebouncedValue(searchInput.trim(), 250, { urlRead: true });
	const searching = search.length > 0;

	// A navigation moved the URL's search (a link to this page with another `?search=`): the box
	// follows it (adjusted during render, React's "storing information from previous renders"). Our
	// own write sets the URL to the settled search it just wrote, so that change is recognised and
	// never overwrites what is being typed.
	const [seenUrlSearch, setSeenUrlSearch] = useState(urlSearch);
	if (urlSearch !== seenUrlSearch) {
		setSeenUrlSearch(urlSearch);
		if (urlSearch !== search) setSearchInput(urlSearch);
	}

	// The settled search is written to the URL, and a selection made under the old search is dropped
	// with it (a selected row only means something under the search it was chosen in). Written only
	// when the settled search CHANGES, so a URL that a navigation moved is never written over.
	const writtenSearch = useRef(search);
	useEffect(() => {
		if (writtenSearch.current === search) return;
		writtenSearch.current = search;
		if (search === urlSearch) return;
		window.history.replaceState(
			null,
			"",
			hrefWithParamPatch(window.location.pathname, window.location.search, {
				[SEARCH_PARAM]: search || null,
				...selectionPatch(null),
			}),
		);
	}, [search, urlSearch]);

	const dimensionsQuery = useDimensionsQuery(search);
	const { data: dimensions, isPending, isFetching } = dimensionsQuery;
	const canEditQuery = useCanEditClassification();
	const canEdit = canEditQuery.data ?? false;
	// Why the create button is disabled, or null when it is not: the edit decision has not answered
	// yet, or it answered no.
	const createReason = canEditQuery.isPending
		? MANAGE_PENDING_REASON
		: canEdit
			? null
			: MANAGE_DENIED_REASON;
	// The unsearched taxonomy's key: what a reorder patches optimistically (reordering is only
	// offered while not searching).
	const baseKey = orpc.classification.dimensions.queryKey({ input: dimensionsInput() });

	const [sheet, setSheet] = useState<Sheet>(null);
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

	const dims = dimensions ?? [];
	const selectedDim = dims.find((d) => d.id === urlSelectedId) ?? dims[0] ?? null;
	const reorderable = canEdit && !searching;

	// Every write below goes through the mutation contract: pending while in flight, one toast
	// policy (a refusal's sentence verbatim, never raw server text), a reorder's optimistic patch
	// rolled back if refused, and every classification read invalidated when it settles.
	const reorderDims = useActionMutation(reorderDimensions, {
		invalidates: classificationReadKeys(),
		optimistic: [{ key: baseKey, update: (current, v) => reorderedDims(current, v.ids) }],
	});
	const reorderVals = useActionMutation(
		(v: { dimId: string; ids: string[] }) => reorderValues({ ids: v.ids }),
		{
			invalidates: classificationReadKeys(),
			optimistic: [{ key: baseKey, update: (current, v) => reorderedValues(current, v.dimId, v.ids) }],
		},
	);
	const addValue = useActionMutation(createValue, { invalidates: classificationReadKeys() });
	const toggleMulti = useActionMutation(updateDimension, { invalidates: classificationReadKeys() });
	const removal = useActionMutation(
		(target: NonNullable<DeleteTarget>) =>
			target.kind === "dimension" ? deleteDimension({ id: target.id }) : deleteValue({ id: target.id }),
		{
			invalidates: classificationReadKeys(),
			successMessage: "Deleted.",
			onSuccess: () => setDeleteTarget(null),
		},
	);
	const deleting = removal.isPending;

	/** Optimistically reorder cached dimensions, then persist. One reorder at a time. */
	const onReorderDims = (ids: string[]) => {
		if (!reorderDims.isPending) reorderDims.mutate({ ids });
	};

	/** Optimistically reorder a dimension's cached values, then persist. One reorder at a time. */
	const onReorderVals = (dimId: string, ids: string[]) => {
		if (!reorderVals.isPending) reorderVals.mutate({ dimId, ids });
	};

	/**
	 * Quick-add a value to a dimension (awaited so the row can show pending). Resolves true once the
	 * value exists and false when it was refused, so the row keeps what was typed on a refusal (F-14).
	 */
	const onAddValue = async (dim: DimensionDTO, label: string): Promise<boolean> => {
		if (addValue.isPending) return false;
		// A refusal is already toasted by the contract; the row only needs to know how it settled.
		return addValue
			.mutateAsync({ dimensionId: dim.id, value: slugifyOrEmpty(label), label, position: dim.values.length })
			.then(
				() => true,
				() => false,
			);
	};

	/** Flip a dimension's single/multi mode (awaited so the switch can show pending). */
	const onToggleMulti = async (dim: DimensionDTO) => {
		if (toggleMulti.isPending) return;
		await toggleMulti
			.mutateAsync({
				id: dim.id,
				key: dim.key,
				label: dim.label,
				description: dim.description ?? undefined,
				multi: !dim.multi,
				applies_to: dim.appliesTo,
				position: dim.position,
			})
			.catch(() => undefined);
	};

	/** Confirm-and-delete the pending dimension or value, with a pending state. */
	const confirmDelete = () => {
		if (!deleteTarget || removal.isPending) return;
		removal.mutate(deleteTarget);
	};

	// Refused (no `org:view` — a viewer whose access went away while the page was open): the
	// no-access render, never the blank slate and never a failure (B4).
	if (readRefusalOf(dimensionsQuery.error) === "forbidden") return <ClassificationNoAccess />;

	return (
		<TooltipProvider delayDuration={200}>
			{/* toolbar */}
			<div className="mb-4 flex items-center gap-2.5">
				<SettingsSearch
					value={searchInput}
					onChange={setSearchInput}
					placeholder="Search dimensions & values"
					className="w-[240px]"
				/>
				{/* No count pill: the list standard draws none (#7481). The taxonomy is read whole and
				    unpaged because it is bounded on the server: CLASSIFICATION_DIMENSIONS_MAX per org
				    and CLASSIFICATION_VALUES_MAX per dimension, enforced by the create actions. */}
				{searching && isFetching ? (
					<span className="text-text-tertiary">
						<Spinner size={13} />
					</span>
				) : null}
				<div className="flex-1" />
				<a
					href="/docs/guides/classification"
					target="_blank"
					rel="noopener noreferrer"
					title="What is classification?"
					className="grid size-9 shrink-0 place-items-center rounded-sm border border-border-strong bg-surface-sunken text-text-tertiary transition-colors hover:text-text-primary"
				>
					<BookOpen className="size-4" />
					<span className="sr-only">What is classification?</span>
				</a>
				{/* On screen for everyone; disabled WITH its reason for a viewer who cannot edit. */}
				<DisabledReason reason={createReason}>
					<Button
						size="sm"
						className="gap-1.5"
						onClick={() => setSheet({ mode: "create" })}
					>
						<Plus className="size-3.5" />
						New dimension
					</Button>
				</DisabledReason>
			</div>

			{dimensionsQuery.isError && dimensions === undefined ? (
				// A failed read is not an empty taxonomy (B4): the blank slate below is an ANSWER.
				<RegionError
					title="Couldn't load the classification taxonomy"
					description="Something went wrong reading this organization's dimensions and values."
					onRetry={() => void dimensionsQuery.refetch()}
				/>
			) : isPending ? (
				// The route skeleton's body, so a read that was not prefetched draws the same shape.
				<ClassificationBodySkeleton />
			) : dims.length === 0 && !searching ? (
				<TaxonomyBlankSlate
					canEdit={canEdit}
					onTemplate={(t) => setSheet({ mode: "create", templateKey: t.key })}
					onCreate={() => setSheet({ mode: "create" })}
				/>
			) : dims.length === 0 ? (
				// `p-12`, not `py-12`, so the empty-state matcher never saw this one — it is the same
				// hand-rolled centred nothing either way.
				<EmptyState
					className="border"
					title="No matches"
					description={`No dimensions or values match “${search}”.`}
				/>
			) : (
				<div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[296px_1fr]">
					<DimensionRail
						dims={dims}
						selectedId={selectedDim?.id ?? null}
						onSelect={(id) => patchUrl(selectionPatch(id))}
						reorderable={reorderable}
						onReorder={onReorderDims}
					/>
					{selectedDim && (
						<DimensionDetail
							dim={selectedDim}
							canEdit={canEdit}
							reorderable={reorderable}
							onEditDimension={() =>
								setSheet({ mode: "edit", dimension: selectedDim })
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
					)}
				</div>
			)}

			{/* overlays */}
			<DimensionEditorSheet
				open={Boolean(sheet)}
				onOpenChange={(o) => !o && setSheet(null)}
				dimension={sheet?.mode === "edit" ? sheet.dimension : undefined}
				initialTemplateKey={sheet?.mode === "create" ? sheet.templateKey : undefined}
			/>
			{valueEditor && (
				<ValueEditor
					open
					onOpenChange={(o) => !o && setValueEditor(null)}
					dimensionId={valueEditor.dimensionId}
					dimensionLabel={valueEditor.dimensionLabel}
					value={valueEditor.value}
				/>
			)}
			<ValueDrillDrawer
				value={drill?.value ?? null}
				dimensionLabel={drill?.dimensionLabel ?? ""}
				onClose={() => setDrill(null)}
			/>
			<AlertDialog
				open={Boolean(deleteTarget)}
				onOpenChange={(o) => !o && !deleting && setDeleteTarget(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{deleteTarget?.title}</AlertDialogTitle>
						<AlertDialogDescription>
							{deleteTarget?.message}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={(e) => {
								// Stay open while the delete is in flight; `onSuccess` closes it.
								e.preventDefault();
								confirmDelete();
							}}
							disabled={deleting}
						>
							{deleting && <Spinner />}
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</TooltipProvider>
	);
}

/**
 * The blank-slate: starter templates (open the editor pre-filled) + create-from-scratch.
 *
 * NOT `EmptyState` from `@repo/ui/empty`, and no longer named as though it were: a grid of
 * pickable starter templates is more than that component expresses, and one file cannot hold two
 * things called `EmptyState`. The no-search-matches state above IS the shared one.
 */
function TaxonomyBlankSlate({
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
				{/* 19px was this file's own answer to a rung the console typesets at 15px
				    everywhere else. The shared component owns the size now; the block below keeps
				    the spacing the heading used to carry. */}
				<SectionHeading
					className="mb-[7px]"
					level={2}
					title={canEdit ? "Start your taxonomy" : "No classification yet"}
				/>
				{/* A viewer who cannot edit is not invited to begin from templates they are not
				    shown (F-27): they are told what this is and who sets it up. */}
				<p className="m-0 mb-[22px] text-ui-md leading-relaxed text-text-secondary">
					{canEdit
						? "A classification is a set of named axes (dimensions) and their allowed values. Begin from a common template — you can adjust everything before creating — or author one from scratch."
						: "A classification is a set of named axes (dimensions) and their allowed values. An owner or admin of this organization sets them up; once they do, they appear here with how each is used."}
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
									<span className="text-ui-md font-semibold text-text-primary">
										{t.label}
									</span>
									<span className="rounded-full border border-border-strong px-[7px] py-0.5 font-mono text-ui-3xs uppercase tracking-wide text-text-tertiary">
										{t.multi ? "multi" : "single"}
									</span>
								</div>
								<div className="min-h-[34px] text-ui-xs leading-relaxed text-text-tertiary">
									{t.description}
								</div>
								<div className="flex items-center justify-between gap-2.5">
									<span className="font-mono text-ui-2xs text-text-tertiary">
										{t.values.map((v) => v.label).join(" · ")}
									</span>
									<Button size="sm" variant="outline" onClick={() => onTemplate(t)}>
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
