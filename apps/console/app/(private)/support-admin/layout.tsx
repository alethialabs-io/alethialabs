// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import type React from "react";
import { getSupportStaff } from "@/lib/support/staff";
import { StaffShell } from "@/components/support/staff/staff-shell";

/**
 * The /support-admin route-group shell. The (private) parent already enforces auth; here
 * we additionally gate on the SUPPORT_STAFF_EMAILS allowlist — a non-staff session gets a
 * 404 (notFound) rather than a redirect, so the console never reveals the dashboard exists.
 * Renders the minimal staff chrome around every nested page.
 */
export default async function SupportAdminLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const staff = await getSupportStaff();
	if (!staff) notFound();

	return <StaffShell staffEmail={staff.email}>{children}</StaffShell>;
}
