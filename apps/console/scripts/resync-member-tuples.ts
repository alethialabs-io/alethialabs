// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The #5463 operator step after migration 0159: re-derive every member's OpenFGA tuples from Postgres.
// 0159 rewrote `grants` in SQL and could not reach the OpenFGA mirror; see
// lib/authz/member-tuple-resync.ts for what is resynced and why it is a superset.
//
// Usage (once per environment that ran 0159 with OpenFGA enabled; a no-op on a community build):
//   pnpm -C apps/console exec tsx scripts/resync-member-tuples.ts               # every org
//   pnpm -C apps/console exec tsx scripts/resync-member-tuples.ts --org <uuid>  # one org
//
// Reads ALETHIA_DATABASE_URL (the SERVICE connection) plus ALETHIA_EDITION and the OpenFGA settings,
// the same environment the console runs with. Members in scope are denied by the OpenFGA PDP between
// their tuples being removed and re-written, so run it when that is acceptable. Running it against
// production and the other long-lived databases is the maintainer's step.
//
// Exit codes: 0 — resynced; 1 — it could not run, or a step failed part-way (re-running is safe: every
// step derives from Postgres again).

import { fileURLToPath } from "node:url";
import { resyncMemberTuples } from "@/lib/authz/member-tuple-resync";
import { getTupleSync } from "@/lib/authz/tuple-sync";
import { getServiceDb } from "@/lib/db";

/** Returns the value of `--name <v>` / `--name=<v>`, or undefined. */
function arg(name: string): string | undefined {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	if (hit) return hit.slice(`--${name}=`.length);
	const idx = process.argv.indexOf(`--${name}`);
	return idx !== -1 ? process.argv[idx + 1] : undefined;
}

/** CLI entry: resync, print the counts, and set the exit code. */
async function main(): Promise<void> {
	const orgId = arg("org");
	try {
		const r = await resyncMemberTuples(getServiceDb(), getTupleSync(), orgId);
		console.log(
			`✓ Resynced the OpenFGA tuples of ${r.members} member(s)${orgId ? ` of org ${orgId}` : ""}; ` +
				`${r.teamTuples} team-membership tuple(s) written back.`,
		);
		process.exitCode = 0;
	} catch (err) {
		console.error("✗ resync-member-tuples failed part-way — re-run it:\n");
		console.error(err);
		process.exitCode = 1;
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
