// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// Alethia Enterprise Edition entry point. `register(core)` runs once at app boot
// (via the core's allowlisted lib/enterprise.ts loader); it receives core
// capabilities and returns the implementations the seams consult. Only TYPE imports
// from core (`@/...`) are used (erased at compile time) — runtime data access goes
// through `core.db`, so this package never imports core runtime internals.

import { sso } from "@better-auth/sso";
import { OpenFgaClient } from "@openfga/sdk";
import { organization } from "better-auth/plugins/organization";
import { sql } from "drizzle-orm";
import type { Actor, Entitlements } from "@/lib/authz/types";
import type { CoreContext, EnterpriseModule } from "@/lib/enterprise";
import { FgaTupleSync } from "./fga-tuple-sync";
import { OpenFgaPdp } from "./openfga-pdp";

/** One OpenFGA client when configured (shared by the engine + the dual-write writer). */
function buildFgaClient(core: CoreContext): OpenFgaClient | null {
	if (!core.fga.isEnabled()) return null;
	const cfg = core.fga.getConfig();
	return new OpenFgaClient({
		apiUrl: cfg.apiUrl,
		storeId: cfg.storeId,
		authorizationModelId: cfg.modelId,
	});
}

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
	const fgaClient = buildFgaClient(core);

	return {
		// Better Auth organization plugin: orgs / teams / members / invitations.
		authPlugins: [
			organization({
				creatorRole: "owner",
				// Membership roles = the PDP roles (owner/admin/operator/viewer), injected
				// from core so the org-plugin role vocabulary matches end-to-end.
				ac: core.orgAc,
				roles: core.orgRoles,
				// Send the invitation email (the drafted emails/invite.tsx) via core.
				sendInvitationEmail: async (data) => {
					await core.sendInviteEmail({
						to: data.email,
						inviterName:
							data.inviter.user.name ?? data.inviter.user.email ?? "A teammate",
						workspaceName: data.organization.name,
						role: typeof data.role === "string" ? data.role : data.role[0],
						token: data.id,
					});
				},
				// Sync org membership → PDP grants on every lifecycle event, so the PDP
				// (which authorizes from grants, not member.role) actually grants access.
				organizationHooks: {
					afterCreateOrganization: async ({ organization: org, user }) => {
						await core.ensureMemberGrant(org.id, user.id, "owner");
					},
					afterAddMember: async ({ organization: org, user, member }) => {
						await core.ensureMemberGrant(org.id, user.id, member.role);
					},
					afterUpdateMemberRole: async ({ organization: org, user, member }) => {
						await core.ensureMemberGrant(org.id, user.id, member.role);
					},
					afterRemoveMember: async ({ organization: org, user }) => {
						await core.revokeMemberGrant(org.id, user.id);
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

		// OpenFGA engine + dual-write, both only when OpenFGA is configured; otherwise
		// undefined ⇒ the community PostgresRbacPDP + no-op seam stay in place.
		pdp: fgaClient ? new OpenFgaPdp(core, fgaClient) : undefined,
		tupleSync: fgaClient ? new FgaTupleSync(core, fgaClient) : undefined,
	};
}
