// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import type {
	WidgetData,
	WidgetKind,
	WidgetMode,
	WidgetSource,
} from "@/types/jsonb.types";
import { agentThreads } from "./agent";

// Elench widget grid — one row per widget pinned to a chat's bento canvas. The grid
// is PER-THREAD (cascade-deleted with it); a widget stores WHERE it sits (pos/span on
// the 5-column grid), WHAT it renders (`kind` + `data`), and — for live widgets — HOW
// to refresh it (`source` = the replayable read-tool call). Owner-scoped like
// agent_threads (`set_org_id` trigger + `owner_all` RLS in programmables.sql).
export const threadWidgets = pgTable(
	"thread_widgets",
	{
		id: uuid().primaryKey().defaultRandom(),
		thread_id: uuid()
			.notNull()
			.references(() => agentThreads.id, { onDelete: "cascade" }),
		user_id: uuid().notNull(),
		org_id: uuid(),
		kind: text().$type<WidgetKind>().notNull(),
		title: text().notNull(),
		/** The replayable read-tool call behind a live widget; null = spec-only (frozen block). */
		source: jsonb().$type<WidgetSource | null>().default(null),
		/** The rendered payload: a tool-output snapshot or one dashboard block. */
		data: jsonb().$type<WidgetData>().default({}).notNull(),
		pos_x: integer().notNull(),
		pos_y: integer().notNull(),
		colspan: integer().default(1).notNull(),
		rowspan: integer().default(1).notNull(),
		mode: text().$type<WidgetMode>().default("frozen").notNull(),
		/**
		 * The toolCallId that auto-pinned this widget. Transcript replay re-renders tool
		 * parts, so pinning upserts on (thread_id, tool_call_id) — the same call never
		 * lands twice. NULL for user-pinned / exploded-block widgets.
		 */
		tool_call_id: text(),
		refreshed_at: timestamp({ withTimezone: true }),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index("idx_thread_widgets_thread").on(t.thread_id),
		uniqueIndex("uq_thread_widgets_toolcall").on(t.thread_id, t.tool_call_id),
	],
);

export type ThreadWidget = typeof threadWidgets.$inferSelect;
export type NewThreadWidget = typeof threadWidgets.$inferInsert;
