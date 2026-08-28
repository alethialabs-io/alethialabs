// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import {
	bigint,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import { jobInitiator } from "./enums";

// Append-only AI usage ledger — one row per metered AI action (a repo scan or an
// agent/Ask AI message), carrying the credits it cost and whether they came from the
// plan's included budget or purchased top-ups. Summed per window/week to enforce the
// credit budget. Owner-scoped (user_id + org_id) for the RLS backstop.
//
// The model/token/cost columns snapshot what the action actually cost us (token usage
// from the AI Gateway × current model price at write time), so real AI cost-of-serve
// is queryable per org — independent of the user-facing credit price. Nullable for
// back-compat with rows written before instrumentation.
export const aiUsageLedger = pgTable(
	"ai_usage_ledger",
	{
		id: uuid().primaryKey().defaultRandom(),
		user_id: uuid().notNull(),
		org_id: uuid(),
		// "scan" | "agent".
		kind: text().notNull(),
		// Credits this action cost.
		credits: integer().default(0).notNull(),
		// "included" | "purchased" — which budget it drew from.
		source: text().default("included").notNull(),
		// Origin of the metered action, mirroring jobs.initiated_by for a consistent actor lexicon
		// across the two usage ledgers. Metered AI actions (scan/agent/support) are user-driven, so
		// this defaults to `user`; a background/system-initiated AI call stamps `system`.
		initiated_by: jobInitiator().notNull().default("user"),
		// jobId (scan) / threadId (agent), for traceability.
		ref_id: text(),
		// Canonical provider/native-id key that served the action (e.g. "anthropic/claude-sonnet-4-6").
		model: text(),
		// Token usage reported by the provider for this action.
		input_tokens: integer(),
		output_tokens: integer(),
		cached_input_tokens: integer(),
		// Our snapshotted USD cost-of-serve in micros (1e-6 USD), priced at write time.
		cost_micros: bigint({ mode: "number" }),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		/**
		 * When this row stopped being a provisional reservation. NULL means, and means ONLY, that a
		 * metered turn's hold is still outstanding.
		 *
		 * WHY IT EXISTS (#2683). `assertAiAllowed` reserves a `METERED_RESERVE_CREDITS` hold row and
		 * `recordAiUsage` reconciles it IN PLACE. If the reconciling write fails, the reserve sits
		 * against the org's window until it rolls — `meteringFailed` logs that a hold "may be
		 * stranded", and nothing releases it. The contract on `assertAiAllowed` says a settled,
		 * errored or empty turn "never leaks its ≈$0.10 hold"; a log line does not meet "never".
		 *
		 * A sweep needs to identify an outstanding hold, and before this column there was no honest
		 * way to. Reconciliation rewrites credits/model/tokens/cost and stamps NOTHING, so the only
		 * available signature was heuristic — "credits still equal the reserve and model IS NULL" —
		 * which misfires on a real turn that used no model and cost the reserve, and misfires in the
		 * direction of releasing a genuine charge to zero. A billing sweep whose failure mode is
		 * quietly undercharging is not one to run on a guess.
		 *
		 * Both WRITING paths stamp it, so the predicate stays exact: the plain INSERT path is settled
		 * on arrival, the reconcile UPDATE stamps it, and only `reserve()` leaves it NULL. If a third
		 * write path is ever added, it must stamp this too — a row that is not a hold but looks like
		 * one would be released to 0, which is money.
		 */
		settled_at: timestamp({ withTimezone: true }),
	},
	(t) => [
		index("idx_ai_usage_org_source_created").on(
			t.org_id,
			t.source,
			t.created_at,
		),
		index("idx_ai_usage_user").on(t.user_id),
		// PARTIAL, on the sweep's exact predicate. Settled rows are the overwhelming majority and a
		// full index on `created_at` would carry all of them to answer a question only about the few
		// that are outstanding. The reconciler runs on a timer forever, so this index is read far
		// more often than the holds it finds.
		index("idx_ai_usage_outstanding_holds")
			.on(t.created_at)
			.where(sql`settled_at IS NULL`),
	],
);

export type AiUsageRow = typeof aiUsageLedger.$inferSelect;
