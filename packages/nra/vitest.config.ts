// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// @repo/nra owns its own tests (the placement standard, /TESTING.md). Pure functions over JSON
// inputs and bytes out, so a node environment with no DOM. The golden files under tests/golden are
// the exact bytes the NRA receives (cp-1251, CR LF), compared byte for byte.

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["./tests/**/*.test.ts"],
	},
});
