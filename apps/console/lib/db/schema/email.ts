// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { jsonb, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { EmailSuppressionDetail } from "@/types/jsonb.types";

// Why an address must never be mailed again: a permanent (hard) bounce or a
// complaint (marked as spam). Transient bounces are NOT suppressed.
export const emailSuppressionReason = pgEnum("email_suppression_reason", [
	"bounce",
	"complaint",
]);

// Platform-global suppression list. Written by the SES SNS webhook
// (app/api/webhooks/ses) on bounce/complaint, read by the senders before every
// send (lib/email/guard.ts). Global, not org-scoped — a dead address is dead for
// everyone — so it's accessed via the service connection, never under RLS.
export const emailSuppression = pgTable("email_suppression", {
	// Lowercased recipient address; PK makes the webhook upsert idempotent.
	email: text().primaryKey(),
	reason: emailSuppressionReason().notNull(),
	// Where it came from, e.g. "ses-sns" or "manual".
	source: text().notNull(),
	detail: jsonb().$type<EmailSuppressionDetail>(),
	created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export type EmailSuppression = typeof emailSuppression.$inferSelect;
