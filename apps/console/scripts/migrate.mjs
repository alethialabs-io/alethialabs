// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// DB migrate runner — replaces the drizzle-kit CLI (whose spinner swallows
// errors). Applies the generated schema migrations, then the idempotent
// programmables (functions/triggers/RLS) via .unsafe(), then sets the app role's
// login password. Prints full errors and exits non-zero on failure.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "../lib/db/migrations");
const programmablesPath = join(here, "../lib/db/programmables.sql");

const url = process.env.ALETHIA_DATABASE_URL;
if (!url) {
	console.error("✗ ALETHIA_DATABASE_URL is not set (see .env.example).");
	process.exit(1);
}

/** Escapes a string for use as a single-quoted SQL literal. */
function sqlLiteral(value) {
	return `'${value.replace(/'/g, "''")}'`;
}

const sql = postgres(url, { max: 1, onnotice: () => {} });

// Postgres "already exists" error classes: duplicate_object (enum/type),
// duplicate_table, duplicate_column. They mean the schema is already present but
// the drizzle migration journal is out of sync — typically after regenerating
// the baseline migration over a populated volume.
const ALREADY_EXISTS_CODES = new Set(["42710", "42P07", "42712"]);

try {
	console.log("→ applying schema migrations…");
	try {
		await migrate(drizzle(sql), { migrationsFolder });
	} catch (migrateErr) {
		if (ALREADY_EXISTS_CODES.has(migrateErr?.cause?.code ?? migrateErr?.code)) {
			console.error(
				"\n✗ Schema objects already exist but the migration journal is out of sync\n" +
					"  (this happens when the baseline migration was regenerated over an existing volume).\n" +
					"  Run `pnpm db:reset` for a clean slate, or drop the conflicting objects.\n",
			);
			await sql.end({ timeout: 1 }).catch(() => {});
			process.exit(1);
		}
		throw migrateErr;
	}

	console.log("→ applying programmables (functions, triggers, RLS)…");
	await sql.unsafe(readFileSync(programmablesPath, "utf8"));

	const appPassword = process.env.ALETHIA_APP_DB_PASSWORD;
	if (appPassword) {
		console.log("→ setting app role login password…");
		await sql.unsafe(
			`ALTER ROLE alethia_app LOGIN PASSWORD ${sqlLiteral(appPassword)}`,
		);
	} else {
		console.warn(
			"⚠ ALETHIA_APP_DB_PASSWORD unset — alethia_app stays NOLOGIN (RLS-enforced app connection won't authenticate).",
		);
	}

	console.log("✓ database migrated");
	await sql.end();
	process.exit(0);
} catch (err) {
	console.error("\n✗ migration failed:\n");
	console.error(err);
	await sql.end({ timeout: 1 }).catch(() => {});
	process.exit(1);
}
