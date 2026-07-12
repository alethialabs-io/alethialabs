// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { tool } from "ai";
import { z } from "zod";
import { dashboardBlockSchema } from "./visualize";

const KINDS = ["table", "stat", "bar", "line", "keyvalue"] as const;

/** The validated pin_widget payload the CLIENT lane consumes (echoed input). */
export const pinWidgetOutputSchema = z.object({
	title: z.string().min(1).max(120),
	kind: z.enum(KINDS).optional(),
	/** A replayable read-tool call (live-widget source; PR 3 refresh). */
	source: z
		.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).nullable() })
		.optional(),
	/** A self-contained dashboard block (stat/bar/line/grid) to render. */
	block: dashboardBlockSchema.optional(),
	/** Grid cell to land on (0-indexed; omitted → first-fit). */
	position: z.object({ x: z.number().int().min(0).max(4), y: z.number().int().min(0) }).optional(),
	size: z
		.object({
			colspan: z.number().int().min(1).max(5),
			rowspan: z.number().int().min(1).max(12),
		})
		.optional(),
	mode: z.enum(["live", "frozen"]).optional(),
});

/**
 * The widget-grid tools (in-app only). `pin_widget` is a validated passthrough like
 * `build_dashboard`: the model describes ONE widget (a dashboard block it composed, or
 * a read-tool source) and the client lane persists + places it on the chat's bento
 * grid (first-fit unless a position is given). No server-side write happens here — the
 * grid rows are created by the client through the PDP-gated server action.
 */
export function widgetTools() {
	return {
		pin_widget: tool({
			description:
				"Pin ONE widget to the user's per-chat bento grid (the side panel). Provide either a `block` (a stat/bar/line/grid block composed from data you fetched — same DSL as build_dashboard) or a `source` (a read tool name + args whose latest result the widget shows). Use when the user asks to put something on the grid / dashboard, or to fill a specific cell (pass `position`). The client places and persists it.",
			inputSchema: pinWidgetOutputSchema,
			execute: async (input) => input,
		}),
	};
}
