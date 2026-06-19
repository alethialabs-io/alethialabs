// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// Alethia Enterprise Edition entry point. `register(core)` runs once at app boot
// (via the core's allowlisted lib/enterprise.ts loader); it receives core
// capabilities and returns the implementations the seams consult. Only TYPE imports
// from core (`@/...`) are used (erased at compile time) — runtime data access goes
// through `core.db`, so this package never imports core runtime internals.

import { sso } from "@better-auth/sso";
import { organization } from "better-auth/plugins/organization";
import { sql } from "drizzle-orm";
import type { CoreContext, EnterpriseModule } from "@/lib/enterprise";
import type { Actor, Entitlements } from "@/lib/authz/types";

const NO_ENTITLEMENTS: Entitlements = {
	organizations: false,
	sso: false,
	customRoles: false,
	auditExport: false,
};

/**
 * Feature entitlements for this deployment. The seam is synchronous, so we resolve
 * once at registration from the environment (set by the licensing service after it
 * verifies the signed license key). STANDUP: replace with signed-license (JWT)
 * verification against a public key.
 */
function readEntitlements(): Entitlements {
	if (process.env.ALETHIA_LICENSE_ACTIVE !== "true") return NO_ENTITLEMENTS;
	return {
		organizations: true,
		sso: true, // OIDC + SAML via @better-auth/sso
		customRoles: true,
		auditExport: true,
	};
}

export function register(core: CoreContext): EnterpriseModule {
	const entitlements = readEntitlements();

	return {
		// Better Auth organization plugin: orgs / teams / members / invitations.
		authPlugins: [
			organization({
				creatorRole: "owner",
				organizationHooks: {
					// The creator owns the new org (org-wide owner grant) so the PDP
					// authorizes them within it — mirrors core's ensurePersonalOrgOwner.
					afterCreateOrganization: async ({ organization: org, user }) => {
						await core.db.execute(sql`
							insert into grants (org_id, principal_type, principal_id, role_id, resource_type)
							select ${org.id}::uuid, 'user', ${user.id}::uuid, ${core.builtinRoleIds.owner}::uuid, 'org'
							where not exists (
								select 1 from grants g
								where g.org_id = ${org.id}::uuid and g.principal_id = ${user.id}::uuid
								  and g.role_id = ${core.builtinRoleIds.owner}::uuid and g.resource_type = 'org'
							)
						`);
					},
				},
			}),

			// Enterprise SSO (OIDC + SAML): Alethia as the Service Provider consuming
			// the customer's IdP (Okta / Entra ID / AWS IAM Identity Center / …).
			// Loaded after organization() so per-org providers (ssoProvider.organizationId)
			// resolve. SSO users are provisioned into their org as least-privileged
			// members so the PDP scopes them correctly. STANDUP: add a getRole mapping
			// (IdP group claim → owner/admin/operator/viewer) and harden SAML
			// (algorithms.onDeprecated: "reject", enable InResponseTo validation).
			sso({
				organizationProvisioning: {
					defaultRole: "viewer",
				},
			}),
		],

		// Map a verified user to their active org. Primary org = earliest membership;
		// users with no org membership fall back to their personal org (orgId == userId).
		// STANDUP follow-up: honor session.activeOrganizationId for active-org switching
		// (needs the session/headers threaded into getActiveScope).
		resolveScope: async (
			userId: string,
			activeOrgId?: string,
		): Promise<Actor> => {
			// Honor the session's selected org, but only if the user is a member of it.
			if (activeOrgId) {
				const selected = await core.db.execute<{ id: string }>(sql`
					select organization_id as id from member
					where user_id = ${userId}::uuid and organization_id = ${activeOrgId}::uuid
					limit 1
				`);
				if (selected[0]) return { userId, orgId: activeOrgId };
			}
			// Else the primary (earliest) membership; else the personal org.
			const rows = await core.db.execute<{ organization_id: string }>(sql`
				select organization_id from member
				where user_id = ${userId}::uuid
				order by created_at asc
				limit 1
			`);
			return { userId, orgId: rows[0]?.organization_id ?? userId };
		},

		entitlements: (_actor: Actor): Entitlements => entitlements,

		// pdp omitted — the community PostgresRbacPDP stays the engine; an OpenFgaPdp
		// is a later binding flip (no call-site changes).
	};
}
