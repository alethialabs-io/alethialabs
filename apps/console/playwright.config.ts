// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig, devices } from "@playwright/test";
import { STORAGE_STATE } from "./e2e/fixtures/auth";

const isCI = !!process.env.CI;
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

// Where the console's stdout (incl. the logged OTP) is teed. Locally `pnpm dev:up` already tees to
// the default path and Playwright reuses that server; in CI this config boots the server itself and
// tees `next start` here (the e2e-browser job sets DEV_CONSOLE_LOG to match).
const consoleLog = process.env.DEV_CONSOLE_LOG ?? "/tmp/alethia-dev-console.log";

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: true,
	forbidOnly: isCI,
	retries: isCI ? 2 : 0,
	workers: isCI ? 1 : undefined,
	reporter: isCI ? [["list"], ["html", { open: "never" }]] : "html",
	use: {
		baseURL,
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		// Generous nav budget: covers a cold CI server's first response (and, locally, `next dev`
		// compiling a route on first hit). Per-assertion expects keep the default 5s.
		navigationTimeout: 60_000,
	},
	projects: [
		// Produces the reusable authenticated persona (e2e/.auth/persona.json). Specs that only need
		// an authed session — not the onboarding demo — can add `dependencies: ["setup"]` +
		// `use: { storageState: STORAGE_STATE }`.
		{ name: "setup", testMatch: /fixtures\/auth\.setup\.ts/ },

		// The CI-gated hero: the full sellable flow, fresh context (it signs itself in as step 1).
		{
			name: "hero",
			testMatch: /hero-happy-path\.spec\.ts/,
			use: { ...devices["Desktop Chrome"] },
		},

		// The Elench AI journeys against a SCRIPTED model (ALETHIA_AI_MOCK=1 on the console):
		// the whole server pipeline — route, tools, grid persistence, artifacts, RLS — runs for
		// real, only the model is deterministic. CI-gated alongside the hero path.
		// One shared persona (the `setup` project) rather than a signup per test: the AI
		// journeys are about the chat, and five hermetic signups in a row trip Better Auth's
		// per-IP rate limit. Each test still gets its own thread (and therefore its own grid).
		{
			name: "elench-ai",
			testMatch: /elench-ai\.spec\.ts/,
			dependencies: ["setup"],
			use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE },
		},

		// Elench SURFACE regressions — menu geometry, rail structure, artifact side-effects: the
		// class of defect a type-check can never see, and the reason this suite exists at all.
		{
			name: "elench-ux",
			testMatch: /elench-ux\.spec\.ts/,
			dependencies: ["setup"],
			use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE },
		},

		// The Elench AI journeys against a REAL model (needs ANTHROPIC_API_KEY). Loose,
		// behavior-level assertions — never merge-gating; run by the nightly workflow.
		{
			name: "elench-live",
			testMatch: /elench-live\.spec\.ts/,
			retries: 2,
			dependencies: ["setup"],
			use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE },
		},

		// The Architecture canvas journeys. One SHARED persona (the `setup` project) rather than a
		// signup per test: these are about the board, and a handful of hermetic signups in a row trips
		// Better Auth's per-IP rate limit — the same reason elench-ai shares one.
		{
			name: "canvas",
			testMatch: /architecture-canvas\.spec\.ts/,
			dependencies: ["setup"],
			use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE },
		},

		// Everything else (the broader smoke specs) self-signs-up per test via the auth fixture, so
		// no shared storageState here. Kept separate so `--project=hero` stays clean + fast in CI.
		{
			name: "chromium",
			testIgnore: [
				/fixtures\/auth\.setup\.ts/,
				/hero-happy-path\.spec\.ts/,
				/elench-ai\.spec\.ts/,
				/elench-ux\.spec\.ts/,
				/elench-live\.spec\.ts/,
				/architecture-canvas\.spec\.ts/,
			],
			use: { ...devices["Desktop Chrome"] },
		},
	],
	// Local: reuse the `pnpm dev:up` console (which already tees to the default log). CI: boot the
	// built console with `next start` and tee stdout so the OTP helper can read the code. `next start`
	// (over `next dev`) keeps the run deterministic — no per-route on-demand compilation mid-test.
	webServer: {
		command: isCI ? `pnpm start 2>&1 | tee ${consoleLog}` : "pnpm dev",
		url: baseURL,
		reuseExistingServer: !isCI,
		timeout: 180_000,
		stdout: "pipe",
		stderr: "pipe",
	},
});

// Re-export so tooling importing the config also has the persona path handy.
export { STORAGE_STATE };
