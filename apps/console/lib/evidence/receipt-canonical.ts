// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { VerifyReceiptBody } from "@/types/jsonb.types";

/**
 * Serializes a receipt body to the exact bytes Go's `encoding/json` produces for
 * `verify.Receipt` (`canonicalBytes` in packages/core/verify/receipt.go): struct
 * fields in declaration order, `omitempty` fields dropped when empty, map keys
 * sorted. This is the single source of truth for the canonical receipt bytes on the
 * console side — the ed25519 receipt signature (receipt-sign.ts) and the Rekor
 * anchor digest (receipt-anchor.ts) both sign/hash over exactly these bytes, so they
 * MUST stay byte-identical to the Go signer or verification breaks across the twins.
 */
export function canonicalReceiptJson(body: VerifyReceiptBody): string {
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
