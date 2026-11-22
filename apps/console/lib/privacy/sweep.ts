// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The privacy sweep: one reconcile-loop task (lib/reconcile/loop.ts) that runs the scheduled half
// of the privacy flows — the reminders and erasures of self-serve account deletions, and the
// expiry of data-export downloads. Each half claims its rows itself, so the task is safe on every
// app instance at once.

import "server-only";
import { sweepExpiredExports } from "./export";
import { sweepScheduledErasures } from "./self-deletion";

/** What one privacy sweep did. A type alias so it is assignable to the heartbeat's result shape. */
export type PrivacySweepResult = {
	reminded: number;
	erased: number;
	refused: number;
	failed: number;
	exportsExpired: number;
};

/** Runs one privacy sweep pass at `now`. */
export async function runPrivacySweep(now: Date = new Date()): Promise<PrivacySweepResult> {
	const erasures = await sweepScheduledErasures(now);
	const exports = await sweepExpiredExports(now);
	return { ...erasures, exportsExpired: exports.deleted };
}
