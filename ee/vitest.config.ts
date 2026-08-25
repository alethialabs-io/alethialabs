// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

import { defineConfig } from "vitest/config";

// Unit tests for the enterprise package. Scoped to self-contained modules (e.g. license
// verification) that don't need the core `@/...` runtime — those are exercised via the console
// integration suite / the PDP-parity job.
export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		coverage: {
			provider: "v8",
			// See the note in apps/marketing/vitest.config.ts on why "json" is listed explicitly.
			reporter: ["text", "json"],
			reportsDirectory: "./coverage",
			// The WHOLE licensed tier. ee/ is the paid surface and was measured by nothing at all —
			// no coverage block, so no artefact, so nothing for the ratchet to hold. Six files, one
			// test (license.test.ts), so this starts low; a floor at the real number is worth more
			// than no floor over the code customers pay for.
			include: ["src/**"],
			exclude: ["**/*.d.ts", "**/*.test.ts"],
		},
	},
});
