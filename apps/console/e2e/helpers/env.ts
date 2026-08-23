// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Loads the monorepo-root .env into process.env for the Playwright process. `pnpm dev:up` sources it
// into the CONSOLE process, but a bare `playwright test` invocation doesn't get it — global-setup and
// the seed helper need ALETHIA_DATABASE_URL et al. Only fills keys that aren't already set (so an
// explicit env override always wins). Idempotent; safe to call from both config and global-setup.

import fs from "node:fs";
import path from "node:path";

/** Walks up from the process cwd (apps/console when Playwright runs) to the repo root. */
function findRepoRoot(): string {
	let dir = process.cwd();
	for (let i = 0; i < 8; i++) {
		if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	// Fallback: cwd is apps/console → two up is the repo root.
	return path.resolve(process.cwd(), "../..");
}

let loaded = false;

/** Parses the repo-root .env and populates any unset process.env keys. */
export function loadRootEnv(): void {
	if (loaded) return;
	loaded = true;
	const envPath = path.join(findRepoRoot(), ".env");
	if (!fs.existsSync(envPath)) return;
	const text = fs.readFileSync(envPath, "utf8");
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const key = line.slice(0, eq).trim();
		if (!key || key in process.env) continue;
		let value = line.slice(eq + 1).trim();
		// Strip surrounding quotes.
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		process.env[key] = value;
	}
}
