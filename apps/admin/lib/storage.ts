// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Minimal S3-compatible storage client for the admin app — just enough to FETCH staff
// attachment downloads server-side. The app can't import the console's lib/storage (cross-app),
// so it reproduces the same client setup (path-style for SeaweedFS/MinIO) against the same
// ALETHIA_STORAGE_* env. Downloads are streamed THROUGH this app (the object store is internal
// in prod — seaweedfs:8333 — so a presigned URL wouldn't resolve from a staff browser; a
// server-side fetch does, and this is a low-traffic staff surface).

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "next-runtime-env";
import { SUPPORT_ATTACHMENTS_BUCKET } from "@repo/support/storage";

let cachedClient: S3Client | undefined;

/**
 * Builds (once) the S3 client from the ALETHIA_STORAGE_* env, mirroring the console's
 * lib/storage client (path-style for SeaweedFS/MinIO). Throws a clear error if the required
 * endpoint/credentials are missing rather than failing late inside the AWS SDK.
 */
function s3Client(): S3Client {
	if (cachedClient) return cachedClient;

	const endpoint = env("ALETHIA_STORAGE_ENDPOINT");
	const accessKeyId = env("ALETHIA_STORAGE_ACCESS_KEY_ID");
	const secretAccessKey = env("ALETHIA_STORAGE_SECRET_ACCESS_KEY");
	if (!endpoint || !accessKeyId || !secretAccessKey) {
		throw new Error(
			"Storage is misconfigured: set ALETHIA_STORAGE_ENDPOINT / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY (see .env.example).",
		);
	}

	cachedClient = new S3Client({
		endpoint,
		region: env("ALETHIA_STORAGE_REGION") || "us-east-1",
		credentials: { accessKeyId, secretAccessKey },
		forcePathStyle: true,
	});
	return cachedClient;
}

/** True when an S3 error means the key/bucket is absent (mirrors the console's isNotFound). */
function isNotFound(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	const name = (err as { name?: string }).name;
	const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
		?.httpStatusCode;
	return name === "NoSuchKey" || name === "NotFound" || status === 404;
}

/**
 * Fetches a support-case attachment's bytes from the object store, or null if the key is
 * absent. Server-side read (the route streams the result to the staff browser).
 */
export async function getSupportAttachment(
	storageKey: string,
): Promise<Uint8Array | null> {
	try {
		const res = await s3Client().send(
			new GetObjectCommand({
				Bucket: SUPPORT_ATTACHMENTS_BUCKET,
				Key: storageKey,
			}),
		);
		if (!res.Body) return null;
		return await res.Body.transformToByteArray();
	} catch (err) {
		if (isNotFound(err)) return null;
		throw err;
	}
}
