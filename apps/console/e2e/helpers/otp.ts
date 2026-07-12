// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Reads the email-OTP code out of the console's stdout log — the hermetic auth seam. In local
// dev / CI (no SES configured) the sign-in code is logged by @repo/email/send.ts on a single line:
//   [email] SES not configured — "…" → <recipient> (sign-in code: 123456)
// so the recipient address and the code sit together. `pnpm dev:up` tees the console output to
// /tmp/alethia-dev-console.log; the CI e2e-browser job tees `next start` to $DEV_CONSOLE_LOG.
// No real email, no external service — the only log-scraping seam in the whole auth path, and it
// matches per-recipient so parallel signups can never read each other's code.

import { readFile, stat } from "node:fs/promises";

/** Where the console's stdout (incl. the OTP line) is teed. Overridable for CI / non-standard stacks. */
export const LOG_PATH = process.env.DEV_CONSOLE_LOG ?? "/tmp/alethia-dev-console.log";

/** Escapes a string for safe embedding in a RegExp (the recipient email carries `.`, `+`, etc.). */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Current byte size of the log — capture BEFORE requesting a code to skip already-logged codes. NB:
 * correctness against a cross-test race comes from the per-recipient `email` match in waitForOtp (each
 * signup uses a unique address); this cursor is only a best-effort skip of prior content, and it is a
 * BYTE offset (sliced byte-accurately below), not a string index.
 */
export async function logCursor(): Promise<number> {
	return stat(LOG_PATH)
		.then((s) => s.size)
		.catch(() => 0);
}

interface WaitForOtpOptions {
	/** When set, only match a `sign-in code:` on the same log line as this recipient — kills any
	 * cross-test race when multiple signups interleave in one shared log. */
	email?: string;
	timeoutMs?: number;
	intervalMs?: number;
}

/**
 * Polls the console log for the newest 6-digit sign-in code appearing after `cursor` bytes (and,
 * when `email` is given, on a line addressed to that recipient), returning it as a string. Throws
 * a clear, actionable error if none shows up within the timeout (stack not running, or SES is
 * configured so the code was emailed instead of logged).
 */
export async function waitForOtp(
	cursor = 0,
	{ email, timeoutMs = 30_000, intervalMs = 250 }: WaitForOtpOptions = {},
): Promise<string> {
	// Per-recipient when we know the email (recipient precedes the code on the warn line); generic
	// otherwise. Fresh RegExp per read — `g` regexes carry lastIndex state across calls.
	const pattern = () =>
		email
			? new RegExp(`${escapeRegExp(email)}[^\\n]*?sign-in code:\\s*(\\d{6})`, "g")
			: /sign-in code:\s*(\d{6})/g;

	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		// Read as raw bytes and slice at the BYTE cursor before decoding: `cursor` is a byte offset
		// (stat().size), so slicing the utf8-decoded string by it would drift on multi-byte chars
		// (the OTP line itself carries `—`/`→`) and could skip past a fresh code.
		const buf = await readFile(LOG_PATH).catch(() => Buffer.alloc(0));
		const text = buf.subarray(cursor).toString("utf8");
		const matches = [...text.matchAll(pattern())];
		const last = matches.at(-1);
		if (last) return last[1];
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(
		`No "sign-in code:"${email ? ` for ${email}` : ""} appeared in ${LOG_PATH} within ${timeoutMs}ms. ` +
			"Is the console running with SES unconfigured (so the OTP is logged), and is DEV_CONSOLE_LOG " +
			"pointed at its stdout? Locally: `pnpm dev:up`. In CI: the e2e-browser job tees `next start`.",
	);
}
