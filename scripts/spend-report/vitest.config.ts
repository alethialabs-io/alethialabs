// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The spend report's PURE half — dates, aggregation, FX, thresholds, leak attribution, the per-cloud
// response parsers and both renderers. Nothing here touches a network or a cloud; the I/O half
// (src/sources/*.ts fetchers, src/main.ts) is exercised by a workflow_dispatch, not by a unit test.
//
// No coverage block, deliberately for now: a coverage-emitting project must be recorded in
// scripts/ts-coverage-sweep.json and gated in ci.yml, and the floors are recorded from CI, not from
// a laptop. That is a follow-up, not something to arm on the first commit.

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		env: { TZ: "UTC" },
		include: ["./tests/**/*.test.ts", "./tests/**/*.test.tsx"],
	},
});
