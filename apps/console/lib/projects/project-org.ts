// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Where a project's work runs. A job belongs to the organization its project lives in, and the
// database refuses any other stamp (`set_org_id_from_project`, lib/db/programmables.sql). The actions
// that queue a job also meter quota, write the audit trail and key idempotency on the ACTOR's org,
// so they run only when the project lives in that org. A project of the caller's personal workspace
// is still visible from a team org (the personal-org arm of the RLS policy); acting on it there is
// refused with a sentence the user can act on, never a constraint error.

/**
 * The user-facing refusal for acting on a project from an org it does not live in, or null when
 * the project lives in the actor's org.
 */
export function projectOrgRefusal(
	projectOrgId: string | null,
	actor: { userId: string; orgId: string },
): string | null {
	if (projectOrgId === actor.orgId) return null;
	if (projectOrgId === actor.userId) {
		return "This project belongs to your personal workspace — switch to it to run this.";
	}
	return "This project belongs to another organization — switch to it to run this.";
}
