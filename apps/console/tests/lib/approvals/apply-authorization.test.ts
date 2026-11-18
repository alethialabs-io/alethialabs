// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The apply-authorization seam (lib/approvals/types.ts), in two halves.
//
// 1. What `requireApplyAuthorization` answers today: it allows every call. That is stated as a
//    test so that the day it stops being true, this file is where the change is announced.
//
// 2. Where it is asked. Every file under app/ and lib/ that inserts a job is listed below with
//    what it may insert, and the list is checked against the tree in BOTH directions: a new file
//    that inserts a job fails until it is classified, and an entry whose file stopped inserting
//    fails until it is removed.
//
// WHAT THE SECOND HALF DOES NOT PROVE. It reads source text. It finds a job insert by the spelling
// `.insert(jobs)`, an applying job by the spelling `job_type: "DEPLOY"` / `job_type: "DESTROY"`,
// and a copied job type by `job_type: <name>.job_type`. An insert through a differently named
// table binding, a job type held in a variable, raw SQL, and anything outside app/ and lib/ are
// not seen. It also cannot tell whether a `requireApplyAuthorization` call is handed the right
// arguments: it checks that the call sits between the insert and the environment's transition.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
	APPLY_OPERATIONS,
	ApplyAuthorizationError,
	type ApplyRequester,
	requireApplyAuthorization,
	SYSTEM_APPLY_ORIGINS,
	type SystemApplyOrigin,
} from "@/lib/approvals/types";
import { CREDENTIAL_KINDS } from "@/lib/authz/types";
import type { Tx } from "@/lib/db";
import { rerunRouteOf } from "@/lib/jobs/operation";

// ── 1. What it answers today ─────────────────────────────────────────────────────────────────

/**
 * A transaction that fails the test if it is touched: today's function must not read or write
 * through it, and a stand-in that quietly accepted a query would hide the day it starts to.
 */
function untouchableTx(): Tx {
	const refuse = (): never => {
		throw new Error("requireApplyAuthorization used the transaction");
	};
	return new Proxy<Tx>(Object.create(null), { get: refuse, apply: refuse });
}

const TARGET = { orgId: "org-1", projectId: "project-1", environmentId: "env-1", jobId: "job-1" };

const REQUESTERS: ApplyRequester[] = [
	...CREDENTIAL_KINDS.map(
		(credential): ApplyRequester => ({
			kind: "actor",
			actor: { userId: "user-1", orgId: "org-1", credential },
		}),
	),
	...SYSTEM_APPLY_ORIGINS.map((origin): ApplyRequester => ({ kind: "system", origin })),
];

/** A short name for a requester, for the test title. */
function nameOf(requester: ApplyRequester): string {
	return requester.kind === "actor" ? requester.actor.credential : `system:${requester.origin}`;
}

describe("requireApplyAuthorization, while it allows everything", () => {
	const cases = REQUESTERS.flatMap((requester) =>
		APPLY_OPERATIONS.map((operation) => ({ who: nameOf(requester), requester, operation })),
	);

	it("is asked about every credential kind and every system origin", () => {
		expect(cases).toHaveLength(
			(CREDENTIAL_KINDS.length + SYSTEM_APPLY_ORIGINS.length) * APPLY_OPERATIONS.length,
		);
	});

	it.each(cases)("allows $operation for $who, with no approval", async ({ requester, operation }) => {
		await expect(
			requireApplyAuthorization(untouchableTx(), requester, operation, TARGET),
		).resolves.toEqual({ approvalId: null });
	});

	it("does not yet check an approval a caller presents", async () => {
		await expect(
			requireApplyAuthorization(
				untouchableTx(),
				{ kind: "system", origin: "ephemeral_reap" },
				"destroy",
				TARGET,
				"not-an-approval",
			),
		).resolves.toEqual({ approvalId: null });
	});
});

describe("ApplyAuthorizationError", () => {
	it("carries its code and its sentence, and is an Error an edge can match by class", () => {
		const err = new ApplyAuthorizationError("approval_required", "This apply needs an approval.");
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(ApplyAuthorizationError);
		expect(err.name).toBe("ApplyAuthorizationError");
		expect(err.code).toBe("approval_required");
		expect(err.message).toBe("This apply needs an approval.");
	});
});

// ── 2. Where it is asked ─────────────────────────────────────────────────────────────────────

/**
 * How a file that inserts jobs stands toward the question.
 *
 * - `gated` — queues an apply or destroy for an actor, and asks.
 * - `system` — queues one with no actor behind the request, under a named origin. Does not call
 *   the function yet; it is on this list instead.
 * - `copies` — inserts a copy of an existing job, whatever its type. What keeps an apply out is
 *   `rerunRouteOf`, which the last test below asks directly.
 * - `seed` — writes fixture rows for a seeded environment.
 * - `never` — inserts only job types that neither apply nor destroy.
 */
type Site =
	| { kind: "gated" }
	| { kind: "system"; origin: SystemApplyOrigin }
	| { kind: "copies" }
	| { kind: "seed" }
	| { kind: "never" };

const SITES: Record<string, Site> = {
	"app/server/actions/projects.ts": { kind: "gated" },

	"lib/jobs/finalize-build.ts": { kind: "system", origin: "build_chain" },
	"lib/promotions/lifecycle.ts": { kind: "system", origin: "promotion" },
	"lib/reconcile/auto-heal.ts": { kind: "system", origin: "auto_heal" },
	"lib/reconcile/reap.ts": { kind: "system", origin: "ephemeral_reap" },

	"app/server/actions/jobs.ts": { kind: "copies" },
	"lib/breakglass/actions.ts": { kind: "copies" },

	"lib/seed/builders.ts": { kind: "seed" },

	"app/api/cli/runners/deploy/route.ts": { kind: "never" },
	"app/server/actions/audit.ts": { kind: "never" },
	"app/server/actions/byo-charts.ts": { kind: "never" },
	"app/server/actions/byo-iac.ts": { kind: "never" },
	"app/server/actions/canvas-jobs.ts": { kind: "never" },
	"app/server/actions/runners.ts": { kind: "never" },
	"app/server/actions/scanner.ts": { kind: "never" },
	"lib/drift/dispatch.ts": { kind: "never" },
	"lib/kubeconfig-mint/request.ts": { kind: "never" },
	"lib/probes/dispatch.ts": { kind: "never" },
};

// Vitest runs with apps/console as its working directory.
const ROOT = process.cwd();

/** Every .ts/.tsx file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === ".next") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
		else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
	}
	return out;
}

/** The files under app/ and lib/ that insert a job, as `/`-separated paths from apps/console. */
function jobInsertingFiles(): Map<string, string> {
	const found = new Map<string, string>();
	for (const file of [join(ROOT, "app"), join(ROOT, "lib")].flatMap(sourceFiles)) {
		const src = readFileSync(file, "utf8");
		if (src.includes(".insert(jobs)")) found.set(relative(ROOT, file).split(sep).join("/"), src);
	}
	return found;
}

const APPLYING_JOB = /job_type:\s*"(?:DEPLOY|DESTROY)"/;
/** `job_type: original.job_type`, but not the select projection `job_type: jobs.job_type`. */
const COPIED_JOB_TYPE = /job_type:\s*(?!jobs\.)[A-Za-z_]\w*\.job_type/;
const ASKS = "requireApplyAuthorization(";

/** What the source text reports about a file. */
interface SiteFacts {
	/** It writes `job_type: "DEPLOY"` or `job_type: "DESTROY"`. */
	applies: boolean;
	/** It writes a job type read off another job. */
	copies: boolean;
	/** It calls `requireApplyAuthorization`. */
	asks: boolean;
	/** It calls `rerunRouteOf`. */
	bounded: boolean;
	/** It lives under lib/seed/. */
	underSeed: boolean;
}

/** The facts a file of each kind must show. A fact left out is one that kind does not constrain. */
function expectedOf(site: Site): Partial<SiteFacts> {
	switch (site.kind) {
		case "gated":
			return { applies: true, asks: true };
		case "system":
			// When one of these starts asking it becomes `gated`, and this is what says so.
			return { applies: true, asks: false };
		case "copies":
			return { applies: false, copies: true, asks: false, bounded: true };
		case "seed":
			return { asks: false, underSeed: true };
		case "never":
			return { applies: false, copies: false, asks: false };
	}
}

describe("every file that inserts a job is accounted for", () => {
	const found = jobInsertingFiles();

	it("finds the files — a scan that matches nothing would pass every check below", () => {
		expect(found.size).toBeGreaterThan(10);
		expect(found.has("app/server/actions/projects.ts")).toBe(true);
	});

	it("lists exactly the files that insert a job, no more and no fewer", () => {
		expect([...found.keys()].sort()).toEqual(Object.keys(SITES).sort());
	});

	it("names every system origin, and no origin twice", () => {
		const origins = Object.values(SITES).flatMap((site) => (site.kind === "system" ? [site.origin] : []));
		expect([...origins].sort()).toEqual([...SYSTEM_APPLY_ORIGINS].sort());
	});

	it.each(Object.entries(SITES))("%s is what the list says it is", (path, site) => {
		const src = found.get(path) ?? "";
		expect({
			applies: APPLYING_JOB.test(src),
			copies: COPIED_JOB_TYPE.test(src),
			asks: src.includes(ASKS),
			bounded: src.includes("rerunRouteOf("),
			underSeed: path.startsWith("lib/seed/"),
		}).toMatchObject(expectedOf(site));
	});
});

describe("a gated file asks before it moves the environment", () => {
	const TRANSITION = /"enqueue(?:Deploy|Destroy)"/g;

	it.each(Object.entries(SITES).filter(([, site]) => site.kind === "gated").map(([path]) => path))(
		"%s asks between each job insert and the deploy or destroy transition that follows it",
		(path) => {
			const src = readFileSync(join(ROOT, path), "utf8");
			const transitions = [...src.matchAll(TRANSITION)];
			// Four today: the BUILD that chains a deploy (twice), the DEPLOY and the DESTROY.
			expect(transitions.length).toBeGreaterThan(0);
			for (const transition of transitions) {
				const built = src.lastIndexOf("signedJob(", transition.index);
				expect(built).toBeGreaterThan(-1);
				expect(src.slice(built, transition.index)).toContain(ASKS);
			}
			expect(src.split(ASKS).length - 1).toBe(transitions.length);
		},
	);
});

describe("a copied job is never an apply or a destroy", () => {
	it.each(["DEPLOY", "DESTROY"] as const)("rerunRouteOf does not copy a %s job, with or without a project", (job_type) => {
		expect(rerunRouteOf({ job_type, project_id: null, environment_id: null }).kind).not.toBe("copy");
		expect(rerunRouteOf({ job_type, project_id: "project-1", environment_id: "env-1" }).kind).not.toBe("copy");
	});
});
