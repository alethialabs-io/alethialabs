// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, createPrivateKey, sign as edSign } from "node:crypto";
import type { SignedReceipt, VerifyReceiptBody } from "@/types/jsonb.types";

/**
 * Signs a demo evidence receipt the same way `packages/core/verify` does — an
 * ed25519 signature over the canonical JSON of the receipt body — so the seeded
 * receipt is a first-class `SignedReceipt` the Evidence surface renders in full.
 *
 * When `ALETHIA_RECEIPT_SIGNING_KEY` is unset it emits `algorithm:"none"` (a
 * legitimate, fully-rendering state). When set, it produces a real signature
 * with a **demo** key — honestly attesting only "the demo runner said so",
 * never customer-anchored trust. To byte-match Go's `json.Marshal(Receipt)` the
 * body is serialized in Go struct-declaration order with `omitempty` fields
 * omitted and map keys sorted.
 */

const SIGNING_KEY_ENV = "ALETHIA_RECEIPT_SIGNING_KEY";
// DER PKCS8 prefix for a raw 32-byte ed25519 seed.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Serializes the receipt body to the exact bytes Go's encoding/json produces. */
function canonicalReceiptJson(body: VerifyReceiptBody): string {
	const ordered: Record<string, unknown> = {};
	ordered.version = body.version;
	ordered.plan_sha256 = body.plan_sha256;
	if (body.tofu_version) ordered.tofu_version = body.tofu_version;
	if (body.provider_versions && Object.keys(body.provider_versions).length > 0) {
		ordered.provider_versions = sortObject(body.provider_versions);
	}
	ordered.catalog_version = body.catalog_version;
	ordered.provider = body.provider;
	ordered.verdict = body.verdict;
	// Go always emits `report` (pointer marshals its struct, never omitted here).
	ordered.report = {
		verdict: body.report.verdict,
		catalog_version: body.report.catalog_version,
		provider: body.report.provider,
		controls: body.report.controls.map((c) => {
			const oc: Record<string, unknown> = {
				id: c.id,
				title: c.title,
				severity: c.severity,
				status: c.status,
			};
			if (c.frameworks && c.frameworks.length > 0) oc.frameworks = c.frameworks;
			oc.provider = c.provider;
			if (c.findings && c.findings.length > 0) {
				oc.findings = c.findings.map((f) => ({ address: f.address, message: f.message }));
			}
			if (c.coverage) oc.coverage = c.coverage;
			return oc;
		}),
		summary: {
			pass: body.report.summary.pass,
			fail: body.report.summary.fail,
			warn: body.report.summary.warn,
			not_evaluable: body.report.summary.not_evaluable,
		},
	};
	if (body.exception) {
		const e: Record<string, unknown> = {
			controls: body.exception.controls,
			reason: body.exception.reason,
			by: body.exception.by,
		};
		if (body.exception.expiry) e.expiry = body.exception.expiry;
		ordered.exception = e;
	}
	if (body.runner) ordered.runner = body.runner;
	if (body.evaluated_at) ordered.evaluated_at = body.evaluated_at;
	return JSON.stringify(ordered);
}

/** Returns a new object with keys sorted (matches Go's sorted map marshaling). */
function sortObject(obj: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const k of Object.keys(obj).sort()) out[k] = obj[k];
	return out;
}

/** Wraps a receipt body in a `SignedReceipt`, signing it when a demo key is present. */
export function signReceipt(body: VerifyReceiptBody): SignedReceipt {
	const raw = process.env[SIGNING_KEY_ENV];
	if (!raw) return { receipt: body, algorithm: "none" };

	const keyBytes = Buffer.from(raw, "base64");
	if (keyBytes.length !== 64) {
		// Not a 64-byte ed25519 private key — degrade honestly to unsigned.
		return { receipt: body, algorithm: "none" };
	}
	const seed = keyBytes.subarray(0, 32);
	const publicKey = keyBytes.subarray(32, 64);
	const keyObject = createPrivateKey({
		key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
		format: "der",
		type: "pkcs8",
	});
	const message = Buffer.from(canonicalReceiptJson(body), "utf8");
	const signature = edSign(null, message, keyObject).toString("base64");
	const keyId = createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
	return { receipt: body, algorithm: "ed25519", key_id: keyId, signature };
}
