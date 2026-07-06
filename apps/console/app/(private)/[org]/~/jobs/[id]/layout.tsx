// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type React from "react";
import { pageMetadata } from "@/lib/seo/page-metadata";

// The job detail page is a client component (live log streaming), so its metadata lives on
// this thin server layout. The title carries the short job id from the route.
export async function generateMetadata({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	return pageMetadata({
		title: `Job ${id.slice(0, 8)}`,
		description: "Provisioning job logs, status, and execution details.",
	});
}

export default function JobDetailLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return children;
}
