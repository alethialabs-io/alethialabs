// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Which cloud identities a design write may name. `projects.cloud_identity_id` and every component's
// `cloud_identity_id` are plain foreign keys, and a foreign-key check ignores row-level security, so
// the database accepts any identity id that exists. The rule a design write must meet is the one the
// rest of the console reads identities with (`identityScopeWhere`, lib/runners/claim-identity.ts):
// an `org`-scope identity of the active org, or the caller's own `personal` identity when the caller
// is a person. A CLI service token is not a person, so it may name only the org's identities.
//
// An id the project ALREADY stores is accepted unchanged, so a project bound by one member to their
// own personal identity can still be edited by the rest of the org. Whether a job may then USE that
// identity is decided again at enqueue (`buildConfigSnapshot`) and at claim (`claimIdentityWhere`).

import "server-only";
import { eq } from "drizzle-orm";
import type { Tx } from "@/lib/db";
import { cloudIdentities, projects } from "@/lib/db/schema";
import { readEnvComponents } from "@/lib/queries/project-components-read";
import { asRecord } from "@/lib/records";
import { actorIdentityWhere } from "@/lib/runners/claim-identity";

/** One identity id a design names, and where in the design it was named. */
interface DesignIdentityRef {
	id: string;
	/** `project`, a singleton component's key (`cluster`), or an array entry (`databases "orders"`). */
	where: string;
}

/** A design value's `cloud_identity_id`, or null when it names none (absent, null or empty). */
function identityIdOf(value: unknown): string | null {
	const id = asRecord(value).cloud_identity_id;
	return typeof id === "string" && id !== "" ? id : null;
}

/** How an array component is named in a refusal: its `name` when it has one, else its position. */
function entryLabel(key: string, entry: unknown, index: number): string {
	const name = asRecord(entry).name;
	return typeof name === "string" && name !== "" ? `${key} "${name}"` : `${key}[${index}]`;
}

/**
 * Every cloud identity id a design (`CreateProjectInput`) names: the project's own and each
 * component's. Walks every top-level key rather than a list of component kinds, so a kind added to
 * the design later is covered without an edit here.
 */
function designIdentityRefs(design: unknown): DesignIdentityRef[] {
	const refs: DesignIdentityRef[] = [];
	for (const [key, value] of Object.entries(asRecord(design))) {
		if (Array.isArray(value)) {
			value.forEach((entry, index) => {
				const id = identityIdOf(entry);
				if (id) refs.push({ id, where: entryLabel(key, entry, index) });
			});
			continue;
		}
		const id = identityIdOf(value);
		if (id) refs.push({ id, where: key });
	}
	return refs;
}

/**
 * A design refused for naming a cloud identity the caller may not use. The message says where in
 * the design and what to pick instead; it never says whether the id exists, so another org's
 * identity and a made-up id are refused with the same sentence.
 */
export class CloudIdentityRefusedError extends Error {
	/** Builds the refusal from the places in the design that named an unusable identity. */
	constructor(
		readonly where: readonly string[],
		personAsking: boolean,
	) {
		super(
			`This design names a cloud account that is not available to you here (${where.join(", ")}). ` +
				(personAsking
					? "Choose one of the organization's cloud accounts, or one of your own."
					: "A service token can use only the organization's shared cloud accounts."),
		);
		this.name = "CloudIdentityRefusedError";
	}
}

/** Whether identity `id` passes `actorIdentityWhere` for this caller. */
async function identityUsable(
	tx: Tx,
	id: string,
	orgId: string,
	personalAuthorId: string | undefined,
): Promise<boolean> {
	const [row] = await tx
		.select({ id: cloudIdentities.id })
		.from(cloudIdentities)
		.where(actorIdentityWhere(id, orgId, personalAuthorId))
		.limit(1);
	return Boolean(row);
}

/**
 * The identity ids the project already stores where this write would replace them: the project row,
 * and the components of the environment being rewritten. Read through the caller's transaction,
 * BEFORE the write clears those components.
 */
async function storedIdentityIds(
	tx: Tx,
	projectId: string,
	environmentId: string,
): Promise<Set<string>> {
	const stored = new Set<string>();
	const [project] = await tx
		.select({ cloud_identity_id: projects.cloud_identity_id })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);
	if (project?.cloud_identity_id) stored.add(project.cloud_identity_id);
	const rows = await readEnvComponents(tx, projectId, environmentId);
	for (const ref of designIdentityRefs(rows)) stored.add(ref.id);
	return stored;
}

/** Who is writing the design, and — for an edit — what it replaces. */
export interface DesignIdentityScope {
	orgId: string;
	/** `personalIdentityAuthor(actor)`: the person's id, or undefined for a service token. */
	personalAuthorId: string | undefined;
	/** Set for an edit of an existing environment; absent for a new project. */
	existing?: { projectId: string; environmentId: string };
}

/**
 * Throws {@link CloudIdentityRefusedError} when `design` names a cloud identity the caller may not
 * use and the project does not already store. Call it BEFORE any write, inside the write's
 * transaction. A design whose every identity is usable costs one read per distinct id and nothing
 * more; the stored ids are read only when one fails.
 */
export async function assertDesignIdentitiesUsable(
	tx: Tx,
	design: unknown,
	scope: DesignIdentityScope,
): Promise<void> {
	const refs = designIdentityRefs(design);
	const unusable = new Set<string>();
	for (const id of new Set(refs.map((r) => r.id))) {
		if (!(await identityUsable(tx, id, scope.orgId, scope.personalAuthorId))) {
			unusable.add(id);
		}
	}
	if (unusable.size === 0) return;
	const stored = scope.existing
		? await storedIdentityIds(tx, scope.existing.projectId, scope.existing.environmentId)
		: new Set<string>();
	const refused = refs.filter((r) => unusable.has(r.id) && !stored.has(r.id));
	if (refused.length > 0) {
		throw new CloudIdentityRefusedError(
			refused.map((r) => r.where),
			scope.personalAuthorId !== undefined,
		);
	}
}
