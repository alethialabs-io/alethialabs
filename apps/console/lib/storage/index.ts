// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	CreateBucketCommand,
	GetObjectCommand,
	HeadBucketCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { getStorageConfig } from "@/lib/config/storage";

/**
 * Thin S3-compatible storage wrapper so "which S3" (SeaweedFS / Garage / AWS
 * S3 / R2) is pure configuration. The
 * hosted tier later points the same wrapper at AWS S3 or R2 by env alone.
 */
export interface StorageBackend {
	/** Uploads a binary object, overwriting any existing object at `key`. */
	put(bucket: string, key: string, body: Uint8Array, contentType: string): Promise<void>;
	/** Downloads an object as raw bytes, or null if it does not exist. */
	get(bucket: string, key: string): Promise<Uint8Array | null>;
}

let cachedClient: S3Client | undefined;

/** Builds (once) the S3 client from validated config. Path-style for SeaweedFS/MinIO. */
function s3Client(): S3Client {
	if (cachedClient) return cachedClient;

	const cfg = getStorageConfig();
	cachedClient = new S3Client({
		endpoint: cfg.endpoint,
		region: cfg.region,
		credentials: {
			accessKeyId: cfg.accessKeyId,
			secretAccessKey: cfg.secretAccessKey,
		},
		forcePathStyle: true,
	});
	return cachedClient;
}

/** True when an S3 error means the key/bucket is absent. */
function isNotFound(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	const name = (err as { name?: string }).name;
	const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
		?.httpStatusCode;
	return name === "NoSuchKey" || name === "NotFound" || status === 404;
}

/** True when CreateBucket failed only because the bucket already exists. */
function isAlreadyExists(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	const name = (err as { name?: string }).name;
	return (
		name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists"
	);
}

const ensuredBuckets = new Set<string>();

/**
 * Ensures `bucket` exists, creating it on first use (self-host) so there is no
 * manual `aws s3 mb` step. Cached per-process — one HeadBucket per bucket. When
 * autoCreateBuckets is off (managed S3), assumes the bucket is pre-provisioned.
 * Mirrors the Go pattern in packages/core/cloud/aws/s3.go (CreateS3BucketIfNotExists).
 */
async function ensureBucket(bucket: string): Promise<void> {
	if (ensuredBuckets.has(bucket)) return;

	const client = s3Client();
	const { autoCreateBuckets } = getStorageConfig();

	try {
		await client.send(new HeadBucketCommand({ Bucket: bucket }));
		ensuredBuckets.add(bucket);
		return;
	} catch (err) {
		if (!isNotFound(err)) throw err;
		if (!autoCreateBuckets) {
			// Managed S3: surface the missing bucket rather than silently creating it.
			throw new Error(
				`Bucket "${bucket}" not found and ALETHIA_STORAGE_AUTO_CREATE_BUCKETS is disabled — pre-provision it.`,
			);
		}
	}

	try {
		await client.send(new CreateBucketCommand({ Bucket: bucket }));
	} catch (createErr) {
		if (!isAlreadyExists(createErr)) throw createErr;
	}
	ensuredBuckets.add(bucket);
}

/** Default S3-backed StorageBackend used by the app. */
export const storage: StorageBackend = {
	async put(bucket, key, body, contentType) {
		await ensureBucket(bucket);
		await s3Client().send(
			new PutObjectCommand({
				Bucket: bucket,
				Key: key,
				Body: body,
				ContentType: contentType,
			}),
		);
	},

	async get(bucket, key) {
		try {
			const res = await s3Client().send(
				new GetObjectCommand({ Bucket: bucket, Key: key }),
			);
			if (!res.Body) return null;
			return await res.Body.transformToByteArray();
		} catch (err) {
			if (isNotFound(err)) return null;
			throw err;
		}
	},
};
