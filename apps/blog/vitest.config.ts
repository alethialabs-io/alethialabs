// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// News's unit suite: the pure index and changelog logic in lib/, with plain fixtures, so it needs
// neither a velite build nor a DOM. No coverage block yet, like @repo/legal and @repo/brand —
// joining the ratchet is its own recorded step (scripts/ts-coverage-sweep.json, a ci.yml step and
// floors), not a side effect of adding tests.

import { defineConfig } from "vitest/config";

export default defineConfig({
	// Opt out of PostCSS config discovery: postcss.config.mjs names `@tailwindcss/postcss`, which
	// vitest cannot load as a classic plugin (apps/marketing/vitest.config.ts records the error).
	css: { postcss: {} },
	test: {
		environment: "node",
		include: ["./tests/**/*.test.ts"],
		css: false,
	},
});
