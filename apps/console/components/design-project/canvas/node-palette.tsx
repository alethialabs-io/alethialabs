"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ArrowLeft, type LucideIcon } from "lucide-react";
import { useState } from "react";
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
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";
import { useInspectorPrefsStore } from "@/lib/stores/use-inspector-prefs-store";
import {
	addableKindsFor,
	NODE_REGISTRY,
	PALETTE_GROUP_ORDER,
	ROADMAP_ITEMS,
	variantOptionsFor,
} from "./graph/node-registry";
import type { NodeKind } from "./graph/types";

interface NodePaletteProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	identities: CloudIdentityOption[];
	/** Cluster add-ons for this environment (edit mode only) — surfaced as an "Add-ons" group.
	 * Picking one opens its config sheet (add-ons live on the canvas, not as graph nodes). */
	addonItems?: AddonMarketItem[];
	onConfigureAddon?: (item: AddonMarketItem) => void;
	/** W5 click-to-place — where a newly-added node lands (viewport centre). Supplied by the canvas
	 * (which owns the React Flow context); omitted (e.g. in a unit test) → the store's cascade fallback. */
	dropPosition?: () => { x: number; y: number };
}

/** One selectable service in the Add palette. `kind` is the canvas node; entries with
 * no `kind` are surfaced as roadmap items (no Terraform module yet). */
interface ServiceEntry {
	id: string;
	label: string;
	subtitle: string;
	icon: LucideIcon;
	kind?: NodeKind;
	comingSoon?: boolean;
}

/** Builds the grouped Add-palette catalog from the node registry for the given addable
 * kinds: each kind's `palette` metadata places it in a `PALETTE_GROUP_ORDER` group, and
 * the `ROADMAP_ITEMS` ("Soon" rows) are appended to their group. Groups left empty by
 * per-provider filtering are dropped. */
function serviceGroupsFor(
	kinds: NodeKind[],
): { title: string; items: ServiceEntry[] }[] {
	return PALETTE_GROUP_ORDER.map((title) => ({
		title,
		items: [
			...kinds
				.filter((kind) => NODE_REGISTRY[kind].palette?.group === title)
				.map((kind): ServiceEntry => {
					const def = NODE_REGISTRY[kind];
					return {
						id: kind,
						label: def.label,
						subtitle: def.palette?.subtitle ?? "",
						icon: def.icon,
						kind,
					};
				}),
			...ROADMAP_ITEMS.filter((item) => item.group === title).map(
				(item): ServiceEntry => ({
					id: item.id,
					label: item.label,
					subtitle: item.subtitle,
					icon: item.icon,
					comingSoon: true,
				}),
			),
		],
	})).filter((group) => group.items.length > 0);
}

/**
 * The Add-service command palette: a searchable, grouped menu over every provisionable
 * service. Selecting one drops its node on the canvas, CLOSES the palette, and leaves that node's
 * card open on the workspace rail. Kinds with variants (e.g. Database → engine) route through a
 * second step first. Singletons already on the canvas are disabled; roadmap items (no module yet)
 * show "Soon".
 *
 * The palette used to stay open on an inline "Configure service" step (W5) instead of closing, and
 * that is the shape #4589 removed. Two things were wrong with it, and only the second is a test
 * problem. The wave's claim — written on `cards/workspace-rail.tsx` and asserted in
 * `e2e/architecture-canvas.spec.ts` — is that NOTHING on this page opens a modal over the board; an add
 * flow that parks a `CommandDialog` over the canvas is that modal, and it also meant the quick
 * config and the rail's Settings tab were two editors for one config. And because the second step
 * has no search box, the spec's `await expect(search).toBeHidden()` was satisfied by the STEP
 * CHANGE: the helper returned with the dialog still mounted, and its overlay then intercepted every
 * later click on the board — six gate tests timing out at their full 180s budget.
 *
 * So there is no second step here any more. The store's `addNode`/`addNodeWithConfig` already put
 * the new node's card on the rail (`card: { kind: "inspector", nodeId }`), which is where its
 * config now lives — one editor, not two, and the board stays clickable behind it.
 */
export function NodePalette({
	open,
	onOpenChange,
	identities,
	addonItems,
	onConfigureAddon,
	dropPosition,
}: NodePaletteProps) {
	const addNode = useCanvasStore((s) => s.addNode);
	const addNodeWithConfig = useCanvasStore((s) => s.addNodeWithConfig);
	const nodes = useCanvasStore((s) => s.nodes);
	// Which tab a kind's card opens on. Adding a service records "settings" for that kind: the
	// inline step this palette used to show WAS that form, and picking a service is a statement that
	// you intend to configure it. Written through the preference the tabs already keep, rather than a
	// second, parallel notion of "which tab is this card on" that could disagree with it.
	const setInspectorTab = useInspectorPrefsStore((s) => s.setTab);
	// The env's Kubernetes minor, for the add-on compat badges. Read defensively: a design may
	// have no cluster yet, and an unset version is an honest `not_evaluable`, never a pass.
	const clusterK8s = useCanvasStore((s) => {
		const c = s.nodes.find((n) => n.data.kind === "cluster")?.data.config;
		const v = c && "cluster_version" in c ? c.cluster_version : null;
		return typeof v === "string" && v ? v : undefined;
	});
	// The project root's effective provider gates which kinds are addable (e.g. Hetzner
	// has no topic/nosql) — same filter as the ⌘K menu and the canvas controls.
	const coreProvider = useCanvasStore((s) =>
		s.getEffectiveProvider(PROJECT_NODE_ID),
	);
	// When set, the palette shows the variant step for this kind (e.g. pick a DB engine). The ONLY
	// nested step left: it is part of naming WHICH service you are adding, so it still precedes the
	// add. Everything after the add happens on the rail.
	const [variantKind, setVariantKind] = useState<NodeKind | null>(null);

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

	const add = (entry: ServiceEntry) => {
		if (entry.comingSoon || !entry.kind) return;
		if (NODE_REGISTRY[entry.kind].variants) {
			setVariantKind(entry.kind);
			return;
		}
		// `addNode` opens the new node's card on the rail; the palette closes behind it.
		addNode(entry.kind, dropPosition?.());
		handOffToRail(entry.kind);
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
	const serviceGroups = serviceGroupsFor(addableKindsFor(coreProvider));

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
		>
			{variantDef && variantKind ? (
				<>
					<CommandInput
						placeholder={`Choose a ${variantDef.label.toLowerCase()} type…`}
					/>
					<CommandList className="max-h-[60vh]">
						<CommandEmpty>No option matches.</CommandEmpty>
						<CommandGroup>
							<CommandItem
								value="__back"
								onSelect={() => setVariantKind(null)}
								className="gap-3 text-muted-foreground"
							>
								<ArrowLeft className="h-4 w-4 shrink-0" />
								<span className="text-sm">Back to services</span>
							</CommandItem>
						</CommandGroup>
						<CommandSeparator />
						<CommandGroup heading={`${variantDef.label} type`}>
							{/* Variant options are provider-filtered (e.g. Hetzner's in-cluster charts
							    back PostgreSQL/Valkey only) — same gate as the inspector's engine radio. */}
							{variantOptionsFor(variantKind, coreProvider).map((opt) => {
								const Icon = variantDef.icon;
								return (
									<CommandItem
										key={opt.value}
										value={`${opt.label} ${opt.description}`}
										onSelect={() => pickVariant(variantKind, opt.value)}
										className="gap-3"
									>
										<Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
										<div className="min-w-0 flex-1">
											<div className="text-sm font-medium">{opt.label}</div>
											<div className="truncate text-xs text-muted-foreground">
												{opt.description}
											</div>
										</div>
									</CommandItem>
								);
							})}
						</CommandGroup>
					</CommandList>
				</>
			) : (
				<>
					<CommandInput placeholder="Search services — database, redis, bucket, queue…" />
					<CommandList className="max-h-[60vh]">
						<CommandEmpty>No service matches.</CommandEmpty>
						{noCloud && (
							<p className="px-3 py-2 text-xs text-muted-foreground">
								Tip: connect a cloud account to provision these for real — you can still
								design now.
							</p>
						)}
						{serviceGroups.map((group) => (
							<CommandGroup key={group.title} heading={group.title}>
								{group.items.map((entry) => {
									const Icon = entry.icon;
									const onCanvas =
										!!entry.kind &&
										NODE_REGISTRY[entry.kind].cardinality === "singleton" &&
										nodes.some((n) => n.data.kind === entry.kind);
									const disabled = entry.comingSoon || onCanvas;
									return (
										<CommandItem
											key={entry.id}
											value={`${entry.label} ${entry.subtitle}`}
											disabled={disabled}
											onSelect={() => add(entry)}
											className="gap-3"
										>
											<Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
											<div className="min-w-0 flex-1">
												<div className="text-sm font-medium">{entry.label}</div>
												<div className="truncate text-xs text-muted-foreground">
													{entry.subtitle}
												</div>
											</div>
											{entry.comingSoon ? (
												<span className="font-mono text-ui-2xs uppercase text-muted-foreground">
													Soon
												</span>
											) : onCanvas ? (
												<span className="font-mono text-ui-2xs text-muted-foreground">
													on canvas
												</span>
											) : null}
										</CommandItem>
									);
								})}
							</CommandGroup>
						))}
						{onConfigureAddon && addonItems && addonItems.length > 0 && (
							<CommandGroup heading="Add-ons">
								{addonItems.map((a) => (
									<CommandItem
										key={a.id}
										value={`add-on ${a.name} ${a.summary} ${a.category}`}
										onSelect={() => {
											onConfigureAddon(a);
											handleOpenChange(false);
										}}
										className="gap-3"
									>
										<AddonIcon
											icon={a.icon}
											className="h-4 w-4 shrink-0 text-muted-foreground"
										/>
										<div className="min-w-0 flex-1">
											<div className="text-sm font-medium">{a.name}</div>
											<div className="truncate text-xs text-muted-foreground">
												{a.summary}
											</div>
										</div>
										{/* Compat sits BEFORE the install slot and only when it wants attention — an add-on
										    whose recorded window fits this cluster shows nothing at all. */}
										<AddonCompatBadge addonId={a.id} k8sVersion={clusterK8s} />
										{a.install ? (
											<AddonStatusBadge
												status={a.install.status}
												health={a.install.health}
											/>
										) : (
											<span className="font-mono text-ui-2xs uppercase text-muted-foreground">
												Free
											</span>
										)}
									</CommandItem>
								))}
							</CommandGroup>
						)}
					</CommandList>
				</>
			)}
		</CommandDialog>
	);
}
