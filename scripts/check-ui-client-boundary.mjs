#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// `packages/ui/src/button.tsx` must keep its `"use client"`, and the note explaining why must keep
// naming the right callers.
//
// WHY THIS EXISTS. That directive's absence cost two long production bisects — `Element type is
// invalid … got: undefined`, on the home page and again on /open-source. The module renders
// base-ui's Button and has always BEEN a client boundary; without the directive the bundler was
// free to pull it into the server graph too, and a page rendering a Button from a server component
// while the shared header rendered one from the client graph got two copies of the module. Neither
// tsc, eslint nor the type checker can see it — only a production build, at request time.
//
// So the file carried a comment saying "keep it that way". The comment then named TWO callers and
// one of them was wrong: apps/docs/components/ai/page-actions.tsx imports a DIFFERENT
// `buttonVariants`, from fumadocs-ui, in an app that does not declare @repo/ui at all.
//
// A wrong citation attached to a correct rule is worse than no citation. The next person to widen
// this file's surface checks the two names, finds one irrelevant, and has no way to tell whether
// the rule or the evidence is the stale half. This turns the claim into something derived from the
// tree, so it cannot drift again.
//
//   node scripts/check-ui-client-boundary.mjs
//   node scripts/check-ui-client-boundary.mjs --self-test

import fs from "node:fs";
import path from "node:path";

/** The module under guard, and the value export whose callers the comment makes a claim about. */
const MODULE = "packages/ui/src/button.tsx";
const VALUE = "buttonVariants";

/** Roots worth walking. node_modules is excluded; so is the module itself. */
const ROOTS = ["apps", "packages"];
const EXTS = new Set([".ts", ".tsx"]);

/** Does a file declare the client directive? First non-comment, non-blank line must be it. */
export function declaresUseClient(text) {
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		if (line.startsWith("//")) continue;
		if (line.startsWith("/*")) {
			// Skip to the end of the block comment.
			return declaresUseClient(text.slice(text.indexOf("*/") + 2));
		}
		return /^["']use client["'];?$/.test(line);
	}
	return false;
}

/**
 * Does this import statement pull VALUE out of THIS module?
 *
 * Both spellings resolve here — the package entry (`@repo/ui/button`) and the sibling relative
 * (`./button`) that calendar.tsx uses. A third-party module of the same name is NOT this module,
 * which is the precise mistake the old comment made.
 */
export function importsValueFromModule(line, importerPath) {
	const m = line.match(/^\s*import\s+\{([^}]*)\}\s+from\s+["']([^"']+)["']/);
	if (m === null) return false;
	const names = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim());
	if (!names.includes(VALUE)) return false;
	const spec = m[2];
	if (spec === "@repo/ui/button") return true;
	// A relative specifier only counts when it actually resolves to MODULE.
	if (spec.startsWith(".")) {
		const resolved = path.normalize(path.join(path.dirname(importerPath), spec));
		return resolved === MODULE.replace(/\.tsx$/, "") || resolved === MODULE;
	}
	return false;
}

function* walk(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		if (e.name === "node_modules" || e.name === ".next" || e.name === "dist") continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) yield* walk(p);
		else if (EXTS.has(path.extname(e.name))) yield p;
	}
}

/** @returns {{problems: string[], importers: string[]}} */
export function check(readFile = (p) => fs.readFileSync(p, "utf8"), exists = fs.existsSync) {
	const problems = [];
	if (!exists(MODULE)) {
		return {
			problems: [`${MODULE} does not exist — this check cannot run, which is not the same as passing.`],
			importers: [],
		};
	}
	if (!declaresUseClient(readFile(MODULE))) {
		problems.push(
			`${MODULE} has lost its \`"use client"\`. That directive's absence is what produced ` +
				'"Element type is invalid … got: undefined" on two separate pages, and no type check or lint ' +
				"can see it — only a production build, at request time.",
		);
	}

	const importers = [];
	for (const root of ROOTS) {
		for (const file of walk(root)) {
			if (file === MODULE) continue;
			const text = readFile(file);
			if (!text.includes(VALUE)) continue;
			for (const line of text.split("\n")) {
				if (!importsValueFromModule(line, file)) continue;
				importers.push(file);
				if (!declaresUseClient(text)) {
					problems.push(
						`${file} imports \`${VALUE}\` from ${MODULE} but is not a client module. ` +
							`${MODULE} is \`"use client"\`, so importing a value out of it pulls a client module into ` +
							"the server graph — the dual-graph condition that cost two production bisects.",
					);
				}
				break;
			}
		}
	}

	// The parser going blind would report a clean bill of health. There has been at least one real
	// importer since this module was written; zero means the matcher stopped matching.
	if (importers.length === 0) {
		problems.push(
			`no importer of \`${VALUE}\` was found anywhere under ${ROOTS.join("/")}. There is at least one ` +
				"(packages/ui/src/calendar.tsx), so this matcher has stopped matching — fix it rather than " +
				"trusting the green.",
		);
	}
	return { problems, importers };
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────
function selfTest() {
	let fails = 0;
	const ok = (name, cond, detail = "") => {
		if (cond) console.log(`ok   - ${name}`);
		else {
			console.error(`FAIL - ${name} ${detail}`);
			fails++;
		}
	};

	ok("a bare directive is recognised", declaresUseClient('"use client";\nimport x from "y";'));
	ok("...after a line comment", declaresUseClient("// SPDX\n// more\n'use client';"));
	ok("...after a block comment", declaresUseClient("/* long\n   rationale */\n\"use client\";"));
	ok("a file without one is not a client module", !declaresUseClient('import x from "y";'));
	// The whole point: a directive further down the file does NOT make it a client module.
	ok("a directive that is not first does not count", !declaresUseClient('import x from "y";\n"use client";'));

	// THE MISTAKE THE OLD COMMENT MADE: same exported name, different module.
	ok("a third-party buttonVariants is not this one",
		!importsValueFromModule("import { buttonVariants } from 'fumadocs-ui/components/ui/button';", "apps/docs/x.tsx"));
	ok("the package specifier counts",
		importsValueFromModule('import { buttonVariants } from "@repo/ui/button";', "apps/console/x.tsx"));
	ok("the sibling relative counts",
		importsValueFromModule('import { Button, buttonVariants } from "./button"', "packages/ui/src/calendar.tsx"));
	ok("a relative that resolves ELSEWHERE does not",
		!importsValueFromModule('import { buttonVariants } from "./button"', "apps/marketing/components/calendar.tsx"));
	ok("importing something else from the module is not a call site",
		!importsValueFromModule('import { Button } from "@repo/ui/button";', "apps/console/x.tsx"));
	ok("an aliased import still counts",
		importsValueFromModule('import { buttonVariants as bv } from "@repo/ui/button";', "apps/console/x.tsx"));

	// Blindness cases — each would otherwise report success.
	const noModule = check(() => "", () => false);
	ok("a missing module fails rather than passes",
		/cannot run, which is not the same as passing/.test(noModule.problems[0] ?? ""), JSON.stringify(noModule.problems));

	if (fails > 0) {
		console.error(`\ncheck-ui-client-boundary self-test: ${fails} failure(s)`);
		process.exit(1);
	}
	console.log("\nself-test: all passed");
}

// ── entry ─────────────────────────────────────────────────────────────────────────────────────
if (process.argv.includes("--self-test")) {
	selfTest();
} else {
	const { problems, importers } = check();
	for (const p of problems) console.error(`::error::ui-client-boundary: ${p}`);
	if (problems.length > 0) {
		console.error(`\n${problems.length} problem(s).`);
		process.exit(1);
	}
	console.log(
		`ui-client-boundary: ${MODULE} is \`"use client"\`; ${importers.length} in-repo importer(s) of ` +
			`\`${VALUE}\`, all client modules — ${importers.join(", ")}`,
	);
}
