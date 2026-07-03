// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// SNS message signature verification (lib/email/sns-signature.ts) — pure crypto. We generate a real
// RSA keypair, sign the canonical string-to-sign ourselves (test fixture), serve the matching public
// key PEM via a mocked fetch boundary, and assert verifySnsSignature accepts genuine signatures and
// rejects every tampered/guard path. The cert fetch is the only mocked boundary; crypto is real.

import { createSign, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { verifySnsSignature } from "@/lib/email/sns-signature";
import type { SnsMessage } from "@/lib/validations/ses-event";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

// A second, unrelated key whose PEM will be served to exercise "right shape, wrong signer".
const otherPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const OTHER_PEM = otherPair.publicKey.export({ type: "spki", format: "pem" }).toString();

const fetchMock = vi.fn();

// certCache in the SUT is module-level and persists across tests; hand each test a unique cert URL.
let certSeq = 0;
function freshCertUrl(): string {
	certSeq += 1;
	return `https://sns.eu-central-1.amazonaws.com/cert-${certSeq}.pem`;
}

/** Build the canonical string-to-sign for the fixture (inverse of the SUT, used only to sign). */
function canonical(msg: SnsMessage): string {
	const fields =
		msg.Type === "Notification"
			? msg.Subject === undefined
				? ["Message", "MessageId", "Timestamp", "TopicArn", "Type"]
				: ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
			: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
	const record = msg as unknown as Record<string, string | undefined>;
	let out = "";
	for (const key of fields) {
		const value = record[key];
		if (value !== undefined) out += `${key}\n${value}\n`;
	}
	return out;
}

/** Sign the canonical string with the test private key for the given signature version. */
function signFor(msg: SnsMessage, version: string): string {
	const algorithm = version === "2" ? "RSA-SHA256" : "RSA-SHA1";
	return createSign(algorithm).update(canonical(msg), "utf8").end().sign(privateKey, "base64");
}

/** A genuine SNS message with a valid signature, served by a fresh cert URL. */
function signedMessage(over: Partial<SnsMessage> = {}, version = "1"): SnsMessage {
	const base: SnsMessage = {
		Type: "Notification",
		MessageId: "11111111-2222-3333-4444-555555555555",
		TopicArn: "arn:aws:sns:eu-central-1:123456789012:ses-events",
		Message: '{"eventType":"Bounce"}',
		Timestamp: "2026-06-28T00:00:00.000Z",
		Signature: "",
		SignatureVersion: version,
		SigningCertURL: freshCertUrl(),
		...over,
	};
	base.Signature = signFor(base, base.SignatureVersion);
	return base;
}

beforeEach(() => {
	fetchMock.mockReset();
	fetchMock.mockResolvedValue({ ok: true, text: async () => PUBLIC_PEM });
	vi.stubGlobal("fetch", fetchMock);
});

describe("verifySnsSignature — valid signatures", () => {
	it("accepts a Notification without a Subject", async () => {
		const msg = signedMessage();
		expect(await verifySnsSignature(msg)).toBe(true);
		expect(fetchMock).toHaveBeenCalledWith(msg.SigningCertURL);
	});

	it("accepts a Notification with a Subject (Subject is in the signed fields)", async () => {
		const msg = signedMessage({ Subject: "Delivery delayed" });
		expect(await verifySnsSignature(msg)).toBe(true);
	});

	it("accepts a SubscriptionConfirmation (SubscribeURL + Token signed)", async () => {
		const msg = signedMessage({
			Type: "SubscriptionConfirmation",
			Token: "tok-abc",
			SubscribeURL: "https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription",
		});
		expect(await verifySnsSignature(msg)).toBe(true);
	});

	it("accepts SignatureVersion 2 signed with SHA256", async () => {
		const msg = signedMessage({}, "2");
		expect(await verifySnsSignature(msg)).toBe(true);
	});
});

describe("verifySnsSignature — tampered / mismatched", () => {
	it("rejects when the Message body is altered after signing", async () => {
		const msg = signedMessage();
		expect(await verifySnsSignature({ ...msg, Message: '{"eventType":"Complaint"}' })).toBe(false);
	});

	it("rejects when a signed-into field (Subject) is altered after signing", async () => {
		const msg = signedMessage({ Subject: "original" });
		expect(await verifySnsSignature({ ...msg, Subject: "swapped" })).toBe(false);
	});

	it("rejects a garbage/replaced signature", async () => {
		const msg = signedMessage();
		expect(await verifySnsSignature({ ...msg, Signature: "bm90LWEtcmVhbC1zaWc=" })).toBe(false);
	});

	it("rejects when the served cert is the wrong public key", async () => {
		fetchMock.mockResolvedValue({ ok: true, text: async () => OTHER_PEM });
		expect(await verifySnsSignature(signedMessage())).toBe(false);
	});

	it("rejects a v1 signature when SignatureVersion claims 2 (algorithm mismatch)", async () => {
		// Sign with SHA1 but declare version 2 → SUT verifies with RSA-SHA256 → mismatch.
		const msg = signedMessage();
		expect(await verifySnsSignature({ ...msg, SignatureVersion: "2" })).toBe(false);
	});
});

describe("verifySnsSignature — cert fetch guards", () => {
	it("rejects (and never fetches) a non-SNS cert host", async () => {
		const msg = signedMessage({ SigningCertURL: "https://evil.example.com/cert.pem" });
		expect(await verifySnsSignature(msg)).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects (and never fetches) a non-https cert URL on an SNS host", async () => {
		const msg = signedMessage({ SigningCertURL: "http://sns.eu-central-1.amazonaws.com/c.pem" });
		expect(await verifySnsSignature(msg)).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects a malformed cert URL", async () => {
		const msg = signedMessage({ SigningCertURL: "not a url" });
		expect(await verifySnsSignature(msg)).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects when the cert fetch is not ok", async () => {
		fetchMock.mockResolvedValue({ ok: false, text: async () => "" });
		expect(await verifySnsSignature(signedMessage())).toBe(false);
	});

	it("accepts an SNS China (amazonaws.com.cn) cert host", async () => {
		const msg = signedMessage({
			SigningCertURL: "https://sns.cn-north-1.amazonaws.com.cn/cert-cn-unique.pem",
		});
		// re-sign for the new URL already handled by signedMessage; URL doesn't affect the signed body.
		expect(await verifySnsSignature(msg)).toBe(true);
	});
});

describe("verifySnsSignature — cert caching", () => {
	it("caches the PEM by URL so a repeat message does not refetch", async () => {
		const url = freshCertUrl();
		const a = signedMessage({ SigningCertURL: url, MessageId: "msg-a" });
		const b = signedMessage({ SigningCertURL: url, MessageId: "msg-b" });

		expect(await verifySnsSignature(a)).toBe(true);
		expect(await verifySnsSignature(b)).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
