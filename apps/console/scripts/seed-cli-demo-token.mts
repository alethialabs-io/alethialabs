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
// WHY IT ALSO DEFINES THE `e2e-run` CLASSIFICATION (#5096). A stack the CLI creates gets its config
// from the console, so its `alethia:project-id` tag is the project's UUID — and every e2e sweeper and
// the orphan reaper find a run's resources by an `e2e-` handle. The run's handle therefore travels as
// a classification: this seed defines the `e2e-run` dimension with THIS run's value, and the demo's
// `classify` beat assigns it through the real binary (`alethia classification assign`), exactly as
// a customer classifies a project. The console snapshots it into the job and the runner stamps it on
// every resource as `alethia:e2e-run`. The CLI has no command that DEFINES a dimension — that is an
// org-settings action in the console — so the seed performs it, the same way it performs the other
// org setup a person would have done in the browser.
//
// Usage:
//   tsx scripts/seed-cli-demo-token.mts --out /tmp/cli-demo.json --e2e-run e2e-<run_id>-<attempt>

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

import { and, eq } from "drizzle-orm";

import { mintServiceToken } from "@/lib/cli/service-token";
import { getServiceDb } from "@/lib/db";
import { profiles } from "@/lib/db/schema/accounts";
import { classificationDimension, classificationValue } from "@/lib/db/schema/classification";
import { slugSchema } from "@/lib/validations/classification";
import { resolveOwner, seedOrgAndPeople } from "@/lib/seed/builders";
import { makeIds } from "@/lib/seed/ids";

/** Reads `--flag value` from argv, or a default. */
function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** The classification dimension key the e2e sweepers read back as `alethia:e2e-run` (#5096). */
const E2E_RUN_DIMENSION = "e2e-run";

/**
 * The run's `e2e-run` value: REQUIRED, a valid classification slug, and the exact CI shape the
 * sweepers' discovery accepts (`e2e-<run_id>-<attempt>`, scripts/e2e/lib/scope-key.sh). Refused
 * here rather than defaulted, because a seed that silently skipped it would let the whole run pass
 * with a stack no sweeper can find if it leaks — the failure #5096 exists to remove.
 */
function e2eRunValue(): string {
	const value = arg("e2e-run", "");
	if (!value) {
		throw new Error("--e2e-run <e2e-<run_id>-<attempt>> is required: it is the sweep handle a leaked CLI-created stack is found by (#5096)");
	}
	if (!slugSchema.safeParse(value).success || !/^e2e-[0-9]+-[0-9]+$/.test(value)) {
		throw new Error(`--e2e-run ${JSON.stringify(value)} is not e2e-<run_id>-<attempt> — the only shape the orphan reaper accepts for this handle`);
	}
	return value;
}

/**
 * Defines the `e2e-run` dimension in the org, holding one value: this run's. Idempotent — a re-run
 * of the step against the same database finds both rows and changes nothing. Scoped to `project`,
 * which is what the demo's `classify` beat assigns it to.
 */
async function seedE2ERunDimension(
	db: ReturnType<typeof getServiceDb>,
	orgId: string,
	ownerId: string,
	value: string,
): Promise<void> {
	await db
		.insert(classificationDimension)
		.values({
			org_id: orgId,
			created_by: ownerId,
			key: E2E_RUN_DIMENSION,
			label: "E2E run",
			description: "The e2e run that created this resource. Read by the e2e orphan reaper (#5096).",
			applies_to: ["project"],
		})
		.onConflictDoNothing();
	const [dimension] = await db
		.select({ id: classificationDimension.id })
		.from(classificationDimension)
		.where(and(eq(classificationDimension.org_id, orgId), eq(classificationDimension.key, E2E_RUN_DIMENSION)))
		.limit(1);
	if (!dimension) {
		throw new Error(`the ${E2E_RUN_DIMENSION} dimension was not found after it was inserted for org ${orgId}`);
	}
	await db
		.insert(classificationValue)
		.values({ org_id: orgId, dimension_id: dimension.id, value, label: value })
		.onConflictDoNothing();
}

async function main(): Promise<void> {
	const email = arg("email", "cli-demo@e2e.alethialabs.io");
	const slug = arg("slug", "cli-demo");
	// Read first, so a missing value refuses before anything is written.
	const e2eRun = e2eRunValue();

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

	await seedE2ERunDimension(db, orgId, ownerId, e2eRun);

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
	process.stderr.write(
		`seeded org=${orgId} owner=${ownerId} token_prefix=${token_prefix} ${E2E_RUN_DIMENSION}=${e2eRun} -> ${out}\n`,
	);
}

main().catch((err) => {
	process.stderr.write(`seed-cli-demo-token failed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
