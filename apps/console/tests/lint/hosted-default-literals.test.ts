// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// No hosted-domain literal in the call sites EDN-H7 (#6904) cleared of hosted defaults.
//
// THE DEFECT. Four call sites fell back to the hosted service when the instance's own URL was
// unset: `process.env.NEXT_PUBLIC_APP_URL ?? "https://alethialabs.io"`. On a self-hosted instance
// that handed deployed runners, the SSO page's SP URLs and the connect flows' OIDC issuer to
// Alethia Labs' hosted service — the opposite of "contacts only the services you configure".
//
// THE RULE. Under the paths below, no STRING LITERAL (plain, or any piece of a template) names the
// hosted domain. The hosted asset bucket may appear only as the initializer of the one constant
// `connector-assets.ts` gates on the instance edition contract (`HOSTED_ASSET_ORIGIN`). Literals
// are found with the TypeScript parser, not a regex over the file, so a comment (the SPDX header
// carries the domain in an email address) is not read, and a literal is not missed because the
// `//` in `https://` looks like a comment to a line-based strip.
//
// SCOPE, stated so a green run is not read as wider than it is: exactly the four files in
// `GUARDED`. A hosted URL assembled from fragments at runtime, or read from a module outside these
// paths, is not seen.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const CONSOLE = join(__dirname, "..", "..");

/** The call sites EDN-H7 named (its `scope:`). */
const GUARDED = [
	"app/server/actions/runners.ts",
	"app/api/cli/runners/deploy/route.ts",
	"lib/rpc/procedures/sso.ts",
	"components/connectors/connector-assets.ts",
];

/** The hosted service's domain, as a host or a host suffix. */
const HOSTED_DOMAIN = /(^|[^a-z0-9-])alethialabs\.(io|com)\b/i;

/** The hosted public-read connector asset bucket's host. */
const HOSTED_BUCKET = /alethia-connector-assets\.s3\./i;

/** One string literal found in a file: its text and the name of the constant it initializes, if any. */
interface FoundLiteral {
	text: string;
	line: number;
	initializes: string | null;
}

/** Every string literal and template piece in `source`, with the constant each one initializes. */
function stringLiterals(fileName: string, source: string): FoundLiteral[] {
	const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
	const found: FoundLiteral[] = [];

	/** Collects the literals under `node`. */
	const visit = (node: ts.Node): void => {
		if (
			ts.isStringLiteral(node) ||
			ts.isNoSubstitutionTemplateLiteral(node) ||
			ts.isTemplateHead(node) ||
			ts.isTemplateMiddle(node) ||
			ts.isTemplateTail(node)
		) {
			const parent = node.parent;
			const initializes =
				ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)
					? parent.name.text
					: null;
			found.push({
				text: node.text,
				line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
				initializes,
			});
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}

/** The violations in one file's source, as `file:line "text"` strings. */
function violations(fileName: string, source: string): string[] {
	const out: string[] = [];
	for (const lit of stringLiterals(fileName, source)) {
		if (HOSTED_DOMAIN.test(lit.text)) out.push(`${fileName}:${lit.line} ${JSON.stringify(lit.text)}`);
		else if (HOSTED_BUCKET.test(lit.text) && lit.initializes !== "HOSTED_ASSET_ORIGIN")
			out.push(`${fileName}:${lit.line} ${JSON.stringify(lit.text)}`);
	}
	return out;
}

describe("hosted-default literals under the EDN-H7 paths (#6904)", () => {
	it.each(GUARDED)("%s names no hosted-domain literal", (path) => {
		const source = readFileSync(join(CONSOLE, path), "utf8");
		expect(violations(path, source)).toEqual([]);
	});

	// The detector itself, against the shapes the four files used to carry. Without this a parser
	// change that found no literals at all would pass every row above.
	it("flags the pre-#6904 fallback shapes and ignores comments", () => {
		const before = [
			`// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>`,
			`const a = process.env.NEXT_PUBLIC_APP_URL ?? "https://alethialabs.io";`,
			"const b = `${process.env.NEXT_PUBLIC_APP_URL ?? \"https://alethialabs.io\"}/api/oidc`;",
			"const c = `https://alethialabs.io/${slug}`;",
			`const ASSET_ORIGIN = process.env.X ?? "https://alethia-connector-assets.s3.eu-west-1.amazonaws.com";`,
			`const HOSTED_ASSET_ORIGIN = "https://alethia-connector-assets.s3.eu-west-1.amazonaws.com";`,
			`const image = "ghcr.io/alethialabs-io/runner";`,
		].join("\n");
		const found = violations("fixture.ts", before);
		expect(found).toHaveLength(4);
		expect(found.map((v) => v.split(" ")[0])).toEqual([
			"fixture.ts:2",
			"fixture.ts:3",
			"fixture.ts:4",
			"fixture.ts:5",
		]);
	});
});
