// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The AI behavior-eval project (Tier B): scores the REAL model against our REAL system
// prompt + tool definitions, asserting the tool trace rather than prose. Costs money and
// varies with the provider, so it is NEVER part of the merge gate — it runs from the
// nightly workflow (`pnpm test:ai-eval`) and skips itself without ANTHROPIC_API_KEY.
// Files are `*.eval.ts`, which the default unit run (`*.test.ts`) can't pick up.

import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	css: { postcss: {} },
	test: {
		css: false,
		environment: "node",
		include: ["./tests/ai-eval/**/*.eval.ts"],
		// Real model round-trips (with tool loops) are slow; run serially.
		testTimeout: 180_000,
		hookTimeout: 60_000,
		fileParallelism: false,
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "."),
			// The server modules pulled in by the route `import "server-only"` (throws under
			// node) — stub it, exactly like the integration project does.
			"server-only": path.resolve(__dirname, "tests/integration/server-only-stub.ts"),
		},
	},
});
