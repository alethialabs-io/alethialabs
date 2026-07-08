// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { tool } from "ai";
import { z } from "zod";
import type { DashboardSpec } from "@/types/jsonb.types";

/** A headline metric. */
const statBlock = z.object({
	kind: z.literal("stat"),
	title: z.string(),
	value: z.union([z.string(), z.number()]),
	sub: z.string().optional(),
});

/** A categorical comparison (vertical bars). */
const barBlock = z.object({
	kind: z.literal("bar"),
	title: z.string(),
	data: z.array(z.object({ label: z.string(), value: z.number() })),
});

/** A trend (sparkline). */
const lineBlock = z.object({
	kind: z.literal("line"),
	title: z.string(),
	points: z.array(z.number()),
	label: z.string().optional(),
});

/** A compact key/value grid. */
const gridBlock = z.object({
	kind: z.literal("grid"),
	title: z.string(),
	cells: z.array(
		z.object({ label: z.string(), value: z.union([z.string(), z.number()]) }),
	),
});

/** The full generative-dashboard DSL — mirrors `DashboardSpec` (jsonb.types). */
export const dashboardSpecSchema = z.object({
	title: z.string(),
	blocks: z.array(
		z.discriminatedUnion("kind", [statBlock, barBlock, lineBlock, gridBlock]),
	),
});

// Compile-time guarantee the Zod schema stays in lockstep with the exported type.
type _SpecMatches = DashboardSpec extends z.infer<typeof dashboardSpecSchema>
	? z.infer<typeof dashboardSpecSchema> extends DashboardSpec
		? true
		: never
	: never;
const _specMatches: _SpecMatches = true;
void _specMatches;

/**
 * The generative-dashboard tool. The model composes a small block list (stat/bar/
 * line/grid) from data it has fetched via the read tools; `execute` is a pure
 * passthrough that validates and returns the spec so the CLIENT renders it (the
 * console interprets the spec with grayscale primitives in the artifact panel).
 */
export function visualizeTools() {
	return {
		build_dashboard: tool({
			description:
				"Render a dashboard for the user from data you have already fetched via the read tools (get_org_usage / get_billing_summary / get_ai_usage / get_drift_posture / estimate_cost / list_* etc). Compose a small block list: stat (a headline number), bar (categorical comparison), line (a trend from a number series), grid (labelled key/value cells). Use REAL fetched numbers — never invent data. The client renders the result as a grayscale dashboard in the side panel.",
			inputSchema: dashboardSpecSchema,
			/** Pure passthrough — the validated spec is rendered client-side. */
			execute: async (spec): Promise<DashboardSpec> => spec,
		}),
	};
}
