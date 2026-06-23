// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type React from "react";
import { DashboardChrome } from "@/components/dashboard-chrome";

/** Legacy `/dashboard/*` chrome. The slug tree `app/(private)/[org]/…` shares the
 * same `<DashboardChrome>`; here there's no org slug to resolve from the URL. */
export default function DashboardLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return <DashboardChrome>{children}</DashboardChrome>;
}
