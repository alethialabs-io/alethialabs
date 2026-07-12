// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The saved-artifact spec schema (zod SSOT), shared by the server actions, the agent
// tools, and the client save/browse UI. Kept out of the "use server" module (those may
// only export async functions).

import { z } from "zod";
import { dashboardBlockSchema } from "@/lib/ai/tools/visualize";
import type { ArtifactSpec } from "@/types/jsonb.types";

/** Portable widget entry inside an artifact spec (mirrors `ArtifactWidget`). */
export const artifactWidgetSchema = z.object({
	kind: z.enum(["table", "stat", "bar", "line", "keyvalue"]),
	title: z.string().min(1).max(120),
	source: z
		.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).nullable() })
		.nullable(),
	data: z.object({
		output: z.unknown().optional(),
		block: dashboardBlockSchema.optional(),
	}),
	mode: z.enum(["live", "frozen"]),
	position: z.object({ x: z.number().int().min(0).max(4), y: z.number().int().min(0) }),
	size: z.object({
		colspan: z.number().int().min(1).max(5),
		rowspan: z.number().int().min(1).max(12),
	}),
});

/** Mirrors `ArtifactSpec` (jsonb.types) — bounded so a runaway spec can't balloon a row. */
export const artifactSpecSchema = z.object({
	widgets: z.array(artifactWidgetSchema).min(1).max(40),
});

// Compile-time lockstep with the JSONB interface (same pattern as visualize.ts).
type _SpecMatches = ArtifactSpec extends z.infer<typeof artifactSpecSchema>
	? true
	: never;
const _specMatches: _SpecMatches = true;
void _specMatches;
