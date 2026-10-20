// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import type { QueryKey } from "@tanstack/react-query";
import type { Topic } from "@/lib/realtime/topics";
import { orpc } from "@/lib/rpc/client";

/**
 * What each real-time topic invalidates (ADR 0005 D3). An event names a topic (and maybe an id);
 * the bus calls `invalidateQueries` for the keys listed here, and only OBSERVED queries refetch —
 * through the read router, i.e. through RLS and the PDP again, so authorization stays in one place.
 *
 * The bus (#6115) reads this map; each page lane adds its topic's keys as it moves its reads onto
 * procedures. A topic with no keys yet invalidates nothing. It is exhaustive over the wire's topic
 * list (`lib/realtime/topics.ts`), so a topic the server can send always has an entry here.
 *
 * `jobs` also carries the legacy `["jobs"]` prefix, which covers `qk.jobs` / `qk.jobsPage` / `qk.job`
 * (lib/query/keys.ts) for every org — the shell's job feed among them (#6114), which keeps that key
 * because other pages share its cache entry. The per-org QueryClient is what keeps the prefix
 * from reaching another org's cache.
 */
/**
 * The query-key prefix of the board's held-destroy read (`components/design-project/canvas/cards/
 * destroy-hold.tsx`). The tenants a held destroy waits on are OTHER environments, so a change to any
 * environment or job in the org re-asks it: the `environments` and `jobs` topics below map onto it.
 * Declared here, not with the card, so this map imports no component (#6119).
 */
export const DESTROY_HOLD_KEY = ["canvas-destroy-hold"] as const;

export const TOPIC_KEYS = {
	// The shell's capped job feed (bell, toasts, breadcrumbs, palette), the full list (runners, plan
	// flow — on `qk.jobs(org)`, reached by the `["jobs"]` prefix) and the setup guide's "provisioned"
	// step change with every job (#6114). So does the overview's usage read, which counts runner
	// minutes and jobs in flight (#6118). The board's environment status carries the in-flight job,
	// the last PLAN's cost and the drift a job wrote; its Activity card is the environment's job
	// history; a held destroy waits on jobs (#6119).
	jobs: (): QueryKey[] => [
		orpc.jobs.key(),
		["jobs"],
		orpc.workspace.recentJobs.key(),
		orpc.workspace.jobs.key(),
		orpc.workspace.setupGuide.key(),
		orpc.overview.usage.key(),
		orpc.canvas.environmentStatus.key(),
		orpc.canvas.environmentJobs.key(),
		[...DESTROY_HOLD_KEY],
	],
	// The env switcher's list (#6114); an environment's status and its components' lifecycles (the
	// board's node states), its described chart workloads and its BYO IaC source (#6119).
	environments: (): QueryKey[] => [
		orpc.workspace.environments.key(),
		orpc.canvas.environmentStatus.key(),
		orpc.canvas.chartWorkloads.key(),
		orpc.canvas.iacSource.key(),
		[...DESTROY_HOLD_KEY],
	],
	projects: (): QueryKey[] => [orpc.workspace.projects.key(), orpc.workspace.setupGuide.key()],
	clusters: (): QueryKey[] => [],
	runners: (): QueryKey[] => [],
	fleet: (): QueryKey[] => [],
	// Catalog add-ons and BYO charts are both `project_addons` rows; an installed add-on is a node on
	// the board, so its health also shows through the environment status (#6119).
	addons: (): QueryKey[] => [
		orpc.canvas.addons.key(),
		orpc.canvas.byoCharts.key(),
		orpc.canvas.environmentStatus.key(),
	],
	alerts: (): QueryKey[] => [orpc.overview.alerts.key()],
	support: (): QueryKey[] => [orpc.workspace.supportCases.key()],
	usage: (): QueryKey[] => [orpc.overview.usage.key()],
} satisfies Record<Topic, () => QueryKey[]>;
