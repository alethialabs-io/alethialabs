// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Published alethia CLI releases. Mirrors runner_releases: the release pipeline
// (GoReleaser job in release-cli.yml) upserts a row per cli-vX.Y.Z tag, and the
// CLI polls /api/releases/cli to tell the user when a newer version exists.
// `min_supported_version` lets us signal a forced-upgrade floor.
export const cliReleases = pgTable("cli_releases", {
	id: uuid().primaryKey().defaultRandom(),
	version: text().notNull().unique(),
	release_notes: text().default("").notNull(),
	released_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	commit_sha: text(),
	github_release_url: text(),
	// Builds older than this should warn loudly (breaking wire/CLI changes).
	min_supported_version: text(),
	is_breaking: boolean().default(false).notNull(),
});

export type CliRelease = typeof cliReleases.$inferSelect;
export type NewCliRelease = typeof cliReleases.$inferInsert;
