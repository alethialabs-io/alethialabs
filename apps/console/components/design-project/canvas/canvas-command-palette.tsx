"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@repo/ui/command";
import { groupResults, useCommandSearch } from "@repo/ui/command-search";
import type { ReactNode } from "react";
import { ArrowRight, Boxes, GitBranch } from "lucide-react";
import {
	PROVIDERS,
	getProvider,
	type CloudProviderMeta,
} from "@/lib/cloud-providers";
import { addCatalogue, catalogueKinds } from "@/lib/canvas/store/add-catalogue";
import { useBoard } from "@/lib/canvas/store/canvas-store-provider";
import { PROJECT_NODE_ID } from "@/lib/canvas/store/types";
import {
	useAllNodes,
	useBoardActions,
	useEffectiveProvider,
	useHiddenKinds,
	useShowConnections,
} from "@/lib/canvas/store/use-board";
import { NODE_REGISTRY } from "./graph/node-registry";
import type { NodeKind } from "./graph/types";
import { configName } from "./graph/node-config";
import { NOTHING_TO_FIT } from "./use-has-drawn-nodes";

/** Maps a node kind to its provider-specific service-name field. */
const SERVICE_FIELD: Partial<Record<NodeKind, keyof CloudProviderMeta>> = {
	cluster: "clusterService",
	network: "networkName",
	database: "dbService",
	cache: "cacheService",
	queue: "queueService",
	topic: "topicService",
	nosql: "nosqlService",
	dns: "dnsService",
	secret: "secretsService",
	bucket: "storageService",
	registry: "registryService",
};

/** Hand-curated search synonyms so real service names / tech terms match. */
const SYNONYMS: Partial<Record<NodeKind, string[]>> = {
	database: ["rds", "postgres", "postgresql", "mysql", "sql", "db", "relational"],
	cache: ["redis", "valkey", "in-memory"],
	dns: ["domain", "cloudflare", "records"],
	cluster: ["kubernetes", "k8s", "compute", "nodes", "workload"],
	queue: ["messaging", "fifo"],
	topic: ["pubsub", "events", "fan-out"],
	nosql: ["dynamodb", "firestore", "cosmos", "document", "key-value"],
	secret: ["secrets", "credentials", "vault", "password"],
	bucket: ["s3", "object storage", "storage", "files", "assets", "blob"],
	registry: ["docker", "ecr", "container images", "oci", "harbor", "images"],
	network: ["vpc", "vnet", "subnet", "cidr"],
	repositories: ["repo", "git", "gitops", "argocd", "deploy"],
};

/** All searchable keywords for a kind: provider service names (every cloud) + synonyms. */
function keywordsFor(kind: NodeKind): string[] {
	const field = SERVICE_FIELD[kind];
	const serviceNames = field
		? Object.values(PROVIDERS)
				.map((p) => p[field])
				.filter((v): v is string => typeof v === "string" && v !== "—")
		: [];
	return Array.from(
		new Set([
			NODE_REGISTRY[kind].label,
			...serviceNames,
			...(SYNONYMS[kind] ?? []),
		]),
	);
}

/** The palette's groups, in the order they list for an empty search. */
type PaletteGroup = "Sources" | "Add" | "Jump to" | "Actions" | "Layers";

/** One palette row: what it shows, what it runs, and the ONE string its search matches. */
interface PaletteCommand {
	/** Stable id: the React key. Action and "Add" rows also fold it into their search text, as
	 * cmdk matched their `value`; "Jump to" rows do not (theirs is a node id nobody types). */
	id: string;
	group: PaletteGroup;
	/** The visible label plus its keywords: what the shared ranker matches. */
	searchText: string;
	run: () => void;
	disabledReason?: string | null;
	content: ReactNode;
}

/** A row's search text, for the shared ranker. */
const commandSearchText = (c: PaletteCommand): string => c.searchText;

/** While a search is typed, a row that cannot run ranks after every row that can, so Enter never
 * lands on it first. An empty search keeps the palette's own order. */
const commandIsDisabled = (c: PaletteCommand): boolean => Boolean(c.disabledReason);

interface CanvasCommandPaletteProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Create flow only — turns the canvas into a project. Omitted on a live project, where the
	 * pending-changes bar is the only path changes take. */
	onSave?: () => void;
	/** Optional — only present while the legacy form view still exists. */
	onToggleView?: () => void;
	onFitView: () => void;
	/** The board draws nothing, so "Fit view" is shown disabled with {@link NOTHING_TO_FIT}. */
	fitViewDisabled?: boolean;
	onAskAi: () => void;
	/** Auto-arrange the board (shared with the ⋯ menu and the pane context menu). */
	onArrange: () => void;
	/** Open the environment-settings card; absent while a BYO-IaC source governs the env. */
	onEnvSettings?: () => void;
	/** Open the activity card (edit mode only). */
	onActivity?: () => void;
	/** Opens the "bring your own Helm chart" flow. Omitted when the feature is off / no project. */
	onAttachChart?: () => void;
	/** Opens the "bring your own IaC" flow. Omitted when the feature is off / no project / a source
	 * already governs the env. */
	onAttachIac?: () => void;
	/** When an IaC source governs the env (replace mode), component-add is meaningless — the
	 * catalogue is empty and the "Add" group is not listed. */
	disableComponentAdd?: boolean;
	/** Open the shortcut sheet. */
	onShowShortcuts?: () => void;
	/** W5 click-to-place — where a newly-added node lands (viewport centre). Supplied by the canvas
	 * (which owns the React Flow context); omitted (e.g. a unit test) → the store's cascade fallback. */
	dropPosition?: () => { x: number; y: number };
}

/**
 * ⌘K command menu: add a service, jump to a card, tidy, fit, undo, switch a layer, open the
 * environment's settings or activity, ask the assistant. Running a job is the toolbar's Run menu:
 * its four jobs queue real work, and they stay behind the one control that holds their
 * double-submit guard.
 *
 * Its "Add" rows are the design kinds of `addCatalogue(provider, flags, governed)`
 * (`lib/canvas/store/add-catalogue.ts`), the same call the add picker makes, so the two cannot
 * list different kinds. A singleton that is already placed is selected, not added again. There is
 * no list of clouds here: a cloud's own service name (`RDS`, `Cloud SQL`) is read from the catalog
 * for the project's cloud, and the search keywords are every cloud's names for the kind.
 */
export function CanvasCommandPalette({
	open,
	onOpenChange,
	onSave,
	onToggleView,
	onFitView,
	fitViewDisabled = false,
	onAskAi,
	onArrange,
	onEnvSettings,
	onActivity,
	onAttachChart,
	onAttachIac,
	disableComponentAdd,
	onShowShortcuts,
	dropPosition,
}: CanvasCommandPaletteProps) {
	const board = useBoard();
	const { addNode, undo, redo, repairOverlaps } = useBoardActions();
	const openInspector = (id: string) => board.view.getState().openInspector(id);
	const showConnections = useShowConnections();
	const toggleConnections = () => board.view.getState().toggleConnections();
	const nodes = useAllNodes();
	const hiddenKinds = useHiddenKinds();
	const toggleKindVisibility = (kind: NodeKind) => board.view.getState().toggleKindVisibility(kind);
	// Null until the project has a cloud: every kind is offered, and no service name is shown.
	const coreProvider = useEffectiveProvider(PROJECT_NODE_ID);
	const meta = coreProvider ? getProvider(coreProvider) : null;

	const run = (fn: () => void) => {
		fn();
		onOpenChange(false);
	};

	/** An "Add <service>" row for `kind`, in its classification's group. */
	const serviceCommand = (kind: NodeKind, group: PaletteGroup): PaletteCommand => {
		const def = NODE_REGISTRY[kind];
		const Icon = def.icon;
		const field = SERVICE_FIELD[kind];
		const serviceName = field && meta ? meta[field] : null;
		return {
			id: `add-${kind}`,
			group,
			searchText: [`Add ${def.label}`, `add-${kind}`, ...keywordsFor(kind)].join(" "),
			run: () => addNode(kind, dropPosition?.()),
			content: (
				<>
					<Icon className="h-4 w-4" />
					<span>Add {def.label}</span>
					{serviceName && serviceName !== "—" && (
						<span className="ml-auto font-mono text-ui-xs text-muted-foreground">
							{serviceName}
						</span>
					)}
				</>
			),
		};
	};

	/** A plain action row: its label is its content, and its id joins the label in the search. */
	const action = (
		id: string,
		label: string,
		fn: () => void,
		disabledReason?: string | null,
	): PaletteCommand => ({
		id,
		group: "Actions",
		searchText: `${label} ${id}`,
		run: fn,
		disabledReason,
		content: label,
	});

	// The kinds this board can take: the one catalogue, asked as the add picker asks it.
	const addableKinds = catalogueKinds(
		addCatalogue(
			coreProvider,
			{ byoHelm: onAttachChart !== undefined, byoIac: onAttachIac !== undefined },
			Boolean(disableComponentAdd),
		),
	);
	const placedNodes = nodes.filter((n) => n.id !== PROJECT_NODE_ID);

	const commands: PaletteCommand[] = [];
	if (onAttachChart) {
		commands.push({
			id: "attach-helm-chart",
			group: "Sources",
			searchText: [
				"Bring your own Helm chart attach-helm-chart",
				"helm", "chart", "byo", "bring your own", "gitops", "argocd", "repo",
			].join(" "),
			run: onAttachChart,
			content: (
				<>
					<GitBranch className="h-4 w-4" />
					<span>Bring your own Helm chart</span>
					<span className="ml-auto font-mono text-ui-xs text-muted-foreground">
						Helm · GitOps
					</span>
					<ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
				</>
			),
		});
	}
	if (onAttachIac) {
		commands.push({
			id: "attach-iac-source",
			group: "Sources",
			searchText: [
				"Bring your own IaC attach-iac-source",
				"iac", "tofu", "opentofu", "terraform", "byo", "bring your own", "module", "repo",
			].join(" "),
			run: onAttachIac,
			content: (
				<>
					<Boxes className="h-4 w-4" />
					<span>Bring your own IaC</span>
					<span className="ml-auto font-mono text-ui-xs text-muted-foreground">
						OpenTofu · replace
					</span>
					<ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
				</>
			),
		});
	}
	for (const kind of addableKinds) commands.push(serviceCommand(kind, "Add"));
	for (const n of placedNodes) {
		const def = NODE_REGISTRY[n.data.kind];
		const Icon = def.icon;
		const name = configName(n.data) || def.label;
		commands.push({
			id: `jump-${n.id}`,
			group: "Jump to",
			searchText: `${name} ${def.label}`,
			run: () => openInspector(n.id),
			content: (
				<>
					<Icon className="h-4 w-4" />
					<span>{name}</span>
					<span className="ml-auto font-mono text-ui-xs text-muted-foreground">
						{def.label}
					</span>
				</>
			),
		});
	}
	commands.push(action("ask-ai", "Ask AI", onAskAi));
	if (onSave) commands.push(action("save", "Save project", onSave));
	if (onEnvSettings) {
		commands.push(action("environment-settings", "Environment settings", onEnvSettings));
	}
	if (onActivity) commands.push(action("activity", "Activity", onActivity));
	commands.push(
		action("fit-view", "Fit view", onFitView, fitViewDisabled ? NOTHING_TO_FIT : null),
		action("auto-arrange", "Tidy layout", onArrange),
		action("repair-overlaps", "Repair overlaps", repairOverlaps),
		action(
			"toggle-connections",
			showConnections ? "Hide connections" : "Show connections",
			toggleConnections,
		),
		action("undo", "Undo", undo),
		action("redo", "Redo", redo),
	);
	if (onShowShortcuts) commands.push(action("shortcuts", "Keyboard shortcuts", onShowShortcuts));
	if (onToggleView) commands.push(action("toggle-form", "Switch to form", onToggleView));
	// One row per kind this board can hold, to draw or stop drawing its cards.
	for (const kind of addableKinds) {
		const hidden = hiddenKinds.includes(kind);
		const label = `${hidden ? "Show" : "Hide"} ${NODE_REGISTRY[kind].label} cards`;
		commands.push({
			id: `layer-${kind}`,
			group: "Layers",
			searchText: `${label} layer layers visibility layer-${kind}`,
			run: () => toggleKindVisibility(kind),
			content: label,
		});
	}

	// Ranked by the shared ranker over each row's label + keywords; the best match's group leads.
	const { search, onSearchChange, results } = useCommandSearch(
		commands,
		commandSearchText,
		{ open, isDisabled: commandIsDisabled },
	);
	const groups = groupResults(results, (c) => c.group);

	return (
		<CommandDialog
			open={open}
			onOpenChange={onOpenChange}
			search={search}
			onSearchChange={onSearchChange}
			filteredItems={groups.flatMap((g) => g.items)}
		>
			<CommandInput placeholder="Search services and actions…" />
			<CommandList>
				<CommandEmpty>No results.</CommandEmpty>
				{groups.map(({ group, items }) => (
					<CommandGroup key={group} heading={group}>
						{items.map((c) => (
							<CommandItem
								key={c.id}
								disabledReason={c.disabledReason}
								onSelect={() => run(c.run)}
							>
								{c.content}
							</CommandItem>
						))}
					</CommandGroup>
				))}
			</CommandList>
		</CommandDialog>
	);
}
