// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { env } from "next-runtime-env";
import { z } from "zod";

/**
 * Typed, validated S3 storage configuration. Read once, lazily (env is injected
 * at runtime by next-runtime-env), and cached. Invalid/missing config fails fast
 * with an actionable message instead of a late, cryptic AWS SDK error — this is
 * the single source of truth for "which S3" the console talks to.
 */
const storageConfigSchema = z.object({
	endpoint: z
		.string()
		.min(1, "ALETHIA_STORAGE_ENDPOINT is required (e.g. http://seaweedfs:8333)"),
	region: z.string().min(1).default("us-east-1"),
	accessKeyId: z.string().min(1, "ALETHIA_STORAGE_ACCESS_KEY_ID is required"),
	secretAccessKey: z.string().min(1, "ALETHIA_STORAGE_SECRET_ACCESS_KEY is required"),
	/**
	 * Whether the app may create buckets it needs on first use. Default true for
	 * self-host (bundled SeaweedFS); hosted/managed-S3 deployments set it false
	 * and pre-provision buckets out of band.
	 */
	autoCreateBuckets: z.boolean().default(true),
});

export type StorageConfig = z.infer<typeof storageConfigSchema>;

/** Parses a boolean-ish env string; undefined falls through to the schema default. */
function parseOptionalBool(raw: string | undefined): boolean | undefined {
	if (raw === undefined || raw === "") return undefined;
	return !["false", "0", "no", "off"].includes(raw.toLowerCase());
}

let cached: StorageConfig | undefined;

/** Returns the validated S3 config, throwing a clear error if it is misconfigured. */
export function getStorageConfig(): StorageConfig {
	if (cached) return cached;

	const parsed = storageConfigSchema.safeParse({
		endpoint: env("ALETHIA_STORAGE_ENDPOINT"),
		region: env("ALETHIA_STORAGE_REGION"),
		accessKeyId: env("ALETHIA_STORAGE_ACCESS_KEY_ID"),
		secretAccessKey: env("ALETHIA_STORAGE_SECRET_ACCESS_KEY"),
		autoCreateBuckets: parseOptionalBool(env("ALETHIA_STORAGE_AUTO_CREATE_BUCKETS")),
	});

	if (!parsed.success) {
		const issues = parsed.error.issues
			.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
			.join("\n");
		throw new Error(
			`Invalid S3 storage configuration:\n${issues}\n` +
				`Set the ALETHIA_STORAGE_* environment variables (see .env.example).`,
		);
	}

	cached = parsed.data;
	return cached;
}

// The support-attachments bucket name lives in @repo/support (shared with the admin app);
// re-exported here so the console's existing `@/lib/config/storage` import sites keep working.
export { SUPPORT_ATTACHMENTS_BUCKET } from "@repo/support/storage";
