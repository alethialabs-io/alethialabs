"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Revoking a service token: a yes/no question (`ConfirmAction level="confirm"`), because it cannot be
// taken back and a pipeline using the token stops at once. The row stays in the list, Revoked, for
// its audit trail.

import { revokeConsoleServiceToken } from "@/app/server/actions/agents/service-tokens";
import { ConfirmAction } from "@/components/confirm/confirm-action";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import type { ServiceTokenListItem } from "@/lib/queries/service-tokens";
import { SERVICE_TOKEN_READS } from "./token-reads";

/** The revoke confirmation for `token`; closed while it is null. */
export function RevokeTokenDialog({ token, onClose }: { token: ServiceTokenListItem | null; onClose: () => void }) {
	const revoke = useActionMutation(revokeConsoleServiceToken, {
		invalidates: SERVICE_TOKEN_READS,
		successMessage: "Token revoked. Recorded in Activity.",
	});
	return (
		<ConfirmAction
			open={token !== null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={token ? `Revoke ${token.name}?` : "Revoke this token?"}
			description="Anything using this token stops working at once. This can't be undone; create a new token to replace it."
			confirmLabel="Revoke token"
			pendingLabel="Revoking…"
			severity={{ level: "confirm" }}
			mutation={revoke}
			variables={token ? { tokenId: token.id } : null}
		/>
	);
}
