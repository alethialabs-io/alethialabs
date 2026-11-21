"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useQuery } from "@tanstack/react-query";
import {
	Cable,
	GitBranch,
	Hand,
	Keyboard,
	LayoutGrid,
	Maximize,
	MoreHorizontal,
	MousePointer2,
	Play,
	Plus,
	Redo2,
	Search,
	Undo2,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Button } from "@repo/ui/button";
import { cn } from "@repo/ui/utils";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import { buildRenderNodes } from "@/lib/canvas/collections";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { isCloudProviderSlug } from "@/lib/cloud-providers/provider-slug";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import { applyLayout, layoutZoned } from "@/lib/canvas/layout";
import { useAddonsQuery } from "@/lib/query/use-addons-query";
import { environmentStatusInput } from "@/lib/query/use-environment-status-query";
import { orpc } from "@/lib/rpc/client";
import { PROJECT_NODE_ID } from "@/lib/canvas/store/types";
import { buildDefaultFormValues, type SourceProjectData } from "../source-project";
import { CanvasSkeleton } from "./canvas-skeleton";
import { BoardGuideView, type CloudChoices } from "./empty/board-guide-view";
import { EnvironmentStatusScope } from "./environment-status-scope";
import { formToGraph } from "./graph/form-to-graph";
import { configName } from "./graph/node-config";
import { NODE_REGISTRY } from "./graph/node-registry";
import type { NodeKind } from "./graph/types";

/** The card footprint `lib/canvas/layout.ts` lays the board out on — the preview draws on the same grid. */
const CARD_W = 248;
const CARD_H = 132;

/** The kinds the board never draws as cards (the project anchor and the environment's substrate). */
const SUBSTRATE: ReadonlySet<NodeKind> = new Set<NodeKind>(["project", "cluster", "network"]);

/** One card of the preview: what it is, what it is called, and where the board will draw it. */
interface PreviewCard {
	id: string;
	kind: NodeKind;
	eyebrow: string;
	title: string;
	/** Offset from the top-left of the drawn cards' bounding box. */
	x: number;
	y: number;
}

/** The preview's cards, and the bounding box they sit in. */
interface PreviewLayout {
	cards: PreviewCard[];
	width: number;
	height: number;
}

/**
 * The cards the board draws for a server design, where it draws them — computed with the SAME pure
 * steps the canvas store seeds with (`formToGraph`, then `layoutZoned`), and collapsed the way the
 * board collapses them (`buildRenderNodes`). No React Flow: this is what lets the first paint show
 * the design while the board's chunk is still on its way.
 *
 * Positions are relative to the cards' bounding box. React Flow fits that box to the pane at no
 * more than zoom 1 (`canvas-flow.tsx`), so a design that fits at zoom 1 lands where it is drawn
 * here, centred; a larger one is shown at zoom 1, clipped, until the board fits it.
 */
export function previewLayout(
	sourceProject: SourceProjectData | undefined,
	identities: CloudIdentityOption[],
): PreviewLayout {
	const { nodes } = formToGraph(buildDefaultFormValues(sourceProject), identities);
	const providerOf = (id: string) =>
		nodes.find((n) => n.id === id)?.data.provider ??
		nodes.find((n) => n.id === PROJECT_NODE_ID)?.data.provider ??
		null;
	const laidOut = applyLayout(nodes, layoutZoned(nodes, providerOf));
	const drawn = buildRenderNodes(
		laidOut.filter((n) => !SUBSTRATE.has(n.data.kind)),
		{},
	);
	if (drawn.length === 0) return { cards: [], width: 0, height: 0 };

	const minX = Math.min(...drawn.map((n) => n.position.x));
	const minY = Math.min(...drawn.map((n) => n.position.y));
	const maxX = Math.max(...drawn.map((n) => n.position.x));
	const maxY = Math.max(...drawn.map((n) => n.position.y));
	const cards = drawn.map((n): PreviewCard => {
		const def = NODE_REGISTRY[n.data.kind];
		// A collection card (the Secrets vault) stands for its members, so it is named for its kind.
		const title = "memberIds" in n.data ? def.label : configName(n.data) || def.label;
		return {
			id: n.id,
			kind: n.data.kind,
			eyebrow: def.eyebrow,
			title,
			x: n.position.x - minX,
			y: n.position.y - minY,
		};
	});
	return { cards, width: maxX - minX + CARD_W, height: maxY - minY + CARD_H };
}

/**
 * The cloud of the account the project is bound to, or null when it has none — what the live board
 * reads off the project root, so the picture's guide and the live guide offer the same template
 * start.
 */
function previewProjectCloud(
	sourceProject: SourceProjectData | undefined,
	identities: CloudIdentityOption[],
): CloudProviderSlug | null {
	const identityId = buildDefaultFormValues(sourceProject).project.cloud_identity_id;
	const provider = identityId ? identities.find((i) => i.id === identityId)?.provider : undefined;
	return provider && isCloudProviderSlug(provider) ? provider : null;
}

/** The picture cannot ask the server which clouds are offered; the live board does. */
const CLOUDS_ON_THEIR_WAY: CloudChoices = { status: "loading" };

/** What the page already knows about the board — the props the workbench hands the canvas. */
interface BoardPreviewData {
	sourceProject?: SourceProjectData;
	cloudIdentities: CloudIdentityOption[];
	projectId?: string;
	environmentId?: string;
	byoHelmEnabled?: boolean;
	/** Whether bring-your-own IaC is enabled (server flag): whether the guide offers that start. */
	byoIacEnabled?: boolean;
}

const BoardPreviewContext = createContext<BoardPreviewData | null>(null);

/**
 * Hands the page's board data to the preview. `next/dynamic`'s `loading` takes no props, so the
 * preview it renders reads them from here.
 */
export function BoardPreviewProvider({
	value,
	children,
}: {
	value: BoardPreviewData;
	children: ReactNode;
}) {
	return <BoardPreviewContext.Provider value={value}>{children}</BoardPreviewContext.Provider>;
}

/**
 * The board's stand-in while it is not drawn yet: `next/dynamic`'s loading state (the server render
 * and the wait for the React Flow chunk) and, with `overlay`, the frames before the store is seeded.
 *
 * With the page's data (`BoardPreviewProvider`) it is the BOARD — the design's cards, the
 * environment's last job and cost, the toolbar, or the blank-board guide — drawn without React Flow.
 * Without it (a caller that never provided any), it is the skeleton, as before.
 *
 * `overlay` is for inside the canvas, which already reads the environment status; on its own the
 * preview opens that same read (prefetched under the same key, so it renders with the page).
 */
export function BoardPreview({ overlay = false }: { overlay?: boolean }) {
	const data = useContext(BoardPreviewContext);
	if (!data) return <CanvasSkeleton overlay={overlay} />;
	if (overlay) return <StaticBoard data={data} overlay />;
	return (
		<EnvironmentStatusScope projectId={data.projectId} environmentId={data.environmentId}>
			<StaticBoard data={data} overlay={false} />
		</EnvironmentStatusScope>
	);
}

/** Nothing to do: the preview is `inert`, and the live board takes over the moment it is drawn. */
function noop() {}

/**
 * The board drawn from data alone. It is a PICTURE of the board: `inert`, because a press on it
 * before the board is live would go nowhere, and `aria-hidden`, so nothing that looks for the
 * board's controls by role (a screen reader, a test) finds a second, dead copy of them — inside the
 * canvas the live controls are mounted under the overlay. `aria-busy`, because the board is still on
 * its way: anything waiting for the page to be ready waits for the live board.
 */
function StaticBoard({ data, overlay }: { data: BoardPreviewData; overlay: boolean }) {
	const { sourceProject, cloudIdentities, projectId, environmentId, byoHelmEnabled, byoIacEnabled } =
		data;
	const env = useEnvironmentStatus();
	const layout = useMemo(
		() => previewLayout(sourceProject, cloudIdentities),
		[sourceProject, cloudIdentities],
	);
	// The board's out-of-band layers, read under the keys the page prefetched: an installed add-on
	// or an attached chart is something on the board, so a design with only those is not blank.
	const addons = useAddonsQuery(projectId, environmentId);
	const charts = useQuery({
		...orpc.canvas.byoCharts.queryOptions({
			input: environmentStatusInput(projectId ?? "", environmentId),
		}),
		enabled: !!projectId && !!byoHelmEnabled,
	});
	// An IaC module governs the environment: the design is inert and nothing can be added to it.
	const iacGoverned = env.iac !== null;
	const cards = iacGoverned ? [] : layout.cards;
	const hasOutOfBand =
		(addons.data?.items ?? []).some((a) => a.install?.enabled) ||
		(charts.data?.charts.length ?? 0) > 0 ||
		(env.iac?.groups.length ?? 0) > 0;
	const blank = !iacGoverned && cards.length === 0 && !hasOutOfBand;

	return (
		<div
			data-slot="board-preview"
			aria-busy="true"
			aria-hidden="true"
			inert
			className={cn(
				"overflow-hidden bg-background",
				overlay
					? "absolute inset-0 z-[var(--z-raised)]"
					: "relative h-full min-h-[480px] w-full",
			)}
		>
			{cards.length > 0 && (
				<div
					className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
					style={{ width: layout.width, height: layout.height }}
				>
					{cards.map((card) => (
						<PreviewCardView key={card.id} card={card} />
					))}
				</div>
			)}

			{blank && (
				<div
					data-slot="board-guide"
					className="pointer-events-none absolute inset-0 flex items-center justify-center p-3"
				>
					<BoardGuideView
						projectCloud={previewProjectCloud(sourceProject, cloudIdentities)}
						cloudChoices={CLOUDS_ON_THEIR_WAY}
						onTemplate={noop}
						onAdd={noop}
						onAttachChart={byoHelmEnabled ? noop : undefined}
						onAttachIac={byoIacEnabled ? noop : undefined}
						onOpenCluster={noop}
					/>
				</div>
			)}

			{/* The board's toolbar, top-centre, as the live board draws it (`toolbar/canvas-toolbar.tsx`):
			    the environment, the tools, and nothing in any other corner but the zoom controls. A
			    picture of the wide form; the live toolbar folds on a narrow board. */}
			<div className="absolute inset-x-0 top-3 flex justify-center px-3">
				<div className="flex max-w-full items-center overflow-hidden border border-border bg-card p-1 shadow-sm">
					<Button type="button" variant="ghost" size="sm" className="h-8 max-w-40 rounded-none px-2 text-xs">
						<span className="truncate font-medium">{env.environment?.name ?? "Environment"}</span>
					</Button>
					<PreviewDivider />
					<PreviewControl
						label="Select"
						className="bg-foreground text-background"
						icon={<MousePointer2 className="h-3.5 w-3.5" />}
					/>
					<PreviewControl label="Hand tool (pan)" icon={<Hand className="h-3.5 w-3.5" />} />
					<PreviewDivider />
					{/* Off, not gone, while an IaC module governs the environment — as on the live board. */}
					<Button
						type="button"
						size="sm"
						className="h-8 rounded-none px-2.5 text-xs"
						disabled={iacGoverned}
					>
						<Plus className="h-3.5 w-3.5" />
						Add
					</Button>
					<PreviewControl label="Connect the selected service" icon={<Cable className="h-3.5 w-3.5" />} />
					<PreviewDivider />
					<PreviewControl label="Undo" icon={<Undo2 className="h-3.5 w-3.5" />} />
					<PreviewControl label="Redo" icon={<Redo2 className="h-3.5 w-3.5" />} />
					<PreviewDivider />
					<PreviewControl label="Tidy layout" icon={<LayoutGrid className="h-3.5 w-3.5" />} />
					<PreviewControl label="Fit view" icon={<Maximize className="h-3.5 w-3.5" />} />
					<PreviewDivider />
					<Button type="button" variant="ghost" size="sm" className="h-8 rounded-none px-2 text-xs">
						<Play className="mr-1 h-3.5 w-3.5" />
						Run
					</Button>
					<PreviewControl label="Sources" icon={<GitBranch className="h-3.5 w-3.5" />} />
					<PreviewDivider />
					<PreviewControl label="Command palette" icon={<Search className="h-3.5 w-3.5" />} />
					<PreviewControl label="Keyboard shortcuts" icon={<Keyboard className="h-3.5 w-3.5" />} />
					<PreviewControl label="More" icon={<MoreHorizontal className="h-3.5 w-3.5" />} />
				</div>
			</div>

			{/* Bottom-left: zoom out, the level, zoom in, fit (`canvas-controls.tsx`). */}
			<div className="absolute bottom-3 left-3 flex items-center border border-border bg-card">
				<PreviewControl label="Zoom out" icon={<ZoomOut className="h-3.5 w-3.5" />} />
				<span className="flex h-8 min-w-12 items-center justify-center px-1.5 font-mono text-ui-xs tabular-nums">
					100%
				</span>
				<PreviewControl label="Zoom in" icon={<ZoomIn className="h-3.5 w-3.5" />} />
				<PreviewControl label="Fit view" icon={<Maximize className="h-3.5 w-3.5" />} />
			</div>
		</div>
	);
}

/** One icon tool of the picture, drawn as the live toolbar and zoom controls draw theirs. */
function PreviewControl({
	label,
	icon,
	className,
}: {
	label: string;
	icon: ReactNode;
	className?: string;
}) {
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon"
			className={cn("h-8 w-8 rounded-none", className)}
			aria-label={label}
		>
			{icon}
		</Button>
	);
}

/** The line between two groups of tools in the picture of the toolbar. */
function PreviewDivider() {
	return <span className="mx-1 block h-5 w-px shrink-0 bg-border" />;
}

/** A design card as the board's full tier heads it (`nodes/base-node.tsx`): plate, eyebrow, name. */
function PreviewCardView({ card }: { card: PreviewCard }) {
	const Icon = NODE_REGISTRY[card.kind].icon;
	return (
		<div
			className="absolute w-[248px] border border-border bg-card text-card-foreground"
			style={{ left: card.x, top: card.y }}
		>
			<div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-2">
				<span className="grid h-[22px] w-[22px] shrink-0 place-items-center border border-border bg-surface-sunken">
					<Icon className="h-3.5 w-3.5 text-muted-foreground" />
				</span>
				<span className="vx-eyebrow truncate">{card.eyebrow}</span>
			</div>
			<div className="truncate px-2.5 py-2 font-mono text-ui-xs text-foreground">{card.title}</div>
		</div>
	);
}
