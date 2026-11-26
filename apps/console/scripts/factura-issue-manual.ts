// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Issues a manual фактура or credit note (L6b): one no checkout produced — the monthly фактура to
// Paddle.com Market Ltd for the month's net supplier proceeds, an Enterprise contract. The document,
// the VAT treatment and the idempotency rules are described in lib/billing/factura/manual.ts; the
// flags and the JSON input in lib/billing/factura/manual-cli.ts (`--help` prints them).
//
// Usage (operator, against production):
//   pnpm creds prod-env -- pnpm -C apps/console run factura:issue-manual -- --file=paddle-2026-12.json
//   … and, once the printed document is right, the same command with --issue.
//
// DRY RUN BY DEFAULT: without `--issue` nothing is written and no number is taken. Reads
// ALETHIA_DATABASE_URL (the service connection) and the storage variables, the environment the
// console runs with. Exit codes: 0 — proposed or issued; 1 — invalid input or refused; 2 — usage.

import { readFile } from "node:fs/promises";
import { ISSUE_MANUAL_USAGE, runIssueManualCli } from "@/lib/billing/factura/manual-cli";

const argv = process.argv.slice(2).filter((a) => a !== "--");
if (argv.includes("--help")) {
	console.log(ISSUE_MANUAL_USAGE);
	process.exit(0);
}
runIssueManualCli(argv, {
	readFile: (path) => readFile(path, "utf8"),
	out: (line) => console.log(line),
	err: (line) => console.error(line),
	manual: {},
})
	.then((code) => process.exit(code))
	.catch((err: unknown) => {
		console.error(err);
		process.exit(1);
	});
