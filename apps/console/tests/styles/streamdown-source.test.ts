// @vitest-environment node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import postcssConfig from "../../postcss.config.mjs";

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
const fromConsole = createRequire(path.join(consoleDir, "package.json"));

/**
 * Compiles the console's real globals.css the way `next build` does: through the plugins the
 * console's own postcss.config.mjs names, resolved from apps/console and rooted there (Next runs
 * them with apps/console as the working directory, which is Tailwind's default `base`).
 */
async function compileGlobals(): Promise<string> {
  const source = await readFile(globalsPath, "utf8");
  const plugins = postcssConfig.plugins.map((name) => {
    const createPlugin: (options: { base: string }) => unknown = fromConsole(name);
    return createPlugin({ base: consoleDir });
  });
  const result = await postcss(plugins).process(source, { from: globalsPath });
  return result.css;
}

/** Every selector in the compiled CSS, with its CSS escapes removed, so an arbitrary value reads as written. */
function selectorsOf(css: string): Set<string> {
  const selectors = new Set<string>();
  postcss.parse(css).walkRules((rule) => {
    selectors.add(rule.selector.replace(/\\(.)/g, "$1"));
  });
  return selectors;
}

/**
 * Class names under test, assembled from parts so that this file does not name them. Tailwind scans
 * every source file under apps/console, tests included: written out whole here, they would be
 * generated BECAUSE this test names them, and the test would pass with the @source line deleted.
 */
const assemble = (parts: string[]) => parts.join("");

/**
 * The witnesses that the @source line is what generates streamdown's classes. They come from
 * streamdown's own namespace: its code-block and table colours read the `--sdm-*` properties that
 * only streamdown sets, so no console file has a reason to write them. Generic utilities make poor
 * witnesses: the two list classes asserted below are also generated from the release-notes
 * renderer's own wrapper classes (#6187), with or without this line.
 */
const STREAMDOWN_WITNESSES = [
  ["bg-[var(--", "sdm-tbg)]"],
  ["text-[var(--", "sdm-c,inherit)]"],
].map(assemble);

/**
 * What streamdown's markdown needs from the console's CSS: list markers, which preflight's
 * `list-style: none` otherwise removes, and wrapping for a long unbroken token. Whichever file
 * generates them, the chat must get them.
 */
const STREAMDOWN_NEEDS = [
  ["list-", "disc"],
  ["list-", "inside"],
  ["wrap-", "anywhere"],
].map(assemble);

/** #6194: streamdown's classes exist in the console's CSS only if globals.css scans its dist. */
describe("globals.css scans streamdown's dist", () => {
  it("generates the classes only streamdown's dist names", async () => {
    const selectors = selectorsOf(await compileGlobals());
    for (const witness of STREAMDOWN_WITNESSES) {
      expect.soft(selectors.has(`.${witness}`), `.${witness} is missing from the compiled CSS`).toBe(
        true,
      );
    }
  }, 60_000);

  it("generates the list and wrapping classes streamdown applies to rendered markdown", async () => {
    const selectors = selectorsOf(await compileGlobals());
    for (const utility of STREAMDOWN_NEEDS) {
      expect.soft(selectors.has(`.${utility}`), `.${utility} is missing from the compiled CSS`).toBe(
        true,
      );
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
