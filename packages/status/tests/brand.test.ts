// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The status page draws EXACTLY the main site's logo. Every expected value here is computed from
 * packages/brand at test time — the real `AlethiaLockup`, the real tokens.css, the real favicon
 * constants — never a copy, so a change to the brand turns this red until `pnpm gen:brand` is run.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ICON_MARK_SVG, faviconSvg } from "@repo/brand/icon-svg";
import { AlethiaLockup, AlethiaMark } from "@repo/brand/lockup";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { generatedModule, lockupCss } from "../scripts/brand-source";
import { FAVICON_SVG, LOCKUP_CSS, LOCKUP_HTML } from "../src/brand.generated";

/** Every attribute that carries geometry, in document order: the mark's drawing, colour aside. */
function geometry(svg: string): string[] {
	return [...svg.matchAll(/\b(d|stroke-width|stroke-linecap|stroke-linejoin|cx|cy|r|viewBox)="([^"]*)"/g)].map(
		(m) => `${m[1]}=${m[2]}`,
	);
}

describe("brand.generated.ts", () => {
	it("is exactly what scripts/gen-brand.ts writes from packages/brand today", () => {
		const committed = readFileSync(join(__dirname, "..", "src", "brand.generated.ts"), "utf8");
		expect(committed, "stale: run `pnpm -F @repo/status gen:brand`").toBe(generatedModule());
	});

	it("holds the main site header's lockup, rendered by AlethiaLockup itself", () => {
		expect(LOCKUP_HTML).toBe(renderToStaticMarkup(createElement(AlethiaLockup, { tag: "labs" })));
		expect(LOCKUP_HTML).toContain("<span>LABS</span>");
	});

	it("holds the lockup's CSS from tokens.css, with the wordmark and tag faces", () => {
		expect(LOCKUP_CSS).toBe(lockupCss());
		expect(LOCKUP_CSS).toContain("font-family:var(--font-grotesk)");
		expect(LOCKUP_CSS).toContain("font-family:var(--font-mono)");
	});

	it("holds the sites' favicon", () => {
		expect(FAVICON_SVG).toBe(faviconSvg());
	});

	// icon-svg.ts carries the mark as a string (next/og cannot render the component), so check it
	// against the component's drawing: otherwise the favicon could drift from the header beside it.
	it("draws the favicon's mark with AlethiaMark's geometry", () => {
		expect(geometry(ICON_MARK_SVG)).toEqual(geometry(renderToStaticMarkup(createElement(AlethiaMark))));
	});
});
