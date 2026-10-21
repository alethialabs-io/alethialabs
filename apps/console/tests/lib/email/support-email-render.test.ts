// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// A support email, rendered through packages/support's OWN `@react-email/components` (#6137, #2151).
//
// `react-dom/server` throws when the react-dom doing the render was installed against a different
// react. #4885 left that pair in the lock as `react-dom@19.3.0(react@19.2.8)`, reachable only through
// packages/support's and packages/brand's copies. Every other email test renders through @repo/email's
// copy, and `tests/actions/support.test.ts` mocks the support sender wholesale, so nothing in CI ever
// loaded the split copy. This test resolves `@react-email/components` from packages/support itself,
// reads the react and react-dom THAT copy sees, and renders a real template with it. No mocks.
//
// The lock-level gate is scripts/ci/check-react-pair.mjs. This is the behaviour it protects.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { SupportCaseCreatedEmail, subject } from "@repo/support/emails/support-case-created";

const SUPPORT_MANIFEST = fileURLToPath(new URL("../../../../../packages/support/package.json", import.meta.url));

/** Reads `version` from a package.json loaded through `req`. */
function versionOf(req: NodeJS.Require, pkg: string): unknown {
	const manifest: unknown = req(`${pkg}/package.json`);
	return typeof manifest === "object" && manifest !== null && "version" in manifest ? manifest.version : undefined;
}

describe("a support email renders through packages/support's own react-email copy", () => {
	const fromSupport = createRequire(SUPPORT_MANIFEST);
	const componentsEntry = fromSupport.resolve("@react-email/components");
	const fromComponents = createRequire(componentsEntry);
	const renderEntry = fromComponents.resolve("@react-email/render");
	const fromRender = createRequire(renderEntry);

	it("sees ONE react: the react-dom it renders with is peered on the same version", () => {
		const react = versionOf(fromRender, "react");
		const reactDom = versionOf(fromRender, "react-dom");
		expect(typeof react).toBe("string");
		expect(reactDom).toBe(react);
		expect(versionOf(fromSupport, "react")).toBe(react);
	});

	it("renders a real template without throwing", async () => {
		const mod: unknown = await import(componentsEntry);
		if (typeof mod !== "object" || mod === null || !("render" in mod) || typeof mod.render !== "function") {
			throw new Error(`${componentsEntry} exports no render()`);
		}
		const html: unknown = await mod.render(
			createElement(SupportCaseCreatedEmail, { caseNumber: 42, caseSubject: "Runner offline" }),
		);
		expect(typeof html).toBe("string");
		expect(String(html)).toContain("CASE-000042");
		expect(String(html)).toContain("Runner offline");
		expect(subject(42, "Runner offline")).toBe("[CASE-000042] We received your request: Runner offline");
	});
});
