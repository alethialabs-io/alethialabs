// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Copies the shared static asset tree from @repo/assets into the current app's public/
// directory. The provider/brand icons live ONCE in packages/assets and are synced into
// each consuming app at dev/build time (the synced paths are gitignored — the package is
// the single source of truth). Wired into every app's `dev` and `build` scripts, so it
// runs identically in local dev, Docker (`pnpm --filter <app> build`), and Vercel.
//
// Run from an app directory (cwd = apps/<app>); writes into ./public.

import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/** Locate packages/assets/static — prefer the resolved workspace package, fall back to
 * the monorepo-relative path (covers `turbo prune` layouts where resolution differs). */
function resolveAssetsDir() {
	try {
		const pkgJson = require.resolve("@repo/assets/package.json");
		return join(dirname(pkgJson), "static");
	} catch {
		return join(process.cwd(), "..", "..", "packages", "assets", "static");
	}
}

const src = resolveAssetsDir();
if (!existsSync(src)) {
	console.error(`[sync-public-assets] source not found: ${src}`);
	process.exit(1);
}

const dest = join(process.cwd(), "public");
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[sync-public-assets] synced @repo/assets/static → ${dest}`);
