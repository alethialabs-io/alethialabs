// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Action-boundary guard. `"use server"` is a FILE-level directive: Next.js compiles every
// export of such a file into a POST-addressable Server Action with a stable action id. A file
// that also writes through getServiceDb() (the RLS-bypassing service client) and never resolves
// an actor is therefore an unauthenticated, unauthorized mutation endpoint reachable by anyone
// who can reach the app — regardless of who its intended in-process caller is.
//
// That is what this guard fails on. It is the shape three runner-callback finalizers had before
// they were moved to lib/ (lib/jobs/finalize-deployment.ts, lib/jobs/finalize-build.ts,
// lib/probes/persistence.ts): one of them, enqueueDeployAfterBuild(jobId), INSERTED a DEPLOY job
// — provisioning real cloud infrastructure — from a bare job UUID.
//
// WHAT THIS GUARD DOES NOT COVER, stated plainly so nobody reads a pass as more than it is:
// the check is FILE-level, so a MIXED file — user-facing actions that authorize, sitting beside
// runner-callback exports that do not — passes. app/server/actions/{promotions,drift,cost,
// byo-charts,byo-iac,reconcile}.ts are all mixed today. Auditing those export-by-export is
// tracked separately; this guard only holds the line against a wholly unauthorized action file.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = "app/server/actions";

/** A real top-of-file directive, not the string mentioned inside a comment. */
const USE_SERVER = /^\s*["']use server["'];?\s*$/m;
/** The RLS-bypassing service client. */
const SERVICE_DB = /\bgetServiceDb\s*\(/;
/** Anything that establishes who is calling. */
const ACTOR = /\b(currentActor|getOwnerScope|getOwner|getSession|requireSession)\s*\(/;
/** Anything that asks the PDP. */
const AUTHZ = /\b(authorize|authorizeQuiet|authorizeCli|authorizeUserId)\s*\(|getPdp\(\)\.enforce/;
/**
 * Escape hatch, mirroring check-authz-scope.mjs's `authz-scope-ok`. The reason is REQUIRED and
 * must sit on the SAME line as the marker.
 *
 * `.` excludes newlines in JS (no /s flag), which is the whole point here: an earlier version
 * used `\s*\S`, and `\s` DOES cross newlines — so a bare `// action-boundary-ok:` matched the
 * first non-space character of the next line and silenced the guard with fourteen characters.
 * The test that was supposed to catch that appended the bare marker at end-of-file, where
 * nothing followed it, so it passed for the wrong reason. The reason text is the entire audit
 * value of an exception; a marker on its own documents nothing.
 */
const ALLOW = /action-boundary-ok:.*\S/;

function walk(dir, out) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (/\.tsx?$/.test(full)) out.push(full);
	}
}

const files = [];
try {
	walk(ROOT, files);
} catch (err) {
	// A missing root is a BROKEN GUARD, not a clean tree. Fail loudly rather than print OK
	// over a directory that was renamed out from under this check.
	console.error(`check-action-boundary: cannot walk ${ROOT} — ${err.message}`);
	console.error("The guard cannot see the code it exists to check. Fix the path.");
	process.exit(1);
}

const actionFiles = files.filter((f) => USE_SERVER.test(readFileSync(f, "utf8")));

// Likewise: finding no server actions at all means the directive moved or the glob rotted.
// "Nothing found" must never read the same as "nothing wrong".
if (actionFiles.length === 0) {
	console.error(
		`check-action-boundary: found ${files.length} file(s) under ${ROOT} but NONE carry a "use server" directive.`,
	);
	console.error("That is not a clean tree — it means this guard is looking at the wrong thing.");
	process.exit(1);
}

const violations = [];
for (const file of actionFiles) {
	const src = readFileSync(file, "utf8");
	if (ALLOW.test(src)) continue;
	if (!SERVICE_DB.test(src)) continue; // RLS protects it
	if (ACTOR.test(src) || AUTHZ.test(src)) continue;
	violations.push(relative(".", file));
}

if (violations.length > 0) {
	console.error(
		'Action-boundary violation — these files carry "use server" (so every export is a public',
	);
	console.error(
		"POST endpoint), write through the RLS-bypassing getServiceDb(), and never resolve an actor:",
	);
	for (const v of violations) console.error(`  ${v}`);
	console.error("");
	console.error("Fix: if it is an internal helper called by an authenticated route, move it to");
	console.error("lib/ and drop the directive. If it is genuinely a pre-auth action, annotate it");
	console.error("with `// action-boundary-ok: <reason>`.");
	process.exit(1);
}

console.log(
	`OK — ${actionFiles.length} "use server" file(s) under ${ROOT}; none combine getServiceDb() with no actor and no authz.`,
);
