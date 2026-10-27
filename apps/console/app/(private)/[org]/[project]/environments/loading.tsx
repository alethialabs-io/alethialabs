// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { EnvironmentsSkeleton } from "@/components/environments/environments-skeleton";

/**
 * The Environments route while the server prefetches its read — the view's own pending render, so
 * the skeleton and the page it stands in for share one layout (RUBRIC B2).
 */
export default function EnvironmentsLoading() {
	return <EnvironmentsSkeleton />;
}
