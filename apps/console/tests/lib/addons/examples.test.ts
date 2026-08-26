// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Every worked add-on configuration in `examples/addons/` must be one the console would ACCEPT.
//
// A reference library exists to be copied. A file in it that the configure form rejects is worse
// than no file: somebody pastes it, gets a validation error on a value we shipped, and now distrusts
// the whole directory. So each one is parsed against that add-on's own Zod `configSchema` — the same
// schema the server validates against — rather than against a second description of it.
//
// The unknown-key check is the load-bearing half. Zod strips unrecognised keys by default, so a
// typo'd or renamed knob would parse CLEANLY and silently do nothing — which is exactly how a worked
// configuration rots the first time a schema changes underneath it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { getAddOn } from "@/lib/addons/catalog";
import type { AddOnField } from "@/lib/addons/types";

const EXAMPLES = join(process.cwd(), "..", "..", "examples", "addons");

/** Every `<add-on>/<name>.yaml` under examples/addons, as [addonId, file, absolute path]. */
function exampleFiles(): [string, string, string][] {
	const out: [string, string, string][] = [];
	for (const addonId of readdirSync(EXAMPLES)) {
		const dir = join(EXAMPLES, addonId);
		if (!statSync(dir).isDirectory()) continue;
		for (const file of readdirSync(dir)) {
			if (file.endsWith(".yaml") || file.endsWith(".yml")) out.push([addonId, file, join(dir, file)]);
		}
	}
	return out;
}

/** Flatten a field descriptor tree into the top-level keys a config file may set. */
function declaredKeys(fields: AddOnField[]): Set<string> {
	return new Set(fields.map((f) => f.key));
}

/** Keys whose values are secrets — these must NEVER appear in a file here. */
function secretKeys(fields: AddOnField[]): Set<string> {
	return new Set(fields.filter((f) => f.type === "secret").map((f) => f.key));
}

const FILES = exampleFiles();

describe("examples/addons", () => {
	// VACUITY, first and by name. A rename or a moved directory makes `exampleFiles()` return
	// nothing, and every `it.each` below then passes by describing an empty set — the commonest way
	// a directory-scanning guard stops working without anyone noticing.
	it("finds files to check", () => {
		expect(FILES.length).toBeGreaterThan(0);
	});

	it.each(FILES)("%s/%s names a real catalog add-on", (addonId) => {
		expect(getAddOn(addonId), `examples/addons/${addonId}/ has no catalog entry`).not.toBeNull();
	});

	it.each(FILES)("%s/%s is accepted by the add-on's own configSchema", (addonId, file, path) => {
		const def = getAddOn(addonId);
		if (!def) return; // reported by the test above; do not fail twice for one cause
		const parsed = parseYaml(readFileSync(path, "utf8")) ?? {};
		const result = def.configSchema.safeParse(parsed);
		expect(
			result.success,
			`examples/addons/${addonId}/${file} would be REJECTED by the configure form: ` +
				(result.success ? "" : JSON.stringify(result.error.issues)),
		).toBe(true);
	});

	// THE ONE THAT CATCHES ROT. Zod strips unknown keys rather than failing, so a knob that was
	// renamed or misspelled parses cleanly and does nothing at all — the file still looks worked, and
	// the value it was written to set is silently dropped.
	it.each(FILES)("%s/%s sets no key the add-on does not declare", (addonId, file, path) => {
		const def = getAddOn(addonId);
		if (!def) return;
		const known = declaredKeys(def.fields);
		const parsed = parseYaml(readFileSync(path, "utf8")) ?? {};
		const unknown = Object.keys(parsed).filter((k) => !known.has(k));
		expect(
			unknown,
			`examples/addons/${addonId}/${file} sets ${JSON.stringify(unknown)}, which ${addonId} does not ` +
				`declare. Zod strips unknown keys silently, so this file would look configured and do nothing.`,
		).toEqual([]);
	});

	// A token pasted into a repository is a leaked token, whatever the file is called. The rule is
	// enforced rather than documented, because the documented version is the one that gets forgotten
	// at the moment somebody is trying to make an example "complete".
	it.each(FILES)("%s/%s carries no secret value", (addonId, file, path) => {
		const def = getAddOn(addonId);
		if (!def) return;
		const secrets = secretKeys(def.fields);
		const parsed = parseYaml(readFileSync(path, "utf8")) ?? {};
		const leaked = Object.keys(parsed).filter((k) => secrets.has(k));
		expect(
			leaked,
			`examples/addons/${addonId}/${file} sets the SECRET field(s) ${JSON.stringify(leaked)}. ` +
				`Secrets are stored encrypted at rest and belong in the configure form, never in this repo.`,
		).toEqual([]);
	});
});
