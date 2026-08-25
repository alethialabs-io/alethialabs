// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withPostHogConfig } from "@posthog/nextjs-config";
import type { NextConfig } from "next";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	type NextConfigInput,
	isNonFatalSourcemapHook,
	withNonFatalSourcemapUpload,
} from "../../next.config";

/** The metadata Next hands the hook (next/dist/server/config-shared: projectDir + distDir). */
const META = { projectDir: "/repo/apps/console", distDir: ".next" };

/** The phase Next passes a config function for a production build. */
const PHASE_PRODUCTION_BUILD = "phase-production-build";

/** Resolves a config the way Next does: invoke it if it is a function, else use it as-is. */
async function resolveLikeNext(config: NextConfigInput): Promise<NextConfig> {
	return typeof config === "function"
		? await config(PHASE_PRODUCTION_BUILD, { defaultConfig: {} })
		: config;
}

/**
 * #2244: an invalid POSTHOG_API_KEY threw out of the PostHog source-map upload and failed EVERY
 * production console build for ten days. The image was never produced, so nothing reaching `main`
 * reached production — while the runner images built fine and the run read as a partial success.
 *
 * #2485: the guard written to prevent that then failed the same way for ten more days. It read
 * `config.compiler?.runAfterProductionCompile` off the value `withPostHogConfig` returns — which is
 * an async config FUNCTION, not a config. `.compiler` on a function is undefined, so the guard took
 * its `if (!hook) return config` early return on every build and handed the config back unwrapped.
 *
 * Every test below that uses a hand-built object was already passing while production was down. The
 * one that matters is "attaches to what withPostHogConfig actually returns" — it uses the real
 * package, because the shape is the thing that broke.
 */
describe("withNonFatalSourcemapUpload", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("against the real @posthog/nextjs-config", () => {
		/** Composes the plugin exactly as next.config.ts does, with throwaway credentials. */
		function composeAsProduction(): NextConfigInput {
			return withNonFatalSourcemapUpload(
				withPostHogConfig(
					{ reactStrictMode: true },
					{
						personalApiKey: "phx_not_a_real_key",
						projectId: "1",
						host: "https://eu.posthog.com",
						sourcemaps: {
							enabled: true,
							releaseName: "console",
							releaseVersion: "0000000",
							deleteAfterUpload: true,
						},
					},
				),
				{ expectHook: true },
			);
		}

		it("attaches to what withPostHogConfig actually returns", async () => {
			const resolved = await resolveLikeNext(composeAsProduction());

			// The assertion the old suite could not make. On the broken guard the hook is present but
			// unwrapped, so this is false and a failing upload kills the build.
			expect(
				isNonFatalSourcemapHook(resolved.compiler?.runAfterProductionCompile),
			).toBe(true);
		});

		it("leaves the plugin's own config intact", async () => {
			const resolved = await resolveLikeNext(composeAsProduction());

			// Wrapping must not cost the settings the upload needs, nor the user's own config.
			expect(resolved.reactStrictMode).toBe(true);
			expect(resolved.productionBrowserSourceMaps).toBe(true);
		});
	});

	describe("a config function", () => {
		/** The shape withPostHogConfig returns: a hook reachable only after the function is invoked. */
		function configFn(hook: () => Promise<void>) {
			return async () => ({
				reactStrictMode: true,
				compiler: { runAfterProductionCompile: hook },
			});
		}

		it("does not let a failing upload fail the build", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const wrapped = withNonFatalSourcemapUpload(
				configFn(async () => {
					throw new Error(
						"API error: error='authentication_error' code='authentication_failed'",
					);
				}),
				{ expectHook: true },
			);

			const resolved = await resolveLikeNext(wrapped);
			await expect(
				resolved.compiler?.runAfterProductionCompile?.(META),
			).resolves.toBeUndefined();

			expect(warn.mock.calls.flat().join(" ")).toContain("source-map upload failed");
		});

		it("still runs the upload on the happy path", async () => {
			const hook = vi.fn(async () => {});
			const wrapped = withNonFatalSourcemapUpload(configFn(hook), {
				expectHook: true,
			});

			const resolved = await resolveLikeNext(wrapped);
			await resolved.compiler?.runAfterProductionCompile?.(META);

			expect(hook).toHaveBeenCalledOnce();
		});
	});

	describe("a plain config object", () => {
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
			const logged = warn.mock.calls.flat().join(" ");
			expect(logged).toContain("source-map upload failed");
			expect(logged).toContain("authentication_failed");
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

	describe("when there is no hook to wrap", () => {
		it("says so when one was expected", () => {
			// The branch that hid #2485 for ten days. "Nothing to guard" must never read like
			// "guarding" — the whole defect class is a guard whose silence means both.
			const error = vi.spyOn(console, "error").mockImplementation(() => {});

			withNonFatalSourcemapUpload({ reactStrictMode: true }, { expectHook: true });

			expect(error.mock.calls.flat().join(" ")).toContain("INERT GUARD");
		});

		it("is a quiet passthrough when none was expected", () => {
			// Sourcemaps disabled (an OSS/local build, or no releaseVersion): there is nothing to wrap
			// and nothing wrong, so the config comes back untouched rather than growing a compiler block.
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			const plain: NextConfig = { reactStrictMode: true };

			expect(withNonFatalSourcemapUpload(plain)).toBe(plain);
			expect(error).not.toHaveBeenCalled();
		});
	});

	describe("source maps left behind by a failed upload", () => {
		/** Builds a throwaway dist dir holding a chunk and its map, and returns both paths. */
		async function makeDist(): Promise<{ meta: typeof META; map: string; js: string }> {
			const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "alethia-sourcemaps-"));
			const chunks = path.join(projectDir, ".next", "static", "chunks");
			await fs.mkdir(chunks, { recursive: true });
			const map = path.join(chunks, "main.js.map");
			const js = path.join(chunks, "main.js");
			await fs.writeFile(map, '{"sources":["../../src/secret.ts"]}');
			await fs.writeFile(js, "console.log(1)");
			return { meta: { projectDir, distDir: ".next" }, map, js };
		}

		it("deletes them, so the image cannot serve them", async () => {
			vi.spyOn(console, "warn").mockImplementation(() => {});
			const { meta, map, js } = await makeDist();

			const wrapped = withNonFatalSourcemapUpload({
				compiler: {
					runAfterProductionCompile: async () => {
						throw new Error("authentication_failed");
					},
				},
			});
			await wrapped.compiler?.runAfterProductionCompile?.(meta);

			// posthog-cli's `--delete-after` never ran, and turbopack has already emitted the maps into
			// .next/static — which the Dockerfile copies into the runtime image. Swallowing the error
			// without this would publish the console's own source at /_next/static.
			await expect(fs.access(map)).rejects.toThrow();
			// Only the maps: the build output itself must survive.
			await expect(fs.access(js)).resolves.toBeUndefined();
		});

		it("keeps them when the upload succeeded", async () => {
			const { meta, map } = await makeDist();
			const wrapped = withNonFatalSourcemapUpload({
				compiler: { runAfterProductionCompile: async () => {} },
			});

			await wrapped.compiler?.runAfterProductionCompile?.(meta);

			// The plugin's own delete-after step owns this path; the guard must not pre-empt it.
			await expect(fs.access(map)).resolves.toBeUndefined();
		});
	});
});
