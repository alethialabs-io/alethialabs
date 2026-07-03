// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Production ControllerDeps — wires the controller's injected DB hooks to the real
// queries. Kept separate from controller.ts so the controller stays DB-free + testable.

import type { ControllerDeps } from "@/lib/fleet/controller";
import {
	backlogByProvider,
	countInflightForProvider,
	latestReleaseVersion,
	managedRunnersByInstance,
	markRunnerDraining,
	retireRunner,
	setRunnerObserved,
} from "@/lib/fleet/queue";

const BOOT_GRACE_SECONDS =
	Number.parseInt(process.env.FLEET_BOOT_GRACE_SECONDS ?? "180", 10) || 180;

/** The live (Postgres-backed) controller deps. */
export function makeDbDeps(): ControllerDeps {
	return {
		runnerMap: (provider) => managedRunnersByInstance(provider),
		backlog: async (provider) => (await backlogByProvider()).get(provider) ?? 0,
		recentPeak: (provider) => countInflightForProvider(provider),
		resolveChannel: () => latestReleaseVersion(),
		drain: (runnerId) => markRunnerDraining(runnerId),
		retire: (runnerId) => retireRunner(runnerId),
		persistObserved: (runnerId, patch) =>
			setRunnerObserved(runnerId, patch.location, patch.version),
		bootGraceSeconds: BOOT_GRACE_SECONDS,
	};
}
