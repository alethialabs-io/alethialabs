"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useReactFlow } from "@xyflow/react";
import {
	Activity,
	Hand,
	Keyboard,
	LayoutGrid,
	Maximize,
	MoreHorizontal,
	Settings2,
	Shuffle,
} from "lucide-react";
import { useContext } from "react";
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
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";
import { CanvasInteractionContext } from "./canvas-flow";
import { addableKindsFor, NODE_REGISTRY } from "./graph/node-registry";

/**
 * The board's ⋯ menu — everything that is not Run or Add, in one place.
 *
 * The toolbar used to carry four top-right controls and the bottom-left bar ten more (a settings
 * popover holding a switch and two actions, an auto-arrange button that duplicated one of them,
 * the hand tool, four view controls, undo/redo, and a layers popover). The maintainer's words:
 * "way too much, ease the user in". The top row keeps the two verbs a first visit needs — Run
 * and Add — and this menu holds the rest, in three labelled groups rather than a submenu: the two
 * cards, the view toggles and tidy actions, and the layer switches. Zoom, fit and undo/redo stay
 * on the bottom-left bar, which is now five controls rather than ten.
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
	const openCard = useCanvasStore((s) => s.openCard);
	const showConnections = useCanvasStore((s) => s.showConnections);
	const toggleConnections = useCanvasStore((s) => s.toggleConnections);
	const repairOverlaps = useCanvasStore((s) => s.repairOverlaps);
	const hiddenKinds = useCanvasStore((s) => s.hiddenKinds);
	const toggleKindVisibility = useCanvasStore((s) => s.toggleKindVisibility);
	const coreProvider = useCanvasStore((s) => s.getEffectiveProvider(PROJECT_NODE_ID));
	const { handTool, setHandTool } = useContext(CanvasInteractionContext);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						type="button"
						variant="outline"
						size="icon"
						className="h-8 w-8"
						aria-label="More"
						title="More"
					>
						<MoreHorizontal className="h-3.5 w-3.5" />
					</Button>
				}
			/>
			<DropdownMenuContent align="end" className="w-60">
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
				<DropdownMenuCheckboxItem checked={handTool} onCheckedChange={setHandTool}>
					<Hand className="mr-2 h-4 w-4 text-muted-foreground" />
					Hand tool
					<span className="ml-auto font-mono text-ui-3xs text-muted-foreground">H</span>
				</DropdownMenuCheckboxItem>
				<DropdownMenuItem onSelect={() => void arrangeBoard(fitView)}>
					<LayoutGrid className="mr-2 h-4 w-4 text-muted-foreground" />
					Auto-arrange
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => repairOverlaps()}>
					<Shuffle className="mr-2 h-4 w-4 text-muted-foreground" />
					Repair overlaps
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => void fitView({ padding: 0.3 })}>
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
