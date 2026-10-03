// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * check-template-cost — the AI starter template's hourly cost on the starter-templates page is
 * the figure the newest proof bundle measured, not a number someone typed once and forgot (#5302).
 *
 * The source of truth is `demos/proofs/templates/ai/<UTC stamp>/template-summary.json` → `cost`,
 * written by the e2e `templates` run from the Hetzner API and committed by commit-proof.sh. The
 * bundle used is the NEWEST stamp whose summary has `verdict: "PASS"` and a `cost` block — a later
 * bundle without a cost block (another cloud, a run that did not price) does not unseat it.
 *
 * Every fact below is DERIVED from that bundle and must appear on the page verbatim:
 *   - `EUR <total_hourly_net_eur>` — the headline figure
 *   - `EUR <hourly_net_eur>` per server, trailing zeros trimmed
 *   - `<n> × <server_type> in <location>` for each shape group
 *   - the measurement date (`asserted_at`, YYYY-MM-DD)
 *   - the run link `actions/runs/<id>` (id from `run_tag`, `nightly-<id>-<attempt>`)
 *   - the bundle link `demos/proofs/templates/ai/<stamp>`
 * And in the other direction, so a stale second figure cannot sit beside the right one: every
 * `EUR <number>`, every `actions/runs/<id>` and every `demos/proofs/templates/ai/<stamp>` on the
 * page must be one of the derived values.
 *
 * What it does NOT check: the prose around the figures (scope, "lower bound") — that is a review
 * question, not a string — and any other page. It refuses a bundle whose net and gross totals
 * differ, because the page does not say which one it quotes; that is a wording decision to make
 * when it first happens, not one to default silently.
 *
 * Usage:  node scripts/check-template-cost.mjs              exit 1 on any finding
 *         node scripts/check-template-cost.mjs --self-test  proves each finding class can fire
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(here, "..", "..", "..");
const BUNDLES_REL = "demos/proofs/templates/ai";
const PAGE_REL = "apps/docs/content/docs/guides/design-project/starter-templates.mdx";

/** Trims a decimal string's trailing zeros: "0.0569000000" → "0.0569", "1.50" → "1.5". */
export function trimDecimal(s) {
	const str = String(s).trim();
	if (!/^\d+(\.\d+)?$/.test(str)) throw new Error(`not a plain decimal: ${JSON.stringify(s)}`);
	return str.includes(".") ? str.replace(/0+$/, "").replace(/\.$/, "") : str;
}

/** Returns the newest PASS bundle with a `cost` block under `bundlesDir`, or null. */
export function newestCostBundle(bundlesDir) {
	const stamps = fs
		.readdirSync(bundlesDir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && /^\d{8}T\d{6}Z$/.test(d.name))
		.map((d) => d.name)
		.sort()
		.reverse();
	for (const stamp of stamps) {
		const file = path.join(bundlesDir, stamp, "template-summary.json");
		if (!fs.existsSync(file)) continue;
		const summary = JSON.parse(fs.readFileSync(file, "utf8"));
		if (summary.verdict === "PASS" && summary.cost) return { stamp, summary };
	}
	return null;
}

/** Derives the facts the page must state from one bundle. Throws on a bundle it cannot read. */
export function expectedFacts(stamp, summary) {
	const cost = summary.cost;
	if (!Array.isArray(cost.servers) || cost.servers.length === 0) {
		throw new Error(`bundle ${stamp}: cost.servers is empty`);
	}
	const total = trimDecimal(cost.total_hourly_net_eur);
	if (trimDecimal(cost.total_hourly_gross_eur) !== total) {
		throw new Error(
			`bundle ${stamp}: net (${cost.total_hourly_net_eur}) and gross (${cost.total_hourly_gross_eur}) differ — the page must say which it quotes; update the page and this check together`,
		);
	}
	const groups = new Map();
	const perServer = new Set();
	for (const s of cost.servers) {
		const key = `${s.server_type} in ${s.location}`;
		groups.set(key, (groups.get(key) ?? 0) + 1);
		perServer.add(trimDecimal(s.hourly_net_eur));
	}
	const runMatch = /-(\d+)-\d+$/.exec(summary.run_tag ?? "") ?? /-(\d{6,})-\d+$/.exec(summary.cluster ?? "");
	if (!runMatch) throw new Error(`bundle ${stamp}: no run id in run_tag or cluster`);
	const date = String(summary.asserted_at ?? "").slice(0, 10);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`bundle ${stamp}: asserted_at is not a date`);
	return {
		euros: [total, ...perServer],
		required: [
			`EUR ${total}`,
			...[...perServer].map((p) => `EUR ${p}`),
			...[...groups].map(([k, n]) => `${n} × ${k}`),
			date,
			`actions/runs/${runMatch[1]}`,
			`${BUNDLES_REL}/${stamp}`,
		],
		runId: runMatch[1],
		stamp,
	};
}

/** Returns the findings for `page` against `facts`; an empty list means the page agrees. */
export function check(page, facts) {
	const findings = [];
	for (const want of facts.required) {
		if (!page.includes(want)) findings.push(`missing: "${want}"`);
	}
	for (const m of page.matchAll(/EUR\s+(\d+(?:\.\d+)?)/g)) {
		if (!facts.euros.includes(trimDecimal(m[1]))) findings.push(`stray figure: "${m[0]}" is not in the bundle`);
	}
	for (const m of page.matchAll(/actions\/runs\/(\d+)/g)) {
		if (m[1] !== facts.runId) findings.push(`stray run: "${m[0]}" is not the bundle's run ${facts.runId}`);
	}
	for (const m of page.matchAll(/demos\/proofs\/templates\/ai\/(\d{8}T\d{6}Z)/g)) {
		if (m[1] !== facts.stamp) findings.push(`stray bundle: "${m[0]}" is not the newest bundle ${facts.stamp}`);
	}
	return findings;
}

/** Plants one defect of each class into a page that passes, and requires each to be reported. */
function selfTest() {
	const summary = {
		verdict: "PASS",
		run_tag: "nightly-111-1",
		asserted_at: "2026-01-02T03:04:05Z",
		cost: {
			servers: [
				{ server_type: "cpx32", location: "nbg1", hourly_net_eur: "0.0569000000" },
				{ server_type: "cpx32", location: "nbg1", hourly_net_eur: "0.0569000000" },
			],
			total_hourly_net_eur: "0.1138",
			total_hourly_gross_eur: "0.1138000",
		},
	};
	const facts = expectedFacts("20260102T030405Z", summary);
	const good =
		"EUR 0.1138 an hour. 2 × cpx32 in nbg1 at EUR 0.0569. 2026-01-02, actions/runs/111, " +
		"demos/proofs/templates/ai/20260102T030405Z";
	const cases = [
		["good page", good, 0],
		["wrong total", good.replace("EUR 0.1138", "EUR 0.1137"), 2],
		["stray old figure", `${good} Previously EUR 0.2000.`, 1],
		["wrong shape", good.replace("2 × cpx32", "3 × cpx32"), 1],
		["wrong date", good.replace("2026-01-02", "2026-01-03"), 1],
		["stray run", `${good} actions/runs/999`, 1],
		["old bundle", `${good} demos/proofs/templates/ai/20250101T000000Z`, 1],
	];
	let failed = false;
	for (const [name, page, want] of cases) {
		const got = check(page, facts).length;
		if (got !== want) {
			console.error(`  ${name}: expected ${want} finding(s), got ${got}`);
			failed = true;
		}
	}
	let refused = false;
	try {
		expectedFacts("x", { ...summary, cost: { ...summary.cost, total_hourly_gross_eur: "0.14" } });
	} catch {
		refused = true;
	}
	if (!refused) {
		console.error("  net≠gross: expected a refusal, got none");
		failed = true;
	}
	if (failed) {
		console.error("check-template-cost self-test FAILED");
		process.exit(1);
	}
	console.log(`check-template-cost self-test: all ${cases.length + 1} cases behave.`);
}

/** Entry point: --self-test, or check the real page against the newest bundle. */
function main() {
	if (process.argv.includes("--self-test")) return selfTest();
	const found = newestCostBundle(path.join(REPO_ROOT, BUNDLES_REL));
	if (!found) {
		console.error(`check-template-cost: no PASS bundle with a cost block under ${BUNDLES_REL}`);
		process.exit(1);
	}
	const facts = expectedFacts(found.stamp, found.summary);
	const page = fs.readFileSync(path.join(REPO_ROOT, PAGE_REL), "utf8");
	const findings = check(page, facts);
	if (findings.length > 0) {
		console.error(`check-template-cost: ${PAGE_REL} disagrees with ${BUNDLES_REL}/${found.stamp}:`);
		for (const f of findings) console.error(`  ${f}`);
		process.exit(1);
	}
	console.log(`check-template-cost: page matches ${BUNDLES_REL}/${found.stamp} (${facts.required.length} facts).`);
}

main();
