// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

import path from "node:path";
import { defineConfig } from "vitest/config";

// Unit tests for the enterprise package. Mostly self-contained modules (e.g. license
// verification); the ones that need a live OpenFGA store are exercised via the console
// integration suite / the PDP-parity job.
//
// The `@` alias resolves core the way ee's own tsconfig `paths` already does, so a test can
// exercise a PURE core helper (`expandGrant`, `grantTarget`) as the real thing rather than a
// hand-written stand-in. That distinction is load-bearing for fga-tuple-sync.test.ts: the
// property under test is "the delete looks where the write wrote", and a stubbed expander would
// only prove the test author's model of it. Pure helpers only — nothing here may pull in core's
// runtime (no `getServiceDb`, no `server-only`), which is the same rule the source file follows.
export default defineConfig({
	resolve: {
		alias: { "@": path.resolve(__dirname, "../apps/console") },
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		coverage: {
			provider: "v8",
			// See the note in apps/marketing/vitest.config.ts on why "json" and "json-summary" are
			// listed explicitly.
			reporter: ["text", "json", "json-summary"],
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
