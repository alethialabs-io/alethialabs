// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { InviteSkeleton } from "./accept-invite";

/**
 * /invites/accept while the route loads: the invitation card's own skeleton — the one the screen
 * shows while it reads the session and the invitation — so the route's first paint, the screen's
 * pending state and the card are one picture. Synchronous, as every `loading.tsx` must be.
 */
export default function AcceptInviteLoading() {
	return <InviteSkeleton />;
}
