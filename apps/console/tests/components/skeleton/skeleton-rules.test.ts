// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Rules 4 and 5 of "The skeleton rules" (docs/ui-conformance/RUBRIC.md; CON-SM7, #6759), read off
// every `loading.tsx` under `app/`:
//
//   4. a skeleton is synchronous — an async `loading.tsx` is banned (decision CON-M4);
//   5. a skeleton is never a spinner.
//
// The files that break either rule today are carried as two ledgers, each owned by the lane whose
// scope holds the file. A ledger fails in BOTH directions: a file that breaks a rule and is not
// listed fails, and so does an entry whose file no longer breaks it — so a list cannot outlive
// what it excuses, and fixing a route moves a line here in the same diff.
//
// WHAT THE MATCHERS READ, AND WHAT THEY DO NOT. Rule 4 is the tokens `async` and `await` anywhere
// in the file outside a block comment or a whole-line `//` comment. A synchronous `loading.tsx` that suspends through React's `use()`
// is the same defect and is NOT matched. Rule 5 is the class token `animate-spin` in the
// `loading.tsx` itself; a spinner inside a component the file renders is NOT matched. Neither
// reads a skeleton that is not a `loading.tsx` (a panel's own pending render).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CONSOLE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const APP = join(CONSOLE, "app");

/**
 * Async `loading.tsx` files, each with the issue whose scope holds it. Keyed by path relative to
 * apps/console. No route was migrated by the unit that wrote this list.
 */
const OWED_ASYNC: Record<string, string> = {
	"app/(private)/[org]/[project]/clusters/loading.tsx": "#6819",
	"app/(private)/[org]/[project]/settings/access/loading.tsx": "#6824",
	"app/(private)/[org]/[project]/settings/preview/loading.tsx": "#6824",
	"app/(private)/[org]/~/clusters/loading.tsx": "#6819",
	"app/(private)/[org]/~/new/loading.tsx": "#6843",
	"app/(private)/[org]/~/settings/access/loading.tsx": "#6823",
	"app/(private)/[org]/~/settings/members/loading.tsx": "#6823",
	"app/(private)/[org]/~/settings/sso/loading.tsx": "#6823",
	"app/(private)/[org]/~/settings/teams/loading.tsx": "#6823",
	"app/(private)/[org]/~/support/cases/[id]/loading.tsx": "#6826",
};

/**
 * Spinner `loading.tsx` files. No open issue's `scope:` line named the one entry when this was
 * written, so it carries the unit that found it.
 */
const OWED_SPINNER: Record<string, string> = {
	"app/(private)/[org]/[project]/loading.tsx": "#6759",
};

/** Every `loading.tsx` under `dir`, recursively. */
function walk(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...walk(p));
		else if (name === "loading.tsx") out.push(p);
	}
	return out;
}

/** The source with block comments and whole-line `//` comments removed, so prose cannot match. */
function withoutComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Does this source declare or await anything asynchronous? */
function isAsync(source: string): boolean {
	return /\b(async|await)\b/.test(withoutComments(source));
}

/** Does this source draw a spinner? */
function isSpinner(source: string): boolean {
	return /(^|[\s"'`:])animate-spin(?![\w-])/.test(withoutComments(source));
}

/** Console-relative, forward-slashed paths of the `loading.tsx` files `test` is true of. */
function matching(test: (source: string) => boolean): string[] {
	return walk(APP)
		.filter((f) => test(readFileSync(f, "utf8")))
		.map((f) => relative(CONSOLE, f).split(sep).join("/"))
		.sort();
}

describe("the matchers can fire, and can stay quiet", () => {
	it("reads an async default export and a bare await", () => {
		expect(isAsync("export default async function Loading() { return null; }")).toBe(true);
		expect(isAsync("export default function Loading() { const x = await read(); return x; }")).toBe(true);
	});

	it("does not read the word in a comment, or inside another identifier", () => {
		expect(isAsync("// this used to be async and await a read\nexport default function Loading() { return null; }")).toBe(false);
		expect(isAsync("/** Not async. */\nexport default function Loading() { return null; }")).toBe(false);
		expect(isAsync("export default function Loading() { return <AsyncBoundary awaited />; }")).toBe(false);
	});

	it("reads a spinner class, with or without a variant prefix", () => {
		expect(isSpinner('<div className="h-6 w-6 animate-spin rounded-full" />')).toBe(true);
		expect(isSpinner('<div className="motion-safe:animate-spin" />')).toBe(true);
	});

	it("does not read a pulse, or a longer class that starts the same way", () => {
		expect(isSpinner('<div className="animate-pulse" />')).toBe(false);
		expect(isSpinner('<div className="animate-spin-slow" />')).toBe(false);
	});
});

describe("loading.tsx", () => {
	const files = walk(APP);

	it("finds the console's loading files, so an empty walk cannot pass", () => {
		expect(files.length).toBeGreaterThan(20);
	});

	it("is synchronous everywhere but the owed files", () => {
		expect(matching(isAsync).filter((f) => !(f in OWED_ASYNC))).toEqual([]);
	});

	it("lists no async file that has already been made synchronous", () => {
		const found = matching(isAsync);
		expect(Object.keys(OWED_ASYNC).filter((f) => !found.includes(f))).toEqual([]);
	});

	it("is a spinner nowhere but the owed files", () => {
		expect(matching(isSpinner).filter((f) => !(f in OWED_SPINNER))).toEqual([]);
	});

	it("lists no spinner that has already been replaced", () => {
		const found = matching(isSpinner);
		expect(Object.keys(OWED_SPINNER).filter((f) => !found.includes(f))).toEqual([]);
	});
});
