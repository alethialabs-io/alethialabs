// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { OrgGeneralSkeleton } from "@/components/settings/general/org-general-skeleton";

/**
 * /{org}/~/settings while it redirects. The index has no page of its own: it always lands on
 * General, so the layout is known and this draws General's own skeleton — nothing moves when the
 * redirect arrives. Every settings sub-page has its own `loading.tsx`, which wins over this one,
 * so this is the index's alone. Synchronous, as every `loading.tsx` must be.
 */
export default function SettingsLoading() {
	return <OrgGeneralSkeleton />;
}
