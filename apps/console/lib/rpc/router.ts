// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { alertsRouter } from "@/lib/rpc/procedures/alerts";
import { billingRouter } from "@/lib/rpc/procedures/billing";
import { canvasRouter } from "@/lib/rpc/procedures/canvas";
import { clustersRouter } from "@/lib/rpc/procedures/clusters";
import { connectorsRouter } from "@/lib/rpc/procedures/connectors";
import { environmentsRouter } from "@/lib/rpc/procedures/environments";
import { evidenceRouter } from "@/lib/rpc/procedures/evidence";
import { jobsRouter } from "@/lib/rpc/procedures/jobs";
import { membersRouter } from "@/lib/rpc/procedures/members";
import { overviewRouter } from "@/lib/rpc/procedures/overview";
import { projectsRouter } from "@/lib/rpc/procedures/projects";
import { runnersRouter } from "@/lib/rpc/procedures/runners";
import { settingsRouter } from "@/lib/rpc/procedures/settings";
import { supportRouter } from "@/lib/rpc/procedures/support";
import { usageRouter } from "@/lib/rpc/procedures/usage";
import { workspaceRouter } from "@/lib/rpc/procedures/workspace";

/**
 * The console's read router (ADR 0005 D1). One sub-router per domain, each in its own file owned by
 * one board lane, so lanes add procedures without ever editing this file (stress test R10).
 */
export const router = {
	alerts: alertsRouter,
	billing: billingRouter,
	canvas: canvasRouter,
	clusters: clustersRouter,
	connectors: connectorsRouter,
	environments: environmentsRouter,
	evidence: evidenceRouter,
	jobs: jobsRouter,
	members: membersRouter,
	overview: overviewRouter,
	projects: projectsRouter,
	runners: runnersRouter,
	settings: settingsRouter,
	support: supportRouter,
	usage: usageRouter,
	workspace: workspaceRouter,
};

/** The router's type — the only thing the browser imports from the server side. */
export type AppRouter = typeof router;
