// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// OpenFGA connection config. Entirely optional: when OPENFGA_API_URL / OPENFGA_STORE_ID
// are unset, OpenFGA is disabled and the community PostgresRbacPDP stays the engine.
// Mirrors the validated+cached pattern of lib/config/database.ts.

import { env } from "next-runtime-env";
import { z } from "zod";

const schema = z.object({
	apiUrl: z.string().min(1),
	storeId: z.string().min(1),
	/** Pin a specific authorization model; latest is used when unset. */
	modelId: z.string().optional(),
});

export type OpenFgaConfig = z.infer<typeof schema>;

let cached: OpenFgaConfig | null = null;

/** Whether OpenFGA is configured (the enterprise engine should be wired). */
export function isOpenFgaEnabled(): boolean {
	return Boolean(env("OPENFGA_API_URL") && env("OPENFGA_STORE_ID"));
}

/** The validated OpenFGA config (cached). Throws if enabled but misconfigured. */
export function getOpenFgaConfig(): OpenFgaConfig {
	if (cached) return cached;
	const parsed = schema.safeParse({
		apiUrl: env("OPENFGA_API_URL"),
		storeId: env("OPENFGA_STORE_ID"),
		modelId: env("OPENFGA_MODEL_ID") || undefined,
	});
	if (!parsed.success) {
		throw new Error(`Invalid OpenFGA config: ${parsed.error.message}`);
	}
	cached = parsed.data;
	return cached;
}
