// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The D1 schema, and the Worker applies it itself.
 *
 * OpenTofu has no D1 query resource, and TOVR's port of this page applied the schema with a
 * `wrangler d1 execute` step after the apply. That step needed the database id written into a
 * throwaway config, and its ordering left the first cron cycles throwing on a missing table. Here
 * the cycle runs these statements once per isolate before it touches a table instead: every one is
 * `IF NOT EXISTS`, so a re-run is a no-op that writes no rows, and a fresh database (or a
 * redeployed Worker) needs no human step at all.
 *
 * Two tables carry data, and the split is the retention policy:
 *
 *   `checks` is a SHORT ROLLING WINDOW, not history. The incident state machine needs to know whether
 *   the last couple of probes failed and nothing more, so rows older than an hour are deleted every
 *   cycle.
 *
 *   `daily` IS the history. One row per component per day, incremented in place, read back for 90
 *   days. It is what the uptime bar and the percentage read, and it is why history survives a Worker
 *   redeploy: the database is a separate resource from the script.
 *
 * Together they cost ~15 row writes a minute, inside D1's free allowance of 100k row writes a day.
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
	`CREATE TABLE IF NOT EXISTS checks (
		component TEXT    NOT NULL,
		ts        INTEGER NOT NULL,
		health    TEXT    NOT NULL,
		ms        INTEGER,
		reason    TEXT,
		PRIMARY KEY (component, ts)
	)`,
	"CREATE INDEX IF NOT EXISTS checks_by_ts ON checks (ts)",
	`CREATE TABLE IF NOT EXISTS daily (
		component TEXT    NOT NULL,
		day       TEXT    NOT NULL,
		total     INTEGER NOT NULL DEFAULT 0,
		up        INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (component, day)
	)`,
	`CREATE TABLE IF NOT EXISTS incidents (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		component   TEXT    NOT NULL,
		started_at  INTEGER NOT NULL,
		resolved_at INTEGER,
		worst       TEXT    NOT NULL,
		reason      TEXT
	)`,
	// At most one open incident per component — the state machine reads `openIncident` as a single
	// row, so the database enforces it rather than trusting the caller to.
	"CREATE UNIQUE INDEX IF NOT EXISTS incidents_one_open_per_component ON incidents (component) WHERE resolved_at IS NULL",
	"CREATE INDEX IF NOT EXISTS incidents_recent ON incidents (started_at DESC)",
];
