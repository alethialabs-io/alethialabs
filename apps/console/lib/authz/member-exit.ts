// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What a member's exit from an org leaves behind besides their grants (#5484): their `team_member`
// rows in the org's teams, and the invitations they sent that are still pending. better-auth's
// `deleteMember` (remove-member, leave) deletes the team rows itself; the CLI member DELETE deletes
// the member row directly and has to do both. better-auth cancels no invitation on either path.

import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db";
import { invitation, team, teamMember } from "@/lib/db/schema";

/** The two writes these helpers issue; satisfied by the service db and by a transaction. */
type MemberExitWriter = Pick<Tx, "update" | "delete">;

/**
 * Cancels the invitations into org `orgId` that user `userId` sent and that are still pending. A
 * removed admin's invitations would otherwise stay pending, and become acceptable again if the
 * admin were ever re-added: `beforeAcceptInvitation` refuses only an inviter who is not an active
 * member at the moment of acceptance.
 */
export async function cancelPendingInvitationsFrom(
	db: MemberExitWriter,
	orgId: string,
	userId: string,
): Promise<void> {
	await db
		.update(invitation)
		.set({ status: "canceled" })
		.where(
			and(
				eq(invitation.organizationId, orgId),
				eq(invitation.inviterId, userId),
				eq(invitation.status, "pending"),
			),
		);
}

/**
 * Deletes user `userId`'s `team_member` rows in org `orgId`'s teams and lowers each team's
 * `memberCount` by the rows deleted from it, as better-auth's `deleteMember` does. Left in place,
 * the rows hand a re-added user their old team memberships, and with them every team grant.
 */
export async function deleteOrgTeamMemberships(
	db: MemberExitWriter,
	orgId: string,
	userId: string,
): Promise<void> {
	const deleted = await db
		.delete(teamMember)
		.where(
			and(
				eq(teamMember.userId, userId),
				sql`${teamMember.teamId} in (select ${team.id} from ${team} where ${team.organizationId} = ${orgId})`,
			),
		)
		.returning({ teamId: teamMember.teamId });
	const perTeam = new Map<string, number>();
	for (const row of deleted) perTeam.set(row.teamId, (perTeam.get(row.teamId) ?? 0) + 1);
	for (const [teamId, count] of perTeam) {
		await db
			.update(team)
			.set({ memberCount: sql`${team.memberCount} - ${count}` })
			.where(and(eq(team.id, teamId), sql`${team.memberCount} >= ${count}`));
	}
}
