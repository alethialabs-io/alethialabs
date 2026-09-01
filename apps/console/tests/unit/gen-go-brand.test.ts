// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the brand → Go projection generator.
 *
 * The thing actually worth testing here is the REFUSAL. `gen-go-brand.ts` claims that a token
 * added to `tokens.css` with no projection entry cannot reach a green build; a guard whose
 * "nothing found" branch is indistinguishable from "nothing wrong" is worth nothing, so the
 * cases below drive the failing branch with hand-written inputs and assert on WHICH token is
 * named, not on a count.
 *
 * Two things are deliberately NOT re-implemented here:
 *
 *   - the CSS scanner is exercised against hand-written stylesheets whose declarations are
 *     listed by hand. A test that re-derived the expected set with the same regex would agree
 *     with any bug it shared;
 *   - the OKLCH→sRGB arithmetic is checked against `packages/brand/src/ramp-srgb.ts` — a
 *     separately written transcription of the same seventeen steps, kept for the surfaces that
 *     provably cannot read a custom property (email, Stripe Elements, `next/og`), and itself
 *     held to `tokens.css` by a third implementation of the transfer function in
 *     `scripts/check-ramp-transcription.mjs`. Agreement between implementations nobody wrote
 *     from the other is evidence; comparing the generator against its own output would not be.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RAMP } from "@repo/brand/ramp-srgb";
import { describe, expect, it } from "vitest";

import { PROJECTIONS, tailwindBinding, type Projection } from "../../scripts/lib/brand-projection";
import { carriesAlpha, colorPair, flatten, hex, oklchToRgba, resolveColor } from "../../scripts/lib/brand-resolve";
import { parseDeclarations, stripComments, tokenCensus } from "../../scripts/lib/css-tokens";
import {
	alignRows,
	auditColorClaims,
	auditProjections,
	build,
	identFor,
	millis,
	pascal,
	themeMaps,
} from "../../scripts/gen-go-brand";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS_CSS = resolve(HERE, "../../../../packages/brand/src/tokens.css");
const css = readFileSync(TOKENS_CSS, "utf8");

describe("the CSS declaration scanner", () => {
	it("finds every declaration on a line that carries three", () => {
		// This is the exact shape the line-anchored grep it replaces gets wrong: the two
		// breakpoint blocks in tokens.css put three display sizes on one physical line.
		const sheet = ":root { --a: 1px; --b: 2px; --c: 3px; }";
		expect(parseDeclarations(sheet).map((d) => d.name)).toEqual(["--a", "--b", "--c"]);
	});

	it("does not mistake a var() USE for a declaration", () => {
		const sheet = ".x { color: var(--text-primary); border-color: var(--border, currentColor); }";
		expect(parseDeclarations(sheet)).toEqual([]);
	});

	it("keeps a declaration whose block omits the final semicolon", () => {
		expect(parseDeclarations(":root { --a: 1px }").map((d) => d.name)).toEqual(["--a"]);
	});

	it("reads a declaration through a comment that interrupts it", () => {
		const decls = parseDeclarations(":root { --dur-1: /* the fastest */ 120ms; }");
		expect(decls).toHaveLength(1);
		expect(decls[0].value).toBe("120ms");
	});

	it("treats braces inside a string as data, not as block structure", () => {
		const sheet = `.x { content: "}{"; } :root { --a: 1px; }`;
		expect(parseDeclarations(sheet).map((d) => d.name)).toEqual(["--a"]);
	});

	it("keeps commas inside a parenthesised value with the value", () => {
		const decls = parseDeclarations(":root { --ease: cubic-bezier(0.2, 0, 0, 1); }");
		expect(decls[0].value).toBe("cubic-bezier(0.2, 0, 0, 1)");
	});

	it("marks the theme, root, dark and media scopes apart", () => {
		const sheet = `
			@theme inline { --t: 1; }
			:root { --r: 2; }
			.dark { --r: 3; }
			.vx-clamp { --l: 4; }
			@media (max-width: 620px) { :root { --r: 5; } }
		`;
		expect(parseDeclarations(sheet).map((d) => [d.name, d.scope, d.inMedia])).toEqual([
			["--t", "theme", false],
			["--r", "root", false],
			["--r", "dark", false],
			["--l", "local", false],
			["--r", "root", true],
		]);
	});

	it("stops at an unterminated comment rather than reading past it", () => {
		// A browser swallows the rest of the sheet too. Mirroring that keeps the census honest:
		// tokens that the browser never applies must not be reported as projectable.
		expect(stripComments(":root { --a: 1; } /* oops").trim()).toBe(":root { --a: 1; }");
	});

	it("censuses each name once, in first-declaration order", () => {
		const sheet = ":root { --b: 1; --a: 2; } .dark { --a: 3; --c: 4; }";
		expect(tokenCensus(sheet)).toEqual(["--b", "--a", "--c"]);
	});
});

describe("OKLCH to sRGB", () => {
	it("reproduces every step of the hand-computed ramp in packages/brand/src/ramp-srgb.ts", () => {
		const { light } = themeMaps(parseDeclarations(css));
		const generated: Record<string, string> = {};
		for (const [token, key] of [
			["--gray-0", "gray0"],
			["--gray-25", "gray25"],
			["--gray-50", "gray50"],
			["--gray-100", "gray100"],
			["--gray-200", "gray200"],
			["--gray-300", "gray300"],
			["--gray-400", "gray400"],
			["--gray-500", "gray500"],
			["--gray-600", "gray600"],
			["--gray-700", "gray700"],
			["--gray-800", "gray800"],
			["--gray-900", "gray900"],
			["--gray-950", "gray950"],
			["--gray-1000", "gray1000"],
			["--gray-1050", "gray1050"],
			["--gray-1100", "gray1100"],
			["--black", "black"],
		] as const) {
			generated[key] = hex(resolveColor(token, light));
		}
		expect(generated).toEqual({ ...RAMP });
	});

	it("refuses a chroma it cannot convert exactly rather than dropping the hue", () => {
		expect(() => oklchToRgba("oklch(0.6 0.2 250)")).toThrow(/chroma 0\.2/);
	});

	it("parses the alpha a token declares", () => {
		expect(oklchToRgba("oklch(1 0 0 / 0.17)").a).toBeCloseTo(0.17, 10);
		expect(oklchToRgba("oklch(1 0 0)").a).toBe(1);
	});

	it("flattens alpha onto the ground in sRGB, the way a browser paints it", () => {
		// 0.17 × 255 + 0.83 × 7 = 49.16 → 0x31. Hand-computed, not read off the generator.
		const fg = oklchToRgba("oklch(1 0 0 / 0.17)");
		const bg = oklchToRgba("oklch(0.130 0 0)");
		expect(hex(flatten(fg, bg))).toBe("#313131");
	});

	it("follows a var() chain to the value at the end of it", () => {
		const map = new Map([
			["--a", "var(--b)"],
			["--b", "var(--c)"],
			["--c", "oklch(0.205 0 0)"],
		]);
		expect(hex(resolveColor("--a", map))).toBe("#171717");
	});

	it("names the cycle rather than recursing forever", () => {
		const map = new Map([
			["--a", "var(--b)"],
			["--b", "var(--a)"],
		]);
		expect(() => resolveColor("--a", map)).toThrow(/cycle/);
	});

	it("resolves `transparent` to the ground it is painted on", () => {
		const light = new Map([
			["--x", "transparent"],
			["--background", "oklch(0.985 0 0)"],
		]);
		expect(colorPair("--x", light, light).light).toBe("#fafafa");
	});
});

/** A stylesheet plus a table, for driving the audit's failing branches. */
function audit(sheet: string, table: Record<string, Projection>): string[] {
	return auditProjections(tokenCensus(sheet), parseDeclarations(sheet), table);
}

describe("the no-silent-gap guard", () => {
	it("names a declared token that has no projection", () => {
		const problems = audit(":root { --a: 1px; --brand-new: 2px; }", {
			"--a": { kind: "none", why: "no analogue" },
		});
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("--brand-new");
		expect(problems[0]).toContain("has no projection");
	});

	it("names a projection whose token no longer exists", () => {
		const problems = audit(":root { --a: 1px; }", {
			"--a": { kind: "none", why: "no analogue" },
			"--gone": { kind: "none", why: "no analogue" },
		});
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("--gone");
		expect(problems[0]).toContain("no longer declared");
	});

	it("refuses a lossy entry that does not say why", () => {
		const problems = audit(":root { --a: 1px; }", {
			"--a": { kind: "lossy", port: "border", to: "BorderSquare", why: "  " },
		});
		expect(problems).toEqual([expect.stringContaining("--a is marked lossy with an empty reason")]);
	});

	it("refuses a lossy entry that names no collapse target", () => {
		const problems = audit(":root { --a: 1px; }", {
			"--a": { kind: "lossy", port: "border", why: "it collapses" },
		});
		expect(problems).toEqual([expect.stringContaining("names no collapse target")]);
	});

	it("refuses a none entry that does not say why", () => {
		const problems = audit(":root { --a: 1px; }", { "--a": { kind: "none", why: "" } });
		expect(problems).toEqual([expect.stringContaining("'none' is an answer only when it says why")]);
	});

	it("refuses an exact entry with an empty note", () => {
		const problems = audit(":root { --a: 1px; }", { "--a": { kind: "exact", port: "layer", note: "" } });
		expect(problems).toEqual([expect.stringContaining("marked exact with an empty note")]);
	});

	it("passes a stylesheet every one of whose tokens is decided", () => {
		// The green branch, driven explicitly — so "no problems" is a result the test has seen
		// this function produce, not an assumption about the shape of its output.
		expect(
			audit(":root { --a: 1px; --b: 2px; }", {
				"--a": { kind: "none", why: "no analogue" },
				"--b": { kind: "exact", port: "layer", note: "a rung" },
			}),
		).toEqual([]);
	});
});

describe("the --color-* structural rule", () => {
	const decls = (sheet: string) => parseDeclarations(sheet);

	it("absorbs a binding that is exactly var(--declared-token)", () => {
		const sheet = "@theme inline { --color-surface: var(--surface); } :root { --surface: oklch(1 0 0); }";
		const p = tailwindBinding("--color-surface", decls(sheet), new Set(tokenCensus(sheet)));
		expect(p?.kind).toBe("none");
		expect(p?.kind === "none" ? p.why : "").toContain("--surface");
	});

	it("REFUSES a --color-* token carrying a value of its own", () => {
		// The case a bare startsWith("--color-") wildcard would have swallowed: a hue enters the
		// grayscale palette and nobody is asked what the CLI does with it.
		const sheet = "@theme inline { --color-brand-blue: oklch(0.6 0.2 250); }";
		expect(tailwindBinding("--color-brand-blue", decls(sheet), new Set(tokenCensus(sheet)))).toBeNull();
	});

	it("REFUSES a binding that points at a token nothing declares", () => {
		const sheet = "@theme inline { --color-ghost: var(--ghost); }";
		expect(tailwindBinding("--color-ghost", decls(sheet), new Set(tokenCensus(sheet)))).toBeNull();
	});

	it("does not apply to a token outside the --color-* namespace", () => {
		const sheet = ":root { --alias: var(--surface); --surface: oklch(1 0 0); }";
		expect(tailwindBinding("--alias", decls(sheet), new Set(tokenCensus(sheet)))).toBeNull();
	});
});

describe("the exact/lossy claim about a colour is checked against the colour", () => {
	const light = new Map([
		["--background", "oklch(0.985 0 0)"],
		["--solid", "oklch(0.5 0 0)"],
		["--washed", "oklch(0 0 0 / 0.4)"],
	]);

	it("flags a colour marked exact whose value carries alpha", () => {
		const p: Projection = { kind: "exact", port: "color", note: "an ink" };
		const problems = auditColorClaims([{ name: "--washed", projection: p, ident: "ColorWashed" }], light, light);
		expect(problems).toEqual([expect.stringContaining("--washed is marked exact but its value carries alpha")]);
	});

	it("flags a colour marked lossy that loses nothing", () => {
		const p: Projection = { kind: "lossy", port: "color", why: "composited" };
		const problems = auditColorClaims([{ name: "--solid", projection: p, ident: "ColorSolid" }], light, light);
		expect(problems).toEqual([expect.stringContaining("resolves opaque in both themes")]);
	});

	it("accepts each claim when it matches its value", () => {
		expect(
			auditColorClaims(
				[
					{ name: "--solid", projection: { kind: "exact", port: "color", note: "an ink" }, ident: "ColorSolid" },
					{ name: "--washed", projection: { kind: "lossy", port: "color", why: "composited" }, ident: "ColorWashed" },
				],
				light,
				light,
			),
		).toEqual([]);
	});
});

describe("Go rendering details", () => {
	it("pascal-cases a token without splitting its digits off", () => {
		expect(pascal("--gray-1050")).toBe("Gray1050");
		expect(pascal("--text-display-lg")).toBe("TextDisplayLg");
	});

	it("names a layer constant without repeating the z", () => {
		expect(identFor("--z-sticky-head", { kind: "exact", port: "layer", note: "x" })).toBe("LayerStickyHead");
	});

	it("names a lossy collapse after its target, not after the token", () => {
		// Six radii must not produce six constant names — that would hide the collapse.
		const to = { kind: "lossy", port: "border", to: "BorderSquare", why: "x" } as const;
		expect(identFor("--radius-sm", to)).toBe("BorderSquare");
		expect(identFor("--radius-md", to)).toBe("BorderSquare");
	});

	it("refuses a duration it cannot read rather than emitting a stopped tick", () => {
		expect(() => millis("0.5s")).toThrow(/whole number of milliseconds/);
		expect(millis("260ms")).toBe(260);
	});

	it("pads columns the way gofmt does, and leaves the last column alone", () => {
		expect(
			alignRows([
				["a", "=", "1", "// one"],
				["bbb", "=", "22", "// two"],
			]),
		).toBe(["\ta   = 1  // one", "\tbbb = 22 // two"].join("\n"));
	});
});

describe("the committed table against the live stylesheet", () => {
	it("decides every token declared in packages/brand/src/tokens.css", () => {
		const { problems, tokens } = build(css);
		expect(problems).toEqual([]);
		expect(tokens.length).toBe(tokenCensus(css).length);
	});

	it("keeps every kind populated — an all-exact or all-none table would mean the vocabulary is unused", () => {
		const { tokens } = build(css);
		const kinds = new Set(tokens.map((t) => t.projection.kind));
		expect([...kinds].sort()).toEqual(["exact", "lossy", "none"]);
	});

	it("marks the ten chart tokens none, with the tripwire the next chart has to trip over", () => {
		const { tokens } = build(css);
		const charts = tokens.filter((t) => /^--(color-)?chart-\d+$/.test(t.name));
		expect(charts.map((t) => t.name).sort()).toEqual([
			"--chart-1",
			"--chart-2",
			"--chart-3",
			"--chart-4",
			"--chart-5",
			"--color-chart-1",
			"--color-chart-2",
			"--color-chart-3",
			"--color-chart-4",
			"--color-chart-5",
		]);
		for (const c of charts) expect(c.projection.kind).toBe("none");
		// The five that carry the ramp itself say what the first chart must do; the five
		// Tailwind bindings point at them.
		for (const c of charts.filter((t) => !t.name.startsWith("--color-"))) {
			expect(c.projection.kind === "none" ? c.projection.why : "").toContain("TRIPWIRE");
		}
	});

	it("projects --tracking-eyebrow and refuses --tracking-display, for opposite-signed reasons", () => {
		expect(PROJECTIONS["--tracking-eyebrow"].kind).toBe("exact");
		const display = PROJECTIONS["--tracking-display"];
		expect(display.kind).toBe("none");
		expect(display.kind === "none" ? display.why : "").toContain("negative");
	});

	it("names every token that carries alpha, and marks each of them lossy or none", () => {
		// Named, not counted. Ten tokens declare a wash; nine more inherit one through a
		// Tailwind binding. NONE of them may be `exact` — a terminal cell has no alpha — and
		// the sweep is written out so that a token GAINING a wash later shows up here as a
		// list that changed rather than as a number that moved.
		const { light, dark } = themeMaps(parseDeclarations(css));
		const alpha = tokenCensus(css).filter((t) => {
			try {
				return carriesAlpha(t, light, dark);
			} catch {
				return false; // not a colour token at all
			}
		});
		expect(alpha.sort()).toEqual([
			"--border",
			"--border-faint",
			"--border-strong",
			"--color-border",
			"--color-border-faint",
			"--color-border-strong",
			"--color-input",
			"--color-input-fill",
			"--color-input-fill-hover",
			"--color-overlay",
			"--color-ring-invalid",
			"--color-sidebar-border",
			"--input",
			"--input-fill",
			"--input-fill-hover",
			"--overlay",
			"--ring-invalid",
			"--sidebar-border",
			"--signal-critical-surface",
		]);
		for (const token of alpha) {
			expect(PROJECTIONS[token]?.kind ?? "none").not.toBe("exact");
		}
	});
});
