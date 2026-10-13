// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The widget-pin input schema (zod SSOT) for the `pinWidget` server action, kept out of the
// "use server" module (those may only export async functions) so tests and fixtures can import it.
//
// `data` is not redeclared here: it IS `artifactWidgetSchema.shape.data`, the same object an
// artifact's widgets carry. Both end up in the same `thread_widgets.data` column `WidgetCard`
// renders — a pin through `pinWidget`, an artifact's widgets inserted directly by
// `openArtifactOnGrid` after `artifactSpecSchema` validated them at save — so the two must accept
// and reject the same payloads. Sharing the one schema object is what makes that true.

import { z } from "zod";
import { artifactWidgetSchema } from "@/lib/ai/artifact-spec";

/** The widget kinds a pin may carry — exactly the `WidgetKind` union. */
const WIDGET_KINDS = ["table", "stat", "bar", "line", "keyvalue"] as const;
/** The widget refresh modes — exactly the `WidgetMode` union. */
export const WIDGET_MODES = ["live", "frozen"] as const;

/** A widget's `data` payload (`{ output?, block? }`) — the one schema pins and artifacts share. */
export const widgetDataSchema = artifactWidgetSchema.shape.data;

/** The replayable `{ tool, args }` source a live widget refreshes from (null for a frozen one). */
const widgetSourceSchema = z
	.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).nullable() })
	.nullable();

/** Input to `pinWidget`: the widget, its grid placement, and the optional auto-pin dedupe key. */
export const pinInputSchema = z.object({
	threadId: z.string().uuid(),
	kind: z.enum(WIDGET_KINDS),
	title: z.string().min(1).max(120),
	source: widgetSourceSchema.optional(),
	data: widgetDataSchema.optional(),
	posX: z.number().int().min(0).max(4),
	posY: z.number().int().min(0),
	colspan: z.number().int().min(1).max(5),
	rowspan: z.number().int().min(1).max(12),
	mode: z.enum(WIDGET_MODES),
	/** Auto-pin dedupe key (the producing toolCallId); omitted for user pins. */
	toolCallId: z.string().optional(),
});
