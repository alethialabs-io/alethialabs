// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// Maintainer tool: issue a signed Alethia Enterprise licence. Run offline, through the credential
// broker so the signing key exists only in this process's environment:
//
//   pnpm creds license-signing -- pnpm -F console exec tsx ../../ee/scripts/issue-license.ts \
//     --subject "Example GmbH" --days 365
//
// `--help` prints every option. The logic, and its tests, live in ../src/license-issue.ts.

import { readFileSync } from "node:fs";
import { runIssueLicense } from "../src/license-issue";

/** Runs the tool against this process and sets its exit code. */
async function main(): Promise<void> {
	process.exitCode = await runIssueLicense(process.argv.slice(2), {
		env: process.env,
		readFile: (path) => readFileSync(path, "utf8"),
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
		now: () => new Date(),
	});
}

void main();
