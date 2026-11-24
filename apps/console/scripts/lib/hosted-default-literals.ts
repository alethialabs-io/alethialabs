// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The detector behind the EDN-H7 (#6904) guard: no hosted-domain literal in the call sites that
// were cleared of hosted defaults. Its test is tests/lint/hosted-default-literals.test.ts.
//
// THE DEFECT. Four call sites fell back to the hosted service when the instance's own URL was
// unset (`process.env.NEXT_PUBLIC_APP_URL ?? <hosted origin>`). On a self-hosted instance that
// handed deployed runners, the SSO page's SP URLs and the connect flows' OIDC issuer to Alethia
// Labs' hosted service.
//
// THE RULE. Under `HOSTED_DEFAULT_GUARDED`, no STRING LITERAL (plain, or any piece of a template)
// names the hosted domain. The hosted asset bucket may appear only as the initializer of the one
// constant `connector-assets.ts` gates on the instance edition contract (`HOSTED_ASSET_ORIGIN`).
// Literals are found with the TypeScript parser, not a regex over the file, so a comment (the SPDX
// header carries the domain in an email address) is not read, and a literal is not missed because
// the `//` in `https://` looks like a comment to a line-based strip.
//
// SCOPE: exactly the files in `HOSTED_DEFAULT_GUARDED`. A hosted URL assembled from fragments at
// runtime, or read from a module outside these paths, is not seen.

import ts from "typescript";

/** The call sites EDN-H7 named (its `scope:`), relative to apps/console. */
export const HOSTED_DEFAULT_GUARDED: readonly string[] = [
	"app/server/actions/runners.ts",
	"app/api/cli/runners/deploy/route.ts",
	"lib/rpc/procedures/sso.ts",
	"components/connectors/connector-assets.ts",
];

/** The hosted service's domain, as a host or a host suffix. */
const HOSTED_DOMAIN = /\balethialabs\.(io|com)\b/i;

/** The hosted public-read connector asset bucket's host. */
const HOSTED_BUCKET = /alethia-connector-assets\.s3\./i;

/** The one constant allowed to hold the hosted bucket. */
const GATED_BUCKET_CONSTANT = "HOSTED_ASSET_ORIGIN";

/** One string literal found in a file: its text, line, and the constant it initializes, if any. */
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

/** The hosted-default violations in one file's source, as `file:line "text"` strings. */
export function hostedDefaultViolations(fileName: string, source: string): string[] {
	const out: string[] = [];
	for (const lit of stringLiterals(fileName, source)) {
		const hostedDomain = HOSTED_DOMAIN.test(lit.text);
		const ungatedBucket = HOSTED_BUCKET.test(lit.text) && lit.initializes !== GATED_BUCKET_CONSTANT;
		if (hostedDomain || ungatedBucket) out.push(`${fileName}:${lit.line} ${JSON.stringify(lit.text)}`);
	}
	return out;
}
