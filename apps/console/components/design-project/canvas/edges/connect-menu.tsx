"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { XYPosition } from "@xyflow/react";
import { Plus } from "lucide-react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuSeparator,
	type ContextMenuPoint,
} from "@repo/ui/context-menu";
import { NODE_REGISTRY } from "../graph/node-registry";
import type { NodeKind } from "../graph/types";
import type { BindableKind } from "./connection-rules";

/** A card that already exists and can be connected to. */
export interface ConnectMenuTarget {
	id: string;
	kind: NodeKind;
	/** "Database orders" — the card as its name reads. */
	title: string;
}

/** An open connect menu: who is connecting, and what it may connect to. */
export interface ConnectMenuState {
	/** Where the menu opens, in viewport pixels. */
	point: ContextMenuPoint;
	sourceId: string;
	/** The service's name, for the menu's heading. */
	sourceName: string;
	/** Cards on the board the service is not connected to yet. */
	targets: ConnectMenuTarget[];
	/** Kinds a new card can be added as, already connected. Empty when nothing can be added. */
	kinds: BindableKind[];
	/** Where a new card is placed, in board coordinates. */
	position: XYPosition;
	/** True when the menu was opened from the keyboard: closing it returns focus to the service. */
	fromKeyboard: boolean;
}

export interface ConnectMenuProps {
	state: ConnectMenuState | null;
	onClose: () => void;
	/** Connect to a card that exists. */
	onConnect: (state: ConnectMenuState, targetId: string) => void;
	/** Add a card of `kind` and connect to it, as one step. */
	onCreate: (state: ConnectMenuState, kind: BindableKind) => void;
}

/**
 * The menu a connection ends in when it does not end on one card.
 *
 * Three gestures open it, and it is one menu so they cannot offer different things: releasing a
 * dragged connection on empty board (connect to something new, placed where the pointer let go),
 * releasing it on the vault (which of its secrets), and pressing the connect key on a selected
 * service (the same choices with no pointer at all). Each row makes exactly one connection.
 */
export function ConnectMenu({ state, onClose, onConnect, onCreate }: ConnectMenuProps) {
	return (
		<ContextMenu
			open={state !== null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			anchor={state?.point ?? null}
		>
			<ContextMenuContent className="max-h-80 w-64 overflow-y-auto">
				{state && (
					<>
						<ContextMenuLabel>Connect {state.sourceName} to</ContextMenuLabel>
						{state.targets.map((target) => {
							const Icon = NODE_REGISTRY[target.kind].icon;
							return (
								<ContextMenuItem key={target.id} onSelect={() => onConnect(state, target.id)}>
									<Icon className="mr-2 h-4 w-4 text-muted-foreground" />
									<span className="truncate">{target.title}</span>
								</ContextMenuItem>
							);
						})}
						{state.targets.length > 0 && state.kinds.length > 0 && <ContextMenuSeparator />}
						{state.kinds.map((kind) => (
							<ContextMenuItem key={kind} onSelect={() => onCreate(state, kind)}>
								<Plus className="mr-2 h-4 w-4 text-muted-foreground" />
								New {NODE_REGISTRY[kind].label.toLowerCase()}
							</ContextMenuItem>
						))}
					</>
				)}
			</ContextMenuContent>
		</ContextMenu>
	);
}
