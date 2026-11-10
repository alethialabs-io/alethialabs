// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ProjectGeneralSkeleton } from "@/components/settings/general/general-states";

/**
 * Instant skeleton for the project settings/general route, in the page's final shape: Project
 * profile (name, URL, classification) with its Save band, then the Danger zone — no title.
 */
export default function ProjectGeneralLoading() {
	return <ProjectGeneralSkeleton />;
}
