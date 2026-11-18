// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Every wizard definition in the console, held to the same two things.
//
// A definition lives in a file named `*.wizard.ts`. This test finds those files by name, loads
// each, and asserts for every definition it exports that
//   - it is complete: every key of the submit schema is owned by exactly one step, and
//   - no key of its draft schema has a name that suggests a credential or a payment detail.
// So a field added to a wizard without an owner fails here, on the PR that adds it.
//
// The name check is a heuristic. What keeps a field out of a draft is that the draft schema has
// to list it; `defineWizard` refuses a draft schema that could keep more than it lists
// (tests/lib/wizard/define.test.ts), and tests/lib/wizard/draft.test.ts reads the stored text.
//
// The search covers the console's source directories, this one included: the fixture next to
// this file is a `*.wizard.ts`, so "found nothing" can never be read as "nothing wrong".

import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertWizardComplete,
	isWizardDefinition,
	sensitiveDraftKeys,
} from "@/lib/wizard/define";

const CONSOLE_DIR = path.resolve(import.meta.dirname, "../../..");

/** The directories a definition may live in. */
const SOURCE_DIRS = ["app", "components", "hooks", "lib", "tests"];

/** Every `*.wizard.ts` under `dir`, as absolute paths. */
function definitionFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "node_modules") found.push(...definitionFiles(full));
		} else if (entry.name.endsWith(".wizard.ts")) {
			found.push(full);
		}
	}
	return found;
}

const FILES = SOURCE_DIRS.flatMap((dir) => definitionFiles(path.join(CONSOLE_DIR, dir))).sort();

/** The wizard definitions among a module's exports. */
async function definitionsIn(file: string) {
	const loaded: unknown = await import(/* @vite-ignore */ file);
	if (typeof loaded !== "object" || loaded === null) return [];
	return Object.values(loaded).filter(isWizardDefinition);
}

describe("wizard definitions (*.wizard.ts)", () => {
	it("finds the definition files, the fixture among them", () => {
		expect(FILES.map((file) => path.relative(CONSOLE_DIR, file))).toContain(
			path.join("tests", "lib", "wizard", "fixtures", "example.wizard.ts"),
		);
	});

	it.each(FILES.map((file) => [path.relative(CONSOLE_DIR, file), file]))(
		"%s exports complete definitions with no sensitive draft key",
		async (_relative, file) => {
			const definitions = await definitionsIn(file);
			expect(definitions.length).toBeGreaterThan(0);
			for (const definition of definitions) {
				expect(() => assertWizardComplete(definition)).not.toThrow();
				const draft = definition.draft;
				expect(draft === null ? [] : sensitiveDraftKeys(draft.schema)).toEqual([]);
			}
		},
	);
});
