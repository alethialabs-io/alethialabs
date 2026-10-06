// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The #5565 one-off check: how many rows ALREADY hold a credential that came from a component's
// `provider_config`?
//
// Until #5565 the canvas offered `rds_extra_credentials` (AWS database; its type declares a
// `password`) and a secret's `value` (AWS secret) as ordinary knobs, so whatever a user typed was
// stored in plaintext JSONB. The write path now refuses new ones; this counts the old ones so the
// maintainer knows whether there is anything to clean up. It counts THREE places, because the value
// does not stay in the component row:
//
//   1. the 11 component tables' `provider_config` — the source;
//   2. `jobs.config_snapshot` — every plan/deploy freezes the components' provider_config into the
//      job's snapshot, so a value removed from the component today is still in every past job;
//   3. `project_changes.payload` — a staged canvas diff carried the whole component record.
//
// A zero in (1) therefore says NOTHING about (2) and (3): a value set, deployed and later removed
// leaves (1) at zero and (2) non-zero. Each place is reported on its own line, and the summary
// names exactly the tables counted.
//
// It reads KEY NAMES ONLY. The queries are `jsonb_object_keys` over every nested object, grouped by
// key, plus a `jsonb_path_exists` row count for a secret's `provider_config.value`; no value is ever
// selected, so nothing secret can reach the terminal, a log or a CI artefact however this is run. It
// changes nothing: no delete, no migration — and the session is made read-only by the server, as in
// audit-grant-scopes.mjs (`default_transaction_read_only` in the startup packet, read back before
// any statement runs).
//
// It also cannot report a FALSE ZERO under row-level security. Every table here is RLS-protected,
// and a role subject to RLS with no org in its session reads every table as empty — which would
// print the ✓ line. So the session starts with `row_security=off` (startup `options`, kept across a
// reconnect, and read back): for a role that bypasses RLS (the
// service role behind ALETHIA_DATABASE_URL) that changes nothing, and for any other role Postgres
// RAISES on the first query instead of filtering, and the audit fails with exit 1.
//
// Usage:
//   pnpm -C apps/console run audit:credential-knobs                 # against ALETHIA_DATABASE_URL
//   pnpm -C apps/console run audit:credential-knobs -- --json       # machine-readable
//   pnpm -C apps/console run audit:credential-knobs -- --print-sql  # just emit the queries
//   pnpm -C apps/console run audit:credential-knobs -- --url postgres://…
//
// Exit codes: 0 — ran, found nothing · 2 — ran, FOUND rows (each named by table, key and count) ·
// 1 — could not run (no URL, unreachable, or the session could not be made read-only).
//
// Which keys count as a credential is NOT restated here: every key comes back and
// `credentialKeyCounts` keeps the ones `isCredentialKey` (lib/cloud-providers/credential-knobs.ts)
// classifies as credentials — the same rule the write path refuses with.
//
// What it still does not count: copies outside this database — tofu state and plan files in the
// state backend, runner logs, and database backups taken while a value was stored.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";
import type { NodeKind } from "@/components/design-project/canvas/graph/types";
import {
	credentialKeyCounts,
	derivedCredentialKeyCounts,
	jsonKeyCountSql,
	type KeyCount,
	providerConfigValueCountSql,
} from "@/lib/cloud-providers/credential-knobs";
import {
	jobs,
	projectChanges,
	projectCaches,
	projectCluster,
	projectContainerRegistries,
	projectDatabases,
	projectDns,
	projectHelmRegistries,
	projectNosqlTables,
	projectQueues,
	projectSecrets,
	projectStorageBuckets,
	projectTopics,
} from "@/lib/db/schema";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT_ENV = join(here, "../../../.env");

/** Every component table with a `provider_config` column, by the canvas kind its knobs are filed under. */
const TABLES: readonly [NodeKind, PgTable][] = [
	["cluster", projectCluster],
	["dns", projectDns],
	["database", projectDatabases],
	["cache", projectCaches],
	["queue", projectQueues],
	["topic", projectTopics],
	["nosql", projectNosqlTables],
	["secret", projectSecrets],
	["bucket", projectStorageBuckets],
	["registry", projectContainerRegistries],
	["helm_registry", projectHelmRegistries],
];

/** The documents DERIVED from component rows that carry a copy of their provider_config. */
const DERIVED: readonly [PgTable, string][] = [
	[jobs, "config_snapshot"],
	[projectChanges, "payload"],
];

/** One finding: a credential key held by `rows` rows of `table`.`column` across `projects` projects. */
interface Finding extends KeyCount {
	table: string;
	column: string;
}

/** Loads the root .env without overriding values already set (for ALETHIA_DATABASE_URL). */
function loadRootEnv(): void {
	if (!existsSync(ROOT_ENV)) return;
	for (const raw of readFileSync(ROOT_ENV, "utf8").split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		if (process.env[key] !== undefined) continue;
		let val = line.slice(eq + 1).trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		process.env[key] = val;
	}
}

/** The value of `--name value` or `--name=value`, or the fallback. */
function arg(name: string, fallback: string | undefined): string | undefined {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	if (hit) return hit.slice(`--${name}=`.length);
	const idx = process.argv.indexOf(`--${name}`);
	return idx !== -1 ? process.argv[idx + 1] : fallback;
}

/** A query result row narrowed to a key tally, or null for a row of any other shape. */
function toKeyCount(row: unknown): KeyCount | null {
	if (typeof row !== "object" || row === null) return null;
	const key = Reflect.get(row, "key");
	const rows = Reflect.get(row, "rows");
	const projects = Reflect.get(row, "projects");
	if (typeof key !== "string" || typeof rows !== "number" || typeof projects !== "number") return null;
	return { key, rows, projects };
}

/** Runs the audit; sets `process.exitCode` rather than exiting, so stdout drains. */
async function main(): Promise<void> {
	const queries: { table: string; column: string; sql: string }[] = [
		...TABLES.map(([, table]) => ({
			table: getTableName(table),
			column: "provider_config",
			sql: jsonKeyCountSql(getTableName(table), "provider_config"),
		})),
		...DERIVED.flatMap(([table, column]) => [
			{ table: getTableName(table), column, sql: jsonKeyCountSql(getTableName(table), column) },
			{ table: getTableName(table), column, sql: providerConfigValueCountSql(getTableName(table), column) },
		]),
	];
	const counted = [...new Set(queries.map((q) => `${q.table}.${q.column}`))];

	if (process.argv.includes("--print-sql")) {
		process.stdout.write(`-- run with row_security=off and a read-only session\n\n${queries.map((q) => `${q.sql};`).join("\n\n")}\n`);
		process.exitCode = 0;
		return;
	}

	loadRootEnv();
	const json = process.argv.includes("--json");
	const url = arg("url", process.env.ALETHIA_DATABASE_URL);
	if (!url) {
		console.error("✗ No database URL. Set ALETHIA_DATABASE_URL (root .env or the environment), or pass --url.");
		process.exitCode = 1;
		return;
	}

	const sql = postgres(url, {
		max: 1,
		onnotice: () => {},
		// Both in the STARTUP packet, so a reconnect by the driver gets them too: a later `SET` would be
		// lost with the connection it ran on.
		connection: { default_transaction_read_only: true, options: "-c row_security=off" },
	});
	try {
		const [mode] = await sql`show transaction_read_only`;
		if (mode?.transaction_read_only !== "on") {
			console.error(
				`✗ Refusing to run: the session is not read-only (transaction_read_only=${mode?.transaction_read_only ?? "unknown"}).`,
			);
			await sql.end({ timeout: 1 }).catch(() => {});
			process.exitCode = 1;
			return;
		}
		// See the header: a role subject to RLS now RAISES on the first query instead of reading every
		// table as empty and reporting a false zero. Read back, like the read-only flag.
		const [rls] = await sql`show row_security`;
		if (rls?.row_security !== "off") {
			console.error(`✗ Refusing to run: row_security could not be turned off (row_security=${rls?.row_security ?? "unknown"}).`);
			await sql.end({ timeout: 1 }).catch(() => {});
			process.exitCode = 1;
			return;
		}

		const findings: Finding[] = [];
		for (const [kind, table] of TABLES) {
			const name = getTableName(table);
			const rows = await sql.unsafe(jsonKeyCountSql(name, "provider_config"));
			const counts = rows.map(toKeyCount).filter((c): c is KeyCount => c !== null);
			for (const c of credentialKeyCounts(kind, counts)) {
				findings.push({ table: name, column: "provider_config", ...c });
			}
		}
		for (const [table, column] of DERIVED) {
			const name = getTableName(table);
			const rows = await sql.unsafe(jsonKeyCountSql(name, column));
			const counts = rows.map(toKeyCount).filter((c): c is KeyCount => c !== null);
			for (const c of derivedCredentialKeyCounts(counts)) findings.push({ table: name, column, ...c });
			const [valueRows] = await sql.unsafe(providerConfigValueCountSql(name, column));
			const v = toKeyCount({ key: "provider_config.value", ...valueRows });
			if (v && v.rows > 0) findings.push({ table: name, column, ...v });
		}
		await sql.end();

		if (json) {
			process.stdout.write(`${JSON.stringify({ counted, findings }, null, 2)}\n`);
		} else if (findings.length === 0) {
			console.log(`✓ No key that is a credential, or is named like one, in any of the ${counted.length} places counted (values not read):`);
			for (const c of counted) console.log(`    ${c}`);
			console.log("  Not counted: tofu state and plan files, runner logs, and database backups.");
		} else {
			console.log(`⚠ Keys that are credentials, or are named like them, found (values not shown). Counted: ${counted.join(", ")}.\n`);
			for (const f of findings) {
				console.log(`  ${f.table}.${f.column} → ${f.key}  ${f.rows} row(s) in ${f.projects} project(s)`);
			}
			console.log(
				"\n  Nothing was deleted. Component values are still applied, and the canvas keeps them unchanged\n" +
					"  on save: move each value to its secret store, then choose 'Remove the stored value' in the\n" +
					"  component's Advanced section. Copies in jobs.config_snapshot and project_changes.payload\n" +
					"  are not removed by that; they need a maintainer decision.\n" +
					"  Not counted: tofu state and plan files, runner logs, and database backups.",
			);
		}
		process.exitCode = findings.length === 0 ? 0 : 2;
	} catch (err) {
		console.error("\n✗ audit-credential-knobs failed:\n");
		console.error(err);
		await sql.end({ timeout: 1 }).catch(() => {});
		process.exitCode = 1;
	}
}

void main();
