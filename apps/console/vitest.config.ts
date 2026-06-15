// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
	css: {
		postcss: {},
	},
	test: {
		environment: "jsdom",
		setupFiles: ["./tests/setup.ts"],
		include: ["./tests/**/*.test.{ts,tsx}"],
		css: false,
	},
	resolve: {
		alias: { "@": path.resolve(__dirname, ".") },
	},
});
