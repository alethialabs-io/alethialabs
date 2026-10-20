// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import { describe, expect, it } from "vitest";

/**
 * postcss, taken from @tailwindcss/postcss's own dependency rather than declared by the console:
 * the plugin is built against it, and the console's build reaches it the same way, through Next.
 */
type Processor = {
  process: (css: string, opts: { from: string }) => Promise<{ css: string }>;
};
/** The slice of a parsed postcss rule this test reads. */
type ParsedRule = {
  selector: string;
  parent: { type: string } | undefined;
  walkDecls: (visit: (decl: { prop: string; value: string }) => void) => void;
};
type PostcssModule = ((plugins: unknown[]) => Processor) & {
  parse: (css: string) => { walkRules: (visit: (rule: ParsedRule) => void) => void };
};
const fromTailwindPostcss = createRequire(require.resolve("@tailwindcss/postcss"));
const postcss: PostcssModule = fromTailwindPostcss("postcss");

const consoleDir = path.resolve(__dirname, "../..");
const globalsPath = path.join(consoleDir, "app/globals.css");

/** Compiles the console's real globals.css the way `next build` does: @tailwindcss/postcss, rooted at apps/console. */
async function compileGlobals(): Promise<string> {
  const source = await readFile(globalsPath, "utf8");
  const result = await postcss([tailwindcss({ base: consoleDir })]).process(source, {
    from: globalsPath,
  });
  return result.css;
}

/** True when the compiled CSS carries a rule for exactly this utility class (not a variant of it). */
function hasUtility(css: string, className: string): boolean {
  return new RegExp(`(^|[\\s,}])\\.${className}\\s*\\{`, "m").test(css);
}

/**
 * The classes under test, assembled from parts so that this file does not name them. Tailwind scans
 * every source file under apps/console, tests included: written out whole here, they would be
 * generated BECAUSE this test names them, and the test would pass with the @source line deleted.
 */
const STREAMDOWN_ONLY = [
  ["list", "disc"],
  ["list", "inside"],
  ["wrap", "anywhere"],
].map((parts) => parts.join("-"));

/**
 * #6194. These classes appear nowhere in console source (a decimal list does, in the canvas, so it
 * is not a witness); streamdown puts them on the lists and text it renders. They exist in the
 * console's CSS only if globals.css points Tailwind at streamdown's dist. Without them, preflight's
 * `list-style: none` wins and a chat list renders with no markers, and a long unbroken token
 * overflows the transcript.
 */
describe("globals.css scans streamdown's dist", () => {
  it("generates the list and wrapping classes streamdown applies to rendered markdown", async () => {
    const css = await compileGlobals();
    for (const utility of STREAMDOWN_ONLY) {
      expect.soft(hasUtility(css, utility), `.${utility} is missing from the compiled CSS`).toBe(true);
    }
  }, 60_000);

  it("keeps streamdown's code-block line numbers on the 13px rung and a named ink tier", async () => {
    const css = await compileGlobals();
    const lineNumber = '[data-streamdown="code-block-body"] code > span::before';
    const declarations = new Map<string, string>();
    let layer = "";
    postcss.parse(css).walkRules((rule) => {
      if (rule.selector !== lineNumber) return;
      layer = rule.parent?.type ?? "";
      rule.walkDecls((decl) => declarations.set(decl.prop, decl.value));
    });
    // Unlayered, so it outranks streamdown's `before:text-[13px]` in Tailwind's utilities layer.
    expect(layer).toBe("root");
    expect(declarations.get("font-size")).toBe("var(--text-ui-md)");
    expect(declarations.get("color")).toBe("var(--text-tertiary)");
  }, 60_000);
});
