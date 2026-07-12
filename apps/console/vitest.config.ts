// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The default (unit + component) Vitest project — jsdom, mocked, no external services, runs
// everywhere (local + CI). The real-Postgres integration suite is a SEPARATE config
// (vitest.integration.config.ts, `pnpm test:integration`) so it stays opt-in and never blocks
// the fast suite. Coverage is opt-in via the `--coverage` flag (the `test` script sets it; CI
// uploads lcov to Codecov). See TESTING.md for the strategy (the Testing Trophy).

import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	css: {
		postcss: {},
	},
	test: {
		environment: "jsdom",
		setupFiles: ["./tests/setup.ts"],
		include: ["./tests/**/*.test.{ts,tsx}"],
		// The integration suite needs a live Postgres — it runs via its own config.
		exclude: ["**/node_modules/**", "**/tests/integration/**"],
		css: false,
		coverage: {
			provider: "v8",
			// text → terminal, html → local browse, lcov + json-summary → the CI coverage badge.
			reporter: ["text", "html", "lcov", "json-summary"],
			reportsDirectory: "./coverage",
			// Scope to our business LOGIC — the layer unit/action tests target. Presentational
			// components (components/**) are intentionally excluded: UI is covered by the focused
			// @repo/ui component tests + e2e, so counting ~24k untested view lines here would make
			// the badge read a misleadingly low number. (The component tests still run.)
			include: ["lib/**", "app/server/actions/**"],
			exclude: [
				"**/*.d.ts",
				"lib/db/migrations/**",
				"lib/db/seed/**",
				"**/*.config.*",
				"tests/**",
				// Mid-refactor: the spec→project rework is in flight, so the legacy spec/zone/
				// scanner surface + the design canvas store are excluded from the coverage scope
				// (the same skip we apply to their tests) until the new project model settles.
				// Re-include + cover once the refactor lands.
				"lib/scanner/**",
				"lib/stores/use-canvas-store.ts",
				"lib/ai/tools/scanner.ts",
				"app/server/actions/scanner.ts",
				"app/server/actions/clusters.ts",
				"app/server/actions/specs.ts",
				"app/server/actions/zones.ts",
				// Real-SQL modules verified by the integration tier (tests/integration/*, real
				// Postgres) — mocked unit tests can't exercise their WHERE/joins/CTEs, so they're
				// scoped to that tier and excluded from the unit badge (same tier-separation as
				// e2e-covered components). Each has a green integration suite.
				"lib/queries/**",
				"lib/billing/ai-quota.ts",
				"lib/billing/queries.ts",
				"lib/fleet/queue.ts",
				"lib/fleet/pools-db.ts",
				"lib/authz/postgres-rbac-pdp.ts",
				"lib/authz/seed.ts",
				// B2c reconcilers: real-SQL convergence/reap/GC verified by tests/integration/
				// reconcile-b2c.test.ts (real Postgres). The loop host + heartbeat seam stay in scope
				// (unit-covered by tests/lib/reconcile/*).
				"lib/reconcile/converge.ts",
				"lib/reconcile/reap.ts",
				"lib/reconcile/gc.ts",
			],
			// Thresholds are report-only for now; ratchet up as suites land (see TESTING.md).
		},
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "."),
			// `server-only` throws under Vitest; alias to an empty stub so server-only-importing
			// modules (lib/billing/ai-guard, ai-quota, lib/queries/*) are unit-testable.
			"server-only": path.resolve(__dirname, "tests/integration/server-only-stub.ts"),
		},
	},
});
