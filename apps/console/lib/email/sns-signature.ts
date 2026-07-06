// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// AWS SNS message signature verification. The /api/webhooks/ses endpoint is
// public, so every message is verified against Amazon's signing certificate
// before we trust a byte of it. Implements the documented algorithm:
//   1. the SigningCertURL host must be an amazonaws.com SNS endpoint,
//   2. build the canonical string-to-sign from a fixed field order,
//   3. RSA-verify the base64 Signature with the fetched certificate.

import { createVerify } from "node:crypto";
import type { SnsMessage } from "@/lib/validations/ses-event";

// Only fetch signing certs from a genuine SNS endpoint — prevents an attacker
// pointing SigningCertURL at a cert they control.
const CERT_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

// Certs are long-lived; cache by URL so we don't refetch per message.
const certCache = new Map<string, string>();

/** Field order AWS signs over, per message type. Subject is included only when present. */
function signedFields(msg: SnsMessage): string[] {
	if (msg.Type === "Notification") {
		return msg.Subject === undefined
			? ["Message", "MessageId", "Timestamp", "TopicArn", "Type"]
			: ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"];
	}
	// SubscriptionConfirmation / UnsubscribeConfirmation.
	return [
		"Message",
		"MessageId",
		"SubscribeURL",
		"Timestamp",
		"Token",
		"TopicArn",
		"Type",
	];
}

/** The canonical "key\nvalue\n…" string-to-sign for a message. */
function stringToSign(msg: SnsMessage): string {
	const record = msg as unknown as Record<string, string | undefined>;
	let out = "";
	for (const key of signedFields(msg)) {
		const value = record[key];
		if (value !== undefined) out += `${key}\n${value}\n`;
	}
	return out;
}

/** Fetches (and caches) the PEM signing certificate, rejecting non-SNS hosts. */
async function fetchCertificate(certUrl: string): Promise<string | null> {
	const cached = certCache.get(certUrl);
	if (cached) return cached;

	let url: URL;
	try {
		url = new URL(certUrl);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || !CERT_HOST.test(url.hostname)) return null;

	const res = await fetch(certUrl);
	if (!res.ok) return null;
	const pem = await res.text();
	certCache.set(certUrl, pem);
	return pem;
}

/**
 * Verifies an SNS message's signature. Returns true only when the certificate is
 * from an SNS endpoint and the RSA signature over the canonical string matches.
 */
export async function verifySnsSignature(msg: SnsMessage): Promise<boolean> {
	const pem = await fetchCertificate(msg.SigningCertURL);
	if (!pem) return false;

	// SignatureVersion 1 → SHA1, 2 → SHA256.
	const algorithm = msg.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";
	try {
		return createVerify(algorithm)
			.update(stringToSign(msg), "utf8")
			.verify(pem, msg.Signature, "base64");
	} catch {
		return false;
	}
}
