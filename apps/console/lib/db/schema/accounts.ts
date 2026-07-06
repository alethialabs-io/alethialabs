// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// User profile (id matches the auth subject; no cross-DB FK — Better Auth owns
// users in Phase D). Kept so CLI auth + display can resolve email/name.
export const profiles = pgTable("profiles", {
	id: uuid().primaryKey(),
	email: text(),
	full_name: text(),
	avatar_url: text(),
	created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

// CLI device-code flow scratch records (service-role access only).
export const cliLogins = pgTable("cli_logins", {
	device_code: text().primaryKey(),
	verification_code: text(),
	profile_id: uuid().references(() => profiles.id),
	refresh_token: text(),
	expires_at: timestamp({ withTimezone: true }),
	created_at: timestamp({ withTimezone: true }).defaultNow(),
});

export type Profile = typeof profiles.$inferSelect;
export type CliLogin = typeof cliLogins.$inferSelect;
