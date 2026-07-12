"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { isToolUIPart, type UIMessage } from "ai";
import { useEffect, useRef } from "react";
import { z } from "zod";
import { syncArtifactWidgets } from "@/app/server/actions/artifacts";
import { pinWidgetOutputSchema } from "@/lib/ai/tools/widgets";
import { dashboardSpecSchema } from "@/lib/ai/tools/visualize";
import { useArtifactStore } from "@/lib/stores/use-artifact-store";
import { useWidgetGridStore } from "@/lib/stores/use-widget-grid-store";
import { blockDefaultSize, WIDGET_REGISTRY, widgetDefForPartType } from "./registry";

const updateArtifactInputSchema = z.object({ artifactId: z.string().uuid() });

const argsSchema = z.record(z.string(), z.unknown());

/** Normalize a tool part's input into replayable source args (null when not a map). */
function toArgs(input: unknown): Record<string, unknown> | null {
	const parsed = argsSchema.safeParse(input);
	return parsed.success ? parsed.data : null;
}

/**
 * Tool-driven widget placement: whenever a finished tool part matches the widget
 * registry, pin it to the active thread's grid — deduped by toolCallId (store guard +
 * the DB's unique upsert) and by source (a repeated query refreshes its widget instead
 * of adding a cell). A finished `build_dashboard` explodes into one widget per block
 * (frozen, spec-only), so "build me a dashboard" assembles the grid directly.
 */
export function useWidgetAutoPin(messages: UIMessage[], threadId: string | null): void {
	const pin = useWidgetGridStore((s) => s.pin);
	const hydrate = useWidgetGridStore((s) => s.hydrate);
	const gridThread = useWidgetGridStore((s) => s.threadId);
	// update_artifact calls already synced this mount (the server action is itself a
	// replay no-op via updated_at, so this only avoids redundant round-trips).
	const syncedRef = useRef<Set<string>>(new Set());

	useEffect(() => {
		if (!threadId || gridThread !== threadId) return;
		const pins: Array<Promise<boolean>> = [];
		for (const m of messages) {
			if (m.role !== "assistant") continue;
			for (const part of m.parts) {
				if (!isToolUIPart(part) || part.state !== "output-available") continue;

				// Exploded generative dashboard: each block = one widget.
				if (part.type === "tool-build_dashboard") {
					const spec = dashboardSpecSchema.safeParse(part.output);
					if (!spec.success) continue;
					spec.data.blocks.forEach((block, i) => {
						const size = blockDefaultSize(block.kind);
						pins.push(
							pin({
								threadId,
								kind: block.kind === "grid" ? "keyvalue" : block.kind,
								title: block.title,
								source: null,
								data: { block },
								colspan: size.colspan,
								rowspan: size.rowspan,
								mode: "frozen",
								toolCallId: `${part.toolCallId}:${i}`,
							}),
						);
					});
					continue;
				}

				// Agent edited a saved artifact → sync its open widgets on this grid, then
				// re-pull the rows so the edit shows.
				if (part.type === "tool-update_artifact") {
					if (syncedRef.current.has(part.toolCallId)) continue;
					const input = updateArtifactInputSchema.safeParse(part.input);
					if (!input.success) continue;
					syncedRef.current.add(part.toolCallId);
					void syncArtifactWidgets(input.data.artifactId, threadId).then(() => {
						if (useWidgetGridStore.getState().threadId !== threadId) return;
						useWidgetGridStore.setState({ threadId: null });
						void hydrate(threadId);
					});
					continue;
				}

				// Explicit model pin (`pin_widget` passthrough): honor its placement hints.
				if (part.type === "tool-pin_widget") {
					const p = pinWidgetOutputSchema.safeParse(part.output);
					if (!p.success) continue;
					const w = p.data;
					const size =
						w.size ??
						(w.block
							? blockDefaultSize(w.block.kind)
							: (w.source && WIDGET_REGISTRY[w.source.tool]?.defaultSize) ?? {
									colspan: 2,
									rowspan: 2,
								});
					const kind =
						w.kind ??
						(w.block
							? w.block.kind === "grid"
								? "keyvalue"
								: w.block.kind
							: (w.source && WIDGET_REGISTRY[w.source.tool]?.kind) ?? "keyvalue");
					pins.push(
						pin({
							threadId,
							kind,
							title: w.title,
							source: w.source ?? null,
							data: w.block ? { block: w.block } : {},
							colspan: size.colspan,
							rowspan: size.rowspan,
							posX: w.position?.x,
							posY: w.position?.y,
							mode: w.mode ?? "frozen",
							toolCallId: part.toolCallId,
						}),
					);
					continue;
				}

				const def = widgetDefForPartType(part.type);
				if (!def || !def.parses(part.output)) continue;
				const toolName = part.type.slice("tool-".length);
				pins.push(
					pin({
						threadId,
						kind: def.kind,
						title: def.title,
						source: { tool: toolName, args: toArgs(part.input) },
						data: { output: part.output },
						colspan: def.defaultSize.colspan,
						rowspan: def.defaultSize.rowspan,
						// Smart defaults: jobs/clusters/connectors/usage land live and keep
						// refetching on their registry cadence; one-off reads stay frozen.
						mode: def.liveByDefault ? "live" : "frozen",
						toolCallId: part.toolCallId,
					}),
				);
			}
		}
		if (pins.length === 0) return;
		// Reveal the grid pane when something new actually landed (dedupes resolve false).
		void Promise.all(pins).then((landed) => {
			if (landed.some(Boolean)) useArtifactStore.getState().openGrid();
		});
	}, [messages, threadId, gridThread, pin]);
}
