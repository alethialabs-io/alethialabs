// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The #4583 audit runner: which `grants` rows carry a `resource_id` alongside a `resource_type`
// that cannot be scoped to one? Two classes — `org-kind` (refused at the write boundaries since
// #4581, so legacy only) and `unscopable-kind` (`job`, `member`, a typo… STILL WRITEABLE today).
// Each is a grant somebody believed was scoped, and the two PDP engines disagree about what it
// means. See docs/ops/grants-scope-contradictions.sql for what each class does on each engine.
//
// Usage:
//   pnpm -C apps/console run audit:grant-scopes                # against ALETHIA_DATABASE_URL
//   pnpm -C apps/console run audit:grant-scopes -- --json      # machine-readable
//   pnpm -C apps/console run audit:grant-scopes -- --print-sql # just emit the query
//   pnpm -C apps/console run audit:grant-scopes -- --url postgres://…
//
// Exit codes, so a maintainer can act on the answer without reading it:
//   0 — the audit ran and found NOTHING. That closes #4583.
//   2 — the audit ran and FOUND rows. Read the `verdict` column before touching any of them.
//   1 — the audit could not run (no URL, unreachable, or the session could not be made read-only).
//
// ── Why this is a runner around a FILE rather than a query in a string ───────────────────────────
// The query lives in docs/ops/grants-scope-contradictions.sql, with the reasoning that makes each
// column readable, and this tool executes that file verbatim. A maintainer who prefers psql runs
// the same bytes. A second copy of the SQL here is a second thing to keep true.
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
const QUERY_FILE = join(here, "../../../docs/ops/grants-scope-contradictions.sql");

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
		`${index + 1}. grant ${row.id}  [${row.pair_class}]`,
		`   org         ${row.org_name ?? "?"} (${row.org_id})`,
		`   subject     ${row.principal_type} ${row.subject ?? "?"} (${row.principal_id})`,
		`   effect      ${row.effect}`,
		`   confers     ${row.role_name ? `role ${row.role_name}` : (row.permission_key ?? "— nothing —")}` +
			` (${row.permissions} permission${row.permissions === 1 ? "" : "s"})`,
		`   scope       resource_type=${row.resource_type} resource_id=${row.resource_id}`,
		`   the id names ${row.resource_kind}${row.resource_kind === "not-found" ? " (in the five tables this query looks in)" : ""}`,
		`   org-wide    ${row.also_org_wide}/${row.permissions} of those already held org-wide by this subject`,
		`   created     ${row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at}`,
		`   VERDICT     ${row.verdict}`,
	];
	return lines.join("\n");
}

async function main() {
	const query = readFileSync(QUERY_FILE, "utf8");
	if (process.argv.includes("--print-sql")) {
		// NOT process.exit(): stdout to a pipe is async, and exiting discards whatever has not
		// flushed — measured at exactly 65536 bytes for a 300 KB write. The whole point of this
		// flag is that the emitted bytes are IDENTICAL to the file, so a silent truncation at a
		// buffer boundary is the one failure it must not have. Setting the code and returning
		// lets node drain the stream and exit on its own.
		process.stdout.write(query);
		process.exitCode = 0;
		return;
	}

	loadRootEnv();
	const json = process.argv.includes("--json");
	const url = arg("url", process.env.ALETHIA_DATABASE_URL);
	if (!url) {
		console.error(
			"✗ No database URL. Set ALETHIA_DATABASE_URL (root .env or the environment), or pass --url.",
		);
		process.exitCode = 1;
		return;
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
			process.exitCode = 1;
			return;
		}

		const rows = await sql.unsafe(query);
		if (json) {
			process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
		} else if (rows.length === 0) {
			console.log(
				"✓ No grant row carries a resource_id alongside an unscopable resource_type —",
			);
			console.log(
				"  neither the 'org-kind' class nor the 'unscopable-kind' class (job/member/typo/…).",
			);
			console.log(
				"  That closes #4583 for BOTH: the engine divergences in #4584 are theoretical on this database, not live.",
			);
		} else {
			const byClass = new Map();
			for (const row of rows) {
				byClass.set(row.pair_class, (byClass.get(row.pair_class) ?? 0) + 1);
			}
			const summary = [...byClass]
				.map(([cls, n]) => `${n} ${cls}`)
				.sort()
				.join(", ");
			console.log(
				`⚠ ${rows.length} grant row${rows.length === 1 ? "" : "s"} carry a resource id under an unscopable resource_type (${summary}).\n`,
			);
			for (const [i, row] of rows.entries()) console.log(`${renderRow(row, i)}\n`);
			console.log(
				"⚠ NEVER remediate one of these by REVOKING it — not before the #4584 fix and not after.\n" +
					"  Before, the delete looked for tuples on an object that does not exist. After, the row\n" +
					"  expands to no tuples so there is nothing for the delete to read, and the tuples it wrote\n" +
					"  under the old reading stay on org:<org-uuid> — where they are indistinguishable from a\n" +
					"  legitimate org-wide grant's, which is why they are not deleted blind. `backfill` only\n" +
					"  ever writes, so nothing clears them at boot either. Either way: row gone, ACCESS KEPT.\n" +
					"\n" +
					"  Safe remediation: write the corrected tuples (or delete the specific stale ones) against\n" +
					"  the OpenFGA store, or empty the store and re-run backfill() — then deal with the row.\n" +
					"  Read each row's verdict first: it says whether that subject holds the permission anyway.",
			);
		}
		await sql.end();
		// Same reason as --print-sql above, and this is the path where it bites: a production
		// run prints nine lines PER ROW, and process.exit() would truncate the report at a
		// buffer boundary with no error. The report IS the deliverable here.
		process.exitCode = rows.length === 0 ? 0 : 2;
	} catch (err) {
		console.error("\n✗ audit-org-scope-grants failed:\n");
		console.error(err);
		await sql.end({ timeout: 1 }).catch(() => {});
		process.exitCode = 1;
	}
}

main();
