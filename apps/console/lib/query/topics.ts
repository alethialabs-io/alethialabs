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
 * `jobs` names its procedures one by one rather than the `orpc.jobs.key()` prefix, because ONE jobs
 * read is not refreshed by a hint: the log head (`jobs.logsHead`, up to two thousand lines). A job's
 * new log lines arrive on its own log stream (`/api/stream/jobs/[id]`), so re-reading the head on
 * every jobs hint is pure cost. `tests/lib/query/topics.test.ts` enumerates the router's jobs
 * procedures and fails on any that is neither listed here nor in {@link JOBS_NOT_ON_TOPIC}, so a new
 * jobs read cannot silently miss its hint.
 *
 * `jobs` also carries the legacy `["jobs"]` prefix, which covers `qk.jobs` / `qk.jobsPage` / `qk.job`
 * (lib/query/keys.ts) for every org — the shell's job feed among them (#6114), which keeps that key
 * because other pages share its cache entry. The per-org QueryClient is what keeps the prefix
 * from reaching another org's cache.
 *
 * USAGE AND BILLING (#6127). A job that starts or finishes moves the usage pages' runner minutes and
 * concurrency, so `jobs` also invalidates those reads — but NOT the over-time charts: a 12-month
 * series refetched on every job hint (~1/s on a busy org, per visible tab) costs more than a chart
 * that lags by its `staleTime`. `usage` (AI spend, announced at most once per 30 s per org)
 * invalidates the DATABASE-backed AI and over-time reads only; `billing` (the billing
 * record and the invoice mirror — rare, Stripe-driven) invalidates every billing read and the usage
 * reads a plan change moves. Neither invalidates `billing.liveAiPrices`: a price list does not move
 * when an org's usage or billing record does. `projects` and `clusters` list the resource counts
 * now, so those reads go live the day their lanes add the triggers.
 */
/**
 * The query-key prefix of the board's held-destroy read (`components/design-project/canvas/cards/
 * destroy-hold.tsx`). The tenants a held destroy waits on are OTHER environments, so a change to any
 * environment or job in the org re-asks it: the `environments` and `jobs` topics below map onto it.
 * Declared here, not with the card, so this map imports no component (#6119).
 */
export const DESTROY_HOLD_KEY = ["canvas-destroy-hold"] as const;

/**
 * The query-key prefix of the agent grid's live widgets (`components/agent/widgets/live-refresh.ts`,
 * #6207). A widget's key is `[...AGENT_WIDGET_KEY, topic, owner, widgetId]`, where `topic` is its
 * source tool's registry topic, so a hint on that topic reaches exactly the widgets fed by it. The
 * widget query has no fetcher of its own: re-running a source tool is a write (it persists the new
 * snapshot), so the grid watches these keys for invalidation and runs the refresh itself. Declared
 * here, not with the grid, so this map imports no component (#6119).
 */
export const AGENT_WIDGET_KEY = ["agent-widget"] as const;

/** The key prefix of the agent widgets whose source data a `topic` hint announces. */
export function agentWidgetKey(topic: Topic): QueryKey {
	return [...AGENT_WIDGET_KEY, topic];
}

/** The jobs procedures a `jobs` hint deliberately does NOT refresh, each with its live source. */
export const JOBS_NOT_ON_TOPIC = {
	logsHead: "new log lines arrive on the job's own log stream (/api/stream/jobs/[id])",
} as const;

export const TOPIC_KEYS = {
	// The jobs procedures one by one (not `orpc.jobs.key()`: the log head is left out, see above);
	// the legacy `["jobs"]` prefix, which reaches `qk.jobs(org)` (runners, the plan flow); the shell's
	// capped job feed (bell, toasts, breadcrumbs, palette) and full list; the setup guide's
	// "provisioned" step, which changes with every job (#6114); the overview's usage read, which
	// counts runner minutes and jobs in flight (#6118), and the usage pages' runner minutes and
	// concurrency (#6127). The board's environment status carries the
	// in-flight job, the last PLAN's cost and the drift a job wrote; its Activity card is the
	// environment's job history; a held destroy waits on jobs (#6119).
	jobs: (): QueryKey[] => [
		orpc.jobs.page.key(),
		orpc.jobs.detail.key(),
		orpc.jobs.status.key(),
		orpc.jobs.planResult.key(),
		orpc.jobs.project.key(),
		["jobs"],
		orpc.workspace.recentJobs.key(),
		orpc.workspace.jobs.key(),
		orpc.workspace.setupGuide.key(),
		orpc.overview.usage.key(),
		orpc.canvas.environmentStatus.key(),
		orpc.canvas.environmentJobs.key(),
		[...DESTROY_HOLD_KEY],
		orpc.usage.org.key(),
		orpc.usage.project.key(),
		// The agent grid's jobs, runner-usage and drift-posture widgets (#6207).
		agentWidgetKey("jobs"),
		// A runner card shows the job in flight on it, and a managed pool's busy count is its runners'
		// CLAIMED/PROCESSING jobs (#6123).
		orpc.runners.list.key(),
		orpc.runners.page.key(),
		orpc.runners.fleet.key(),
	],
	// The env switcher's list (#6114); an environment's status and its components' lifecycles (the
	// board's node states), its described chart workloads and its BYO IaC source (#6119). The
	// clusters grid (#6122) shows each cluster's environment lifecycle and its data services too.
	environments: (): QueryKey[] => [
		orpc.workspace.environments.key(),
		orpc.canvas.environmentStatus.key(),
		orpc.canvas.chartWorkloads.key(),
		orpc.canvas.iacSource.key(),
		[...DESTROY_HOLD_KEY],
		orpc.clusters.key(),
	],
	// A project's name/slug/region changed, or one was created or deleted (#6128): the shell's list
	// (switcher, breadcrumbs, palette), the setup guide, usage, and the project's Settings → General.
	projects: (): QueryKey[] => [
		orpc.workspace.projects.key(),
		orpc.workspace.setupGuide.key(),
		orpc.usage.resources.key(),
		agentWidgetKey("projects"),
		orpc.settings.project.key(),
	],
	// The Usage counts (#6127) and the clusters grid (#6122) both read the clusters under management;
	// the agent grid's clusters widget re-runs its source on the same hint (#6207).
	clusters: (): QueryKey[] => [
		orpc.usage.resources.key(),
		orpc.usage.projectResources.key(),
		orpc.clusters.key(),
		agentWidgetKey("clusters"),
	],
	// A runner's row (status, version, default, …) shows on the grid, in the universe the Versions panel
	// and the pickers read, and — for a managed runner — in its pool's counts (#6123).
	runners: (): QueryKey[] => [
		orpc.runners.list.key(),
		orpc.runners.page.key(),
		orpc.runners.fleet.key(),
		// The agent grid's runners widget (#6207).
		agentWidgetKey("runners"),
	],
	// A pool's configuration (#6123).
	fleet: (): QueryKey[] => [orpc.runners.fleet.key()],
	// Catalog add-ons and BYO charts are both `project_addons` rows; an installed add-on is a node on
	// the board, so its health also shows through the environment status (#6119).
	addons: (): QueryKey[] => [
		orpc.canvas.addons.key(),
		orpc.canvas.byoCharts.key(),
		orpc.canvas.environmentStatus.key(),
	],
	// The Alerts hub's reads — settings, policies, channels, the delivery ledger — and the overview's
	// Alerts card (#6118, #6125). Hints come from the alert tables' triggers (programmables.sql) and
	// reach only members who may `view_alerts` (lib/realtime/routing.ts).
	alerts: (): QueryKey[] => [orpc.alerts.key(), orpc.overview.alerts.key()],
	// The shell's bell + toaster feed, and every support page read — "My cases" in each bucket and the
	// open case's thread (#6130). Hints come from the `support_cases` trigger (programmables.sql).
	support: (): QueryKey[] => [orpc.workspace.supportCases.key(), orpc.support.key()],
	usage: (): QueryKey[] => [
		orpc.overview.usage.key(),
		orpc.usage.ai.key(),
		orpc.usage.overTime.key(),
		orpc.usage.projectAi.key(),
		orpc.usage.projectOverTime.key(),
		agentWidgetKey("usage"),
	],
	billing: (): QueryKey[] => [
		orpc.billing.summary.key(),
		orpc.billing.paymentMethods.key(),
		orpc.billing.invoices.key(),
		orpc.billing.transactions.key(),
		orpc.billing.planHistory.key(),
		orpc.usage.org.key(),
		orpc.usage.ai.key(),
		// The overview's usage card shows the plan and the AI budgets a billing change moves.
		orpc.overview.usage.key(),
		agentWidgetKey("billing"),
	],
	// The org row changed (#6128): its name, slug and logo in the switcher and breadcrumb (the
	// workspace context) and Settings → General.
	organization: (): QueryKey[] => [orpc.workspace.context.key(), orpc.settings.org.key()],
} satisfies Record<Topic, () => QueryKey[]>;
