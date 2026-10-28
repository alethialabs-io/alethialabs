"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Boxes, Plus } from "lucide-react";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import type { NodeKind } from "@/components/design-project/canvas/graph/types";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

/**
 * The kinds a design always carries and the board never draws as cards: the project root and the
 * environment's substrate (its cluster and network, edited as environment settings). A design made
 * of only these is a blank design — "Cluster" preselected as the starting point still draws nothing.
 */
const SUBSTRATE: ReadonlySet<NodeKind> = new Set<NodeKind>(["project", "cluster", "network"]);

/**
 * Whether the design has nothing on it to draw: no component, no BYO chart, no add-on, no IaC card.
 *
 * Read from the canvas STORE, not React Flow's node lookup: the lookup fills in an effect after the
 * nodes arrive, so asking it would flash the guide for a frame on every board that has content.
 * Hidden layers do not count as empty — the components are there, the viewer chose not to see them.
 */
export function useDesignIsEmpty(): boolean {
	return useCanvasStore((s) => !s.nodes.some((n) => !SUBSTRATE.has(n.data.kind)));
}

/**
 * What a blank board says (F037): it is empty, and the one next step is adding a component. Laid
 * over the middle of the board without blocking it — the pane still pans and right-clicks around it.
 *
 * The guide's own name (`data-slot="board-guide"`) sits on the OVERLAY, never on the EmptyState:
 * `@repo/ui/empty` marks its region `data-slot="empty"`, and a `data-slot` passed to it replaces that
 * mark — which is how the board read as a hand-rolled empty region to the audit (T5) while rendering
 * the shared component.
 */
export function BoardGuide({ onAdd }: { onAdd: () => void }) {
	return (
		<div
			data-slot="board-guide"
			className="pointer-events-none absolute inset-0 flex items-center justify-center"
		>
			<EmptyState
				className="pointer-events-auto max-w-md flex-none"
				icon={<Boxes aria-hidden />}
				title="Nothing designed yet"
				description="Add your first component — a service, a database, a queue — and it is drawn here. Press A to add from anywhere on the board."
				action={
					<Button type="button" size="sm" onClick={onAdd}>
						<Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
						Add a component
					</Button>
				}
			/>
		</div>
	);
}
