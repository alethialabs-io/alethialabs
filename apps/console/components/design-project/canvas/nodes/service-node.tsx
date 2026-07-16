"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { NodeProps } from "@xyflow/react";
import type { CanvasNode } from "../graph/types";
import { BaseNode } from "./base-node";

/**
 * The React Flow renderer for every registry-backed node kind.
 *
 * There used to be thirteen of these — one file per kind, each ~25 lines, each differing only in
 * which two strings it printed. What a kind shows now lives in its `NODE_REGISTRY` row
 * (`card.facts` + `card.handles`), so a new service is a table edit and never a new component.
 *
 * The one kind that still has its own component is `chart` (chart-node.tsx): BYO charts are
 * persisted out-of-band and carry their own detach / rescan actions, so they aren't just a card.
 */
export function ServiceNode({ id, selected, data }: NodeProps<CanvasNode>) {
	// `insideContainer` is set on the render node by canvas-flow when the card sits inside a container
	// region — it drives the dense card treatment. Absent (e.g. an isolated card in a test) → full card.
	return <BaseNode id={id} selected={selected} dense={data.insideContainer} />;
}
