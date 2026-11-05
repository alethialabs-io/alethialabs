// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The console's animations are plain CSS in app/globals.css (#6147 replaced the `motion` library
// with them). These pin two things. First, that every animation which MOVES or RESIZES something
// has a `prefers-reduced-motion: reduce` rule for every class that runs it — a fade alone is not
// motion and needs none. Second, that each class a component names for its animation is defined,
// because a class with no rule behind it renders as no animation and fails nothing else.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Shimmer } from "@/components/ai-elements/shimmer";

/** The slice of a parsed postcss node this test reads. */
interface CssNode {
	type: string;
	name?: string;
	params?: string;
	selector?: string;
	prop?: string;
	value?: string;
	nodes?: CssNode[];
}
/** postcss, taken from @tailwindcss/postcss's own dependency (see tests/styles/streamdown-source.test.ts). */
const postcss: { parse: (css: string) => CssNode } = createRequire(
	require.resolve("@tailwindcss/postcss"),
)("postcss");

const globalsPath = path.resolve(__dirname, "../../app/globals.css");

/** A `transition` on one of these moves or resizes the element. */
const MOVING_TRANSITION = /\b(all|width|height|inline-size|block-size|transform|translate|scale|rotate|top|right|bottom|left|inset|margin[\w-]*|background-position)\b/;

/** Whether an at-rule is the reduced-motion media query. */
function isReduceMedia(node: CssNode): boolean {
	return (
		node.type === "atrule" &&
		node.name === "media" &&
		/prefers-reduced-motion:\s*reduce/.test(node.params ?? "")
	);
}

/** A rule's selector split into its comma-separated selectors. */
function selectorsOf(rule: CssNode): string[] {
	return (rule.selector ?? "").split(",").map((s) => s.trim());
}

/** The declarations directly inside a rule. */
function declsOf(rule: CssNode): { prop: string; value: string }[] {
	return (rule.nodes ?? []).flatMap((n) =>
		n.type === "decl" && n.prop && n.value !== undefined ? [{ prop: n.prop, value: n.value }] : [],
	);
}

/**
 * Every animation in a stylesheet that moves something without a reduced-motion rule for the class
 * running it, as `selector: reason` lines. Empty means every one is covered.
 */
function unguardedMotion(css: string): string[] {
	const root = postcss.parse(css);
	/** keyframe name → the properties it animates */
	const keyframes = new Map<string, Set<string>>();
	const normalRules: CssNode[] = [];
	const reduceRules: CssNode[] = [];

	const walk = (node: CssNode, inReduce: boolean) => {
		for (const child of node.nodes ?? []) {
			if (child.type === "atrule" && child.name === "keyframes") {
				const props = new Set<string>();
				for (const step of child.nodes ?? []) for (const d of declsOf(step)) props.add(d.prop);
				keyframes.set((child.params ?? "").trim(), props);
			} else if (child.type === "rule") {
				(inReduce ? reduceRules : normalRules).push(child);
			} else if (child.type === "atrule") {
				walk(child, inReduce || isReduceMedia(child));
			}
		}
	};
	walk(root, false);

	const moves = (name: string) => [...(keyframes.get(name) ?? [])].some((p) => p !== "opacity");
	const keyframesIn = (value: string) =>
		value.split(/[\s,]+/).filter((token) => keyframes.has(token));

	/** The reduced-motion declarations for one selector, merged across every rule that names it. */
	const reduced = (selector: string) =>
		reduceRules.filter((r) => selectorsOf(r).includes(selector)).flatMap(declsOf);

	const findings: string[] = [];
	for (const rule of normalRules) {
		for (const { prop, value } of declsOf(rule)) {
			if (prop === "animation" || prop === "animation-name") {
				const moving = keyframesIn(value).filter(moves);
				if (moving.length === 0) continue;
				for (const selector of selectorsOf(rule)) {
					const stilled = reduced(selector).some(
						(d) =>
							(d.prop === "animation" || d.prop === "animation-name") &&
							(d.value.trim() === "none" ||
								(keyframesIn(d.value).length > 0 && !keyframesIn(d.value).some(moves))),
					);
					if (!stilled) findings.push(`${selector}: animation ${moving.join(", ")} moves with no reduced-motion rule`);
				}
			}
			if ((prop === "transition" || prop === "transition-property") && MOVING_TRANSITION.test(value)) {
				for (const selector of selectorsOf(rule)) {
					const stilled = reduced(selector).some(
						(d) => (d.prop === "transition" || d.prop === "transition-property") && d.value.trim() === "none",
					);
					if (!stilled) findings.push(`${selector}: transition "${value}" moves with no reduced-motion rule`);
				}
			}
		}
	}
	return findings;
}

describe("app/globals.css animations under prefers-reduced-motion", () => {
	it("gives every moving animation and transition a reduced-motion rule", async () => {
		const css = await readFile(globalsPath, "utf8");
		expect(unguardedMotion(css)).toEqual([]);
	});

	// The checker itself, against stylesheets whose answer is known — so an empty list above means
	// "covered", not "the checker found nothing to look at".
	it("reports a moving keyframe, a moving transition and a half-covered selector list", () => {
		const css = `
			@keyframes slide { from { transform: translateY(4px); opacity: 0; } }
			@keyframes fade { from { opacity: 0; } }
			.a, .b { animation: slide 180ms ease-out; }
			.c { transition: width 200ms ease-out; }
			.d { animation: fade 150ms; }
			@media (prefers-reduced-motion: reduce) { .a { animation-name: fade; } }
		`;
		expect(unguardedMotion(css)).toEqual([
			".b: animation slide moves with no reduced-motion rule",
			'.c: transition "width 200ms ease-out" moves with no reduced-motion rule',
		]);
	});

	it("accepts animation: none, a fade fallback and transition: none as the reduced form", () => {
		const css = `
			@keyframes slide { from { transform: translateY(4px); } }
			@keyframes fade { from { opacity: 0; } }
			.a { animation: slide 1s; } .b { animation: slide 1s; } .c { transition: width 1s; }
			@media (prefers-reduced-motion: reduce) {
				.a { animation: none; } .b { animation-name: fade; } .c { transition: none; }
			}
		`;
		expect(unguardedMotion(css)).toEqual([]);
	});

	// Each class a component names for its animation (agent-chat, elench-panel, shimmer,
	// workspace-rail, design-project-canvas). A typo on either side renders as no animation.
	it.each([
		["agent-message-in", "animation"],
		["agent-thinking-in", "animation"],
		["elench-panel-in", "animation"],
		["workspace-rail", "transition"],
		["workspace-card-in", "animation"],
		["canvas-env-in", "animation"],
		["shimmer-sweep", "animation"],
	])("defines .%s with a %s", async (name, prop) => {
		const root = postcss.parse(await readFile(globalsPath, "utf8"));
		const defined = (root.nodes ?? []).some(
			(n) =>
				n.type === "rule" &&
				selectorsOf(n).includes(`.${name}`) &&
				declsOf(n).some((d) => d.prop === prop),
		);
		expect(defined).toBe(true);
	});

	// The shimmer's class goes through `cn` (tailwind-merge), which drops any class it reads as a
	// conflicting utility — a `text-*` name would be read as a colour and lost beside
	// `text-transparent`. So the class is pinned on the RENDERED span, not just in the source.
	it("renders the shimmer with its keyframe class and its per-pass duration", () => {
		const html = renderToStaticMarkup(createElement(Shimmer, { duration: 1.5, children: "Thinking..." }));
		expect(html).toMatch(/class="[^"]*\bshimmer-sweep\b/);
		expect(html).toContain("--shimmer-duration:1.5s");
	});
});
