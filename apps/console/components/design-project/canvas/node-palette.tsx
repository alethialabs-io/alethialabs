"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ArrowLeft, Boxes, GitBranch } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { AddonMarketItem } from "@/app/server/actions/addons";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import {
	AddonCompatBadge,
	AddonIcon,
	AddonStatusBadge,
} from "@/components/addons/addon-visuals";
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@repo/ui/command";
import { groupResults, rankItems } from "@repo/ui/command-search";
import {
	addCatalogue,
	type AddCatalogueFlags,
	type AddCatalogueGroup,
	type AddCatalogueRow,
} from "@/lib/canvas/store/add-catalogue";
import { getProvider } from "@/lib/cloud-providers";
import { PROJECT_NODE_ID } from "@/lib/canvas/store/types";
import { useAllNodes, useBoardActions, useEffectiveProvider } from "@/lib/canvas/store/use-board";
import { useInspectorPrefsStore } from "@/lib/stores/use-inspector-prefs-store";
import { NODE_REGISTRY, variantOptionsFor } from "./graph/node-registry";
import type { NodeKind } from "./graph/types";
import { GOVERNED_REASON, GOVERNED_ROW_REASON, notOnCloud } from "./toolbar/reasons";
import { useClusterK8sVersion } from "./use-cluster-k8s-version";

interface NodePaletteProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	identities: CloudIdentityOption[];
	/** Cluster add-ons for this environment — listed as an "Add-ons" group. Picking one opens its
	 * card on the rail (add-ons live on the canvas, not as design nodes). */
	addonItems?: AddonMarketItem[];
	onConfigureAddon?: (item: AddonMarketItem) => void;
	/** Opens the "bring your own Helm chart" flow. Absent when the feature is off: no row. */
	onAttachChart?: () => void;
	/** Opens the "bring your own IaC" flow. Absent when the feature is off: no row. */
	onAttachIac?: () => void;
	/** A bring-your-own IaC module governs the environment: every row is listed, and none can be
	 * picked. */
	governed?: boolean;
	/** Where a newly-added node lands. Supplied by the canvas (which owns the React Flow context);
	 * omitted (e.g. in a unit test) → the store's cascade fallback. */
	dropPosition?: () => { x: number; y: number };
}

/** One palette row: its group, the ONE string its search matches, and what it shows and runs. */
interface PaletteRow {
	id: string;
	group: string;
	/** What the shared ranker matches (the row's label and its secondary text). */
	searchText: string;
	/** Cannot be picked, and the row itself says why (a "Soon" mark). */
	disabled?: boolean;
	/** Cannot be picked, for this reason, which the row shows as text. */
	disabledReason?: string | null;
	onSelect: () => void;
	content: ReactNode;
}

/** A row's search text, for the shared ranker. */
const rowSearchText = (row: PaletteRow): string => row.searchText;

/** Whether a row cannot be chosen, for the shared ranker. */
const rowIsDisabled = (row: PaletteRow): boolean => Boolean(row.disabled || row.disabledReason);

/** What a search for a bring-your-own source also matches, beside its label. */
const SOURCE_KEYWORDS: Record<"byo-chart" | "byo-iac", string> = {
	"byo-chart": "bring your own helm chart byo gitops argocd repository",
	"byo-iac": "bring your own iac opentofu tofu terraform module byo repository",
};

/** True when `row` is in `groups` under the same heading: it can be added on this board. */
function isOffered(groups: AddCatalogueGroup[], title: string, row: AddCatalogueRow): boolean {
	return groups.some(
		(group) =>
			group.title === title &&
			group.rows.some((other) => other.type === row.type && other.id === row.id),
	);
}

/**
 * The add picker: a searchable, grouped menu over everything that can be added to this board.
 * Selecting a service drops its node on the canvas, CLOSES the picker, and leaves that node
 * selected with its card open on the rail. Kinds with variants (e.g. Database → engine) route
 * through a second step first.
 *
 * WHAT IT LISTS comes from one function, `addCatalogue(provider, flags, governed)`
 * (`lib/canvas/store/add-catalogue.ts`), which the command palette reads too — the two used to
 * build their own lists and disagreed: this one had add-ons and roadmap rows, that one had the
 * bring-your-own sources, and neither had both. There is no list of clouds or of kinds in this
 * file.
 *
 * A row that cannot be added is LISTED, disabled, with the reason in the row. The picker asks the
 * catalogue twice: once for this board (its cloud, its flags, whether a bring-your-own IaC module
 * governs it) and once for a board with no cloud and no module, which is everything that exists.
 * A row in the second answer and not in the first is one this board cannot take, and it says which
 * of the two reasons applies. Before this a kind the cloud cannot back was simply absent, which
 * reads as "the product does not have that" rather than "not on this cloud". A singleton that is
 * already placed and a roadmap row ("Soon") are disabled the same way.
 *
 * The picker used to stay open on an inline "Configure service" step (W5) instead of closing, and
 * that is the shape #4589 removed. Two things were wrong with it, and only the second is a test
 * problem. The wave's claim — written on `cards/workspace-rail.tsx` and asserted in
 * `e2e/architecture-canvas.spec.ts` — is that NOTHING on this page opens a modal over the board; an add
 * flow that parks a `CommandDialog` over the canvas is that modal, and it also meant the quick
 * config and the rail's Settings tab were two editors for one config. And because the second step
 * has no search box, the spec's `await expect(search).toBeHidden()` was satisfied by the STEP
 * CHANGE: the helper returned with the dialog still mounted, and its overlay then intercepted every
 * later click on the board — six gate tests timing out at their full 180s budget.
 *
 * So there is no second step here any more. The store's `addNode`/`addNodeWithConfig` already
 * select the new node and put its card on the rail, which is where its config now lives — one
 * editor, not two, and the board stays clickable behind it.
 */
export function NodePalette({
	open,
	onOpenChange,
	identities,
	addonItems,
	onConfigureAddon,
	onAttachChart,
	onAttachIac,
	governed = false,
	dropPosition,
}: NodePaletteProps) {
	const { addNode, addNodeWithConfig } = useBoardActions();
	const nodes = useAllNodes();
	// Which tab a kind's card opens on. Adding a service records "settings" for that kind: the
	// inline step this palette used to show WAS that form, and picking a service is a statement that
	// you intend to configure it. Written through the preference the tabs already keep, rather than a
	// second, parallel notion of "which tab is this card on" that could disagree with it.
	const setInspectorTab = useInspectorPrefsStore((s) => s.setTab);
	// The env's Kubernetes version as it will deploy, for the add-on compat badges: an unset
	// version resolves to the catalog default (#5314) — except on BYO-IaC, where the module decides
	// it and the badge says so (#5365); no cluster yet is an honest `not_evaluable`.
	const clusterK8s = useClusterK8sVersion();
	// The project root's effective provider decides which kinds this board can take.
	const coreProvider = useEffectiveProvider(PROJECT_NODE_ID);
	// When set, the palette shows the variant step for this kind (e.g. pick a DB engine). The ONLY
	// nested step left: it is part of naming WHICH service you are adding, so it still precedes the
	// add. Everything after the add happens on the rail.
	const [variantKind, setVariantKind] = useState<NodeKind | null>(null);
	// The search query, ranked by the shared ranker below. It starts empty each time the palette
	// opens (not as it closes, which would flash the full list during the exit animation) and each
	// time the step changes.
	const [search, setSearch] = useState("");
	const [wasOpen, setWasOpen] = useState(open);
	if (open !== wasOpen) {
		setWasOpen(open);
		if (open) setSearch("");
	}

	/** Moves to the variant step for `kind`, or back to the service list; the search starts over. */
	const setStep = (kind: NodeKind | null) => {
		setVariantKind(kind);
		setSearch("");
	};

	/** Reset the nested step whenever the dialog closes. */
	const handleOpenChange = (o: boolean) => {
		if (!o) setVariantKind(null);
		onOpenChange(o);
	};

	/** Land on the new node's card, on the tab that holds its config, and get out of the way. */
	const handOffToRail = (kind: NodeKind) => {
		setInspectorTab(kind, "settings");
		handleOpenChange(false);
	};

	/** Add a node of `kind`, through its variant step when the kind has one. */
	const add = (kind: NodeKind) => {
		if (NODE_REGISTRY[kind].variants) {
			setStep(kind);
			return;
		}
		// `addNode` selects the new node and opens its card on the rail; the palette closes behind it.
		addNode(kind, dropPosition?.());
		handOffToRail(kind);
	};

	/** Commit a variant choice: add the node pre-filled for it, then hand off to its rail card. */
	const pickVariant = (kind: NodeKind, value: string) => {
		const { key } = NODE_REGISTRY[kind].variants ?? { key: "" };
		addNodeWithConfig(kind, { [key]: value }, null, dropPosition?.());
		setVariantKind(null);
		handOffToRail(kind);
	};

	const noCloud = identities.length === 0;
	const variantDef = variantKind ? NODE_REGISTRY[variantKind] : null;

	// The catalogue, asked twice (see the component's doc comment).
	const flags: AddCatalogueFlags = {
		byoHelm: onAttachChart !== undefined,
		byoIac: onAttachIac !== undefined,
		addons:
			onConfigureAddon && addonItems
				? addonItems.map((a) => ({ id: a.id, name: a.name, subtitle: a.summary }))
				: undefined,
	};
	const offered = addCatalogue(coreProvider, flags, governed);
	const everything = addCatalogue(null, flags, false);
	const whyNot = governed
		? GOVERNED_ROW_REASON
		: coreProvider
			? notOnCloud(getProvider(coreProvider).name)
			: null;

	/** The variant step's options for `variantKind`, provider-filtered (e.g. Hetzner's in-cluster
	 * charts back PostgreSQL/Valkey only) — same gate as the inspector's engine radio. */
	const variantRows: PaletteRow[] =
		variantDef && variantKind
			? variantOptionsFor(variantKind, coreProvider).map((opt) => {
					const Icon = variantDef.icon;
					return {
						id: opt.value,
						group: `${variantDef.label} type`,
						searchText: `${opt.label} ${opt.description}`,
						onSelect: () => pickVariant(variantKind, opt.value),
						content: (
							<>
								<Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
								<div className="min-w-0 flex-1">
									<div className="text-sm font-medium">{opt.label}</div>
									<div className="truncate text-xs text-muted-foreground">
										{opt.description}
									</div>
								</div>
							</>
						),
					};
				})
			: [];

	/** The icon, name and second line every row shares. */
	const body = (icon: ReactNode, label: string, subtitle: string): ReactNode => (
		<>
			{icon}
			<div className="min-w-0 flex-1">
				<div className="text-sm font-medium">{label}</div>
				<div className="truncate text-xs text-muted-foreground">{subtitle}</div>
			</div>
		</>
	);

	/** One catalogue row as a palette row; `unavailable` is why this board cannot take it. */
	const paletteRow = (
		group: string,
		entry: AddCatalogueRow,
		unavailable: string | null,
	): PaletteRow | null => {
		switch (entry.type) {
			case "kind": {
				const Icon = entry.icon;
				const onCanvas = entry.singleton && nodes.some((n) => n.data.kind === entry.kind);
				return {
					id: entry.id,
					group,
					searchText: `${entry.label} ${entry.subtitle}`,
					disabledReason:
						unavailable ??
						(onCanvas ? "Already on the board. An environment has one." : null),
					onSelect: () => add(entry.kind),
					content: body(
						<Icon className="h-4 w-4 shrink-0 text-muted-foreground" />,
						entry.label,
						entry.subtitle,
					),
				};
			}
			case "roadmap": {
				const Icon = entry.icon;
				return {
					id: entry.id,
					group,
					searchText: `${entry.label} ${entry.subtitle}`,
					disabled: true,
					onSelect: () => {},
					content: (
						<>
							{body(
								<Icon className="h-4 w-4 shrink-0 text-muted-foreground" />,
								entry.label,
								entry.subtitle,
							)}
							<span className="font-mono text-ui-2xs uppercase text-muted-foreground">
								Soon
							</span>
						</>
					),
				};
			}
			case "addon": {
				const a = addonItems?.find((item) => item.id === entry.id);
				if (!a || !onConfigureAddon) return null;
				return {
					id: `addon-${a.id}`,
					group,
					// A deprecated add-on stays findable (an environment may already have it), but its row
					// names the replacement, so a new install is steered there before the card opens (#6543).
					searchText: `add-on ${a.name} ${a.summary} ${a.category}${a.deprecated ? ` deprecated ${a.deprecated.replacementName}` : ""}`,
					disabledReason: unavailable,
					onSelect: () => {
						onConfigureAddon(a);
						handleOpenChange(false);
					},
					content: (
						<>
							{body(
								<AddonIcon
									icon={a.icon}
									className="h-4 w-4 shrink-0 text-muted-foreground"
								/>,
								a.name,
								a.deprecated && !a.install
									? `Deprecated. Use ${a.deprecated.replacementName} instead.`
									: a.summary,
							)}
							{/* Compat sits BEFORE the install slot and only when it wants attention — an add-on
							    whose recorded window fits this cluster shows nothing at all. */}
							<AddonCompatBadge
								addonId={a.id}
								k8sVersion={clusterK8s.version}
								versionUnknownReason={clusterK8s.reason}
							/>
							{a.install ? (
								<AddonStatusBadge
									status={a.install.status}
									health={a.install.health}
								/>
							) : a.deprecated ? (
								<span className="font-mono text-ui-2xs uppercase text-muted-foreground">
									Deprecated
								</span>
							) : (
								<span className="font-mono text-ui-2xs uppercase text-muted-foreground">
									Free
								</span>
							)}
						</>
					),
				};
			}
			case "source": {
				const attach = entry.id === "byo-chart" ? onAttachChart : onAttachIac;
				if (!attach) return null;
				const Icon = entry.id === "byo-chart" ? GitBranch : Boxes;
				return {
					id: entry.id,
					group,
					searchText: `${entry.label} ${entry.subtitle} ${SOURCE_KEYWORDS[entry.id]}`,
					disabledReason: unavailable,
					onSelect: () => {
						attach();
						handleOpenChange(false);
					},
					content: body(
						<Icon className="h-4 w-4 shrink-0 text-muted-foreground" />,
						entry.label,
						entry.subtitle,
					),
				};
			}
		}
	};

	const serviceRows: PaletteRow[] = everything.flatMap((group) =>
		group.rows.flatMap((entry) => {
			const row = paletteRow(
				group.title,
				entry,
				isOffered(offered, group.title, entry) ? null : whyNot,
			);
			return row ? [row] : [];
		}),
	);

	// Whichever step is showing, ranked by the shared ranker.
	// While a search is typed, a disabled row ("Soon", already on the canvas, not on this cloud)
	// ranks after every row that can be added. An empty search keeps the catalogue's order exactly,
	// whatever is placed.
	const results = rankItems(
		variantDef ? variantRows : serviceRows,
		search,
		rowSearchText,
		rowIsDisabled,
	);
	const groups = groupResults(results, (row) => row.group);

	/** The "Back to services" row, above the variant options while nothing is typed. Hidden once the
	 * user searches, so the first highlighted row (what Enter runs) is always their best match. */
	const backRow: PaletteRow = {
		id: "__back",
		group: "",
		searchText: "",
		onSelect: () => setStep(null),
		content: (
			<>
				<ArrowLeft className="h-4 w-4 shrink-0" />
				<span className="text-sm">Back to services</span>
			</>
		),
	};

	const showBack = variantDef !== null && search.trim() === "";

	/** Renders one row as a `CommandItem`. */
	const item = (row: PaletteRow, className = "gap-3") => (
		<CommandItem
			key={row.id}
			disabled={row.disabled}
			disabledReason={row.disabledReason}
			onSelect={row.onSelect}
			className={className}
		>
			{row.content}
		</CommandItem>
	);

	return (
		<CommandDialog
			open={open}
			onOpenChange={handleOpenChange}
			title={
				variantDef
					? `Choose ${variantDef.label.toLowerCase()} type`
					: "Add a service"
			}
			description="Search and add infrastructure to your project."
			className="sm:max-w-xl"
			search={search}
			onSearchChange={setSearch}
			filteredItems={showBack ? [backRow, ...results] : results}
		>
			{variantDef ? (
				<>
					<CommandInput
						placeholder={`Choose a ${variantDef.label.toLowerCase()} type…`}
					/>
					<CommandList className="max-h-[60vh]">
						<CommandEmpty>No option matches.</CommandEmpty>
						{showBack && (
							<>
								<CommandGroup>{item(backRow, "gap-3 text-muted-foreground")}</CommandGroup>
								<CommandSeparator />
							</>
						)}
						{groups.map(({ group, items }) => (
							<CommandGroup key={group} heading={group}>
								{items.map((row) => item(row))}
							</CommandGroup>
						))}
					</CommandList>
				</>
			) : (
				<>
					<CommandInput placeholder="Search services — database, redis, bucket, queue…" />
					<CommandList className="max-h-[60vh]">
						<CommandEmpty>No service matches.</CommandEmpty>
						{governed && (
							<p role="note" className="px-3 py-2 text-xs text-muted-foreground">
								{GOVERNED_REASON}
							</p>
						)}
						{!governed && noCloud && (
							<p className="px-3 py-2 text-xs text-muted-foreground">
								Tip: connect a cloud account to provision these for real — you can still
								design now.
							</p>
						)}
						{groups.map(({ group, items }) => (
							<CommandGroup key={group} heading={group}>
								{items.map((row) => item(row))}
							</CommandGroup>
						))}
					</CommandList>
				</>
			)}
		</CommandDialog>
	);
}
