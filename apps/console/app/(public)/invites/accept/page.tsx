// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { markOnboardingComplete } from "@/app/server/actions/onboarding";
import { AcceptInviteScreen } from "./accept-invite";

/**
 * `/invites/accept` — a server page so the server action that completes an invitee's setup is
 * handed to the client screen as a prop, rather than imported by a client module.
 */
export default function AcceptInvitePage() {
	return <AcceptInviteScreen completeSetup={markOnboardingComplete} />;
}
