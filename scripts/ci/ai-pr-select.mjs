#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// ai-pr-select — which real-model journeys a PR's changed files warrant (e2e-ai-nightly.yml, epic #7840).
//
// The paid AI runs exist to answer one question for the person changing an AI tool: did it get
// better or worse? So the PR leg spends exactly where the change is. The tool-choice eval runs on
// EVERY PR that reaches this workflow (its `paths:` filter is the AI surface, and the eval is cents);
// the browser journeys (`elench-live`, minutes of runner and a console build) run only for the
// features the diff touches.
//
// RULES is a list of (pattern → specs). A file can match several rules; the union is the answer.
// A `fallback` rule answers only for a file no other rule claimed. A file under the workflow's
// `paths:` that matches NO rule selects nothing beyond the eval — `--self-test` pins that every path the workflow filters on is covered here, so a path added to
// the filter without a rule is a red self-test, not a silently eval-only PR.
//
//   git diff --name-only … | node scripts/ci/ai-pr-select.mjs      → prints {"specs": [...]} as JSON
//   node scripts/ci/ai-pr-select.mjs --self-test

import fs from "node:fs";
import path from "node:path";

const E2E = "apps/console/e2e";
const AGENT = [`${E2E}/elench-live.spec.ts`, `${E2E}/ai-live-agent.spec.ts`];
const SUPPORT = [`${E2E}/ai-live-support.spec.ts`];
const PROJECT = [`${E2E}/ai-live-project.spec.ts`];
const ARTIFACTS = [`${E2E}/ai-live-artifacts.spec.ts`];
const API = [`${E2E}/ai-live-api.spec.ts`];
const ALL = [...AGENT, ...SUPPORT, ...PROJECT, ...ARTIFACTS, ...API];

/**
 * The (pattern, specs) rules. `specs: []` means "eval only" — stated, so the self-test can tell
 * a deliberate eval-only path from a forgotten one.
 * @type {{re: RegExp, specs: string[], why: string, fallback?: boolean}[]}
 */
export const RULES = [
	// A spec or its helpers changed: run that spec (helpers and config: all of them).
	{ re: /^apps\/console\/e2e\/(elench-live|ai-live-[a-z-]+)\.spec\.ts$/, specs: ["$self"], why: "the journey itself changed" },
	{ re: /^apps\/console\/e2e\/helpers\/ai-[a-z-]+\.ts$/, specs: ALL, why: "a helper every live journey uses" },
	// Model routing, provider options, pricing: every AI surface rides on these.
	{ re: /^apps\/console\/lib\/config\/ai\.ts$/, specs: ALL, why: "model routing for every AI surface" },
	{ re: /^apps\/console\/lib\/ai\/(provider-[a-z-]+|transparency|ai-observability|message-limits|knowledge-limits)\.ts$/, specs: ALL, why: "shared provider plumbing" },
	{ re: /^apps\/console\/lib\/billing\/model-costs\.ts$/, specs: [], why: "pricing only — the eval's cost column shows it" },
	// Support chat.
	{ re: /^apps\/console\/(lib\/ai\/support\/|lib\/ai\/tools\/support\.ts$|app\/api\/support\/ask\/)/, specs: SUPPORT, why: "support Ask AI" },
	// Project assistant.
	{ re: /^apps\/console\/(app\/api\/projects\/[^/]+\/assistant\/|lib\/ai\/(project-[a-z-]+|proposal|canvas-context|client-tools)\.ts$)/, specs: PROJECT, why: "project assistant" },
	// Dashboards and artifacts.
	{ re: /^apps\/console\/lib\/ai\/(tools\/(artifacts|widgets|visualize)\.ts|artifact-spec\.ts|widget-schema\.ts)$/, specs: [...ARTIFACTS, `${E2E}/elench-live.spec.ts`], why: "dashboards and artifacts" },
	// Agent identities and repo-scan inference.
	{ re: /^apps\/console\/(app\/api\/agent\/\[agentId\]\/|lib\/scanner\/infer\.ts$)/, specs: API, why: "agent-identity turns, repo-scan inference" },
	// The Elench agent: its route, prompt and the rest of its tools.
	// The Elench agent: its route, prompt and the rest of its tools. FALLBACK rules: they apply only
	// when no feature rule above claimed the file, so a support-prompt change does not also pay for
	// the agent journeys just because it lives under lib/ai/.
	{ re: /^apps\/console\/app\/api\/agent\//, specs: AGENT, why: "the agent route and system prompt", fallback: true },
	{ re: /^apps\/console\/lib\/ai\//, specs: AGENT, why: "agent tools and context", fallback: true },
	// The eval itself: the eval always runs, nothing more is needed.
	{ re: /^apps\/console\/(tests\/ai-eval\/|vitest\.ai-eval\.config\.ts$)/, specs: [], why: "the eval itself" },
	// The workflow and its scripts: run everything once, so a change to the instrument is measured.
	{ re: /^(\.github\/workflows\/e2e-ai-nightly\.yml|scripts\/ci\/ai-(pr-select|eval-report)\.mjs)$/, specs: ALL, why: "the instrument changed" },
];

/**
 * The live specs a list of changed files selects.
 * @param {string[]} files
 * @returns {{specs: string[], unmatched: string[]}}
 */
export function select(files) {
	const specs = new Set();
	const unmatched = [];
	for (const f of files.map((s) => s.trim()).filter(Boolean)) {
		const direct = RULES.filter((r) => !r.fallback && r.re.test(f));
		const hits = direct.length ? direct : RULES.filter((r) => r.fallback && r.re.test(f));
		for (const r of hits) for (const s of r.specs) specs.add(s === "$self" ? f : s);
		if (!hits.length) unmatched.push(f);
	}
	return { specs: [...specs].sort(), unmatched };
}

/**
 * The `paths:` globs of e2e-ai-nightly.yml's pull_request trigger (line-based; the file is ours).
 * @param {string} text
 * @returns {string[]}
 */
export function workflowPaths(text) {
	const lines = text.split("\n");
	const start = lines.findIndex((l) => /^\s{4}paths:\s*$/.test(l));
	if (start < 0) return [];
	const out = [];
	for (const l of lines.slice(start + 1)) {
		const m = l.match(/^\s{6}-\s+"([^"]+)"\s*$/);
		if (!m) break;
		out.push(m[1]);
	}
	return out;
}

/**
 * A representative concrete path for a glob, so the self-test can ask RULES about it.
 * @param {string} glob
 */
function sample(glob) {
	return glob.replace(/\*\*\/\*\.ts$/, "x/y.ts").replace(/\*\*$/, "x/y.ts").replace(/\*\.ts$/, "x.ts").replace(/\*/g, "x");
}

/** Self-test: the rules answer the cases they were written for, and cover the workflow's filter. */
function selfTest() {
	let failures = 0;
	const eq = (name, got, want) => {
		if (JSON.stringify(got) !== JSON.stringify(want)) {
			failures++;
			console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
		}
	};
	eq("support prompt → support spec", select(["apps/console/lib/ai/support/prompt.ts"]).specs, SUPPORT);
	eq("eval only → no specs", select(["apps/console/tests/ai-eval/agent-behavior.eval.ts"]).specs, []);
	eq("a spec selects itself", select([`${E2E}/ai-live-api.spec.ts`]).specs, [`${E2E}/ai-live-api.spec.ts`]);
	eq("a read tool → the agent journeys", select(["apps/console/lib/ai/tools/read.ts"]).specs, [...AGENT].sort());
	eq("artifact tool → artifacts + elench-live, not ai-live-agent", select(["apps/console/lib/ai/tools/artifacts.ts"]).specs, [...ARTIFACTS, `${E2E}/elench-live.spec.ts`].sort());
	eq("routing → everything", select(["apps/console/lib/config/ai.ts"]).specs, [...ALL].sort());
	eq("project route", select(["apps/console/app/api/projects/[projectId]/assistant/route.ts"]).specs, PROJECT);
	eq("agent identity route", select(["apps/console/app/api/agent/[agentId]/route.ts"]).specs, API);
	eq("union of two features", select(["apps/console/lib/ai/support/case.ts", "apps/console/lib/scanner/infer.ts"]).specs, [...API, ...SUPPORT].sort());

	// Coverage: every path the workflow triggers on is answered by a rule (even if the answer is []).
	const wf = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../.github/workflows/e2e-ai-nightly.yml");
	const globs = workflowPaths(fs.readFileSync(wf, "utf8"));
	if (globs.length < 5) {
		failures++;
		console.error(`FAIL read only ${globs.length} paths from e2e-ai-nightly.yml — the line parser went blind`);
	}
	for (const g of globs) {
		const s = sample(g);
		if (select([s]).unmatched.length) {
			failures++;
			console.error(`FAIL workflow path ${g} (sampled as ${s}) matches no RULE — add one, even if it selects []`);
		}
	}
	if (failures) {
		console.error(`${failures} self-test check(s) failed`);
		process.exit(1);
	}
	console.log(`ai-pr-select self-test: ok (${globs.length} workflow paths covered)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
	if (process.argv.includes("--self-test")) selfTest();
	else {
		const files = fs.readFileSync(0, "utf8").split("\n");
		const { specs, unmatched } = select(files);
		process.stdout.write(`${JSON.stringify({ specs, unmatched })}\n`);
	}
}
