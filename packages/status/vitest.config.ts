// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// @repo/status owns its own tests (the placement standard — see /TESTING.md). They run under Node:
// D1 is SQLite, so tests/helpers/fake-bindings.ts runs the Worker's real SQL on node:sqlite.

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["./tests/**/*.test.ts"],
	},
});
