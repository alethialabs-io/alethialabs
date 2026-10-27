// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a `?scan=` value can be a job id at all. The route skips the prefetch and the screen reads
 * nothing for one that cannot, and says the scan was not found — the read router would refuse the
 * input anyway. A plain module, not the `"use client"` hooks file, because the route (a server
 * component) calls it too.
 */
export function isScanJobId(value: string): boolean {
	return UUID.test(value);
}
