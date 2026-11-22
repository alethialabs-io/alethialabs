// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ProjectGeneralSkeleton } from "@/components/settings/general/general-states";

/**
 * Skeleton for the project settings index. Every section (General, Access, Activity, Preview
 * environments) draws its own; this one covers only `/{org}/{project}/settings`, which redirects to
 * General — so it is General's shape rather than a generic block that matches no page.
 */
export default function SettingsLoading() {
	return <ProjectGeneralSkeleton />;
}
