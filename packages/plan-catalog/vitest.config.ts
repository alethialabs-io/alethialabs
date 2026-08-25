// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// @repo/plan-catalog owns its own tests (the placement standard — see /TESTING.md). Pure
// data + accessors, so a node environment with no DOM. Coverage is uploaded to Codecov under
// the `plan-catalog` flag and merged with the other projects.

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["./tests/**/*.test.ts"],
		coverage: {
			provider: "v8",
			// "json" writes coverage-final.json — the RAW statement map, and the artefact the
			// coverage ratchet (scripts/ts-coverage.mjs) measures. It is in vitest's DEFAULT
			// reporter set, but naming any `reporter` array REPLACES that default, so it has to
			// be listed explicitly here. json-summary stays for scripts/coverage-badge.mjs.
			reporter: ["text", "lcov", "json-summary", "json"],
			include: ["src/**"],
		},
	},
});
