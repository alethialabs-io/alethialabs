// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Lets a tsx script load the PDF renderer (factura:export, nra:build, nra:protocol). tsx compiles the
 * console's TypeScript to CommonJS, so `@react-pdf/renderer` and its dependencies are `require`d,
 * and `@react-pdf/hyphenate` publishes its subpaths under the `import` condition only: resolution
 * fails with ERR_PACKAGE_PATH_NOT_EXPORTED before any PDF is drawn. Node (22.15+) can `require` an
 * ES module synchronously; what is missing is only the resolution, so this hook retries exactly that
 * failure with the `import` condition added. Next bundles the renderer for the server and never
 * takes this path. `registerHooks` is not in the console's @types/node (20), hence the runtime check.
 */
export async function allowEsmOnlyPackages(): Promise<void> {
	const mod: unknown = await import("node:module");
	if (typeof mod !== "object" || mod === null || !("registerHooks" in mod) || typeof mod.registerHooks !== "function") return;
	mod.registerHooks({
		resolve(
			specifier: string,
			context: { conditions?: string[] },
			next: (s: string, c: { conditions?: string[] }) => unknown,
		): unknown {
			try {
				return next(specifier, context);
			} catch (err) {
				const code = typeof err === "object" && err !== null && "code" in err ? err.code : null;
				if (code !== "ERR_PACKAGE_PATH_NOT_EXPORTED" || !specifier.startsWith("@react-pdf/")) throw err;
				return next(specifier, { ...context, conditions: [...(context.conditions ?? []), "import"] });
			}
		},
	});
}

/**
 * The directory a user's relative path means. Running a console script through pnpm with -C
 * starts it in apps/console (the PDF fonts are found from there), while the person typed the path
 * in the folder they ran pnpm from, which pnpm passes as INIT_CWD.
 */
export function userCwd(): string {
	return process.env.INIT_CWD ?? process.cwd();
}
