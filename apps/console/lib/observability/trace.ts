// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { randomBytes } from "node:crypto";

/**
 * Mints a fresh W3C `traceparent` (version 00, sampled): a random 16-byte
 * trace-id + 8-byte span-id, formatted `00-<32hex>-<16hex>-01`. Stamped on a job
 * at enqueue so the console → runner hops share one trace-id and their spans/logs
 * correlate. See https://www.w3.org/TR/trace-context/#traceparent-header.
 */
export function newTraceparent(): string {
	const traceId = randomBytes(16).toString("hex"); // 32 hex chars
	const spanId = randomBytes(8).toString("hex"); // 16 hex chars
	return `00-${traceId}-${spanId}-01`;
}

/**
 * Extracts the 32-hex trace-id (the middle segment) from a `traceparent`, or
 * `null` if the string isn't a well-formed version-00 traceparent. Used to attach
 * `trace_id` to structured logs.
 */
export function traceIdFromTraceparent(
	traceparent: string | null | undefined,
): string | null {
	if (!traceparent) return null;
	const m = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(traceparent);
	return m ? m[1] : null;
}
