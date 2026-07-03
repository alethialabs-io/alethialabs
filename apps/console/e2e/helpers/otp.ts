// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Reads the email-OTP code out of the dev console log. In local dev (no SES) the sign-in code
// is logged by packages/email/src/send.ts as `… (sign-in code: 123456)`; `pnpm dev:up` tees the
// console output to /tmp/alethia-dev-console.log. This is deliberately the only brittle seam in
// the e2e auth path — override the path with DEV_CONSOLE_LOG if your stack logs elsewhere.

import { readFile, stat } from "node:fs/promises";

const LOG_PATH = process.env.DEV_CONSOLE_LOG ?? "/tmp/alethia-dev-console.log";
const CODE_RE = /sign-in code:\s*(\d{6})/g;

/** Current byte size of the log — capture this BEFORE requesting a code so we ignore stale ones. */
export async function logCursor(): Promise<number> {
	return stat(LOG_PATH)
		.then((s) => s.size)
		.catch(() => 0);
}

/**
 * Polls the dev log for the latest `sign-in code:` that appears after `cursor` bytes, returning
 * the 6-digit code. Throws a clear message if none shows up (stack not running, or SES is
 * actually configured so the code never hits the log).
 */
export async function waitForOtp(
	cursor = 0,
	{ timeoutMs = 20_000, intervalMs = 250 } = {},
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const text = await readFile(LOG_PATH, "utf8").catch(() => "");
		const matches = [...text.slice(cursor).matchAll(CODE_RE)];
		const last = matches.at(-1);
		if (last) return last[1];
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(
		`No "sign-in code:" appeared in ${LOG_PATH} within ${timeoutMs}ms. ` +
			"Is `pnpm dev:up` running with SES unconfigured (so the OTP is logged)?",
	);
}
