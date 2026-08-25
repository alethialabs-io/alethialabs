// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Marketing's unit suite. Node environment, no setup file and no jsdom: the only tests here
// exercise `proxy.ts`, which takes a NextRequest and returns a NextResponse — there is no DOM
// to render. Kept deliberately small; if a component test ever lands here it will need jsdom
// and a setup file, and that is the moment to grow this config, not before.
//
// This suite used to live in apps/console (tests/lib/marketing-proxy.test.ts) and reached across
// with `../../../marketing/proxy`. That import dragged apps/marketing/proxy.ts into the CONSOLE's
// type-check program, and since the console image installs only `--filter console...`, marketing's
// `next` was absent there and `next/server` failed to resolve — TS2307, which broke every
// production deploy from 2026-07-30. The test belongs to the app it tests.

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["./tests/**/*.test.ts"],
		exclude: ["**/node_modules/**"],
	},
});
