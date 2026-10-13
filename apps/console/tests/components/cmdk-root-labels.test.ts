// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GUARD (#5824): every cmdk root in `packages/ui/src` and `apps/console` names its search.
//
// cmdk names its search input through `aria-labelledby` → its own hidden `<label cmdk-label>`, whose
// text is the root's `label` prop. A root without one renders an input whose name computes to "" —
// and an empty `aria-labelledby` target still beats the placeholder, so the search is an unnamed
// combobox with its placeholder visible inside it. Every root in the repo shipped that way until
// #5803 and #5824.
//
// WHAT THIS READS: every `.ts` / `.tsx` file under `packages/ui/src` and `apps/console`, except
// `node_modules`, `.next` and `coverage` (build output), the `tests`, `e2e` and `__tests__` trees,
// and `*.test.*` / `*.spec.*` / `*.stories.*` files (they render roots to exercise behaviour).
//
// WHAT A ROOT IS: derived from each file's IMPORTS, not from a tag name. A local binding imported
// from `@repo/ui/command` (or `./command` inside packages/ui) as `Command` or `CommandDialog`, or
// from `cmdk` as `Command`, `CommandRoot` or `CommandDialog` — under any alias, and through a
// namespace import (`<ui.Command>`) — plus cmdk's `<X.Dialog>` member. So `import { Command as Cmd }`
// followed by an unnamed `<Cmd>` is caught.
//
// WHAT NAMED MEANS:
//  - A `Command` root needs `label=` with a value that is not blank: absent, `""`, `{""}`, `{null}`
//    and `{undefined}` all fail. A `{...spread}` alone fails too — it hides whether a label is
//    passed. Any OTHER expression counts as set: a text match cannot know that `{maybeEmpty}` is
//    empty at runtime. The rendered-name half lives in tests/components/cmdk-search-names.test.tsx
//    and packages/ui/tests/command.test.tsx.
//  - `@repo/ui`'s `CommandDialog` forwards its `title` (default "Command Palette") as the label, so
//    it fails only on a blank `title`.
//  - `cmdk` may be imported only by `packages/ui/src/command.tsx`; anything else bypasses the wrapper.
//
// WHERE IT STOPS: it does not follow a component that re-wraps a root under a NEW component and is
// then used without a label. `PromptInputCommand` is such a wrapper and makes `label` a required
// prop for that reason. The one exempt site is the `Command` wrapper itself in
// `packages/ui/src/command.tsx`, which forwards `label` from its callers through `{...props}`; the
// exemption is checked in both directions below.

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

/**
 * The JSX tag names in `source` that render a cmdk root, mapped to the prop that names it. Derived
 * from the file's import declarations, so an alias or a namespace import is followed.
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
		const fromCmdk = spec === "cmdk";
		if (!fromUi && !fromCmdk) continue;
		/** Exported name → the prop that names it, for this module. */
		const roots: Record<string, NameProp> = fromUi
			? { Command: "label", CommandDialog: "title" }
			: { Command: "label", CommandRoot: "label", CommandDialog: "label" };
		const ns = /\*\s+as\s+([\w$]+)/u.exec(clause);
		if (ns) {
			for (const [name, prop] of Object.entries(roots))
				tags.set(`${ns[1]}.${name}`, prop);
			if (fromCmdk) tags.set(`${ns[1]}.Command.Dialog`, "label");
		}
		const named = /\{([^}]*)\}/u.exec(clause);
		for (const part of named ? named[1].split(",") : []) {
			const [imported, local] = part
				.trim()
				.replace(/^type\s+/u, "")
				.split(/\s+as\s+/u);
			if (!imported || part.trim().startsWith("type ")) continue;
			const prop = roots[imported];
			if (!prop) continue;
			const binding = local ?? imported;
			tags.set(binding, prop);
			if (fromCmdk && imported === "Command")
				tags.set(`${binding}.Dialog`, "label");
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

/** `file:line <Tag` for every cmdk root in `source` that does not name its search. */
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

/** The one site allowed to render an unnamed root: the wrapper that forwards `label` from callers. */
const EXEMPT = ["packages/ui/src/command.tsx:25 <CommandPrimitive"];

const FILES = [...sourceFiles(UI_SRC), ...sourceFiles(CONSOLE_ROOT)];

/** Path relative to the repo root, for readable failures. */
const rel = (f: string) => path.relative(REPO_ROOT, f);

const FINDINGS = FILES.flatMap((f) =>
	unnamedRoots(readFileSync(f, "utf8"), rel(f)),
);

describe("cmdk root labels (#5824)", () => {
	it("reads all of apps/console and packages/ui/src, .ts and .tsx", () => {
		const read = FILES.map(rel);
		expect(read.length).toBeGreaterThan(1000);
		expect(read).toContain("packages/ui/src/command.tsx");
		for (const dir of ["app", "components", "lib", "hooks", "emails"]) {
			expect(read.some((f) => f.startsWith(`apps/console/${dir}/`))).toBe(true);
		}
		expect(read.some((f) => f.endsWith(".ts"))).toBe(true);
	});

	it("finds cmdk roots to check (a scan that matches nothing proves nothing)", () => {
		const roots = FILES.flatMap((f) => {
			const source = readFileSync(f, "utf8");
			return [...rootTags(source).keys()].flatMap((tag) => [
				...source.matchAll(new RegExp(`<${escapeTag(tag)}(?=[\\s/>])`, "gu")),
			]);
		});
		expect(roots.length).toBeGreaterThanOrEqual(10);
	});

	it("names every cmdk root's search", () => {
		expect(FINDINGS.filter((f) => !EXEMPT.includes(f))).toEqual([]);
	});

	it("still needs every exemption (a stale one would hide a new root at that line)", () => {
		expect(EXEMPT.filter((e) => !FINDINGS.includes(e))).toEqual([]);
	});

	it("imports cmdk only through @repo/ui/command", () => {
		const importers = FILES.filter((f) =>
			/from\s+["']cmdk["']/u.test(readFileSync(f, "utf8")),
		).map(rel);
		expect(importers).toEqual(["packages/ui/src/command.tsx"]);
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
			['import { Command as Primitive } from "cmdk";\n<Primitive>', 1],
			[
				'import { Command as Primitive } from "cmdk";\n<Primitive.Dialog open>',
				1,
			],
			['import { CommandRoot } from "cmdk";\n<CommandRoot label="Find">', 0],
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
