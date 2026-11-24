// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every docs page stays under the word cap of its page type (docs rework, 2026-11-24).
 *
 * The docs grew to ~207,000 words because nothing ever said "too long". A page type has a shape
 * and a length (apps/docs/README.md → "Page types"); the section a page lives in decides its type,
 * so the cap is keyed on the top-level directory. Only PROSE is counted: frontmatter and fenced
 * code are stripped first, because a long code sample is not what makes a page hard to read.
 *
 * Pages that were over their cap when the guard landed are recorded in page-length-ledger.json
 * with their word count at that time. The ledger is a ratchet, read in both directions:
 *   - a page over its cap that is not in the ledger fails (a new long page);
 *   - a ledgered page that grew past its recorded count fails (an old long page got longer);
 *   - a ledgered page now under its cap fails as a STALE entry (delete the line: the fix landed);
 *   - a ledgered page that shrank but is still over its cap fails too, until its count is lowered
 *     to the new figure, so the ceiling follows every improvement down;
 *   - a ledger entry for a page that no longer exists fails.
 * Sections NOT in CAPS (reference, troubleshooting, editions, changelog) are not measured: reference
 * is moving to generated pages, and a troubleshooting page is one block per problem with no cap.
 *
 * Usage: node scripts/check-page-length.mjs [--self-test]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Prose-word cap per top-level docs section (the section decides the page type). */
export const CAPS = {
	"get-started": 1500, // quickstart
	tutorials: 2500, // tutorial
	guides: 1000, // how-to
	"self-host": 1000, // how-to
	agents: 1000, // how-to
	concepts: 1200, // concept
};

/** Counts the prose words of an MDX source: no frontmatter, no fenced code. */
export function proseWords(source) {
	const body = source.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/```[\s\S]*?```/g, "");
	return body.split(/\s+/).filter(Boolean).length;
}

/** Lists every .mdx file under dir, as paths relative to dir with forward slashes. */
function listPages(dir) {
	const out = [];
	const walk = (d) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith(".mdx")) out.push(path.relative(dir, p).split(path.sep).join("/"));
		}
	};
	walk(dir);
	return out.sort();
}

/** Returns the list of violations for a content dir and a ledger object ({ "<rel path>": words }). */
export function check(contentDir, ledger) {
	const problems = [];
	const seen = new Set();
	for (const rel of listPages(contentDir)) {
		const cap = CAPS[rel.split("/")[0]];
		if (cap === undefined) continue;
		const words = proseWords(fs.readFileSync(path.join(contentDir, rel), "utf8"));
		const recorded = ledger[rel];
		if (recorded !== undefined) seen.add(rel);
		if (words <= cap) {
			if (recorded !== undefined)
				problems.push(`${rel}: now ${words} words, under its cap of ${cap}. Delete its ledger line.`);
			continue;
		}
		if (recorded === undefined) {
			problems.push(`${rel}: ${words} words, over its cap of ${cap}. Shorten it or split it.`);
		} else if (words > recorded) {
			problems.push(`${rel}: grew to ${words} words (ledger ceiling ${recorded}, cap ${cap}). Shorten it.`);
		} else if (words < recorded) {
			problems.push(`${rel}: shrank to ${words} words. Lower its ledger entry from ${recorded} to ${words}.`);
		}
	}
	for (const rel of Object.keys(ledger)) {
		if (!seen.has(rel) && !fs.existsSync(path.join(contentDir, rel)))
			problems.push(`${rel}: in the ledger but no such page. Delete its ledger line.`);
	}
	return problems;
}

/** Plants one of each defect in a temp tree and asserts each is reported, and nothing else. */
function selfTest() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "page-length-"));
	const page = (rel, n) => {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		const code = "```bash\n" + "x ".repeat(5000) + "\n```\n";
		fs.writeFileSync(path.join(dir, rel), `---\ntitle: T\n---\n\n${"word ".repeat(n)}\n${code}`);
	};
	page("guides/short.mdx", 900); // fine: under cap, code not counted
	page("guides/new-long.mdx", 1100); // defect: over cap, not ledgered
	page("guides/grew.mdx", 1300); // defect: grew past ledger
	page("guides/fixed.mdx", 800); // defect: stale ledger entry
	page("guides/shrank.mdx", 1150); // defect: ceiling not lowered
	page("guides/steady.mdx", 1200); // fine: ledgered at its count
	page("reference/huge.mdx", 9000); // fine: reference is not measured
	const ledger = {
		"guides/grew.mdx": 1200,
		"guides/fixed.mdx": 1500,
		"guides/shrank.mdx": 1250,
		"guides/steady.mdx": 1200,
		"guides/gone.mdx": 1400, // defect: page missing
	};
	const got = check(dir, ledger).map((p) => p.split(":")[0]).sort();
	const want = ["guides/fixed.mdx", "guides/gone.mdx", "guides/grew.mdx", "guides/new-long.mdx", "guides/shrank.mdx"];
	fs.rmSync(dir, { recursive: true, force: true });
	if (JSON.stringify(got) !== JSON.stringify(want)) {
		console.error(`check-page-length self-test FAILED.\n  want: ${want.join(", ")}\n  got:  ${got.join(", ")}`);
		process.exit(1);
	}
	console.log(`check-page-length self-test: all ${want.length} planted defects reported, none invented.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	if (process.argv.includes("--self-test")) {
		selfTest();
	} else {
		const contentDir = path.join(HERE, "..", "content", "docs");
		const ledger = JSON.parse(fs.readFileSync(path.join(HERE, "..", "page-length-ledger.json"), "utf8"));
		const problems = check(contentDir, ledger);
		const pages = listPages(contentDir).filter((r) => CAPS[r.split("/")[0]] !== undefined).length;
		if (problems.length) {
			console.error(`check-page-length: ${problems.length} problem(s) across ${pages} measured pages:`);
			for (const p of problems) console.error(`  - ${p}`);
			process.exit(1);
		}
		console.log(`check-page-length: ${pages} measured pages; ${Object.keys(ledger).length} still over their cap, none grew.`);
	}
}
