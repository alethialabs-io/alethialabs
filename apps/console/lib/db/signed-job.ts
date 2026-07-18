// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The single stamp for a job insert's config_snapshot signature (Phase A). Wrap every job insert's
// values with signedJob(...) so no enqueue path — console (buildConfigSnapshot), CLI, reconcile,
// canvas-jobs, byo-iac/charts, runner-lifecycle, dispatchers — ships a provisioning snapshot the
// claim endpoint can't authenticate. Centralized here so a new job-insert site is a one-token
// change, not a security gap. See lib/runners/snapshot-sig.ts.

import type { jobs } from "@/lib/db/schema";
import { signSnapshot } from "@/lib/runners/snapshot-sig";

type JobInsert = typeof jobs.$inferInsert;

/** Stamp `config_snapshot_sig` (HMAC of the snapshot) onto a job insert's values. */
export function signedJob(values: JobInsert): JobInsert {
	return {
		...values,
		config_snapshot_sig: signSnapshot(values.config_snapshot ?? {}),
	};
}
