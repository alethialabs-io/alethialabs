// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The caught-error lint rule (#6650): in console server code, `console.error` / `console.warn` may
// not be handed a caught error; it goes through `log.error(msg, { err })`. These cases run the
// console's REAL eslint.config.mjs over source text at a path the rule's `files` covers, so a
// broken selector, a narrowed `files` glob or a dropped block fails here, not silently in CI.

import path from "node:path";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

const CONSOLE_DIR = path.resolve(import.meta.dirname, "../..");
const MESSAGE = "Report a caught error through the structured logger: log.error(msg, { err }).";

let eslint: ESLint;

beforeAll(() => {
	eslint = new ESLint({ cwd: CONSOLE_DIR, overrideConfigFile: "eslint.config.mjs" });
});

/** How many times the caught-error rule fires on `code` linted as if it lived at `file`. */
async function hits(code: string, file = "lib/lint-fixture/server-module.ts"): Promise<number> {
	const [result] = await eslint.lintText(code, { filePath: path.join(CONSOLE_DIR, file) });
	return result.messages.filter((m) => m.message === MESSAGE).length;
}

describe("caught-error lint rule (#6650)", () => {
	it.each([
		["a caught error passed to console.error", 'try {} catch (err) { console.error("x", err); }'],
		["a member of a caught error passed to console.warn", 'const err = new Error(); console.warn("x", err.message);'],
		["an error identifier under another listed name", 'try {} catch (e) { console.warn("x", e); }'],
		["a member chain rooted at a caught error", 'const err = new Error(); console.error(err.cause.stack);'],
		["a caught error interpolated into a template literal", 'try {} catch (error) { console.error(`x: ${error}`); }'],
		["a caught error's member interpolated", 'const err = new Error(); console.error(`x: ${err.message}`);'],
		["a caught error wrapped in a call", 'const err = new Error(); console.error(JSON.stringify(err));'],
	])("fires on %s", async (_name, code) => {
		expect(await hits(code)).toBe(1);
	});

	it("fires in app/ route code too", async () => {
		expect(
			await hits('try {} catch (err) { console.error("x", err); }', "app/api/lint-fixture/route.ts"),
		).toBe(1);
	});

	it.each([
		["the structured logger", 'declare const log: { error(m: string, f: object): void }; try {} catch (err) { log.error("x", { err }); }'],
		["a plain string", 'console.error("plain string");'],
		["a template literal with no error in it", 'const id = 1; console.warn(`job ${id} refused`);'],
		["a member whose PROPERTY merely shares a listed name", 'const r = { reason: "x" }; console.warn("x", r.reason);'],
		["console.log of an error", 'const err = new Error(); console.log(err);'],
	])("does not fire on %s", async (_name, code) => {
		expect(await hits(code)).toBe(0);
	});

	it("does not fire in a \"use client\" .ts module", async () => {
		expect(await hits('"use client";\ntry {} catch (err) { console.error("x", err); }')).toBe(0);
	});

	it.each([
		["a .tsx component", "lib/lint-fixture/widget.tsx"],
		["a test", "tests/lint-fixture/thing.test.ts"],
		["a co-located test", "lib/lint-fixture/thing.test.ts"],
		["the browser-reachable billing intent helper", "lib/billing/intent-error.ts"],
	])("does not apply to %s", async (_name, file) => {
		expect(await hits('try {} catch (err) { console.error("x", err); }', file)).toBe(0);
	});

	it("keeps the useSession guard applying to the files this rule covers", async () => {
		const [result] = await eslint.lintText("declare const a: { useSession(): void }; a.useSession();", {
			filePath: path.join(CONSOLE_DIR, "lib/lint-fixture/server-module.ts"),
		});
		expect(result.messages.some((m) => m.message.includes("useViewer()"))).toBe(true);
	});
});
