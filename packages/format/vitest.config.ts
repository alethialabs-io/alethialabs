// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// @repo/format owns its own tests (the placement standard — see /TESTING.md). Pure functions,
// no DOM, so a node environment. Coverage joins the ratchet under its own project.

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		// Pinned so date output is deterministic. Without it these tests pass on a UTC CI
		// runner and fail on a maintainer's laptop in Europe/Sofia — the formatter renders in
		// the runtime's zone by design, so the TEST is what has to be fixed, not the code.
		env: { TZ: "UTC" },
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
