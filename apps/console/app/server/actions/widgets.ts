"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { dashboardBlockSchema } from "@/lib/ai/tools/visualize";
import { requireOwner } from "@/lib/auth/owner";
import { withOwnerScope } from "@/lib/db";
import { type ThreadWidget, threadWidgets } from "@/lib/db/schema";
import type {
	WidgetData,
	WidgetKind,
	WidgetMode,
	WidgetSource,
} from "@/types/jsonb.types";

const KINDS = ["table", "stat", "bar", "line", "keyvalue"] as const;
const MODES = ["live", "frozen"] as const;

const sourceSchema = z
	.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).nullable() })
	.nullable();

const pinInputSchema = z.object({
	threadId: z.string().uuid(),
	kind: z.enum(KINDS),
	title: z.string().min(1).max(120),
	source: sourceSchema.optional(),
	data: z
		.object({ output: z.unknown().optional(), block: dashboardBlockSchema.optional() })
		.optional(),
	posX: z.number().int().min(0).max(4),
	posY: z.number().int().min(0),
	colspan: z.number().int().min(1).max(5),
	rowspan: z.number().int().min(1).max(12),
	mode: z.enum(MODES),
	/** Auto-pin dedupe key (the producing toolCallId); omitted for user pins. */
	toolCallId: z.string().optional(),
});

export type PinWidgetInput = z.infer<typeof pinInputSchema>;

const updateInputSchema = z.object({
	id: z.string().uuid(),
	posX: z.number().int().min(0).max(4).optional(),
	posY: z.number().int().min(0).optional(),
	colspan: z.number().int().min(1).max(5).optional(),
	rowspan: z.number().int().min(1).max(12).optional(),
	mode: z.enum(MODES).optional(),
	title: z.string().min(1).max(120).optional(),
});

export type UpdateWidgetInput = z.infer<typeof updateInputSchema>;

/** List a thread's widgets, stable order (creation) — layout comes from pos columns. */
export async function listThreadWidgets(threadId: string): Promise<ThreadWidget[]> {
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) =>
		tx
			.select()
			.from(threadWidgets)
			.where(eq(threadWidgets.thread_id, threadId))
			.orderBy(asc(threadWidgets.created_at)),
	);
}

/**
 * Pin a widget to a thread's grid. Auto-pins are idempotent two ways:
 * - by `toolCallId` — transcript replay re-renders tool parts, and the unique
 *   `(thread_id, tool_call_id)` upsert makes the second pin a no-op returning the row;
 * - by `source` — the same `{tool, args}` already on the grid becomes a data refresh
 *   of that widget (a repeated chat query updates, it doesn't clutter a new cell).
 */
export async function pinWidget(input: PinWidgetInput): Promise<ThreadWidget> {
	const parsed = pinInputSchema.parse(input);
	const owner = await requireOwner();
	return withOwnerScope(owner, async (tx) => {
		// zod's KINDS/MODES enums are exactly the WidgetKind/WidgetMode unions.
		const kind: WidgetKind = parsed.kind;
		const mode: WidgetMode = parsed.mode;
		const source: WidgetSource | null = parsed.source ?? null;
		const data: WidgetData = parsed.data ?? {};

		// Replace-by-source: refresh the existing widget for this exact tool call shape.
		if (source) {
			const existing = await tx
				.select()
				.from(threadWidgets)
				.where(eq(threadWidgets.thread_id, parsed.threadId));
			const match = existing.find(
				(w) =>
					w.source &&
					w.source.tool === source.tool &&
					JSON.stringify(w.source.args ?? null) === JSON.stringify(source.args ?? null),
			);
			if (match) {
				const [updated] = await tx
					.update(threadWidgets)
					.set({
						data,
						refreshed_at: sql`now()`,
						updated_at: sql`now()`,
						...(parsed.toolCallId ? { tool_call_id: parsed.toolCallId } : {}),
					})
					.where(eq(threadWidgets.id, match.id))
					.returning();
				return updated;
			}
		}

		const [row] = await tx
			.insert(threadWidgets)
			.values({
				thread_id: parsed.threadId,
				user_id: owner,
				org_id: owner,
				kind,
				title: parsed.title,
				source,
				data,
				pos_x: parsed.posX,
				pos_y: parsed.posY,
				colspan: parsed.colspan,
				rowspan: parsed.rowspan,
				mode,
				tool_call_id: parsed.toolCallId ?? null,
			})
			.onConflictDoNothing({
				target: [threadWidgets.thread_id, threadWidgets.tool_call_id],
			})
			.returning();
		if (row) return row;

		// Conflict path: the toolCallId was already pinned — return the existing row.
		const [existing] = await tx
			.select()
			.from(threadWidgets)
			.where(
				and(
					eq(threadWidgets.thread_id, parsed.threadId),
					eq(threadWidgets.tool_call_id, parsed.toolCallId ?? ""),
				),
			)
			.limit(1);
		return existing;
	});
}

/** Update a widget's placement / size / mode / title (drag-end, resize, toggle). */
export async function updateWidget(input: UpdateWidgetInput): Promise<void> {
	const parsed = updateInputSchema.parse(input);
	const owner = await requireOwner();
	await withOwnerScope(owner, async (tx) => {
		await tx
			.update(threadWidgets)
			.set({
				...(parsed.posX !== undefined ? { pos_x: parsed.posX } : {}),
				...(parsed.posY !== undefined ? { pos_y: parsed.posY } : {}),
				...(parsed.colspan !== undefined ? { colspan: parsed.colspan } : {}),
				...(parsed.rowspan !== undefined ? { rowspan: parsed.rowspan } : {}),
				...(parsed.mode !== undefined ? { mode: parsed.mode } : {}),
				...(parsed.title !== undefined ? { title: parsed.title } : {}),
				updated_at: sql`now()`,
			})
			.where(eq(threadWidgets.id, parsed.id));
	});
}

/** Remove a widget from the grid. */
export async function deleteWidget(id: string): Promise<void> {
	const owner = await requireOwner();
	await withOwnerScope(owner, async (tx) => {
		await tx.delete(threadWidgets).where(eq(threadWidgets.id, id));
	});
}
