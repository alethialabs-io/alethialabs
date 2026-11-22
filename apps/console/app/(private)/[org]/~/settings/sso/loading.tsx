// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { SsoRouteSkeleton } from "@/components/settings/members/people-route-skeletons";

/**
 * Instant skeleton for the settings/sso route (#6132, F021): the manager's shape, or the upsell's box
 * alone without the plan. Synchronous (CON-M4): the gate comes from the workspace store, not from
 * awaiting the actor — see `people-route-skeletons`.
 */
export default function SsoLoading() {
	return <SsoRouteSkeleton />;
}
