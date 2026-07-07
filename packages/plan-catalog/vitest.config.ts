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
			reporter: ["text", "lcov", "json-summary"],
			include: ["src/**"],
		},
	},
});
