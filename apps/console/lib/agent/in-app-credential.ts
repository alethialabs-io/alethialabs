// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The in-product agent's credential (agent surface §4.1, §4.6). A chat turn is answered for a person,
// but its tools are executed by the model, so they act as `agent_in_app`, the credential table 4.2
// treats like a connected agent: a deploy or a destroy needs a person's approval bound to the reviewed
// plan, the org's kill switch refuses it, and "agents may not apply to production" refuses it on a
// production environment (lib/approvals/policy.ts).
//
// The turn route binds this actor for the model's stream (lib/agent/turn-route.ts), so every tool and
// every subagent the model runs reads it from `currentActor()` unchanged. Pure, so the shape is
// tested without a database.

import type { Actor } from "@/lib/authz/types";

/**
 * `actor` as the in-product agent acting for them in conversation `threadId`.
 *
 * `credentialRef` is the thread: an approval is bound to the credential that requested it
 * (lib/approvals/gate.ts compares `requester_credential_ref`), so an approval one conversation asked
 * for is used by that conversation's request and no other. A token ceiling the person's actor
 * carried is kept: this credential never exceeds the actor it was built from.
 */
export function inAppAgentActor(actor: Actor, threadId: string): Actor {
	return { ...actor, credential: "agent_in_app", credentialRef: threadId };
}

/** True when `actor` is the in-product agent, i.e. a tool is running inside a chat turn. */
export function isInAppAgent(actor: Actor): boolean {
	return actor.credential === "agent_in_app" && typeof actor.credentialRef === "string";
}
