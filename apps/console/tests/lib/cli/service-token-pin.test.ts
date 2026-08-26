// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment node

// A service token's ORGANIZATION PIN, asserted two ways — because either one alone is insufficient.
//
// THE BEHAVIOUR (first half): `verifyCliToken` is DRIVEN, with a service token resolving to a known
// org, and must refuse a request whose `X-Alethia-Org` names a different one.
//
// THE REACH (second half): a repo-wide scan, because the pin is a property of the SYSTEM rather than
// of one function, and it was already broken in three places on the day it was written:
//
//   - `/api/jobs` (PLAN / DEPLOY / DESTROY — the routes that provision real cloud infrastructure)
//     resolved its scope straight from the header, bypassing `authorizeCli` entirely.
//   - `resolveCliProvider` called `getActiveScope(userId)` with no org, which resolves whichever org
//     that PERSON last had active — somebody's session state standing in for a machine's scope.
//   - `authorizeCli` itself, until the branch was added.
//
// The first version of this file was the scan ALONE, and `check-test-imports.mjs` was right to red
// it: a file that only reads source text with `node:fs` imports no real module and executes none of
// the code it is about. It would have passed just as convincingly with the implementation deleted —
// which is the worst possible property for the test guarding a tenancy boundary.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted, because `vi.mock`'s factory is hoisted above every `const` in this file and
// `lib/cli/auth.ts` imports `resolveServiceToken` at MODULE LOAD — so a plain top-level `vi.fn()`
// is read before it is initialised and the whole suite fails to collect. (The sibling
// service-token.test.ts gets away with a plain const only because `getServiceDb` is called lazily
// inside functions, long after initialisation.)
const { resolveServiceToken } = vi.hoisted(() => ({ resolveServiceToken: vi.fn() }));

vi.mock("@/lib/cli/service-token", async (importOriginal) => {
	// The REAL module for everything else — `isServiceToken` decides which branch a bearer takes, and
	// stubbing it would let this file pass while the prefix routing was broken.
	const actual = await importOriginal<typeof import("@/lib/cli/service-token")>();
	return { ...actual, resolveServiceToken };
});

import { verifyCliToken } from "@/lib/cli/auth";

const TOKEN = "alethia_sat_pin-test-token";

/** A request carrying the service token, optionally scoped by an org header. */
function req(headerOrg?: string): Request {
	const headers = new Headers({ Authorization: `Bearer ${TOKEN}` });
	if (headerOrg) headers.set("X-Alethia-Org", headerOrg);
	return new Request("https://console.test/api/cli/whatever", { headers });
}

beforeEach(() => {
	vi.clearAllMocks();
	resolveServiceToken.mockResolvedValue({
		tokenId: "tok-1",
		organizationId: "org-A",
		name: "ci",
		createdBy: "user-1",
	});
});

describe("verifyCliToken pins a service token to the org it was minted for", () => {
	it("accepts a request with no org header and reports the token's own org", async () => {
		const { payload, error } = await verifyCliToken(req());
		expect(error).toBeNull();
		expect(payload?.service_token_org_id).toBe("org-A");
		expect(payload?.sub).toBe("user-1");
	});

	it("accepts a header that AGREES with the token's org", async () => {
		const { payload, error } = await verifyCliToken(req("org-A"));
		expect(error).toBeNull();
		expect(payload?.service_token_org_id).toBe("org-A");
	});

	// THE ONE THAT MATTERS. Refused, not ignored: ignoring the header would let a pipeline believe it
	// is writing to org B while every write lands in org A — a wrong answer that looks like a right
	// one, which is worse than an error.
	it("REFUSES a header naming a different org", async () => {
		const { payload, error } = await verifyCliToken(req("org-B"));
		expect(payload).toBeNull();
		expect(error?.status).toBe(403);
		expect(await error?.json()).toMatchObject({ error: expect.stringContaining("different organization") });
	});

	// The token acts AS its creator. With that profile deleted there is no identity left to act as,
	// and falling back to anything at all would be the wrong direction.
	it("fails closed when the minting profile is gone", async () => {
		resolveServiceToken.mockResolvedValue({ tokenId: "t", organizationId: "org-A", name: "ci", createdBy: null });
		const { payload, error } = await verifyCliToken(req());
		expect(payload).toBeNull();
		expect(error?.status).toBe(401);
	});

	// One message for not-found, revoked and expired. Distinguishing them for an UNAUTHENTICATED
	// caller is an oracle telling an attacker holding a leaked token whether it was ever real.
	it("gives one answer for every unresolvable token", async () => {
		resolveServiceToken.mockResolvedValue(null);
		const { payload, error } = await verifyCliToken(req());
		expect(payload).toBeNull();
		expect(error?.status).toBe(401);
	});
});

// ── The reach. Behaviour above proves the chokepoint; this proves nothing bypasses it. ──

const ROOT = join(process.cwd(), "..", "..", "apps", "console");

/** Every .ts/.tsx file under a directory, recursively, excluding tests. */
function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === ".next" || entry === "tests") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
		else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
	}
	return out;
}

/**
 * Files that verify a CLI token AND resolve an organization from it.
 *
 * `lib/cli/auth.ts` is excluded because it IS the chokepoint — it carries the check every other
 * caller is being held to, and the behaviour tests above are what prove it.
 */
function orgResolvingCliCallers(): string[] {
	return [join(ROOT, "app", "api"), join(ROOT, "lib")]
		.flatMap((r) => sourceFiles(r))
		.filter((f) => !f.endsWith(join("lib", "cli", "auth.ts")))
		.filter((f) => {
			const src = readFileSync(f, "utf8");
			return src.includes("verifyCliToken") && (src.includes("getActiveScope(") || src.includes("X-Alethia-Org"));
		});
}

describe("nothing that resolves an org from a CLI token bypasses the pin", () => {
	it("finds callers to check — a scan that matches nothing passes for the wrong reason", () => {
		expect(orgResolvingCliCallers().length).toBeGreaterThan(0);
	});

	it.each(orgResolvingCliCallers())(
		"%s reads service_token_org_id (else a token minted for one org acts on another)",
		(file) => {
			expect(readFileSync(file, "utf8").includes("service_token_org_id")).toBe(true);
		},
	);
});
