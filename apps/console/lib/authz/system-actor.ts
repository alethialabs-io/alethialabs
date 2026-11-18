// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The actor of an activity-log row that no person caused: Alethia itself, reporting something it
// observed (a cluster a drift scan found deleted outside Alethia, #6736).
//
// `authz_activity_log.actor_id` is NOT NULL and carries no foreign key, so a fixed id that no
// account can hold names the system. It is deliberately NOT the all-zero uuid: that value is what
// an erasure writes over a person's id (lib/privacy/erasure-plan.ts NIL_UUID), and a feed that
// rendered an erased person as "Alethia" would be making a claim about who acted that is false.
//
// Pure (no I/O) so the activity feed's client-side humanizer can import it.

/** The activity-log actor id of an event Alethia recorded on its own, with nobody acting. */
export const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000001";

/** How the activity feed names the system actor. */
export const SYSTEM_ACTOR_LABEL = "Alethia";

/** Whether an activity row's actor is the system rather than a person. */
export function isSystemActor(actorId: string): boolean {
	return actorId === SYSTEM_ACTOR_ID;
}
