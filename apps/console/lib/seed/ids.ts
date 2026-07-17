// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";

/**
 * Deterministic UUIDv5 so the seeder is idempotent — the same logical entity
 * (org, project, environment, job…) always resolves to the same id, so re-runs
 * upsert instead of duplicating. No `uuid` dependency; built on node:crypto.
 */

// A fixed namespace for all Alethia demo-seed ids (itself a v4 uuid, arbitrary).
const DEMO_NAMESPACE = "a1e7f0de-0000-4000-8000-a1e7f0de0000";

/** RFC-4122 v5 (SHA-1) uuid of `name` within `namespace`. */
export function uuidv5(name: string, namespace = DEMO_NAMESPACE): string {
	const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
	const hash = createHash("sha1").update(ns).update(name, "utf8").digest();
	const b = hash.subarray(0, 16);
	b[6] = (b[6] & 0x0f) | 0x50; // version 5
	b[8] = (b[8] & 0x3f) | 0x80; // RFC-4122 variant
	const h = b.toString("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Builds a stable id factory scoped to one demo org's slug, so two different
 * demo slugs never collide in id space. `id("project:payments")`,
 * `id("project:payments/env/production")`, etc.
 */
export function makeIds(scope: string) {
	return (name: string) => uuidv5(`${scope}::${name}`);
}
