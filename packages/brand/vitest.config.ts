// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// @repo/brand owns the tests of its pure modules (the placement standard — see /TESTING.md): the
// generated News covers, the shared feed reader, and the intro splash (server markup plus its timer logic
// through an injected host). No DOM, so a node environment. No coverage
// block yet, like @repo/legal — joining the ratchet is a separate, recorded step
// (scripts/ts-coverage-sweep.json + a ci.yml step + floors), not a side effect of adding tests.

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["./tests/**/*.test.{ts,tsx}"],
	},
});
