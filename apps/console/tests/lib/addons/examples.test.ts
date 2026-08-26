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
		expect(getAddOn(addonId)).not.toBeNull();
	});

	it.each(FILES)(
		"%s/%s is accepted by the add-on's own configSchema — a worked config the console would reject " +
			"is worse than none, because somebody pastes it and gets an error on a value we shipped",
		(addonId, file, path) => {
		const def = getAddOn(addonId);
		if (!def) return; // reported by the test above; do not fail twice for one cause
		const parsed = parseYaml(readFileSync(path, "utf8")) ?? {};
		const result = def.configSchema.safeParse(parsed);
		// The ISSUES are the actionable part, so assert on them rather than on the boolean: a failure
		// then prints which field and which value the configure form would reject, where `expected
		// false to be true` would print nothing at all.
		expect(result.success ? [] : result.error.issues).toEqual([]);
	});

	// THE ONE THAT CATCHES ROT. Zod strips unknown keys rather than failing, so a knob that was
	// renamed or misspelled parses cleanly and does nothing at all — the file still looks worked, and
	// the value it was written to set is silently dropped.
	it.each(FILES)(
		"%s/%s sets no key the add-on does not declare — Zod STRIPS unknown keys, so a renamed or " +
			"misspelled one parses cleanly and silently does nothing, leaving the file looking configured",
		(addonId, file, path) => {
		const def = getAddOn(addonId);
		if (!def) return;
		const known = declaredKeys(def.fields);
		const parsed = parseYaml(readFileSync(path, "utf8")) ?? {};
		expect(Object.keys(parsed).filter((k) => !known.has(k))).toEqual([]);
	});

	// A token pasted into a repository is a leaked token, whatever the file is called. The rule is
	// enforced rather than documented, because the documented version is the one that gets forgotten
	// at the moment somebody is trying to make an example "complete".
	it.each(FILES)(
		"%s/%s carries no secret value — a secret knob is stored encrypted at rest and belongs in the " +
			"configure form; a token pasted into a repository is a leaked token whatever the file is called",
		(addonId, file, path) => {
		const def = getAddOn(addonId);
		if (!def) return;
		const secrets = secretKeys(def.fields);
		const parsed = parseYaml(readFileSync(path, "utf8")) ?? {};
		expect(Object.keys(parsed).filter((k) => secrets.has(k))).toEqual([]);
	});
});
