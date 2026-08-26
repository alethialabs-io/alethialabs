// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment node

// A REPO-WIDE GUARD: every place that resolves an ORGANIZATION from a CLI token must honour a
// service token's pin.
//
// WHY A SOURCE-SCANNING TEST RATHER THAN MORE UNIT TESTS. The pin is a property of the SYSTEM, not
// of one function, and it was already broken in three places on the day it was written:
//
//   - `/api/jobs` (PLAN / DEPLOY / DESTROY — the routes that provision real cloud infrastructure)
//     resolved its scope straight from `X-Alethia-Org`, bypassing `authorizeCli` entirely.
//   - `resolveCliProvider` called `getActiveScope(userId)` with no org, which resolves whichever
//     org that PERSON last had active — somebody's session state, standing in for a machine's scope.
//   - `authorizeCli` itself, until the branch was added.
//
// Each was reachable, and none of them would have been caught by testing the token library. A new
// route written next month is the same risk, and it will be written by somebody who has not read
// this file — so the check has to run without being remembered.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(process.cwd(), "..", "..", "apps", "console");

/** Every .ts/.tsx file under a directory, recursively, excluding tests. */
function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === ".next" || entry === "tests") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...sourceFiles(full));
		} else if (/\.(ts|tsx)$/.test(entry)) {
			out.push(full);
		}
	}
	return out;
}

/**
 * Files that verify a CLI token AND resolve an organization from it.
 *
 * `authorizeCli` is excluded because it IS the guard — it carries the branch every other caller is
 * being held to. Everything else that does both must honour the pin explicitly.
 */
function orgResolvingCliCallers(): string[] {
	const roots = [join(ROOT, "app", "api"), join(ROOT, "lib")];
	return roots
		.flatMap((r) => sourceFiles(r))
		.filter((f) => !f.endsWith(join("lib", "cli", "auth.ts")))
		.filter((f) => {
			const src = readFileSync(f, "utf8");
			const verifies = src.includes("verifyCliToken");
			const resolvesOrg = src.includes("getActiveScope(") || src.includes("X-Alethia-Org");
			return verifies && resolvesOrg;
		});
}

describe("a service token's organization pin is honoured everywhere it could be resolved", () => {
	it("finds callers to check — a guard that scans nothing passes for the wrong reason", () => {
		// VACUITY. If a refactor renames `verifyCliToken` or moves these files, this scan silently
		// matches nothing and every assertion below becomes true by default. That is the single most
		// common way a guard like this stops working, so it is checked first and by name.
		expect(orgResolvingCliCallers().length).toBeGreaterThan(0);
	});

	it.each(orgResolvingCliCallers())("%s honours service_token_org_id", (file) => {
		const src = readFileSync(file, "utf8");
		expect(
			src.includes("service_token_org_id"),
			`${file} verifies a CLI token and resolves an organization, but never reads the token's ` +
				`pinned org. A service token minted for one organization would act on whichever org ` +
				`the header names, or on its creator's default — see lib/cli/auth.ts.`,
		).toBe(true);
	});
});
