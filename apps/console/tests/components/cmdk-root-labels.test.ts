// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GUARD (#5824): every cmdk root in `packages/ui/src` and `apps/console` carries a `label`.
//
// cmdk names its search input through `aria-labelledby` → its own hidden `<label cmdk-label>`, whose
// text is the root's `label` prop. A root without one renders an input whose name computes to "" —
// and an empty `aria-labelledby` target still beats the placeholder, so the search is an unnamed
// combobox with its placeholder visible inside it. Every root in the repo shipped that way until
// #5803 and #5824.
//
// WHAT THIS READS, AND WHERE IT STOPS:
//  - `<CommandDialog>` is named by construction: it passes its `title` (default "Command Palette")
//    to cmdk as the label, so it fails only on a blank `title` literal.
//  - The cmdk ROOT reaches the console only as `@repo/ui/command`'s `Command` / `CommandDialog`, so
//    a JSX opening tag named exactly `<Command` or `<CommandDialog` is the subject. Its attributes
//    must include `label=` with a value that is not an empty string literal. A `{...spread}` alone
//    does NOT count: the rendered name is what matters and a spread hides whether one is passed.
//  - `cmdk` itself may be imported only by `packages/ui/src/command.tsx`. Anything else importing
//    it would bypass the wrapper and this guard, so that is a failure too.
//  - It is a TEXT match over the source. It does not follow a component that re-wraps `Command`
//    under another name and is then used without a label; `PromptInputCommand` is such a wrapper
//    and makes `label` a required prop for exactly that reason. The rendered-name half lives in
//    tests/components/cmdk-search-names.test.tsx and packages/ui/tests/command.test.tsx.
//  - Test, story and e2e files are not read: they render roots to exercise behaviour, not ship UI.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `apps/console`, found by ascent. THROWS when not found: a scan of an empty directory would report
 * zero offenders, which is a guard going green for having looked nowhere.
 */
function consoleRoot(): string {
	let dir = process.cwd();
	for (let up = 0; up < 6; up += 1) {
		if (
			existsSync(path.join(dir, "vitest.config.ts")) &&
			existsSync(path.join(dir, "components"))
		) {
			return dir;
		}
		dir = path.dirname(dir);
	}
	throw new Error(`could not locate apps/console from ${process.cwd()}`);
}

const CONSOLE_ROOT = consoleRoot();
const UI_SRC = path.resolve(CONSOLE_ROOT, "../../packages/ui/src");
const SKIP_DIRS = new Set([
	"node_modules",
	".next",
	"tests",
	"e2e",
	"__tests__",
	"coverage",
]);

/** Every `.tsx` file under `dir`, skipping build output and test trees. */
function tsxFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
		else if (/\.tsx$/u.test(entry) && !/\.(test|stories)\.tsx$/u.test(entry))
			out.push(full);
	}
	return out;
}

/**
 * The attribute text of the JSX opening tag that starts at `start` (just past the tag name), up to
 * the `>` that closes it. Braces are depth-counted and string literals skipped, so an arrow
 * function or a `>` inside an attribute expression does not end the tag early.
 */
function openingTagAttributes(source: string, start: number): string {
	let depth = 0;
	let quote: string | null = null;
	for (let i = start; i < source.length; i += 1) {
		const ch = source[i];
		if (quote) {
			if (ch === "\\") i += 1;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") quote = ch;
		else if (ch === "{") depth += 1;
		else if (ch === "}") depth -= 1;
		else if (ch === ">" && depth === 0) return source.slice(start, i);
	}
	return source.slice(start);
}

/**
 * How the attribute text sets `name`: "absent", "empty" (an empty or blank string literal), or
 * "set" (a non-empty literal or any expression).
 */
function attribute(
	attributes: string,
	name: string,
): "absent" | "empty" | "set" {
	const match = new RegExp(
		`(?:^|\\s)${name}=(\\{\\s*(["'\`])(.*?)\\2\\s*\\}|(["'])(.*?)\\4|\\{)`,
		"su",
	).exec(attributes);
	if (!match) return "absent";
	const literal = match[3] ?? match[5];
	return literal !== undefined && literal.trim() === "" ? "empty" : "set";
}

/**
 * Whether a root's attributes name its search. `<Command>` needs a non-empty `label`.
 * `<CommandDialog>` passes its `title` (default "Command Palette") to cmdk as the label, so it is
 * named unless a caller blanks the title.
 */
function namesItsSearch(tag: string, attributes: string): boolean {
	if (tag === "CommandDialog")
		return attribute(attributes, "title") !== "empty";
	return attribute(attributes, "label") === "set";
}

/** `file:line <Tag` for every cmdk root in `source` that has no non-empty `label`. */
function unlabelledRoots(source: string, file: string): string[] {
	const found: string[] = [];
	for (const m of source.matchAll(/<(Command|CommandDialog)(?=[\s/>])/gu)) {
		const start = (m.index ?? 0) + m[0].length;
		if (!namesItsSearch(m[1], openingTagAttributes(source, start))) {
			const line = source.slice(0, m.index).split("\n").length;
			found.push(`${file}:${line} <${m[1]}`);
		}
	}
	return found;
}

const FILES = [
	...tsxFiles(UI_SRC),
	...tsxFiles(path.join(CONSOLE_ROOT, "components")),
	...tsxFiles(path.join(CONSOLE_ROOT, "app")),
];

/** Path relative to the repo root, for readable failures. */
const rel = (f: string) =>
	path.relative(path.resolve(CONSOLE_ROOT, "../.."), f);

describe("cmdk root labels (#5824)", () => {
	it("reads a non-trivial set of files, including the command wrapper", () => {
		expect(FILES.length).toBeGreaterThan(100);
		expect(FILES.map(rel)).toContain("packages/ui/src/command.tsx");
	});

	it("finds cmdk roots to check (a scan that matches nothing proves nothing)", () => {
		const roots = FILES.flatMap((f) => [
			...readFileSync(f, "utf8").matchAll(
				/<(Command|CommandDialog)(?=[\s/>])/gu,
			),
		]);
		expect(roots.length).toBeGreaterThanOrEqual(10);
	});

	it("gives every cmdk root a non-empty label", () => {
		const offenders = FILES.flatMap((f) =>
			unlabelledRoots(readFileSync(f, "utf8"), rel(f)),
		);
		expect(offenders).toEqual([]);
	});

	it("imports cmdk only through @repo/ui/command", () => {
		const importers = FILES.filter((f) =>
			/from\s+["']cmdk["']/u.test(readFileSync(f, "utf8")),
		).map(rel);
		expect(importers).toEqual(["packages/ui/src/command.tsx"]);
	});

	it("flags the shapes it is meant to flag, and only those", () => {
		const cases: [string, number][] = [
			["<Command>", 1],
			["<Command className={cn(a)} {...props} />", 1],
			['<Command label="">', 1],
			["<Command label={''}>", 1],
			['<CommandDialog open title="">', 1],
			["<CommandDialog open title={' '}>", 1],
			["<CommandDialog open onOpenChange={setOpen}>", 0],
			['<CommandDialog title={variant ? `Choose ${x}` : "Add"}>', 0],
			["<Command\n  className={x}\n>", 1],
			['<Command label="Find project">', 0],
			["<Command label={title} className={cn(a)}>", 0],
			['<Command onKeyDown={(e) => e.key === ">"} label="Search">', 0],
			["<Command onKeyDown={() => a > b} label={purpose}>", 0],
			['<CommandInput placeholder="x" />', 0],
			["<CommandList>", 0],
		];
		const flagged = cases.map(([src]) => [
			src,
			unlabelledRoots(src, "case").length,
		]);
		expect(flagged).toEqual(cases);
	});
});
