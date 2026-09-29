// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Writes packages/core/api/testdata/component_schema.json — the golden for the published
// component-kind registry, `GET /api/cli/schema/components` (#3671) — from the console's own
// builder, componentSchemaDocument().
//
// Before this existed the golden only CLAIMED to be dumped from the builder (#5140). Nothing
// produced it and nothing compared it, so when the builder's nullable encoding moved from
// `anyOf` to `type: [X, "null"]` the golden kept the old encoding and the old `version` hash,
// and every consumer stayed green: Go reads only `fields`, the TS helpers accept both
// encodings, and cli-contract.test.ts checks the golden against the wire SCHEMA, not against
// the BUILDER. tests/validations/component-schema-golden.test.ts is the comparison; this is the
// fix it names.
//
// The bytes are the builder's document, indented two spaces, run through the repo's prettier
// (the root devDependency, resolved with the golden's own path so any config that later applies
// to it applies here too).
// The test renders through this same function, so "byte for byte" means one formatter, not two
// that happen to agree today.
//
// Run: pnpm -C apps/console run gen:component-schema

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format, resolveConfig } from "prettier";
import { componentSchemaDocument } from "@/lib/cli/project-components";

/** Absolute path of the component-schema golden the Go and TS contract tests both read. */
export const COMPONENT_SCHEMA_GOLDEN = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../packages/core/api/testdata/component_schema.json",
);

/** The command that regenerates the golden — named in the drift test's failure message. */
export const REGENERATE_COMMAND = "pnpm -C apps/console run gen:component-schema";

/** Renders componentSchemaDocument() as the exact bytes the committed golden must hold. */
export async function renderComponentSchemaGolden(): Promise<string> {
	const options = (await resolveConfig(COMPONENT_SCHEMA_GOLDEN)) ?? {};
	// Indented, not compact: prettier keeps an object expanded when its input has a newline after
	// the `{`, so the input's layout is part of the output. Compact input collapses every short
	// object onto one line; indented input is what the committed golden was produced from.
	return format(JSON.stringify(componentSchemaDocument(), null, 2), {
		...options,
		filepath: COMPONENT_SCHEMA_GOLDEN,
	});
}

/** Writes the golden, reporting whether its bytes changed. */
async function main(): Promise<void> {
	const next = await renderComponentSchemaGolden();
	let previous = "";
	try {
		previous = readFileSync(COMPONENT_SCHEMA_GOLDEN, "utf8");
	} catch {
		// First write: there is nothing to compare against.
	}
	writeFileSync(COMPONENT_SCHEMA_GOLDEN, next);
	console.log(
		`${previous === next ? "unchanged" : "wrote"} packages/core/api/testdata/component_schema.json`,
	);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err: unknown) => {
		console.error(err);
		process.exit(1);
	});
}
