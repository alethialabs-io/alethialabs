// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Minimal S3-compatible storage client for the admin app — just enough to PRESIGN staff
// attachment downloads. The app can't import the console's lib/storage (cross-app), so it
// reproduces the same client setup (path-style for SeaweedFS/MinIO) against the same
// ALETHIA_STORAGE_* env. Downloads are served as short-lived presigned GET URLs the browser
// fetches DIRECTLY from storage — no bytes flow through this app.

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "next-runtime-env";
import { SUPPORT_ATTACHMENTS_BUCKET } from "@repo/support/storage";

/** How long a presigned attachment URL stays valid — long enough to click, short enough to leak safely. */
const PRESIGN_TTL_SECONDS = 300;

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

/** Strips characters that would break the Content-Disposition filename. */
function headerSafeName(name: string): string {
	return name.replace(/["\r\n]+/g, "_");
}

/**
 * Returns a short-lived presigned GET URL for a support-case attachment. The response is
 * forced to download (Content-Disposition: attachment) with the original filename + type, so
 * the browser saves the file rather than rendering it inline.
 */
export async function presignSupportAttachmentDownload(
	storageKey: string,
	fileName: string,
	contentType?: string,
): Promise<string> {
	return getSignedUrl(
		s3Client(),
		new GetObjectCommand({
			Bucket: SUPPORT_ATTACHMENTS_BUCKET,
			Key: storageKey,
			ResponseContentDisposition: `attachment; filename="${headerSafeName(fileName)}"`,
			ResponseContentType: contentType || "application/octet-stream",
		}),
		{ expiresIn: PRESIGN_TTL_SECONDS },
	);
}
