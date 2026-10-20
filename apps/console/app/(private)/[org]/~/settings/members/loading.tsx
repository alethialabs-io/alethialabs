// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";
import { PageToolbarSkeleton } from "@repo/ui/page-toolbar";

/** Instant skeleton for the settings/members route: its toolbar (count, copy, one action), then the table. */
export default function MembersLoading() {
	return (
		<div>
			<PageToolbarSkeleton className="mb-4" count actions={1} />
			<DataTableSkeleton columns={4} rows={6} />
		</div>
	);
}
