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

/** Every enterprise feature on — the grant for a licensed instance / a paid org. */
const ALL_ENTITLEMENTS: Entitlements = {
	organizations: true,
	sso: true, // OIDC + SAML via @better-auth/sso
	customRoles: true,
	auditExport: true,
	advancedAlerting: true,
	// A licensed instance gets the enterprise tier's quotas (mirrors the ladder in
	// core's planEntitlements("enterprise"); inlined to keep this package type-only on core).
	quotas: { maxConcurrentJobs: null, priorityLevel: 30, includedRunnerMinutes: 20_000 },
	// Enterprise "20×" AI tier (mirrors core's planEntitlements("enterprise").ai).
	ai: {
		enabled: true,
		tier: "max",
		windowCredits: 6_000,
		windowHours: 5,
		weeklyCredits: 60_000,
	},
};

/**
 * Whether a signed license unlocks every feature for the WHOLE instance (self-managed
 * / air-gapped enterprise, and the local dev flag). When false, entitlements are
 * resolved per-org from the billing record instead (the hosted path).
 * STANDUP: replace the env flag with signed-license (JWT) verification against a
 * public key.
 */
function licensedInstanceWide(): boolean {
	return process.env.ALETHIA_LICENSE_ACTIVE === "true";
}

export function register(core: CoreContext): EnterpriseModule {
	const fgaClient = buildFgaClient(core);
	const tupleSync = fgaClient ? new FgaTupleSync(core, fgaClient) : undefined;

	return {
		// Better Auth organization plugin: orgs / teams / members / invitations.
		authPlugins: [
			organization({
				creatorRole: "owner",
				// Group-based grants: a grant can target a team (grants.principal_type='team').
				teams: { enabled: true },
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
					core.emitAlertEvent(data.organization.id, "system.member.invited", {
						title: `Member invited: ${data.email}`,
						severity: "info",
						actor_id: data.inviter.user.id,
						resource_type: "member",
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
						core.emitAlertEvent(org.id, "system.member.joined", {
							title: `Member joined: ${user.email ?? user.id}`,
							severity: "info",
							actor_id: user.id,
							resource_type: "member",
							resource_id: user.id,
						});
					},
					afterUpdateMemberRole: async ({ organization: org, user, member }) => {
						await core.ensureMemberGrant(org.id, user.id, member.role);
					},
					afterRemoveMember: async ({ organization: org, user }) => {
						await core.revokeMemberGrant(org.id, user.id);
						core.emitAlertEvent(org.id, "system.member.removed", {
							title: `Member removed: ${user.email ?? user.id}`,
							severity: "warning",
							actor_id: user.id,
							resource_type: "member",
							resource_id: user.id,
						});
					},
					// Team membership → OpenFGA group tuples (team:T#member@user:U), so
					// team-scoped grants reach members. Postgres resolves team_member at
					// query time; this keeps the FGA store in step.
					afterAddTeamMember: async ({ teamMember, user }) => {
						await tupleSync?.syncTeamMember(teamMember.teamId, user.id);
					},
					afterRemoveTeamMember: async ({ teamMember, user }) => {
						await tupleSync?.removeTeamMember(teamMember.teamId, user.id);
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
					// better-auth's org role (owner/admin/member) — least-privileged
					// "member"; the PDP then maps it to Alethia's viewer-scoped access.
					defaultRole: "member",
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

		// Per-org entitlement resolution (replaces the old global env flag). A licensed
		// instance unlocks everything; otherwise the org's plan + subscription status
		// (from its billing record, via core) decides — so an unsubscribed org falls
		// back to the community baseline and the org-creation gate bites.
		resolveEntitlements: async (orgId: string): Promise<Entitlements> => {
			if (licensedInstanceWide()) return ALL_ENTITLEMENTS;
			return core.resolveOrgEntitlements(orgId);
		},

		// OpenFGA engine + dual-write, both only when OpenFGA is configured; otherwise
		// undefined ⇒ the community PostgresRbacPDP + no-op seam stay in place.
		pdp: fgaClient ? new OpenFgaPdp(core, fgaClient) : undefined,
		tupleSync,
	};
}
