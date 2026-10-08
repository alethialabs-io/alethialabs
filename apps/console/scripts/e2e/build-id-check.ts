// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The post-deploy smoke's `build-id` check, separated from the script so a unit test can run it.
//
// post-deploy-smoke.ts calls `main()` at import time — it is a script, and making that conditional
// would risk a smoke that exits 0 having run nothing. So the one piece a test must drive lives here,
// with the browser behind a single-method probe, and tests/unit/post-deploy-smoke-build-id.test.ts
// runs it against the production edge router (deploy/prod/Caddyfile.tunnel).

/**
 * The page the build id is read from. It must be one the CONSOLE serves on the public host.
 *
 * NOT `/`. On the public host the edge (deploy/prod/Caddyfile.tunnel, the router production runs
 * behind the tunnel) hands an anonymous `/` to the MARKETING container. Marketing renders its own
 * `<PublicEnvScript />` and its image never sets `NEXT_PUBLIC_APP_VERSION`, so reading `/` asked the
 * marketing app which console build was live and always heard "unset" — deploy run 37760242162
 * (merge 87ddeb534) failed exactly so after #5621 had already fixed the console's runner stage
 * (#5620). `/login` is outside the marketing path list and is not a docs/blog prefix, so it falls
 * to the console catch-all.
 */
export const BUILD_ID_PATH = "/login";

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
 * Asserts the console build the browser is running equals the promoted SHA.
 *
 * `expected` is `SMOKE_EXPECTED_SHA`, empty when the deploy did not rebuild the console image — that
 * is reported as NOT ASSERTED, never as a pass. With an expected SHA, only an exact match passes:
 * an absent key ("unset") fails, so the check cannot pass on a page that rendered no build id.
 */
export async function assertServedBuild(
	probe: BuildIdProbe,
	expected: string | undefined,
	report: BuildIdReport,
): Promise<void> {
	const { version, finalPathname } = await probe.read(BUILD_ID_PATH);
	if (finalPathname !== BUILD_ID_PATH) {
		report.fail(
			`${BUILD_ID_PATH} ended on ${finalPathname}, so the build id read there is not the console's`,
		);
		return;
	}
	if (!expected) {
		// Not every deploy moves the console image. Saying so is honest; inventing a pass is not.
		report.note(`NOT ASSERTED (apps unchanged) — served build id is ${version ?? "unset"}`);
	} else if (version !== expected) {
		report.fail(
			`the console at ${BUILD_ID_PATH} is running build ${version ?? "unset"}, but ${expected} ` +
				`was promoted — stale bytes are being served`,
		);
	} else {
		report.note(`console build ${version} (read at ${BUILD_ID_PATH})`);
	}
}
