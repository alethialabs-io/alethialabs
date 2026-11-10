// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Whether a classifiable resource belongs to an organization — the check an assignment write makes
// before it pins a value to `(resource_kind, resource_id)`.
//
// `classification_assignment.resource_id` is a bare uuid with no foreign key (it spans fourteen
// tables), and the RLS wall on the assignment row is its DIMENSION's org, not the resource's. So
// nothing at the storage level ties the resource to the org the assignment is written for: this
// does. Every read runs on the service role with an explicit org predicate, because an RLS-scoped
// read would answer "not visible" for some tables and "no policy" for others.
//
// Two kinds are shared rather than owned, and are accepted from any organization: a BUILT-IN role
// (`role.organization_id` is NULL) and a MANAGED runner (platform-operated, `org_id` NULL). An
// assignment on either is still the assigning org's own row, read back only under that org.

import { and, eq, isNull, or } from "drizzle-orm";
import { getServiceDb } from "@/lib/db";
import {
	alertChannels,
	alertDeliveries,
	alertRules,
	cloudIdentities,
	cloudKubernetesClusters,
	connectorCredentials,
	member,
	projectCluster,
	projectEnvironments,
	projects,
	role,
	runners,
	runnerUsageSessions,
	supportCases,
} from "@/lib/db/schema";
import type { ResourceKind } from "@/lib/db/schema/enums";

/** The organization an assignment is written for, and the user writing it. */
export interface ClassificationScope {
	orgId: string;
	userId: string;
}

/**
 * True when the `kind` resource `resourceId` belongs to `scope.orgId` (or is one of the shared
 * kinds described above). False for an unknown id and for another organization's resource alike.
 */
export async function classifiableResourceInOrg(
	kind: ResourceKind,
	resourceId: string,
	scope: ClassificationScope,
): Promise<boolean> {
	const db = getServiceDb();
	const { orgId } = scope;
	switch (kind) {
		case "cloud_identity":
			return found(
				await db
					.select({ id: cloudIdentities.id })
					.from(cloudIdentities)
					.where(and(eq(cloudIdentities.id, resourceId), eq(cloudIdentities.org_id, orgId)))
					.limit(1),
			);
		case "connector_credential":
			return found(
				await db
					.select({ id: connectorCredentials.id })
					.from(connectorCredentials)
					.where(
						and(eq(connectorCredentials.id, resourceId), eq(connectorCredentials.org_id, orgId)),
					)
					.limit(1),
			);
		case "alert_rule":
			return found(
				await db
					.select({ id: alertRules.id })
					.from(alertRules)
					.where(and(eq(alertRules.id, resourceId), eq(alertRules.org_id, orgId)))
					.limit(1),
			);
		case "alert_channel":
			return found(
				await db
					.select({ id: alertChannels.id })
					.from(alertChannels)
					.where(and(eq(alertChannels.id, resourceId), eq(alertChannels.org_id, orgId)))
					.limit(1),
			);
		case "alert_delivery":
			return found(
				await db
					.select({ id: alertDeliveries.id })
					.from(alertDeliveries)
					.where(and(eq(alertDeliveries.id, resourceId), eq(alertDeliveries.org_id, orgId)))
					.limit(1),
			);
		case "member":
			// A personal workspace has no `member` rows; its members page shows the owner under their
			// user id (getMembers), so that is the one member id it can classify.
			if (orgId === scope.userId && resourceId === scope.userId) return true;
			return found(
				await db
					.select({ id: member.id })
					.from(member)
					.where(and(eq(member.id, resourceId), eq(member.organizationId, orgId)))
					.limit(1),
			);
		case "project":
			return found(
				await db
					.select({ id: projects.id })
					.from(projects)
					.where(and(eq(projects.id, resourceId), eq(projects.org_id, orgId)))
					.limit(1),
			);
		case "project_environment":
			// The project's org is the truth for an environment (its own org_id is nullable).
			return found(
				await db
					.select({ id: projectEnvironments.id })
					.from(projectEnvironments)
					.innerJoin(projects, eq(projects.id, projectEnvironments.project_id))
					.where(and(eq(projectEnvironments.id, resourceId), eq(projects.org_id, orgId)))
					.limit(1),
			);
		case "project_cluster":
			return found(
				await db
					.select({ id: projectCluster.id })
					.from(projectCluster)
					.innerJoin(projects, eq(projects.id, projectCluster.project_id))
					.where(and(eq(projectCluster.id, resourceId), eq(projects.org_id, orgId)))
					.limit(1),
			);
		case "cloud_kubernetes_cluster":
			return found(
				await db
					.select({ id: cloudKubernetesClusters.id })
					.from(cloudKubernetesClusters)
					.innerJoin(
						cloudIdentities,
						eq(cloudIdentities.id, cloudKubernetesClusters.cloud_identity_id),
					)
					.where(
						and(eq(cloudKubernetesClusters.id, resourceId), eq(cloudIdentities.org_id, orgId)),
					)
					.limit(1),
			);
		case "role":
			return found(
				await db
					.select({ id: role.id })
					.from(role)
					.where(
						and(
							eq(role.id, resourceId),
							or(
								eq(role.organization_id, orgId),
								and(eq(role.is_builtin, true), isNull(role.organization_id)),
							),
						),
					)
					.limit(1),
			);
		case "runner":
			return found(
				await db
					.select({ id: runners.id })
					.from(runners)
					.where(
						and(
							eq(runners.id, resourceId),
							or(
								eq(runners.org_id, orgId),
								and(eq(runners.operator, "managed"), isNull(runners.org_id)),
							),
						),
					)
					.limit(1),
			);
		case "runner_usage_session":
			return found(
				await db
					.select({ id: runnerUsageSessions.id })
					.from(runnerUsageSessions)
					.where(
						and(eq(runnerUsageSessions.id, resourceId), eq(runnerUsageSessions.org_id, orgId)),
					)
					.limit(1),
			);
		case "support_case":
			// A case filed before it carried an org is its filer's own.
			return found(
				await db
					.select({ id: supportCases.id })
					.from(supportCases)
					.where(
						and(
							eq(supportCases.id, resourceId),
							or(
								eq(supportCases.org_id, orgId),
								and(isNull(supportCases.org_id), eq(supportCases.user_id, scope.userId)),
							),
						),
					)
					.limit(1),
			);
	}
}

/** Whether a `limit(1)` lookup matched a row. */
function found(rows: readonly unknown[]): boolean {
	return rows.length > 0;
}
