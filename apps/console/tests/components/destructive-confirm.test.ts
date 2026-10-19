// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// No console file may use a `*-foreground` colour utility that has no token behind it (#6108).
//
// THE DEFECT. Eight destructive confirms carried `text-destructive-foreground`. The design system
// defines no `--color-destructive-foreground`, so Tailwind emitted nothing for it. tailwind-merge
// still counted it as the button's text colour and dropped the real one. The label inherited the
// dialog's foreground, which is `--destructive`'s grey, and the "Delete project" button was blank.
// Neither tsc nor lint can see a class that compiles to nothing.
//
// THE RULE. A `<utility>-<name>-foreground` class must name a `--color-<name>-foreground` that
// exists in an `@theme` block of a stylesheet the console loads (`@repo/brand/tokens.css`, or the
// console's own `app/globals.css`). The token set is READ from those files, not typed here, so
// adding a token is enough to allow its class.
//
// THE SHARED CONFIRM. The third test renders the real `AlertDialogAction` from `@repo/ui` with
// `variant="destructive"`, which every console destructive confirm now goes through. It asserts that
// the rendered button carries exactly one text colour, and that the colour has a token. A sweep of
// the console's own files cannot see a phantom class introduced inside the shared variant.
//
// SCOPE, stated so a green run is not read as wider than it is: every .ts/.tsx under apps/console
// except node_modules, .next and tests. Only `*-foreground` names are checked, not every colour
// utility. Classes assembled from string fragments at runtime cannot be seen.

import { render } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogContent,
	AlertDialogTitle,
} from "@repo/ui/alert-dialog";

const CONSOLE = join(__dirname, "../..");
const STYLESHEETS = [
	join(CONSOLE, "../../packages/brand/src/tokens.css"),
	join(CONSOLE, "app/globals.css"),
];
const SKIP = new Set(["node_modules", ".next", "tests", "coverage", "e2e", "test-results"]);

/** Colour utilities that take a theme colour name. */
const CLASS =
	/(?<![\w-])(?:text|bg|border(?:-[xytrblse])?|ring|ring-offset|outline|fill|stroke|decoration|caret|accent|placeholder|divide|shadow|from|via|to)-([a-z0-9-]*-foreground|foreground)(?![\w-])/g;

/** Every `--color-*` name declared inside an `@theme` block of the console's stylesheets. */
function themeColours(): Set<string> {
	const names = new Set<string>();
	for (const file of STYLESHEETS) {
		const css = readFileSync(file, "utf8");
		for (const m of css.matchAll(/@theme[^{]*\{([\s\S]*?)\n\}/g)) {
			for (const d of m[1].matchAll(/--color-([a-z0-9-]+)\s*:/g)) names.add(d[1]);
		}
	}
	return names;
}

/** Every .ts/.tsx source file under `dir`, skipping build output and tests. */
function sources(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (SKIP.has(e.name)) continue;
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...sources(p));
		else if (/\.tsx?$/.test(e.name)) out.push(p);
	}
	return out;
}

/** `file:line class` for every `*-foreground` utility in `text` whose token is not in `known`. */
function phantoms(text: string, known: Set<string>, file = "<input>"): string[] {
	const found: string[] = [];
	text.split("\n").forEach((line, i) => {
		for (const m of line.matchAll(CLASS)) {
			if (!known.has(m[1])) found.push(`${file}:${i + 1} ${m[0]}`);
		}
	});
	return found;
}

describe("console *-foreground colour utilities", () => {
	const known = themeColours();

	it("reads the theme colours out of the stylesheets", () => {
		// Guards the derivation: an empty set would make every class a phantom; a set missing the
		// common names would mean the @theme regex stopped matching.
		expect(known.has("foreground")).toBe(true);
		expect(known.has("muted-foreground")).toBe(true);
		expect(known.has("primary-foreground")).toBe(true);
	});

	it("finds the class this test exists for", () => {
		// The instrument must be able to go red: the exact className #6108 removed.
		const old = 'className="bg-destructive text-destructive-foreground hover:bg-destructive/90"';
		expect(phantoms(old, known)).toEqual(["<input>:1 text-destructive-foreground"]);
		expect(phantoms("hover:text-destructive-foreground/80", known)).toHaveLength(1);
		expect(phantoms("text-muted-foreground border-l-foreground", known)).toEqual([]);
	});

	it("renders the shared destructive confirm with one text colour, and that colour has a token", () => {
		render(
			createElement(
				AlertDialog,
				{ open: true },
				createElement(
					AlertDialogContent,
					null,
					createElement(AlertDialogTitle, null, "Delete project?"),
					createElement(AlertDialogAction, { variant: "destructive" }, "Delete project"),
				),
			),
		);
		const action = document.querySelector('[data-slot="alert-dialog-action"]');
		if (!action) throw new Error("the shared confirm did not render");
		const classes = action.className;
		expect(phantoms(classes, known)).toEqual([]);
		const textColours = classes
			.split(/\s+/)
			.filter((c) => /^text-/.test(c) && known.has(c.slice("text-".length)));
		expect(textColours).toEqual(["text-foreground"]);
	});

	it("names a token for every *-foreground utility under apps/console", () => {
		const files = sources(CONSOLE);
		expect(files.length).toBeGreaterThan(100);
		const found = files.flatMap((f) => phantoms(readFileSync(f, "utf8"), known, f.slice(CONSOLE.length + 1)));
		expect(found).toEqual([]);
	});
});
