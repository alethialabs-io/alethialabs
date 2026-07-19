// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// @repo/ui owns its own tests (the placement standard — see /TESTING.md): the design-system
// primitives + composed filters live here, so their unit/component tests live here too, in a
// package-level `tests/` dir (NOT co-located in `src/`, which would pollute the `./src/*.tsx`
// export glob + the apps' Tailwind `@source` scan). jsdom + React for component tests; coverage
// is uploaded to Codecov under the `ui` flag and merged with the other projects.

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [react()],
	test: {
		environment: "jsdom",
		setupFiles: ["./tests/setup.ts"],
		include: ["./tests/**/*.test.{ts,tsx}"],
		// The PhoneInput RTL tests drive many userEvent interactions (typing a full number +
		// a country search); on a loaded CI runner the sequence blew past vitest's 5000ms
		// default, flaking the required TypeScript job on ~every train. `delay: null` on the
		// userEvent setups makes the events near-instant; this is the CI-load safety margin.
		testTimeout: 15000,
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
