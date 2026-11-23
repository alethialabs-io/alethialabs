// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// No hosted-domain literal in the call sites EDN-H7 (#6904) cleared of hosted defaults. The rule,
// its boundary and the detector live in scripts/lib/hosted-default-literals.ts; this file runs it
// over the real files and checks the detector against the shapes those files used to carry.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	HOSTED_DEFAULT_GUARDED,
	hostedDefaultViolations,
} from "../../scripts/lib/hosted-default-literals";

const CONSOLE = join(__dirname, "..", "..");

describe("hosted-default literals under the EDN-H7 paths (#6904)", () => {
	it.each(HOSTED_DEFAULT_GUARDED)("%s names no hosted-domain literal", (path) => {
		const source = readFileSync(join(CONSOLE, path), "utf8");
		expect(hostedDefaultViolations(path, source)).toEqual([]);
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
		const found = hostedDefaultViolations("fixture.ts", before);
		expect(found.map((v) => v.split(" ")[0])).toEqual([
			"fixture.ts:2",
			"fixture.ts:3",
			"fixture.ts:4",
			"fixture.ts:5",
		]);
	});

	it("guards exactly the four EDN-H7 call sites", () => {
		expect(HOSTED_DEFAULT_GUARDED).toHaveLength(4);
	});
});
