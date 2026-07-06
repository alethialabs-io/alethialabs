// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The integration Vitest project — the "real Postgres" tier of the Testing Trophy. It runs
// the SQL query builders (lib/queries/*), the AI-credit ledger math (lib/billing/ai-quota),
// and RLS scoping against an actual database, which mocks can't verify. Gated behind
// `pnpm test:integration` (needs `pnpm db:up`); never part of the fast unit run. Node
// environment (no jsdom) and a longer timeout for DB round-trips. See TESTING.md.

import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	// Don't load the app's Tailwind PostCSS config — these are node tests, no CSS.
	css: { postcss: {} },
	test: {
		css: false,
		environment: "node",
		include: ["./tests/integration/**/*.test.ts"],
		setupFiles: ["./tests/integration/setup.ts"],
		// DB round-trips + migrations are slower than unit tests; run serially for a clean DB.
		testTimeout: 30_000,
		hookTimeout: 60_000,
		fileParallelism: false,
		// No coverage here: this suite's value is correctness + RLS verification (it executes
		// the real SQL). v8 doesn't reliably attribute coverage to modules loaded through the
		// node pool + `server-only` alias, so the coverage badge stays driven by the unit run.
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "."),
			// The real query modules `import "server-only"` (throws under node) — stub it.
			"server-only": path.resolve(__dirname, "tests/integration/server-only-stub.ts"),
		},
	},
});
