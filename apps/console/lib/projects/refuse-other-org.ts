// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A job of a project belongs to that project's org, and the database refuses any other stamp
// (`set_org_id_from_project`, lib/db/programmables.sql). An action that queues a project's job while
// the actor's org is not the project's would hit that refusal as a constraint error. This asks first
// and refuses in a sentence the user can act on (`projectOrgRefusal`), as a TYPED error a caller can
// tell apart from a failure.

import "server-only";

import { eq } from "drizzle-orm";
import type { Tx } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { projectOrgRefusal } from "@/lib/projects/project-org";

/** The refusal for queueing a project's job from an org the project does not live in. */
export class ProjectOrgRefusalError extends Error {
	/** `message` is the user-facing sentence from {@link projectOrgRefusal}. */
	constructor(message: string) {
		super(message);
		this.name = "ProjectOrgRefusalError";
	}
}

/** Throws {@link ProjectOrgRefusalError} unless `projectId` lives in `actor`'s org. */
export async function refuseProjectOfAnotherOrg(
	tx: Tx,
	projectId: string,
	actor: { userId: string; orgId: string },
): Promise<void> {
	const [project] = await tx
		.select({ org_id: projects.org_id })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);
	const refusal = projectOrgRefusal(project?.org_id ?? null, actor);
	if (refusal) throw new ProjectOrgRefusalError(refusal);
}
