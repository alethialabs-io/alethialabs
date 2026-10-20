// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";

/** Instant skeleton for the settings/activity route: the activity table, with no title above it. */
export default function ActivityLoading() {
	return <DataTableSkeleton columns={4} rows={8} />;
}
