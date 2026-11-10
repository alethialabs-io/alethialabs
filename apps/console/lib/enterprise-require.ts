// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A runtime-only fallback loader for `lib/enterprise.ts` (#6149). It never names the enterprise
// package itself — the specifier is passed in, so `lib/enterprise.ts` stays the only file that does
// (scripts/check-ee-boundary.mjs). Kept in its own module so a test can replace it without reaching
// into Node's loader, and so the bundler-visible require in `lib/enterprise.ts` stays untouched.

import { join } from "node:path";

/**
 * Retries a missed enterprise-package require relative to the app's working directory, through Node's
 * OWN module loader, or returns undefined when that cannot find it either.
 *
 * WHY (#6149, finding F049). `import.meta.url` is the location of the CHUNK this module was bundled
 * into, and under the Turbopack dev server a server-action chunk and an RSC chunk do not live in
 * the same place: on the 2026-10-19 sandbox the RSC render loaded `@alethia/ee` while every server
 * action on the same page did not. The working directory is the console app in every way it runs.
 *
 * WHY `process.getBuiltinModule`: a `createRequire(<computed base>)` call is rewritten by the
 * bundler into a stub that throws "expression is too dynamic" (it broke the enterprise image build
 * in the first revision of this fix). Reaching the loader through the runtime keeps the bundler out
 * of it, and the primary require in `lib/enterprise.ts` keeps the exact shape the bundler already handles.
 */
export function requireFromWorkingDirectory(specifier: string): unknown {
  try {
    const nodeModule = process.getBuiltinModule("node:module");
    return nodeModule.createRequire(join(process.cwd(), "package.json"))(specifier);
  } catch {
    return undefined;
  }
}

