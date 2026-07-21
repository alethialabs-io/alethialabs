// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	createHash,
	generateKeyPairSync,
	type KeyObject,
	sign as ecSign,
} from "node:crypto";
import { canonicalReceiptJson } from "@/lib/evidence/receipt-canonical";
import {
	AnchorVerificationError,
	verifyAnchorOffline,
} from "@/lib/evidence/receipt-anchor";
import type { RekorAnchor, SignedReceipt, VerifyReceiptBody } from "@/types/jsonb.types";
import { describe, expect, it } from "vitest";

/** A minimal, fully-populated receipt body (all fields canonicalReceiptJson reads). */
function testReceipt(): SignedReceipt {
	const body: VerifyReceiptBody = {
		version: "elench-receipt-1",
		plan_sha256: "abc123",
		catalog_version: "elench-controls-0.4.0",
		provider: "aws",
		verdict: "pass",
		report: {
			verdict: "pass",
			catalog_version: "elench-controls-0.4.0",
			provider: "aws",
			controls: [],
			summary: { pass: 1, fail: 0, warn: 0, not_evaluable: 0 },
		},
		evaluated_at: "2026-07-21T00:00:00Z",
	};
	return { receipt: body, algorithm: "ed25519", key_id: "deadbeef", signature: "c2ln" };
}

function rfc6962Leaf(leaf: Buffer): Buffer {
	return createHash("sha256").update(Buffer.concat([Buffer.from([0x00]), leaf])).digest();
}
function rfc6962Node(l: Buffer, r: Buffer): Buffer {
	return createHash("sha256").update(Buffer.concat([Buffer.from([0x01]), l, r])).digest();
}

/** Builds a valid anchor (two-leaf tree, entry at `index`) and returns it + the log key. */
function buildAnchor(receipt: SignedReceipt, index: number): { anchor: RekorAnchor; logKey: KeyObject } {
	const log = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const anchorKp = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

	const canonical = canonicalReceiptJson(receipt.receipt);
	const digest = createHash("sha256").update(canonical, "utf8").digest();
	const anchorSigB64 = ecSign("sha256", Buffer.from(canonical, "utf8"), anchorKp.privateKey).toString("base64");
	const anchorPubB64 = Buffer.from(
		anchorKp.publicKey.export({ type: "spki", format: "pem" }) as string,
		"utf8",
	).toString("base64");

	const body = {
		kind: "hashedrekord",
		apiVersion: "0.0.1",
		spec: {
			data: { hash: { algorithm: "sha256", value: digest.toString("hex") } },
			signature: { content: anchorSigB64, publicKey: { content: anchorPubB64 } },
		},
	};
	const bodyBytes = Buffer.from(JSON.stringify(body), "utf8");
	const bodyB64 = bodyBytes.toString("base64");

	const ourLeaf = rfc6962Leaf(bodyBytes);
	const otherLeaf = rfc6962Leaf(Buffer.from("sibling"));
	const root = index === 0 ? rfc6962Node(ourLeaf, otherLeaf) : rfc6962Node(otherLeaf, ourLeaf);

	const logDer = log.publicKey.export({ type: "spki", format: "der" }) as Buffer;
	const logID = createHash("sha256").update(logDer).digest("hex");
	const integratedTime = 1_700_000_000;

	const setBytes = Buffer.from(
		`{"body":${JSON.stringify(bodyB64)},"integratedTime":${integratedTime},"logID":${JSON.stringify(logID)},"logIndex":${index}}`,
		"utf8",
	);
	const setB64 = ecSign("sha256", setBytes, log.privateKey).toString("base64");
	const checkpoint = `rekor.test\n2\n${root.toString("base64")}\n\n— rekor.test c2ln\n`;

	const anchor: RekorAnchor = {
		log_url: "https://rekor.test",
		log_id: logID,
		log_index: index,
		integrated_time: integratedTime,
		body: bodyB64,
		signed_entry_timestamp: setB64,
		anchor_algorithm: "ecdsa-p256-sha256",
		anchor_signature: anchorSigB64,
		anchor_public_key: anchorPubB64,
		inclusion_proof: {
			log_index: index,
			root_hash: root.toString("hex"),
			tree_size: 2,
			hashes: [otherLeaf.toString("hex")],
			checkpoint,
		},
	};
	return { anchor, logKey: log.publicKey };
}

describe("verifyAnchorOffline", () => {
	it("accepts a valid anchor at either leaf position", () => {
		for (const index of [0, 1]) {
			const receipt = testReceipt();
			const { anchor, logKey } = buildAnchor(receipt, index);
			expect(() => verifyAnchorOffline(receipt, anchor, logKey)).not.toThrow();
		}
	});

	it("rejects a tampered receipt", () => {
		const receipt = testReceipt();
		const { anchor, logKey } = buildAnchor(receipt, 0);
		const tampered = { ...receipt, receipt: { ...receipt.receipt, plan_sha256: "deadbeef" } };
		expect(() => verifyAnchorOffline(tampered, anchor, logKey)).toThrow(AnchorVerificationError);
	});

	it("rejects a wrong log key", () => {
		const receipt = testReceipt();
		const { anchor } = buildAnchor(receipt, 0);
		const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
		expect(() => verifyAnchorOffline(receipt, anchor, other.publicKey)).toThrow(AnchorVerificationError);
	});

	it.each([
		["flipped audit hash", (a: RekorAnchor) => { a.inclusion_proof.hashes = [Buffer.alloc(32).toString("hex")]; }],
		["wrong root", (a: RekorAnchor) => { a.inclusion_proof.root_hash = Buffer.alloc(32).toString("hex"); }],
		["forged SET", (a: RekorAnchor) => { a.signed_entry_timestamp = Buffer.from("nope").toString("base64"); }],
		["checkpoint mismatch", (a: RekorAnchor) => { a.inclusion_proof.checkpoint = `rekor.test\n99\n${Buffer.alloc(32).toString("base64")}\n\n— rekor.test c2ln\n`; }],
	])("rejects: %s", (_name, mutate) => {
		const receipt = testReceipt();
		const { anchor, logKey } = buildAnchor(receipt, 0);
		mutate(anchor);
		expect(() => verifyAnchorOffline(receipt, anchor, logKey)).toThrow(AnchorVerificationError);
	});
});
