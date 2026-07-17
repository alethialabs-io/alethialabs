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
	},
});
