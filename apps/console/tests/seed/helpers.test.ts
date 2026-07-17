// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { makeIds, uuidv5 } from "@/lib/seed/ids";
import { signReceipt } from "@/lib/seed/receipt-sign";
import type { VerifyReceiptBody } from "@/types/jsonb.types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function sampleBody(): VerifyReceiptBody {
	const report = {
		verdict: "pass" as const,
		catalog_version: "2026.07.1",
		provider: "aws",
		controls: [{ id: "iam-001", title: "No static keys", severity: "high" as const, status: "pass" as const, provider: "aws" }],
		summary: { pass: 1, fail: 0, warn: 0, not_evaluable: 0 },
	};
	return {
		version: "1",
		plan_sha256: "d00afee3a0a1aa46d3814c234df364d0ffee658def91126693e00cea6ab0f0c9",
		provider_versions: { helm: "2.14.0", aws: "5.62.0" },
		catalog_version: "2026.07.1",
		provider: "aws",
		verdict: "pass",
		report,
	};
}

describe("seed ids", () => {
	it("produces valid, deterministic v5 uuids", () => {
		expect(uuidv5("x")).toMatch(UUID_RE);
		expect(uuidv5("x")).toBe(uuidv5("x"));
		expect(uuidv5("x")).not.toBe(uuidv5("y"));
	});

	it("scopes ids by slug so different demo orgs never collide", () => {
		const a = makeIds("demo-acme");
		const b = makeIds("demo-globex");
		expect(a("project:payments")).toBe(a("project:payments"));
		expect(a("project:payments")).not.toBe(b("project:payments"));
	});
});

describe("signReceipt", () => {
	const prev = process.env.ALETHIA_RECEIPT_SIGNING_KEY;
	afterEach(() => {
		if (prev === undefined) delete process.env.ALETHIA_RECEIPT_SIGNING_KEY;
		else process.env.ALETHIA_RECEIPT_SIGNING_KEY = prev;
	});

	it("emits an honestly-unsigned receipt when no key is set", () => {
		delete process.env.ALETHIA_RECEIPT_SIGNING_KEY;
		const r = signReceipt(sampleBody());
		expect(r.algorithm).toBe("none");
		expect(r.signature).toBeUndefined();
		expect(r.receipt.plan_sha256).toBe(sampleBody().plan_sha256);
	});

	it("signs deterministically with a demo ed25519 key", () => {
		const priv = generateKeyPairSync("ed25519").privateKey;
		const jwk = priv.export({ format: "jwk" }) as { d: string; x: string };
		const key64 = Buffer.concat([Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url")]);
		expect(key64.length).toBe(64);
		process.env.ALETHIA_RECEIPT_SIGNING_KEY = key64.toString("base64");

		const r1 = signReceipt(sampleBody());
		const r2 = signReceipt(sampleBody());
		expect(r1.algorithm).toBe("ed25519");
		expect(r1.key_id).toMatch(/^[0-9a-f]{16}$/);
		expect(r1.signature).toBeTruthy();
		// Deterministic — same body + key ⇒ identical signature.
		expect(r1.signature).toBe(r2.signature);
	});
});
