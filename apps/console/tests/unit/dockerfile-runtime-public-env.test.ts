// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A `NEXT_PUBLIC_*` that the console reads AT RUNTIME must exist in the RUNNING container (#5621).
//
// `next-runtime-env` does not inline anything. `env("NEXT_PUBLIC_X")` reads the server's
// `process.env` when it runs on the server, and `<PublicEnvScript />` (app/layout.tsx) serialises
// that same runtime `process.env` into `window.__ENV` for the browser. So a value set with `ENV` in
// the Dockerfile's `build` stage reaches `next build` and nothing else: the `runner` stage starts
// from a fresh `node:22-alpine`, and the server it runs has never heard of it.
//
// That is exactly how the production smoke's build-id check failed on its first run: the `build`
// stage set `NEXT_PUBLIC_APP_VERSION=$VERSION`, the `runner` stage did not, `window.__ENV` had no
// such key, and the check reported "the browser is running build unset". The same gap left PostHog
// errors untagged with a release, because lib/analytics/config.ts reads the version the same way.
//
// WHAT THIS RANGES OVER, stated so nobody reads it as more:
//   - the runtime reads are found by scanning the console source (tests excluded) for a LITERAL
//     `env("NEXT_PUBLIC_…")` in a file that imports `next-runtime-env`, plus any literal
//     `__ENV.NEXT_PUBLIC_…`. A key passed through a variable (`env(name)`) is NOT seen. Today the
//     two such call sites (lib/ai/transparency.ts, lib/config/auth.ts) read only non-public keys.
//   - `process.env.NEXT_PUBLIC_…` is deliberately NOT a runtime read: Next inlines it at build
//     time, so for those the build stage is the right place (e.g. NEXT_PUBLIC_CANVAS_ENABLED).
//   - both console images are checked: Dockerfile (enterprise) and Dockerfile.community.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CONSOLE = process.cwd();
const REPO = join(CONSOLE, "..", "..");
const DOCKERFILES = ["Dockerfile", "Dockerfile.community"];
const DEPLOY_WORKFLOW = join(REPO, ".github/workflows/deploy-console.yml");

/** Where a runtime-read var gets its value when the image itself does not set it. */
type OtherSource =
	| { kind: "deploy-env"; why: string }
	| { kind: "code-default"; why: string };

/**
 * Every runtime-read `NEXT_PUBLIC_*` that the runner stage does NOT set, with where its runtime value
 * comes from instead. Checked in both directions: an entry that is no longer read, or that the runner
 * now sets, fails — a ledger that outlives its subject is a lie nobody re-reads.
 *
 * `deploy-env` entries are verified against the deploy workflow's `.env` assembly, which the
 * production compose stack loads as the console's `env_file`.
 */
const OTHER_RUNTIME_SOURCE: Record<string, OtherSource> = {
	NEXT_PUBLIC_APP_URL: { kind: "deploy-env", why: "the public origin, per environment" },
	NEXT_PUBLIC_LEGAL_URL: { kind: "deploy-env", why: "the public origin, per environment" },
	NEXT_PUBLIC_POSTHOG_KEY: { kind: "deploy-env", why: "emitted from the vault" },
	NEXT_PUBLIC_POSTHOG_HOST: { kind: "deploy-env", why: "emitted from the vault (empty = EU default)" },
	NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: { kind: "deploy-env", why: "emitted from the vault" },
	NEXT_PUBLIC_STATUS_URL: {
		kind: "code-default",
		why: "unset ⇒ lib/legal.ts falls back to https://status.alethialabs.io",
	},
	NEXT_PUBLIC_FEEDBACK_REPO_URL: {
		kind: "code-default",
		why: "unset ⇒ sidebar-profile.tsx falls back to the public issues URL",
	},
	NEXT_PUBLIC_UMAMI_HOST: {
		kind: "code-default",
		why: "unset ⇒ Umami is off (deploy/analytics/README.md: the Umami stack was removed)",
	},
	NEXT_PUBLIC_UMAMI_WEBSITE_ID: {
		kind: "code-default",
		why: "unset ⇒ Umami is off (deploy/analytics/README.md: the Umami stack was removed)",
	},
};

/** Must be set by the runner stage itself — the build-id the post-deploy smoke reads. */
const RUNNER_MUST_SET: Record<string, string> = { NEXT_PUBLIC_APP_VERSION: "$VERSION" };

/** Directories under apps/console never scanned for runtime reads. */
const SKIP_DIRS = new Set(["node_modules", ".next", "tests", "coverage", "dist", "public", ".turbo"]);

/** Recursively list the console's .ts/.tsx/.mjs source files, skipping build output and tests. */
function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		if (SKIP_DIRS.has(name)) continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
		else if (/\.(ts|tsx|mjs)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
	}
	return out;
}

/** The `NEXT_PUBLIC_*` keys the console reads at runtime through next-runtime-env / `window.__ENV`. */
function runtimeReads(): Map<string, string[]> {
	const reads = new Map<string, string[]>();
	const add = (key: string, file: string) => {
		const files = reads.get(key) ?? [];
		files.push(file.slice(CONSOLE.length + 1));
		reads.set(key, files);
	};
	for (const file of sourceFiles(CONSOLE)) {
		const text = readFileSync(file, "utf8");
		if (/from\s+["']next-runtime-env["']/.test(text)) {
			for (const m of text.matchAll(/\benv\(\s*["'](NEXT_PUBLIC_[A-Z0-9_]+)["']\s*\)/g)) add(m[1], file);
		}
		for (const m of text.matchAll(/__ENV\??\.(NEXT_PUBLIC_[A-Z0-9_]+)/g)) add(m[1], file);
	}
	return reads;
}

/** One Dockerfile stage: its name and the ENV / ARG keys it declares (with ENV values). */
interface Stage {
	name: string;
	env: Map<string, string>;
	args: Set<string>;
}

/** Split `k=v k2=v2` (or the legacy `k v`) into pairs. Values here carry no quoted spaces. */
function pairs(rest: string): [string, string][] {
	const tokens = rest.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 2 && !tokens[0].includes("=")) return [[tokens[0], tokens[1]]];
	return tokens.map((t) => {
		const eq = t.indexOf("=");
		return eq === -1 ? [t, ""] : [t.slice(0, eq), t.slice(eq + 1).replace(/^"(.*)"$/, "$1")];
	});
}

/** Parse a Dockerfile into stages, joining `\` continuations and dropping comment lines. */
function parseStages(text: string): Stage[] {
	const logical: string[] = [];
	let buf = "";
	for (const raw of text.split("\n")) {
		if (/^\s*#/.test(raw)) continue;
		const line = raw.replace(/\s+$/, "");
		if (line.endsWith("\\")) {
			buf += `${line.slice(0, -1)} `;
			continue;
		}
		logical.push(buf + line);
		buf = "";
	}
	if (buf) logical.push(buf);

	const stages: Stage[] = [];
	for (const line of logical) {
		const m = /^\s*([A-Za-z]+)\s+(.*)$/.exec(line);
		if (!m) continue;
		const op = m[1].toUpperCase();
		if (op === "FROM") {
			const as = /\s+AS\s+([A-Za-z0-9_.-]+)\s*$/i.exec(m[2]);
			stages.push({ name: as ? as[1] : `#${stages.length}`, env: new Map(), args: new Set() });
			continue;
		}
		const stage = stages.at(-1);
		if (!stage) continue;
		if (op === "ENV") for (const [k, v] of pairs(m[2])) stage.env.set(k, v);
		if (op === "ARG") for (const [k] of pairs(m[2])) stage.args.add(k);
	}
	return stages;
}

const reads = runtimeReads();
const deployWorkflow = readFileSync(DEPLOY_WORKFLOW, "utf8");

describe("runtime-read NEXT_PUBLIC_* vars (#5621)", () => {
	it("finds the runtime reads (a scanner that finds nothing would pass everything)", () => {
		expect(reads.has("NEXT_PUBLIC_APP_VERSION")).toBe(true);
		expect(reads.size).toBeGreaterThanOrEqual(5);
	});

	it("every ledger entry is still a runtime read, and deploy-env entries are really emitted", () => {
		for (const [key, src] of Object.entries(OTHER_RUNTIME_SOURCE)) {
			expect(reads.has(key), `${key} is in the ledger but nothing reads it at runtime`).toBe(true);
			if (src.kind === "deploy-env") {
				const emitted = new RegExp(`(echo "${key}=|emit ${key}\\b)`).test(deployWorkflow);
				expect(emitted, `${key} claims deploy-env but deploy-console.yml never writes it`).toBe(true);
			}
		}
	});

	for (const file of DOCKERFILES) {
		describe(`apps/console/${file}`, () => {
			const stages = parseStages(readFileSync(join(CONSOLE, file), "utf8"));
			const runner = stages.find((s) => s.name === "runner");

			it("has a runner stage", () => {
				expect(runner).toBeDefined();
			});

			it("the runner stage sets the build id the post-deploy smoke reads", () => {
				for (const [key, value] of Object.entries(RUNNER_MUST_SET)) {
					expect(runner?.env.get(key), `${file} runner must set ${key}`).toBe(value);
				}
				// `$VERSION` is empty in a stage that never declared it — build args are per stage.
				expect(runner?.args.has("VERSION")).toBe(true);
			});

			it("no runtime-read var is set at build time only", () => {
				const buildOnly: string[] = [];
				for (const stage of stages) {
					if (stage === runner) continue;
					for (const key of stage.env.keys()) {
						if (reads.has(key) && !runner?.env.has(key)) buildOnly.push(`${key} (stage ${stage.name})`);
					}
				}
				expect(buildOnly).toEqual([]);
			});

			it("every runtime-read var has a runtime source: the runner stage or the ledger", () => {
				const missing: string[] = [];
				const doubled: string[] = [];
				for (const [key, files] of reads) {
					const inRunner = runner?.env.has(key) ?? false;
					const inLedger = key in OTHER_RUNTIME_SOURCE;
					if (!inRunner && !inLedger) missing.push(`${key} (read in ${files.join(", ")})`);
					if (inRunner && inLedger) doubled.push(key);
				}
				expect(missing).toEqual([]);
				expect(doubled).toEqual([]);
			});
		});
	}
});
