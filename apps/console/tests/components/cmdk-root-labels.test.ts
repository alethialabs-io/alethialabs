// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GUARD (#5824): every command-list root in `packages/ui/src` and `apps/console` names its search.
//
// It was written against cmdk, which named its search input through `aria-labelledby` → its own
// hidden `<label cmdk-label>`, whose text was the root's `label` prop. A root without one rendered an
// input whose name computed to "" — and an empty `aria-labelledby` target still beats the
// placeholder, so the search was an unnamed combobox with its placeholder visible inside it. Every
// root in the repo shipped that way until #5803 and #5824. Since #6145 the root is Base UI's
// Autocomplete, which `@repo/ui/command` wraps and whose input it names with the root's `label` (as
// `aria-label`). An unnamed Base UI input falls back to its placeholder rather than to "", so the
// original defect cannot recur in that form; the rule stays as "every search has an explicit name".
//
// WHAT THIS READS: every `.ts` / `.tsx` file under `packages/ui/src` and `apps/console`, except
// `node_modules`, `.next` and `coverage` (build output), the `tests`, `e2e` and `__tests__` trees,
// and `*.test.*` / `*.spec.*` / `*.stories.*` files (they render roots to exercise behaviour).
//
// WHAT A ROOT IS: derived from each file's IMPORTS, not from a tag name. A local binding imported
// from `@repo/ui/command` (or `./command` inside packages/ui) as `Command` or `CommandDialog`, or
// Base UI's `Autocomplete` imported from `@base-ui/react/autocomplete` or `@base-ui/react`, whose
// `<X.Root>` is the root — under any alias, and through a namespace import (`<ui.Command>`,
// `<X.Autocomplete.Root>`). So `import { Command as Cmd }` followed by an unnamed `<Cmd>` is caught.
//
// WHAT NAMED MEANS:
//  - A `Command` root needs `label=` with a value that is not blank: absent, `""`, `{""}`, `{null}`
//    and `{undefined}` all fail. A `{...spread}` alone fails too — it hides whether a label is
//    passed. Any OTHER expression counts as set: a text match cannot know that `{maybeEmpty}` is
//    empty at runtime. The rendered-name half lives in tests/components/cmdk-search-names.test.tsx
//    and packages/ui/tests/command.test.tsx.
//  - `@repo/ui`'s `CommandDialog` forwards its `title` (default "Command Palette") as the label, so
//    it fails only on a blank `title`.
//  - Base UI's `Autocomplete.Root` takes no `label` at all, so every one of them is a finding: it may
//    be rendered only by `packages/ui/src/command.tsx`, which names the input from its caller's
//    `label`, and is imported only there; anything else bypasses the wrapper. `cmdk` is gone and may
//    not come back.
//
// WHERE IT STOPS: it does not follow a component that re-wraps a root under a NEW component and is
// then used without a label. The one exempt site is the `Autocomplete.Root` inside the `Command`
// wrapper in `packages/ui/src/command.tsx`, which names the input through `CommandInput` instead;
// the exemption is checked in both directions below.

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
const REPO_ROOT = path.resolve(CONSOLE_ROOT, "../..");
const UI_SRC = path.join(REPO_ROOT, "packages/ui/src");
const SKIP_DIRS = new Set([
	"node_modules",
	".next",
	"coverage",
	"tests",
	"e2e",
	"__tests__",
]);

/** Every non-test `.ts` / `.tsx` file under `dir`, skipping build output and test trees. */
function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
		else if (
			/\.tsx?$/u.test(entry) &&
			!/\.d\.ts$/u.test(entry) &&
			!/\.(test|spec|stories)\.tsx?$/u.test(entry)
		)
			out.push(full);
	}
	return out;
}

/** How a root is named: by its `label`, or (`@repo/ui`'s CommandDialog) by its `title`. */
type NameProp = "label" | "title";

/** True when `spec` is `@repo/ui/command`, or a relative import of `command` from packages/ui. */
function isUiCommandModule(spec: string): boolean {
	return (
		spec === "@repo/ui/command" || /^\.{1,2}\/(?:.*\/)?command$/u.test(spec)
	);
}

/** The Base UI modules `Autocomplete` can be imported from. */
const BASE_UI_AUTOCOMPLETE = new Set(["@base-ui/react/autocomplete", "@base-ui/react"]);

/**
 * The JSX tag names in `source` that render a command-list root, mapped to the prop that names it.
 * Derived from the file's import declarations, so an alias or a namespace import is followed.
 */
function rootTags(source: string): Map<string, NameProp> {
	const tags = new Map<string, NameProp>();
	const importRe =
		/import\s+(type\s+)?([\w*{}\s,$]+?)\s+from\s+["']([^"']+)["']/gu;
	for (const m of source.matchAll(importRe)) {
		if (m[1]) continue;
		const clause = m[2];
		const spec = m[3];
		const fromUi = isUiCommandModule(spec);
		const fromBaseUi = BASE_UI_AUTOCOMPLETE.has(spec);
		if (!fromUi && !fromBaseUi) continue;
		/** Exported name → the tag suffix that is the root, and the prop that names it. */
		const roots: Record<string, [string, NameProp]> = fromUi
			? { Command: ["", "label"], CommandDialog: ["", "title"] }
			: { Autocomplete: [".Root", "label"] };
		const ns = /\*\s+as\s+([\w$]+)/u.exec(clause);
		if (ns) {
			if (spec === "@base-ui/react/autocomplete") tags.set(`${ns[1]}.Root`, "label");
			else
				for (const [name, [suffix, prop]] of Object.entries(roots))
					tags.set(`${ns[1]}.${name}${suffix}`, prop);
		}
		const named = /\{([^}]*)\}/u.exec(clause);
		for (const part of named ? named[1].split(",") : []) {
			const [imported, local] = part
				.trim()
				.replace(/^type\s+/u, "")
				.split(/\s+as\s+/u);
			if (!imported || part.trim().startsWith("type ")) continue;
			const root = roots[imported];
			if (!root) continue;
			tags.set(`${local ?? imported}${root[0]}`, root[1]);
		}
	}
	return tags;
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
 * Whether the attribute text gives `name` a value that is not blank. Absent, a blank string
 * literal, `{null}` and `{undefined}` are blank; any other expression is taken as set.
 */
function isSet(attributes: string, name: string): boolean {
	const match = new RegExp(
		`(?:^|\\s)${name}=(?:\\{\\s*(["'\`])(.*?)\\1\\s*\\}|(["'])(.*?)\\3|\\{\\s*(null|undefined)\\s*\\}|\\{)`,
		"su",
	).exec(attributes);
	if (!match) return false;
	if (match[5]) return false;
	const literal = match[2] ?? match[4];
	return literal === undefined || literal.trim() !== "";
}

/** Escapes a tag name (which may contain `.`) for use in a RegExp. */
const escapeTag = (tag: string) => tag.replace(/[.$]/gu, "\\$&");

/** `file:line <Tag` for every command-list root in `source` that does not name its search. */
function unnamedRoots(source: string, file: string): string[] {
	const found: string[] = [];
	for (const [tag, prop] of rootTags(source)) {
		const tagRe = new RegExp(`<(${escapeTag(tag)})(?=[\\s/>])`, "gu");
		for (const m of source.matchAll(tagRe)) {
			const start = (m.index ?? 0) + m[0].length;
			const attributes = openingTagAttributes(source, start);
			const named =
				prop === "title"
					? !/(?:^|\s)title=/u.test(attributes) || isSet(attributes, "title")
					: isSet(attributes, "label");
			if (!named) {
				const line = source.slice(0, m.index).split("\n").length;
				found.push(`${file}:${line} <${m[1]}`);
			}
		}
	}
	return found.sort();
}

/**
 * The one site allowed to render an unnamed root: the wrapper's own `Autocomplete.Root`, whose input
 * `CommandInput` names from the `label` its callers pass to `Command`.
 */
const EXEMPT = ["packages/ui/src/command.tsx:68 <Autocomplete.Root"];

const FILES = [...sourceFiles(UI_SRC), ...sourceFiles(CONSOLE_ROOT)];

/** Path relative to the repo root, for readable failures. */
const rel = (f: string) => path.relative(REPO_ROOT, f);

const FINDINGS = FILES.flatMap((f) =>
	unnamedRoots(readFileSync(f, "utf8"), rel(f)),
);

describe("command-list root labels (#5824)", () => {
	it("reads all of apps/console and packages/ui/src, .ts and .tsx", () => {
		const read = FILES.map(rel);
		expect(read.length).toBeGreaterThan(1000);
		expect(read).toContain("packages/ui/src/command.tsx");
		for (const dir of ["app", "components", "lib", "hooks", "emails"]) {
			expect(read.some((f) => f.startsWith(`apps/console/${dir}/`))).toBe(true);
		}
		expect(read.some((f) => f.endsWith(".ts"))).toBe(true);
	});

	it("finds command-list roots to check (a scan that matches nothing proves nothing)", () => {
		const roots = FILES.flatMap((f) => {
			const source = readFileSync(f, "utf8");
			return [...rootTags(source).keys()].flatMap((tag) => [
				...source.matchAll(new RegExp(`<${escapeTag(tag)}(?=[\\s/>])`, "gu")),
			]);
		});
		expect(roots.length).toBeGreaterThanOrEqual(10);
	});

	it("names every command-list root's search", () => {
		expect(FINDINGS.filter((f) => !EXEMPT.includes(f))).toEqual([]);
	});

	it("still needs every exemption (a stale one would hide a new root at that line)", () => {
		expect(EXEMPT.filter((e) => !FINDINGS.includes(e))).toEqual([]);
	});

	it("imports Base UI's Autocomplete only through @repo/ui/command", () => {
		const importers = FILES.filter((f) => {
			const source = readFileSync(f, "utf8");
			return (
				/from\s+["']@base-ui\/react\/autocomplete["']/u.test(source) ||
				/import\s+(?:\*\s+as\s+[\w$]+|\{[^}]*\bAutocomplete\b[^}]*\})\s+from\s+["']@base-ui\/react["']/u.test(
					source,
				)
			);
		}).map(rel);
		expect(importers).toEqual(["packages/ui/src/command.tsx"]);
	});

	it("imports cmdk nowhere (#6145 removed it)", () => {
		const importers = FILES.filter((f) =>
			/from\s+["']cmdk["']/u.test(readFileSync(f, "utf8")),
		).map(rel);
		expect(importers).toEqual([]);
	});

	it("flags the shapes it is meant to flag, and only those", () => {
		const UI =
			'import { Command, CommandDialog, CommandInput } from "@repo/ui/command";\n';
		const cases: [string, number][] = [
			[`${UI}<Command>`, 1],
			[`${UI}<Command className={cn(a)} {...props} />`, 1],
			[`${UI}<Command label="">`, 1],
			[`${UI}<Command label={''}>`, 1],
			[`${UI}<Command label={undefined}>`, 1],
			[`${UI}<Command label={null}>`, 1],
			[`${UI}<Command label={ undefined }>`, 1],
			[`${UI}<Command\n  className={x}\n>`, 1],
			[`${UI}<CommandDialog open title="">`, 1],
			[`${UI}<CommandDialog open title={' '}>`, 1],
			[`${UI}<CommandDialog open title={undefined}>`, 1],
			[`${UI}<CommandDialog open onOpenChange={setOpen}>`, 0],
			[`${UI}<CommandDialog title={v ? \`Choose \${x}\` : "Add"}>`, 0],
			[`${UI}<Command label="Find project">`, 0],
			[`${UI}<Command label={title} className={cn(a)}>`, 0],
			[`${UI}<Command onKeyDown={(e) => e.key === ">"} label="Search">`, 0],
			[`${UI}<Command onKeyDown={() => a > b} label={purpose}>`, 0],
			[`${UI}<Command label={undefinedFallback}>`, 0],
			[`${UI}<CommandInput placeholder="x" />`, 0],
			// Aliases and namespaces are followed.
			['import { Command as Cmd } from "@repo/ui/command";\n<Cmd>', 1],
			[
				'import { Command as Cmd } from "@repo/ui/command";\n<Cmd label="Find">',
				0,
			],
			[
				'import {\n  CommandDialog as Palette,\n} from "@repo/ui/command";\n<Palette title="">',
				1,
			],
			[
				'import * as ui from "@repo/ui/command";\n<ui.Command className="x">',
				1,
			],
			['import * as ui from "@repo/ui/command";\n<ui.Command label="Find">', 0],
			[
				'import { Autocomplete } from "@base-ui/react/autocomplete";\n<Autocomplete.Root open>',
				1,
			],
			[
				'import { Autocomplete as AC } from "@base-ui/react";\n<AC.Root items={x}>',
				1,
			],
			['import * as AC from "@base-ui/react/autocomplete";\n<AC.Root>', 1],
			['import * as B from "@base-ui/react";\n<B.Autocomplete.Root>', 1],
			[
				'import { Autocomplete } from "@base-ui/react/autocomplete";\n<Autocomplete.Input />',
				0,
			],
			// A cmdk import is no longer a root here; the "imports cmdk nowhere" test owns it.
			['import { Command as Primitive } from "cmdk";\n<Primitive>', 0],
			['import { Command } from "./command";\n<Command>', 1],
			// Without an import there is no root, whatever the tag is called.
			["<Command>", 0],
			['import { Command } from "@/components/somewhere-else";\n<Command>', 0],
			['import type { Command } from "@repo/ui/command";\n<Command>', 0],
		];
		const flagged = cases.map(([src]) => [
			src,
			unnamedRoots(src, "case").length,
		]);
		expect(flagged).toEqual(cases);
	});
});
