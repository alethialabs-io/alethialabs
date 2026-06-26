// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type React from "react";
import { notFound, redirect } from "next/navigation";
import { resolveOrgScope } from "@/app/server/actions/resolve";
import { getOwner } from "@/lib/auth/owner";
import { deploymentMode } from "@/lib/billing/config";
import { AppShell } from "@/components/shell/app-shell";

/**
 * C2 slug-tree layout. Resolves the `{org}` segment to a scope and syncs the
 * session's active organization to it (so the rest of the request is scoped to the
 * URL org), then renders the shared dashboard chrome. Unknown/forbidden org → 404.
 */
export default async function OrgLayout({
	children,
	params,
}: {
	children: React.ReactNode;
	params: Promise<{ org: string }>;
}) {
	const { org } = await params;
	// No valid session (e.g. a stale/expired cookie the optimistic middleware let
	// through) → sign-in, not a dead-end 404.
	if (!(await getOwner())) redirect("/login");
	try {
		await resolveOrgScope(org);
	} catch {
		// Authenticated but the org is unknown / not a member → genuine 404.
		notFound();
	}
	// Feedback is a hosted-only feature (it emails Alethia Labs); the shell hides it
	// off the hosted control plane. Resolved server-side and passed to the client shell.
	const isHosted = deploymentMode() === "hosted";
	return <AppShell isHosted={isHosted}>{children}</AppShell>;
}
