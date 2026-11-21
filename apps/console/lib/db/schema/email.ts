// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	boolean,
	index,
	jsonb,
	pgEnum,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import type { EmailSuppressionDetail } from "@/types/jsonb.types";
import { user } from "./auth";

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

/**
 * What one address has said it wants, per mail category.
 *
 * Keyed by ADDRESS, not by account: an alert recipient need not have an account, and an
 * unsubscribe link has to work for whoever holds the message. `user_id` links the row to an
 * account when the address belongs to one, so the erasure register can reach it.
 *
 * A category with no row reads its DEFAULT (`lib/email/preferences.ts`): `product_updates` is off
 * until the person turns it on, and a per-channel alert category is on — the channel's admin chose
 * the recipient, and the row exists only once that recipient mutes it. Service-role only (RLS with
 * no app policy, programmables.sql): an unsubscribe arrives without a session.
 */
export const emailPreference = pgTable(
	"email_preference",
	{
		/** Lower-cased, trimmed recipient address. */
		email: text().notNull(),
		/** `product_updates`, or `alert_channel:<channel id>` for one alert channel. */
		category: text().notNull(),
		enabled: boolean().notNull(),
		/** The account the address belongs to, when it belongs to one. */
		user_id: uuid().references(() => user.id, { onDelete: "cascade" }),
		/** How the choice was made: `preferences_page`, `one_click`, `unsubscribe_page`. */
		source: text().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.email, t.category] }),
		index("email_preference_user_idx").on(t.user_id),
	],
);

export type EmailPreference = typeof emailPreference.$inferSelect;
