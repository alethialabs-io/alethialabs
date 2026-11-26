"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useRouter } from "next/navigation";
import { RegionError } from "@/components/errors/region-error";

/**
 * The SSO page when its bootstrap read FAILED (not refused): a region error in the page's body with
 * a retry, as every other people & access page renders a failed read (R6 E-21). It used to throw to
 * the route's error boundary, so SSO alone replaced the whole page — breadcrumb context included —
 * for a read that one retry usually answers. The retry re-runs the server route, which is where the
 * bootstrap is read.
 */
export function SsoReadFailed() {
	const router = useRouter();
	return (
		<RegionError
			title="Couldn't load SSO settings"
			description="Something went wrong reading this organization's single sign-on settings. Check your connection and try again."
			onRetry={() => router.refresh()}
		/>
	);
}
