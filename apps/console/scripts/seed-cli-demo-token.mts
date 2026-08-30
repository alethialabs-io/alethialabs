// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Seeds the org, the owner and ONE service token the `cli-demo` e2e dimension authenticates with,
// then prints the token's plaintext on stdout — the only moment it exists in the clear.
//
// WHY THIS EXISTS. The CLI-demo bar's provisioning half (#3038) drives the real `alethia` binary
// against a real console. The binary's non-interactive credential is ALETHIA_TOKEN
// (apps/cli/cmd/auth_utils.go ServiceTokenEnv), and a service token can only be minted by something
// with database access — the console mints it for a human through the UI. In CI there is no human,
// so the job mints one directly, exactly as the console would.
//
// WHY IT REUSES lib/seed/builders RATHER THAN INSERTING ROWS. `resolveOwner` also records the
// owner's acceptance of every acceptance-required legal document. Without that, every route under
// (private) redirects to the clickwrap gate — so a hand-rolled INSERT would produce a user who
// cannot reach the product, and the beats would fail on a legal redirect that looks nothing like
// the CLI defect it would be reported as (#2372).
//
// WHY IT WRITES A FILE RATHER THAN PRINTING THE TOKEN. The harness needs TWO things, not one: the
// token, and the ORG the token is pinned to. The org is not a nicety —
// `claim_next_job`'s self-runner branch scopes to `j.org_id = v_runner_org_id` (audit P0, #392), so
// the runner the harness seeds must carry the SAME org as the token the CLI authenticates with. If
// they differ, the job the CLI creates is never claimed, sits QUEUED, and the run fails on a deploy
// timeout that reads as a provisioning defect and is actually a tenancy mismatch.
//
// So both travel together in one JSON file, at --out, mode 0600. Nothing is printed to stdout:
// a credential on stdout ends up in the job log the moment any caller forgets to redirect it.
//
// Usage:
//   tsx scripts/seed-cli-demo-token.mts --out /tmp/cli-demo.json

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

import { mintServiceToken } from "@/lib/cli/service-token";
import { getServiceDb } from "@/lib/db";
import { profiles } from "@/lib/db/schema/accounts";
import { resolveOwner, seedOrgAndPeople } from "@/lib/seed/builders";
import { makeIds } from "@/lib/seed/ids";

/** Reads `--flag value` from argv, or a default. */
function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
	const email = arg("email", "cli-demo@e2e.alethialabs.io");
	const slug = arg("slug", "cli-demo");

	const db = getServiceDb();
	const id = makeIds(`cli-demo::${slug}`);
	const ownerId = await resolveOwner(db, email, id);
	// Community tenancy unifies the org id with the owner id (see SeedCtx). Following that rather
	// than minting a separate org id keeps this seed on the same path the product uses, so a token
	// minted here resolves to the same Actor the console would have resolved.
	const orgId = ownerId;

	await seedOrgAndPeople({ db, ownerId, orgId, ownerEmail: email, slug, id, now: new Date() });

	// THE PROFILE ROW, and it is not optional — `cli_service_tokens.created_by` is a foreign key to
	// `profiles(id)`, NOT to `user(id)`.
	//
	// In the product a profile is written by `upsertProfile` from a better-auth hook when the user
	// is created. This seed bypasses better-auth (it inserts the `user` row directly, through
	// resolveOwner), so that hook never fires and the table stays empty — and `mintServiceToken`
	// then fails the FK with a message naming ten columns and no cause.
	//
	// Measured, not assumed: on a real migrated database `profiles` was empty, `"user"` carried the
	// row, and there is no trigger bridging them. So the seed mirrors the hook's side effect, the
	// same way it already mirrors the user row it creates.
	//
	// createdBy CANNOT be dropped to null instead. A service token ACTS AS the profile that minted
	// it (lib/cli/service-token.ts) — that is what gives it an Actor the ReBAC PDP already governs,
	// rather than a machine principal on a second authorization path. A null would authenticate and
	// then authorize as nobody.
	await db
		.insert(profiles)
		.values({ id: ownerId, email, full_name: "Alethia CLI demo", avatar_url: null })
		.onConflictDoNothing();

	const { token, token_prefix } = await mintServiceToken({
		organizationId: orgId,
		// Named for the run, so a token left behind in a shared database is attributable rather
		// than anonymous. Nothing reaps these; a name is the difference between "delete it" and
		// "find out what it is first".
		name: `e2e cli-demo ${new Date().toISOString()} ${randomUUID().slice(0, 8)}`,
		createdBy: ownerId,
	});

	const out = arg("out", "");
	if (!out) {
		throw new Error("--out <path> is required: the token and its org travel together in a file, never on stdout");
	}
	// 0600: the token is live from this moment. The caller reads it, exports it masked, and the
	// file dies with the runner.
	writeFileSync(out, `${JSON.stringify({ orgId, ownerId, token }, null, 2)}\n`, { mode: 0o600 });
	// The PREFIX is safe to log and is what makes a leaked token attributable later; the token
	// itself never reaches stdout or stderr.
	process.stderr.write(`seeded org=${orgId} owner=${ownerId} token_prefix=${token_prefix} -> ${out}\n`);
}

main().catch((err) => {
	process.stderr.write(`seed-cli-demo-token failed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
