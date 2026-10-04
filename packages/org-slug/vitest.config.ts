// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// @repo/org-slug owns its own tests (the placement standard — see /TESTING.md). One pure module,
// no DOM, so a node environment. Coverage joins the ratchet under its own project.

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["./tests/**/*.test.ts"],
		coverage: {
			provider: "v8",
			// "json" writes coverage-final.json — the raw statement map the coverage ratchet
			// (scripts/ts-coverage.mjs) measures. Naming any `reporter` array REPLACES vitest's
			// default set, so it is listed explicitly. json-summary feeds scripts/coverage-badge.mjs.
			reporter: ["text", "lcov", "json-summary", "json"],
			include: ["src/**"],
		},
	},
});
