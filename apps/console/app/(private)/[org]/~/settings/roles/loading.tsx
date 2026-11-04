// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { RolesSkeleton } from "@/components/settings/roles/roles-skeleton";

/** Instant skeleton for the settings/roles route: the page's own toolbar, filter bar and master/detail. */
export default function RolesLoading() {
	return <RolesSkeleton />;
}
