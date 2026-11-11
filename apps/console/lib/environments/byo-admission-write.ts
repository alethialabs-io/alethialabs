// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The write behind the setByoAdmissionEnforce server action (#6541), kept out of the "use server"
// file so it is not itself a callable action: it takes the caller's transaction and user, and the
// action has already bound the project to the actor's org and authorized `edit`.

import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/lib/db";
import { auditLog, projectEnvironments } from "@/lib/db/schema";

/** The input of setByoAdmissionEnforce: two ids and the setting. */
export const byoAdmissionEnforceInput = z.object({
	projectId: z.string().uuid(),
	environmentId: z.string().uuid(),
	enforce: z.boolean(),
});

/** The parsed input of setByoAdmissionEnforce. */
export type ByoAdmissionEnforceInput = z.infer<typeof byoAdmissionEnforceInput>;

/** The slice of a transaction the write uses. */
export type ByoAdmissionWriteTx = Pick<Tx, "select" | "update" | "insert">;

/**
 * Reads the stored setting, writes the new one, and records `byo_admission_enforce: { from, to }`
 * in the audit log when it changed — both in the caller's transaction, so a change is never written
 * without its audit row. The setting changes a security control in both directions, so both
 * directions are recorded. Throws when the environment is not in the project.
 */
export async function writeByoAdmissionEnforce(
	tx: ByoAdmissionWriteTx,
	userId: string,
	input: ByoAdmissionEnforceInput,
): Promise<{ changed: boolean }> {
	const inEnv = and(
		eq(projectEnvironments.id, input.environmentId),
		eq(projectEnvironments.project_id, input.projectId),
	);
	const [before] = await tx
		.select({ enforce: projectEnvironments.byo_admission_enforce })
		.from(projectEnvironments)
		.where(inEnv)
		.limit(1);
	if (!before) throw new Error("Environment not found for this project");
	if (before.enforce === input.enforce) return { changed: false };
	await tx
		.update(projectEnvironments)
		.set({ byo_admission_enforce: input.enforce, updated_at: new Date() })
		.where(inEnv);
	await tx.insert(auditLog).values({
		project_id: input.projectId,
		user_id: userId,
		action: "UPDATED",
		changes: {
			environment_id: input.environmentId,
			byo_admission_enforce: { from: before.enforce, to: input.enforce },
		},
	});
	return { changed: true };
}
