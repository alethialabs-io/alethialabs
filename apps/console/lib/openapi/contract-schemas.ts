// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { componentSchemaWire } from "@/lib/cli/project-components";
import * as cliContract from "@/lib/validations/cli-contract";

/**
 * The modules that hold the wire contract `cliJson` checks answers against, and the schemas each
 * exports. Almost all of it is `lib/validations/cli-contract.ts`; the component-kind registry's
 * document (`componentSchemaWire`) is defined beside the registry it describes.
 *
 * The document names a response component after its export here, and refuses a response schema
 * that is not one of these; the drift test treats a `cliJson` answer as contracted only when its
 * schema is imported from one of these modules.
 */
export const CONTRACT_MODULES: ReadonlyArray<{
	readonly specifier: string;
	readonly exports: ReadonlyArray<readonly [string, unknown]>;
}> = [
	{ specifier: "@/lib/validations/cli-contract", exports: Object.entries(cliContract) },
	{ specifier: "@/lib/cli/project-components", exports: [["componentSchemaWire", componentSchemaWire]] },
];

/** The export name of a contract schema, or undefined when no contract module exports it. */
export function contractExportName(schema: unknown): string | undefined {
	for (const contractModule of CONTRACT_MODULES) {
		for (const [name, value] of contractModule.exports) if (value === schema) return name;
	}
	return undefined;
}
