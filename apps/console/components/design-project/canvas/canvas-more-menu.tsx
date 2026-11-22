"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useReactFlow } from "@xyflow/react";
import {
	Activity,
	Keyboard,
	LayoutGrid,
	Maximize,
	MoreHorizontal,
	Settings2,
	Shuffle,
} from "lucide-react";
import { formatMonthlyRate } from "@repo/format";
import { Button } from "@repo/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import { arrangeBoard } from "@/lib/canvas/arrange";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import { useBoard, useOthers } from "@/lib/canvas/store/canvas-store-provider";
import { PROJECT_NODE_ID, type WorkspaceCard } from "@/lib/canvas/store/types";
import {
	useBoardActions,
	useEffectiveProvider,
	useHiddenKinds,
	useShowConnections,
} from "@/lib/canvas/store/use-board";
import { addableKindsFor, NODE_REGISTRY } from "./graph/node-registry";
import type { NodeKind } from "./graph/types";
import { NOTHING_TO_FIT, useHasDrawnNodes } from "./use-has-drawn-nodes";

/**
 * The toolbar's ⋯ menu: what belongs to the environment and to how the board is drawn, and is not
 * a tool.
 *
 * It is the last item of the board's top-centre toolbar (#6832). The tools themselves — select and
 * hand, add, connect, undo and redo, tidy and fit, run, the command palette, the shortcut sheet —
 * are buttons there; this menu holds the rest in three labelled groups: the environment (what it
 * costs, its settings, its activity), the view (connections, tidy actions) and the layer switches.
 * Tidy, fit and the shortcut sheet are rows here as well as tools, because a narrow toolbar hides
 * those three buttons and they must stay reachable without a keyboard.
 *
 * The environment's monthly cost is a line here. It was a chip floating in the board's top-right
 * corner; a never-priced environment shows no line at all, as the chip showed nothing.
 *
 * Flat on purpose. A submenu costs a hover-then-click for items that are one click of chrome, and
 * `DropdownMenuSub*` is exercised nowhere else in the console — an unexercised primitive is not
 * what a toolbar simplification should rest on.
 */
export function CanvasMoreMenu({
	iacGoverned,
	onShowShortcuts,
}: {
	/** A BYO-IaC source governs this environment: it owns the substrate, so no env settings. */
	iacGoverned: boolean;
	onShowShortcuts: () => void;
}) {
	const { fitView } = useReactFlow();
	const canFit = useHasDrawnNodes();
	const board = useBoard();
	const others = useOthers();
	const openCard = (card: WorkspaceCard) => board.view.getState().openCard(card);
	const showConnections = useShowConnections();
	const toggleConnections = () => board.view.getState().toggleConnections();
	const { repairOverlaps } = useBoardActions();
	const hiddenKinds = useHiddenKinds();
	const toggleKindVisibility = (kind: NodeKind) => board.view.getState().toggleKindVisibility(kind);
	const coreProvider = useEffectiveProvider(PROJECT_NODE_ID);
	const env = useEnvironmentStatus();

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						type="button"
						data-tool=""
						variant="ghost"
						size="icon"
						className="h-8 w-8 rounded-none"
						aria-label="More"
						title="More"
					>
						<MoreHorizontal className="h-3.5 w-3.5" />
					</Button>
				}
			/>
			<DropdownMenuContent align="end" className="w-60">
				<DropdownMenuLabel className="vx-eyebrow">Environment</DropdownMenuLabel>
				{env.monthlyCost != null && (
					<DropdownMenuLabel className="flex items-center justify-between gap-2 py-1 font-normal">
						<span className="text-ui-sm text-muted-foreground">Cost, from the last plan</span>
						{/* `exact` because the cards on the same board are the parts of this number, and a
						    total that rounds differently from its parts cannot be checked. */}
						<span className="font-mono text-xs">{formatMonthlyRate(env.monthlyCost, "exact")}</span>
					</DropdownMenuLabel>
				)}
				{!iacGoverned && (
					<DropdownMenuItem onSelect={() => openCard({ kind: "env-settings" })}>
						<Settings2 className="mr-2 h-4 w-4 text-muted-foreground" />
						Environment settings
					</DropdownMenuItem>
				)}
				<DropdownMenuItem onSelect={() => openCard({ kind: "activity" })}>
					<Activity className="mr-2 h-4 w-4 text-muted-foreground" />
					Activity
				</DropdownMenuItem>
				<DropdownMenuSeparator />

				<DropdownMenuLabel className="vx-eyebrow">View</DropdownMenuLabel>
				<DropdownMenuCheckboxItem
					checked={showConnections}
					onCheckedChange={() => toggleConnections()}
				>
					Show connections
				</DropdownMenuCheckboxItem>
				<DropdownMenuItem onSelect={() => void arrangeBoard(board, others, fitView)}>
					<LayoutGrid className="mr-2 h-4 w-4 text-muted-foreground" />
					Tidy layout
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => repairOverlaps()}>
					<Shuffle className="mr-2 h-4 w-4 text-muted-foreground" />
					Repair overlaps
				</DropdownMenuItem>
				<DropdownMenuItem
					disabledReason={canFit ? null : NOTHING_TO_FIT}
					onSelect={() => void fitView({ padding: 0.3 })}
				>
					<Maximize className="mr-2 h-4 w-4 text-muted-foreground" />
					Fit view
				</DropdownMenuItem>

				<DropdownMenuSeparator />
				<DropdownMenuLabel className="vx-eyebrow">Layers</DropdownMenuLabel>
				{addableKindsFor(coreProvider).map((kind) => {
					const def = NODE_REGISTRY[kind];
					return (
						<DropdownMenuCheckboxItem
							key={kind}
							checked={!hiddenKinds.includes(kind)}
							onCheckedChange={() => toggleKindVisibility(kind)}
						>
							{def.label}
						</DropdownMenuCheckboxItem>
					);
				})}

				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={onShowShortcuts}>
					<Keyboard className="mr-2 h-4 w-4 text-muted-foreground" />
					Keyboard shortcuts
					<span className="ml-auto font-mono text-ui-3xs text-muted-foreground">?</span>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
