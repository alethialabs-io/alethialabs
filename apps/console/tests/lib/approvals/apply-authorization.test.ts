// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Where the apply-authorization question (lib/approvals/types.ts) is asked. What it answers is
// tests/lib/approvals/policy.test.ts (table 4.2) and tests/lib/approvals/gate.test.ts (the gate).
//
// Every file under app/ and lib/ that inserts a job is listed below with what it may insert, and the
// list is checked against the tree in BOTH directions: a new file that inserts a job fails until it is
// classified, and an entry whose file stopped inserting fails until it is removed. Every file that
// inserts a DEPLOY or a DESTROY asks — for an actor, or under its named system origin.
//
// WHAT THIS DOES NOT PROVE. It reads source text. It finds a job insert by the spelling
// `.insert(jobs)`, an applying job by the spelling `job_type: "DEPLOY"` / `job_type: "DESTROY"`,
// and a copied job type by `job_type: <name>.job_type`. An insert through a differently named
// table binding, a job type held in a variable, raw SQL, and anything outside app/ and lib/ are
// not seen. It also cannot tell whether a `requireApplyAuthorization` call is handed the right
// arguments: for a gated file it checks that the call sits between the insert and the environment's
// transition, and for a system file that every call names that file's own origin.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { SYSTEM_APPLY_ORIGINS, type SystemApplyOrigin } from "@/lib/approvals/types";
import { rerunRouteOf } from "@/lib/jobs/operation";

// ── Where it is asked ─────────────────────────────────────────────────────────────────────

/**
 * How a file that inserts jobs stands toward the question.
 *
 * - `gated` — queues an apply or destroy for an actor, and asks.
 * - `system` — queues one with no actor behind the request, and asks under its named origin.
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
			return { applies: true, asks: true };
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

	it.each(
		Object.entries(SITES).flatMap(([path, site]) => (site.kind === "system" ? [[path, site.origin] as const] : [])),
	)("%s asks under its own origin, %s, and no other", (path, origin) => {
		const src = found.get(path) ?? "";
		const named = [...src.matchAll(/kind: "system", origin: "(\w+)"/g)].map((m) => m[1]);
		expect(named.length).toBeGreaterThan(0);
		expect(new Set(named)).toEqual(new Set([origin]));
		expect(src.split(ASKS).length - 1).toBe(named.length);
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
