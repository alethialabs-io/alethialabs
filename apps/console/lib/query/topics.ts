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
export const TOPIC_KEYS = {
	// The shell's capped job feed (bell, toasts, breadcrumbs, palette), the full list (runners, plan
	// flow — on `qk.jobs(org)`, reached by the `["jobs"]` prefix) and the setup guide's "provisioned"
	// step change with every job (#6114).
	jobs: (): QueryKey[] => [
		orpc.jobs.key(),
		["jobs"],
		orpc.workspace.recentJobs.key(),
		orpc.workspace.jobs.key(),
		orpc.workspace.setupGuide.key(),
	],
	environments: (): QueryKey[] => [orpc.workspace.environments.key()],
	projects: (): QueryKey[] => [orpc.workspace.projects.key(), orpc.workspace.setupGuide.key()],
	clusters: (): QueryKey[] => [],
	runners: (): QueryKey[] => [],
	fleet: (): QueryKey[] => [],
	addons: (): QueryKey[] => [],
	alerts: (): QueryKey[] => [],
	support: (): QueryKey[] => [orpc.workspace.supportCases.key()],
	usage: (): QueryKey[] => [],
} satisfies Record<Topic, () => QueryKey[]>;
