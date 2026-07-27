// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// @repo/ui owns its own tests (the placement standard — see /TESTING.md): the design-system
// primitives + composed filters live here, so their unit/component tests live here too, in a
// package-level `tests/` dir (NOT co-located in `src/`, which would pollute the `./src/*.tsx`
// export glob + the apps' Tailwind `@source` scan). jsdom + React for component tests; coverage
// is uploaded to Codecov under the `ui` flag and merged with the other projects.

import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

import { TEST_TIMEOUT_MS } from "./tests/timeouts";

export default defineConfig({
	plugins: [react()],
	test: {
		environment: "jsdom",
		setupFiles: ["./tests/setup.ts"],
		include: ["./tests/**/*.test.{ts,tsx}"],
		alias: {
			// `react-phone-number-input/flags` is ~250 full SVG flag components. #1452 cut the
			// phone-input tests' cost by passing the library's `countries` prop, but CountrySelect
			// takes no such prop — it renders COUNTRY_OPTIONS straight from countries.ts
			// (country-select.tsx:88), so every popover-open still mounts the entire set in jsdom.
			// That left country-select.test.tsx the slowest file in the package at ~50s, with its
			// worst test ~1.5s under the old per-test budget. Swapping a shape-compatible stub in
			// fixes it at the source, for both files. See tests/stubs/flags.tsx.
			"react-phone-number-input/flags": fileURLToPath(
				new URL("./tests/stubs/flags.tsx", import.meta.url),
			),
		},
		// The per-TEST budget. DERIVED from the per-WAIT budget in tests/timeouts.ts — the two are
		// different clocks and setting them independently is what flaked the required TypeScript job
		// twice (#1236 → #1402). Change the constants there, never a literal here.
		testTimeout: TEST_TIMEOUT_MS,
		coverage: {
			provider: "v8",
			reporter: ["text", "lcov", "json-summary"],
			// Scope to OUR authored shared logic + composite components — the layer worth
			// unit/RTL-testing. Vendored shadcn/Radix primitives (button, dialog, card, …) are
			// presentational re-exports covered by e2e, NOT counted here — the same policy console
			// applies to its components/** (see apps/console/vitest.config.ts). Keeps the coverage
			// badge a representative "our code is tested" number, not vendored-wrapper noise.
			include: [
				"src/range.ts",
				"src/countries.ts",
				"src/quick-range-filter.tsx",
				"src/date-range-filter.tsx",
				"src/facet-filter.tsx",
				"src/grouped-filter-sheet.tsx",
				"src/country-select.tsx",
				"src/phone-input.tsx",
				"src/view-toggle.tsx",
				"src/provider-icon.tsx",
				"src/copy-button.tsx",
				"src/status-badge.tsx",
			],
			exclude: ["src/**/*.d.ts"],
		},
	},
});
