// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// lib/platform/provision loads under PLAIN tsx (#7413), the way operator scripts run it.
//
// Since INV-1 the import graph runs provision → lib/email/billing-email → lib/billing/factura/issue →
// the фактура PDF renderer. @react-pdf/renderer does not load under plain Node resolution (its textkit
// asks @react-pdf/hyphenate for a subpath that package does not export), so a static import anywhere
// on that path made `provisionOrg` uncallable from any script. vitest and Next.js both resolve that
// subpath, which is why this test cannot simply `import` the module: it would pass with the defect
// present. It spawns `node --import tsx` instead — the exact runtime that broke.
//
// The child maps `server-only` to Next's own empty build of it, as scripts/payment-holds.ts does: that
// marker is resolved by Next at build time and is not installed on its own, and it is not the defect
// under test.
//
// Verified against the defect: with lib/billing/factura/issue.ts importing `./document` directly
// again, the child exits non-zero with ERR_PACKAGE_PATH_NOT_EXPORTED for `@react-pdf/hyphenate`.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

// The in-process half: the seam itself. If render-pdf imported the document module statically, this
// mock's factory would run on import and throw — the lazy `import("./document")` is what keeps it out.
vi.mock("@/lib/billing/factura/document", () => {
	throw new Error("the фактура document module was evaluated at import time");
});

/** The console package root, which the child runs in so `tsx` and the `@/` paths resolve. */
const CONSOLE_ROOT = resolve(__dirname, "../../..");

/** The child's entry: register the `server-only` mapping, then import provision and report. */
const CHILD = `
import nodeModule from "node:module";
import { pathToFileURL } from "node:url";
const base = pathToFileURL(process.cwd() + "/package.json").href;
const empty = pathToFileURL(nodeModule.createRequire(base).resolve("next/dist/compiled/server-only/empty.js")).href;
nodeModule.registerHooks({
	resolve: (specifier, context, next) =>
		specifier === "server-only" ? { url: empty, shortCircuit: true } : next(specifier, context),
});
const mod = await import(pathToFileURL(process.cwd() + "/lib/platform/provision.ts").href);
process.stdout.write(typeof mod.provisionOrg === "function" ? "LOADED" : "NO-EXPORT");
process.exit(0);
`;

describe("the фактура render seam", () => {
	it("imports without evaluating the PDF document module", async () => {
		const mod = await import("@/lib/billing/factura/render-pdf");
		expect(typeof mod.renderFacturaPdf).toBe("function");
	});
});

describe("lib/platform/provision under plain tsx", () => {
	it("loads without evaluating the фактура PDF renderer", () => {
		const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", CHILD], {
			cwd: CONSOLE_ROOT,
			encoding: "utf8",
			timeout: 60_000,
		});
		// stderr rides along in the compared object so a failure's diff names the module that refused.
		expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({
			status: 0,
			stdout: "LOADED",
			stderr: expect.any(String),
		});
	});
});
