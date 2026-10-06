// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The #5565 one-off check: how many component rows ALREADY hold a credential in `provider_config`?
//
// Until #5565 the canvas offered `rds_extra_credentials` (AWS database; its type declares a
// `password`) and a secret's `value` (AWS secret) as ordinary knobs, so whatever a user typed was
// stored in plaintext JSONB. The write path now refuses new ones; this counts the old ones, per
// table and per key, so the maintainer knows whether there is anything to clean up.
//
// It reads KEY NAMES ONLY. The query is `jsonb_object_keys` grouped by key, and no value is ever
// selected, so nothing secret can reach the terminal, a log or a CI artefact however this is run. It
// changes nothing: no delete, no migration — and the session is made read-only by the server, as in
// audit-grant-scopes.mjs (`default_transaction_read_only=on` in the startup packet, read back before
// any statement runs).
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
// What it does not count: copies of those values that left the component row before #5565 — the
// frozen `config_snapshot` of a job planned from such a row, and a staged canvas diff in
// `project_changes`. Both are derived from the rows counted here, so a zero here means there is
// nothing upstream of them either; a non-zero means those copies should be looked at too.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";
import type { NodeKind } from "@/components/design-project/canvas/graph/types";
import {
	credentialKeyCounts,
	type KeyCount,
	providerConfigKeyCountSql,
} from "@/lib/cloud-providers/credential-knobs";
import {
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

/** One finding: a credential key held by `rows` rows of `table` across `projects` projects. */
interface Finding extends KeyCount {
	table: string;
	kind: NodeKind;
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
	if (process.argv.includes("--print-sql")) {
		process.stdout.write(
			`${TABLES.map(([kind, table]) => `-- ${kind}\n${providerConfigKeyCountSql(getTableName(table))};`).join("\n\n")}\n`,
		);
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
		connection: { default_transaction_read_only: true },
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

		const findings: Finding[] = [];
		for (const [kind, table] of TABLES) {
			const name = getTableName(table);
			const rows = await sql.unsafe(providerConfigKeyCountSql(name));
			const counts = rows.map(toKeyCount).filter((c): c is KeyCount => c !== null);
			for (const c of credentialKeyCounts(kind, counts)) findings.push({ table: name, kind, ...c });
		}
		await sql.end();

		if (json) {
			process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
		} else if (findings.length === 0) {
			console.log("✓ No component row holds a credential in provider_config. Nothing to clean up for #5565.");
		} else {
			const total = findings.reduce((n, f) => n + f.rows, 0);
			console.log(`⚠ ${total} provider_config entr${total === 1 ? "y holds" : "ies hold"} a credential (values not shown):\n`);
			for (const f of findings) {
				console.log(`  ${f.table}.provider_config.${f.key}  ${f.rows} row(s) in ${f.projects} project(s)`);
			}
			console.log(
				"\n  These are still applied, and the canvas keeps them unchanged on save. Nothing was deleted.\n" +
					"  Move each value to its secret store, then remove the key — on the canvas, choose\n" +
					"  'Remove the stored value' in the component's Advanced section.",
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
