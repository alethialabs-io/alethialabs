// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alibaba session — the server-side equivalent of the runner's `alibaba_credentials.go`. Uses Alethia's
// PLATFORM RAM creds (ALETHIA_ALIBABA_*) to AssumeRole into the customer's RAM role (zero customer
// secrets stored; the role ARN is metadata). Implemented as a signed STS RPC call (no heavy SDK) so the
// health probe stays dependency-light, mirroring the token-cloud fetch probes. Every Alibaba connection
// is platform-managed — a successful AssumeRole is the proof of access.

import { createHmac, randomUUID } from "node:crypto";
import type { CloudIdentity } from "@/lib/db/schema";

const STS_ENDPOINT = "https://sts.aliyuncs.com/";
const TIMEOUT_MS = 12_000;

/** Result of assuming the customer RAM role. */
export interface AlibabaSession {
	/** The account id we authenticated into (from the role ARN). */
	accountId: string | null;
}

/** Reads the platform Alibaba creds Alethia uses to assume customer RAM roles, or throws clearly. */
function platformCredentials() {
	const accessKeyId = process.env.ALETHIA_ALIBABA_ACCESS_KEY_ID;
	const accessKeySecret = process.env.ALETHIA_ALIBABA_ACCESS_KEY_SECRET;
	if (!accessKeyId || !accessKeySecret) {
		throw new Error(
			"Platform Alibaba credentials are not configured (ALETHIA_ALIBABA_ACCESS_KEY_ID / ALETHIA_ALIBABA_ACCESS_KEY_SECRET).",
		);
	}
	return { accessKeyId, accessKeySecret };
}

/** acs:ram::<account>:role/Name → <account>. */
function accountIdFromArn(roleArn: string | null | undefined): string | null {
	if (!roleArn) return null;
	const m = roleArn.match(/^acs:ram::(\d+):role\//);
	return m?.[1] ?? null;
}

/** RFC3986 percent-encoding as required by Alibaba's RPC signature (v1.0). */
function percentEncode(value: string): string {
	return encodeURIComponent(value)
		.replace(/\+/g, "%20")
		.replace(/\*/g, "%2A")
		.replace(/%7E/g, "~");
}

/** Builds the canonicalized query + HMAC-SHA1 signature for an Alibaba STS RPC GET call. */
function sign(params: Record<string, string>, accessKeySecret: string): string {
	const canonical = Object.keys(params)
		.sort()
		.map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
		.join("&");
	const stringToSign = `GET&${percentEncode("/")}&${percentEncode(canonical)}`;
	const signature = createHmac("sha1", `${accessKeySecret}&`)
		.update(stringToSign)
		.digest("base64");
	return `${canonical}&Signature=${percentEncode(signature)}`;
}

/**
 * Assumes the customer's RAM role for one Alibaba cloud identity. Throws on missing platform creds, a
 * missing/invalid role ARN, or an STS failure (revoked trust / wrong policy) — the caller maps that to
 * DISCONNECTED. On success the AssumeRole itself is the proof of access; we return the account id.
 */
export async function assumeAlibabaRole(
	identity: Pick<CloudIdentity, "credentials">,
	opts?: { purpose?: string },
): Promise<AlibabaSession> {
	const { accessKeyId, accessKeySecret } = platformCredentials();
	const roleArn = identity.credentials.role_arn ?? null;
	if (!roleArn) throw new Error("This Alibaba connection has no role ARN.");

	const params: Record<string, string> = {
		Action: "AssumeRole",
		RoleArn: roleArn,
		RoleSessionName: `alethia-${(opts?.purpose ?? "probe").slice(0, 24)}`,
		DurationSeconds: "3600",
		Version: "2015-04-01",
		Format: "JSON",
		AccessKeyId: accessKeyId,
		SignatureMethod: "HMAC-SHA1",
		SignatureVersion: "1.0",
		SignatureNonce: randomUUID(),
		Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
	};

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(`${STS_ENDPOINT}?${sign(params, accessKeySecret)}`, {
			method: "GET",
			signal: controller.signal,
		});
		const body = (await res.json().catch(() => ({}))) as {
			Code?: string;
			Message?: string;
			Credentials?: { AccessKeyId?: string };
		};
		if (!res.ok || body.Code) {
			throw new Error(body.Message || body.Code || `Alibaba STS HTTP ${res.status}`);
		}
		if (!body.Credentials?.AccessKeyId) {
			throw new Error("Alibaba AssumeRole returned no credentials.");
		}
		return { accountId: accountIdFromArn(roleArn) };
	} finally {
		clearTimeout(timer);
	}
}
