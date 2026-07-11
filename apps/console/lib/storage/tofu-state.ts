// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Object location for a project environment's tofu state, served by the console http-backend
 * proxy (E0). The key is derived from immutable UUIDs — NOT the human project name — because
 * `projects` is only `unique(org_id, slug)`, so a name-based key (the retired s3 scheme) would
 * collide two orgs' identically-named projects onto one state object. UUIDs are globally unique,
 * so the key is unambiguous across tenants. The console always derives this SERVER-SIDE from the
 * job row; a runner never supplies it.
 */
export const TOFU_STATE_BUCKET =
	process.env.ALETHIA_STORAGE_STATE_BUCKET || "project-tofu-state";

/** The state object key for a project environment. */
export function projectStateKey(
	projectId: string,
	environmentId: string,
): string {
	return `projects/${projectId}/${environmentId}/tofu.tfstate`;
}
