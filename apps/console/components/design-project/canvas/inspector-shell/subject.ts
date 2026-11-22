"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What the inspector needs to know about a `Subject` before it draws one (#6834): which subject a
// node id names, whether the rail has anything to show for it, which of a subject's tabs is in
// front, and how to close.

import { useCallback } from "react";
import { useBoard } from "@/lib/canvas/store/canvas-store-provider";
import type { InspectorTab, Subject } from "@/lib/canvas/store/types";
import { useAnyNode } from "@/lib/canvas/store/use-board";
import type { CanvasNode } from "../graph/types";

/** What the rail knows about its host, for the subjects that need a project or an environment. */
export interface InspectorContext {
	/** The project the subjects act on. */
	projectId?: string;
	/** The environment the subjects read; null until one resolves. */
	environmentId?: string | null;
}

const ADDON_PREFIX = "addon-";
const CHART_PREFIX = "chart-";

/** The node id an add-on is addressed by, whether or not it is installed and on the board. */
export function addonNodeId(addonId: string): string {
	return `${ADDON_PREFIX}${addonId}`;
}

/** The add-on a node id names, or null. An add-on that is not installed has no node on the board. */
export function addonIdOf(nodeId: string): string | null {
	return nodeId.startsWith(ADDON_PREFIX) ? nodeId.slice(ADDON_PREFIX.length) || null : null;
}

/** The bring-your-own chart a node id names, or null. */
export function chartIdOf(nodeId: string): string | null {
	return nodeId.startsWith(CHART_PREFIX) ? nodeId.slice(CHART_PREFIX.length) || null : null;
}

/** A stable key per subject: the body is remounted when the subject changes, the rail is not. */
export function subjectKey(subject: Subject): string {
	switch (subject.kind) {
		case "node":
			return `node:${subject.id}`;
		case "collection":
			return `collection:${subject.nodeKind}`;
		case "environment":
			return "environment";
		case "selection":
			return `selection:${subject.ids.join(",")}`;
	}
}

/**
 * Whether the rail has something to draw for a subject. One answer, read by the rail (its width)
 * and by the board (its seam), so the two cannot disagree: an add-on needs a project to read its
 * catalog from, a selection of no cards is nothing to show, and everything else always can be.
 */
export function inspectorOpen(subject: Subject | null, ctx: InspectorContext = {}): boolean {
	if (subject === null) return false;
	if (subject.kind === "node" && addonIdOf(subject.id) !== null) return ctx.projectId !== undefined;
	if (subject.kind === "selection") return subject.ids.length > 0;
	return true;
}

/** The tab in front: the one asked for when the subject has it, else the subject's first. */
export function resolveTab(
	requested: InspectorTab | null,
	available: readonly InspectorTab[],
): InspectorTab {
	const found = available.find((tab) => tab === requested);
	return found ?? available[0] ?? "configure";
}

/**
 * The node a subject names: a design node from the document, else a card the design does not own,
 * from its query (`BoardSourcesProvider`).
 */
export function useSubjectNode(id: string): CanvasNode | undefined {
	return useAnyNode(id);
}

/** Close the inspector. The rail returns the focus to where it came from. */
export function useCloseInspector(): () => void {
	const board = useBoard();
	return useCallback(() => board.view.getState().setSubject(null), [board]);
}
