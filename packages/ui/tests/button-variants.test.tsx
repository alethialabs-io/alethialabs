// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The destructive confirm must have a legible label in BOTH themes (#6108).
//
// THE DEFECT. Eight console confirms ("Delete project" among them) rendered `AlertDialogAction`
// with `className="bg-destructive text-destructive-foreground"` over the `default` variant.
// tailwind-merge read `text-destructive-foreground` as a text colour and dropped the variant's
// `text-primary-foreground`. No `--color-destructive-foreground` token exists, so the class emitted
// no CSS and the label inherited the dialog's `--foreground`. That is `--destructive`'s own grey in
// both themes, so prod showed lab(98.26) on lab(98.26) in dark.
//
// WHAT THIS DOES. It renders the REAL composition (an open AlertDialog with a destructive Action),
// reads the class lists jsdom produced, and resolves each colour utility through `tokens.css`'s
// `@theme` map and then the `:root` / `.dark` blocks. A utility with no token is a failure, not a
// skip. That is the exact shape of the defect. Contrast is computed from the resolved OKLCH
// lightness. The palette is achromatic, so Y = L³ exactly, and a chromatic value is refused rather
// than approximated.
//
// The last test feeds the old className back in and requires the resolver to reject it. That
// proves the instrument can go red on the defect it exists for.

import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as React from "react";
import { describe, expect, it } from "vitest";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogTitle,
} from "../src/alert-dialog";

const TOKENS = join(dirname(fileURLToPath(import.meta.url)), "../../brand/src/tokens.css");
const CSS = readFileSync(TOKENS, "utf8");

/** The top-level `--name: value` declarations of the block opened by `opener` in tokens.css. */
function block(opener: string): Map<string, string> {
	const start = CSS.indexOf(`\n${opener} {`);
	if (start < 0) throw new Error(`tokens.css has no "${opener} {" block`);
	const end = CSS.indexOf("\n}", start + 1);
	const body = CSS.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "");
	const out = new Map<string, string>();
	for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
	return out;
}

const THEME = block("@theme inline");
const ROOT = block(":root");
const THEMES: Record<"light" | "dark", Map<string, string>> = {
	light: ROOT,
	dark: new Map([...ROOT, ...block(".dark")]),
};

/** Resolve every `var(--x)` in `value` against one theme, recursively. */
function resolveVars(value: string, vars: Map<string, string>, depth = 0): string {
	if (depth > 20) throw new Error(`var() cycle resolving ${value}`);
	return value.replace(/var\((--[a-z0-9-]+)\)/g, (_, name: string) => {
		const v = vars.get(name);
		if (v === undefined) throw new Error(`${name} is not defined in this theme`);
		return resolveVars(v, vars, depth + 1);
	});
}

/** Tailwind `text-*` utilities that are NOT colours (sizes, alignment, wrapping). */
const TEXT_NON_COLOUR = /^text-(xs|sm|base|lg|[2-9]?xl|ui-[a-z0-9]+|display-[a-z0-9]+|left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/;

/**
 * The unconditional (no variant prefix) colour utility for `prefix` in a class list, resolved to a
 * value for `theme`. Returns `null` when the list sets none, and throws on a utility with no token.
 */
function colour(classes: string, prefix: "text" | "bg", theme: "light" | "dark"): string | null {
	const hits = classes
		.split(/\s+/)
		.filter((c) => c.startsWith(`${prefix}-`) && !c.includes(":") && !c.includes("["))
		.filter((c) => !(prefix === "text" && TEXT_NON_COLOUR.test(c)));
	if (hits.length > 1) throw new Error(`more than one ${prefix} colour: ${hits.join(" ")}`);
	if (hits.length === 0) return null;
	const name = hits[0].slice(prefix.length + 1);
	if (name === "transparent") return "transparent";
	const token = THEME.get(`--color-${name}`);
	if (token === undefined) {
		throw new Error(`${hits[0]} has no --color-${name} token, so it emits no CSS`);
	}
	return resolveVars(token, THEMES[theme]);
}

/** Relative luminance of an achromatic `oklch(L 0 0)` value: Y = L³. */
function luminance(value: string): number {
	const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+[\d.]+\s*\)$/.exec(value);
	if (!m) throw new Error(`not an opaque oklch() value: ${value}`);
	if (Number(m[3]) !== 0) throw new Error(`chromatic value, L³ would be an approximation: ${value}`);
	const l = Number(m[1]) / (m[2] ? 100 : 1);
	return l ** 3;
}

/** WCAG contrast ratio of two achromatic oklch values. */
function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/** Render an open dialog with one Action and return the popup's and the action's class lists. */
function confirmClasses(props: React.ComponentProps<typeof AlertDialogAction>): {
	popup: string;
	action: string;
} {
	render(
		<AlertDialog open>
			<AlertDialogContent>
				<AlertDialogTitle>Delete project?</AlertDialogTitle>
				<AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
				<AlertDialogAction {...props}>Delete project</AlertDialogAction>
			</AlertDialogContent>
		</AlertDialog>,
	);
	const popup = document.querySelector('[data-slot="alert-dialog-content"]');
	const action = document.querySelector('[data-slot="alert-dialog-action"]');
	if (!popup || !action) throw new Error("the dialog did not render its popup and action");
	return { popup: popup.className, action: action.className };
}

/** The label and the paint behind it, for one theme, falling through a transparent fill. */
function paint(classes: { popup: string; action: string }, theme: "light" | "dark") {
	const popupBg = colour(classes.popup, "bg", theme);
	const popupFg = colour(classes.popup, "text", theme) ?? resolveVars("var(--foreground)", THEMES[theme]);
	const ownBg = colour(classes.action, "bg", theme);
	const bg = ownBg === null || ownBg === "transparent" ? popupBg : ownBg;
	const fg = colour(classes.action, "text", theme) ?? popupFg;
	if (bg === null || bg === "transparent") throw new Error("no opaque background under the label");
	return { fg, bg };
}

describe("the destructive confirm (AlertDialogAction variant=destructive)", () => {
	it("reads the theme blocks out of tokens.css", () => {
		// Guards the parser: an empty map would make every lookup below throw for the wrong reason.
		expect(THEME.get("--color-foreground")).toBe("var(--foreground)");
		expect(THEMES.dark.get("--foreground")).toBe("var(--text-primary)");
		expect(THEMES.light.get("--text-primary")).not.toBe(THEMES.dark.get("--text-primary"));
	});

	it.each(["light", "dark"] as const)(
		"has a foreground token different from its background, ≥ 4.5:1, in the %s theme",
		(theme) => {
			const { fg, bg } = paint(confirmClasses({ variant: "destructive" }), theme);
			expect(fg).not.toBe(bg);
			expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
		},
	);

	it("rejects the old per-dialog className, which painted the label in a token that does not exist", () => {
		const classes = confirmClasses({
			className: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
		});
		expect(() => paint(classes, "dark")).toThrow(/text-destructive-foreground has no --color-destructive-foreground token/);
	});
});
