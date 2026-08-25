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
		// Co-located capability-service tests (the Wave-2 per-cloud lanes ship `services/<cloud>.test.ts`
		// next to the enumeration code) run alongside the central `tests/**` suite — without this glob
		// they'd be silently skipped.
		include: [
			"./tests/**/*.test.{ts,tsx}",
			"./lib/cloud-providers/capabilities/**/*.test.{ts,tsx}",
		],
		// The integration suite needs a live Postgres — it runs via its own config.
		exclude: ["**/node_modules/**", "**/tests/integration/**"],
		// Vitest's default is 5000ms, and this suite ran on it until #1475: the runner-token tests
		// mint real RSA-2048 assertions and measured ~4.3-4.4s in isolation — a ~600ms margin that a
		// contended CI worker eats, timing out 7 tests on an unrelated PR. The keygen is now cached
		// (tests/fixtures/rsa-keys.ts) and that is the actual fix; this is the margin for the cost a
		// cache cannot remove — cold transform of a Next route under a saturated worker pool.
		//
		// Deliberately NOT huge. An over-generous per-test budget is how @repo/ui lost the ability to
		// report WHICH assertion hung (#1402): tight enough that a real hang still fails fast, wide
		// enough that honest work is never guillotined.
		testTimeout: 20_000,
		css: false,
		coverage: {
			provider: "v8",
			// text → terminal, html → local browse, lcov + json-summary → the CI coverage badge.
			// "json" writes coverage-final.json — the RAW statement map, and the artefact the
			// coverage ratchet (scripts/ts-coverage.mjs) measures. It is in vitest's DEFAULT
			// reporter set, but naming any `reporter` array REPLACES that default, so it has to
			// be listed explicitly here. json-summary stays for scripts/coverage-badge.mjs.
			reporter: ["text", "html", "lcov", "json-summary", "json"],
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
				// WAS: "Mid-refactor: the spec→project rework is in flight … the same skip we apply
				// to their tests … re-include + cover once the refactor lands."
				//
				// The refactor landed. `app/server/actions/specs.ts` and `.../zones.ts` were
				// deleted by 18f6b55e on 2026-06-30 — so two of these globs had been excluding
				// NOTHING for eight weeks, which is why an exclusion that matches zero files has
				// to be an error rather than a shrug.
				//
				// And the parenthetical was never true. `tests/lib/scanner/{schema,
				// suggest-bindings,to-project,to-project-services}.test.ts` and
				// `tests/lib/stores/use-canvas-store-{containers,keyless}.test.ts` are not
				// skipped — they run on every PR, importing `@/lib/scanner/*` and
				// `@/lib/stores/use-canvas-store` directly. Their coverage was being computed by
				// v8 and then discarded by this scope. So the badge was not merely excluding
				// untested code; it was throwing away tests that were already passing.
				//
				// `lib/scanner/**` and `use-canvas-store.ts` were re-included first, and CI measured
				// the console at 67.09% -> 67.29% — it went UP, because their tests were already
				// running and this scope was discarding the result.
				//
				// The last three — lib/ai/tools/scanner.ts, app/server/actions/scanner.ts and
				// app/server/actions/clusters.ts — are re-included now, and they are the opposite
				// case: nothing EXECUTES any of them, so measuring them moves the number DOWN. They
				// were split out precisely so the two directions would be separately attributable
				// rather than netting out inside one commit.
				//
				// "nothing executes them" rather than "no test names them", because two of the
				// three ARE named — `tests/lib/ai/tools/registry.test.ts:23,29` and
				// `read.test.ts:18,46`, four times, including a literal
				// `import { getClusters } from "@/app/server/actions/clusters"`. Every one of those
				// is a `vi.mock`, which REPLACES the module, so the real code never runs and v8
				// records nothing for it. The distinction matters for whoever closes the gap: the
				// remedy is a test that exercises these modules, and adding another `vi.mock`
				// would satisfy "a test names it" while changing the coverage by zero.
				//
				// Publishing that drop is the point. An exclusion that keeps untested code out of
				// the denominator does not make the code tested, it makes the badge wrong; and the
				// ratchet (#2649) can only hold a floor under surface it can see. There is nothing
				// left here to re-include — every remaining exclusion below is either infrastructural
				// or a tier-separation claim with a named suite behind it.
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
				// BYOC B2.3 probe dispatch + ingest/query: real-SQL, verified by tests/integration/
				// probes-b23.test.ts. The pure scheduler (lib/probes/schedule.ts) stays in scope,
				// unit-covered by tests/lib/probes/schedule.test.ts.
				"lib/probes/dispatch.ts",
				"app/server/actions/probes.ts",
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
