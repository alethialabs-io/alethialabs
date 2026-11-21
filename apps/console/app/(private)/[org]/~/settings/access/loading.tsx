// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { AccessRouteSkeleton } from "@/components/settings/members/people-route-skeletons";

/**
 * Instant skeleton for the settings/access route: the inheritance note and the list's own shape, or
 * the note and the upsell without the plan (F021). Synchronous (CON-M4): the gate comes from the
 * workspace store, not from awaiting the actor — see `people-route-skeletons`.
 */
export default function AccessLoading() {
	return <AccessRouteSkeleton />;
}
