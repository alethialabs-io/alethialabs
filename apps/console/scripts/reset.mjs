// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// DESTRUCTIVE dev reset: drops the app schema + drizzle migration journal so the next
// `migrate` rebuilds from a clean slate. Used to recover from migration-journal drift
// (the escape hatch migrate.mjs points to). Roles are cluster-level and survive.
// `db:reset` chains this with `migrate.mjs`. Never run against a database you care about.

import postgres from "postgres";

const url = process.env.ALETHIA_DATABASE_URL;
if (!url) {
	console.error("✗ ALETHIA_DATABASE_URL is not set (see .env.example).");
	process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
	console.log("→ terminating other connections to the database…");
	await sql`
		select pg_terminate_backend(pid)
		from pg_stat_activity
		where datname = current_database() and pid <> pg_backend_pid()`;

	console.log("→ dropping schemas (public + drizzle)…");
	await sql.unsafe(`DROP SCHEMA IF EXISTS drizzle CASCADE`);
	await sql.unsafe(`DROP SCHEMA IF EXISTS public CASCADE`);
	await sql.unsafe(`CREATE SCHEMA public`);

	console.log("✓ database reset — run migrate to rebuild the schema.");
	await sql.end();
	process.exit(0);
} catch (err) {
	console.error("\n✗ reset failed:\n", err);
	await sql.end({ timeout: 1 }).catch(() => {});
	process.exit(1);
}
