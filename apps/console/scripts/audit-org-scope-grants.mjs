// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The #4583 audit runner: which `grants` rows name the `org` resource kind while ALSO carrying a
// resource id? Each one is a grant somebody believed was scoped and is not — narrow under the
// community `PostgresRbacPDP`, organization-wide under the OpenFGA engine, and rendered as
// "organization" in the access UI while still carrying the id.
//
// Usage:
//   pnpm -C apps/console run audit:org-scope-grants                # against ALETHIA_DATABASE_URL
//   pnpm -C apps/console run audit:org-scope-grants -- --json      # machine-readable
//   pnpm -C apps/console run audit:org-scope-grants -- --print-sql # just emit the query
//   pnpm -C apps/console run audit:org-scope-grants -- --url postgres://…
//
// Exit codes, so a maintainer can act on the answer without reading it:
//   0 — the audit ran and found NOTHING. That closes #4583.
//   2 — the audit ran and FOUND rows. Read the `verdict` column before touching any of them.
//   1 — the audit could not run (no URL, unreachable, or the session could not be made read-only).
//
// ── Why this is a runner around a FILE rather than a query in a string ───────────────────────────
// The query lives in docs/ops/grants-org-kind-with-resource-id.sql, with the reasoning that makes
// each column readable, and this tool executes that file verbatim. A maintainer who prefers psql
// runs the same bytes. A second copy of the SQL here is a second thing to keep true.
//
// ── What "read-only" is and is not ──────────────────────────────────────────────────────────────
// It cannot refuse a connection string that HAS write privileges — a service-role URL is writable
// by construction and nothing observable about it says otherwise. What it can do, and does, is
// make the SESSION read-only: `default_transaction_read_only=on` travels in the startup packet, so
// every transaction on this connection begins read-only and Postgres itself rejects any write with
// 25006 (read_only_sql_transaction). The check below then READS the setting back rather than
// assuming the server honored it, and refuses to run a single statement if it is not `on`. So the
// guarantee is "this tool cannot write", not "this tool declines writable credentials".

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT_ENV = join(here, "../../../.env");
const QUERY_FILE = join(here, "../../../docs/ops/grants-org-kind-with-resource-id.sql");

/** Loads root .env without overriding already-set values (for ALETHIA_DATABASE_URL). */
function loadRootEnv() {
	if (!existsSync(ROOT_ENV)) return;
	for (const raw of readFileSync(ROOT_ENV, "utf8").split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		if (process.env[key] !== undefined) continue;
		let val = line.slice(eq + 1).trim();
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		process.env[key] = val;
	}
}

function arg(name, fallback) {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	if (hit) return hit.slice(`--${name}=`.length);
	const idx = process.argv.indexOf(`--${name}`);
	return idx !== -1 ? process.argv[idx + 1] : fallback;
}

/** One row, rendered as an indented block — wider than any terminal table would be. */
function renderRow(row, index) {
	const lines = [
		`${index + 1}. grant ${row.id}`,
		`   org         ${row.org_name ?? "?"} (${row.org_id})`,
		`   subject     ${row.principal_type} ${row.subject ?? "?"} (${row.principal_id})`,
		`   effect      ${row.effect}`,
		`   confers     ${row.role_name ? `role ${row.role_name}` : (row.permission_key ?? "— nothing —")}` +
			` (${row.permissions} permission${row.permissions === 1 ? "" : "s"})`,
		`   resource_id ${row.resource_id}  →  ${row.resource_kind}`,
		`   org-wide    ${row.also_org_wide}/${row.permissions} of those already held org-wide by this subject`,
		`   created     ${row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at}`,
		`   VERDICT     ${row.verdict}`,
	];
	return lines.join("\n");
}

async function main() {
	const query = readFileSync(QUERY_FILE, "utf8");
	if (process.argv.includes("--print-sql")) {
		process.stdout.write(query);
		process.exit(0);
	}

	loadRootEnv();
	const json = process.argv.includes("--json");
	const url = arg("url", process.env.ALETHIA_DATABASE_URL);
	if (!url) {
		console.error(
			"✗ No database URL. Set ALETHIA_DATABASE_URL (root .env or the environment), or pass --url.",
		);
		process.exit(1);
	}

	const sql = postgres(url, {
		max: 1,
		onnotice: () => {},
		// The startup packet, not a later `SET`: the session is read-only from its first
		// statement, including anything the driver itself might issue.
		connection: { default_transaction_read_only: "on" },
	});
	try {
		const [mode] = await sql`show transaction_read_only`;
		if (mode?.transaction_read_only !== "on") {
			console.error(
				`✗ Refusing to run: the session is not read-only (transaction_read_only=${mode?.transaction_read_only ?? "unknown"}).`,
			);
			console.error(
				"  This audit only ever reads, and it will not run on a connection where that is not enforced by the server.",
			);
			await sql.end({ timeout: 1 }).catch(() => {});
			process.exit(1);
		}

		const rows = await sql.unsafe(query);
		if (json) {
			process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
		} else if (rows.length === 0) {
			console.log(
				"✓ No grant rows carry the (resource_type='org', resource_id IS NOT NULL) pair.",
			);
			console.log(
				"  That closes #4583: the engine divergences in #4584 are theoretical on this database, not live.",
			);
		} else {
			console.log(
				`⚠ ${rows.length} grant row${rows.length === 1 ? "" : "s"} name the 'org' kind while carrying a resource id.\n`,
			);
			for (const [i, row] of rows.entries()) console.log(`${renderRow(row, i)}\n`);
			console.log(
				"⚠ Do NOT remediate by revoking on a deployment that has not taken the #4584 fix:\n" +
					"  the revoke path deleted tuples on an object that never existed, so it removes the ROW\n" +
					"  and leaves the ACCESS. Read the verdict on each row first.",
			);
		}
		await sql.end();
		process.exit(rows.length === 0 ? 0 : 2);
	} catch (err) {
		console.error("\n✗ audit-org-scope-grants failed:\n");
		console.error(err);
		await sql.end({ timeout: 1 }).catch(() => {});
		process.exit(1);
	}
}

main();
