// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { NextConfig } from "next";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withNonFatalSourcemapUpload } from "../../next.config";

/** The metadata Next hands the hook (next/dist/server/config-shared: projectDir + distDir). */
const META = { projectDir: "/repo/apps/console", distDir: ".next" };

/**
 * #2244: an invalid POSTHOG_API_KEY threw out of the PostHog source-map upload and failed EVERY
 * production console build for ten days. The image was never produced, so nothing reaching `main`
 * reached production — while the runner images built fine and the run read as a partial success.
 *
 * The config comment had claimed "the upload never breaks a deploy" the whole time. It gated on the
 * key being PRESENT, not valid.
 */
describe("withNonFatalSourcemapUpload", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not let a failing upload fail the build", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const config: NextConfig = {
			compiler: {
				runAfterProductionCompile: async () => {
					// The real failure: posthog-cli exits non-zero on an invalid personal API key.
					throw new Error(
						"API error: error='authentication_error' code='authentication_failed'",
					);
				},
			},
		};

		const wrapped = withNonFatalSourcemapUpload(config);

		// The assertion IS that this resolves. Before the fix it rejected, and Next turned that into
		// "Failed to run runAfterProductionCompile" → exit 1 → no image → no deploy.
		await expect(
			wrapped.compiler?.runAfterProductionCompile?.(META),
		).resolves.toBeUndefined();

		// Swallowed, but never silent — a build log has to show why symbolication stopped.
		expect(warn).toHaveBeenCalledOnce();
		const [message] = warn.mock.calls[0] ?? [];
		expect(String(message)).toContain("source-map upload failed");
		expect(String(message)).toContain("authentication_failed");
	});

	it("still runs the upload on the happy path", async () => {
		const hook = vi.fn(async () => {});
		const config: NextConfig = { compiler: { runAfterProductionCompile: hook } };

		const wrapped = withNonFatalSourcemapUpload(config);
		await wrapped.compiler?.runAfterProductionCompile?.(META);

		// Non-fatal must not mean skipped: when the key is good, source maps still upload.
		expect(hook).toHaveBeenCalledOnce();
	});

	it("passes the compiler metadata through untouched", async () => {
		const hook = vi.fn(async () => {});
		const config: NextConfig = { compiler: { runAfterProductionCompile: hook } };

		const wrapped = withNonFatalSourcemapUpload(config);
		const args = { projectDir: "/repo/apps/console", distDir: "/custom/dist" };
		await wrapped.compiler?.runAfterProductionCompile?.(args);

		expect(hook).toHaveBeenCalledWith(args);
	});

	it("is a no-op when no hook was installed", () => {
		// The plugin only installs the hook under turbopack with a compiler hook available; with
		// sourcemaps disabled (an OSS/local build, or no releaseVersion) there is nothing to wrap,
		// and the config must come back untouched rather than growing an empty compiler block.
		const plain: NextConfig = { reactStrictMode: true };
		expect(withNonFatalSourcemapUpload(plain)).toBe(plain);
	});

	it("preserves the rest of the config", () => {
		const config: NextConfig = {
			reactStrictMode: true,
			compiler: {
				removeConsole: true,
				runAfterProductionCompile: async () => {},
			},
		};

		const wrapped = withNonFatalSourcemapUpload(config);

		expect(wrapped.reactStrictMode).toBe(true);
		expect(wrapped.compiler?.removeConsole).toBe(true);
	});
});
