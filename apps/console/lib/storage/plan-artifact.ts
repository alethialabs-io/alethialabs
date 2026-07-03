// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure helpers for the tofu plan-artifact object store, shared by the upload (POST) and download
// (GET) handlers in app/api/jobs/[id]/plan-artifact/route.ts so the storage key + size policy live
// in one place (and are unit-testable without the HTTP/storage boundary).

/** Object-storage bucket holding tofu plan artifacts. */
export const PLAN_ARTIFACT_BUCKET = "plan-artifacts";

/** Max accepted plan-artifact upload size (50 MiB). */
export const MAX_PLAN_ARTIFACT_BYTES = 50 * 1024 * 1024;

/** Storage key for a job's tofu plan output. */
export function planArtifactKey(jobId: string): string {
	return `${jobId}/tofu.plan.out`;
}

/**
 * Classifies an upload body size against the policy: `"empty"` (0 bytes → 400),
 * `"too_large"` (over the cap → 413), or `null` (accepted).
 */
export function planArtifactSizeError(
	bytes: number,
): "empty" | "too_large" | null {
	if (bytes <= 0) return "empty";
	if (bytes > MAX_PLAN_ARTIFACT_BYTES) return "too_large";
	return null;
}
