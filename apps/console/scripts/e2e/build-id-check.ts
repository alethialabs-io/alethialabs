// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The post-deploy smoke's `build-id` and `marketing-build-id` checks, separated from the script so a unit test can run it.
//
// post-deploy-smoke.ts calls `main()` at import time — it is a script, and making that conditional
// would risk a smoke that exits 0 having run nothing. So the one piece a test must drive lives here,
// with the browser behind a single-method probe, and tests/unit/post-deploy-smoke-build-id.test.ts
// runs it against the production edge router (deploy/prod/Caddyfile.tunnel).

/** One app whose served build id the smoke asserts, and the page it is read from. */
export interface BuildTarget {
	/** The app's name as the report says it — `console` or `marketing`. */
	app: string;
	/** A path the edge (deploy/prod/Caddyfile.tunnel) hands to THIS app for an anonymous visitor. */
	path: string;
}

/**
 * The page the CONSOLE's build id is read from. It must be one the CONSOLE serves on the public host.
 *
 * NOT `/`. On the public host the edge (deploy/prod/Caddyfile.tunnel, the router production runs
 * behind the tunnel) hands an anonymous `/` to the MARKETING container. Marketing renders its own
 * `<PublicEnvScript />`, so reading `/` asked the marketing app which console build was live —
 * deploy run 37760242162 (merge 87ddeb534) failed exactly so ("unset") after #5621 had already fixed
 * the console's runner stage (#5620). `/login` is outside the marketing path list and is not a
 * docs/blog prefix, so it falls to the console catch-all.
 */
export const BUILD_ID_PATH = "/login";

/** The console, read at {@link BUILD_ID_PATH}. */
export const CONSOLE_BUILD: BuildTarget = { app: "console", path: BUILD_ID_PATH };

/**
 * The marketing site, read at `/` — the path an anonymous visitor to the public host is routed to
 * marketing for (the `@marketing` matcher in Caddyfile.tunnel). Its image sets
 * `NEXT_PUBLIC_APP_VERSION` in the runner stage since #5697; before that this read was always unset.
 */
export const MARKETING_BUILD: BuildTarget = { app: "marketing", path: "/" };

/** What the browser saw on the build-id page. */
export interface ServedBuild {
	/** `window.__ENV.NEXT_PUBLIC_APP_VERSION`, or null when the page carries no such key. */
	version: string | null;
	/** The pathname the browser ended on — a redirect off the console route is a failure, not a read. */
	finalPathname: string;
}

/** The browser, narrowed to the one question this check asks of it. */
export interface BuildIdProbe {
	read(pathname: string): Promise<ServedBuild>;
}

/** Where the check reports — the same `fail`/`note` pair every smoke check is handed. */
export interface BuildIdReport {
	fail(why: string): void;
	note(what: string): void;
}

/**
 * Asserts the build of `target` that the browser is running equals the promoted SHA.
 *
 * `expected` is `SMOKE_EXPECTED_SHA`, empty when the deploy did not rebuild the apps image group —
 * that is reported as NOT ASSERTED, never as a pass. Console and marketing are in the SAME group
 * (deploy-console.yml: `build-amd64` builds both, `retag-unchanged` retags both), so one expected SHA
 * is right for either: rebuilt together at the deploy SHA, or retagged together and not asserted. With an expected SHA, only an exact match passes:
 * an absent key ("unset") fails, so the check cannot pass on a page that rendered no build id.
 */
export async function assertServedBuild(
	target: BuildTarget,
	probe: BuildIdProbe,
	expected: string | undefined,
	report: BuildIdReport,
): Promise<void> {
	const { version, finalPathname } = await probe.read(target.path);
	if (finalPathname !== target.path) {
		report.fail(
			`${target.path} ended on ${finalPathname}, so the build id read there is not the ${target.app}'s`,
		);
		return;
	}
	if (!expected) {
		// Not every deploy moves the apps images. Saying so is honest; inventing a pass is not.
		report.note(`NOT ASSERTED (apps unchanged) — served ${target.app} build id is ${version ?? "unset"}`);
	} else if (version !== expected) {
		report.fail(
			`the ${target.app} at ${target.path} is running build ${version ?? "unset"}, but ${expected} ` +
				`was promoted — stale bytes are being served`,
		);
	} else {
		report.note(`${target.app} build ${version} (read at ${target.path})`);
	}
}
