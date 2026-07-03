// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Single source of truth for the plan-gated settings surfaces: which plan unlocks each,
// the upsell copy, and the "Learn more" docs link. Consumed by <FeatureUpsell> (the
// in-page panel that replaces a gated empty state) and <UpgradeDialog> (the modal shown
// when a gated action is attempted). Pure data — no JSX — so non-UI callers can read it.

import {
	BellRing,
	KeyRound,
	ShieldCheck,
	UserPlus,
	UsersRound,
	Workflow,
	type LucideIcon,
} from "lucide-react";
import type { PlanId } from "@repo/plan-catalog";

/** The plan-gated settings features that show an upsell instead of a hard wall. */
export type GatedFeature =
	| "teams"
	| "access"
	| "roles"
	| "sso"
	| "invite"
	| "alerting"
	| "byoRunners";

export interface FeatureUpsellMeta {
	/** The lowest plan that unlocks the feature — drives the "Upgrade to {name}" label
	 *  and whether the enterprise "Contact Sales" CTA is shown. */
	requiredPlan: Extract<PlanId, "team" | "enterprise">;
	icon: LucideIcon;
	/** Action-oriented title, e.g. "Create and manage teams". */
	title: string;
	/** One-line value proposition. */
	blurb: string;
	/** Relative docs link (rewritten to the docs zone) for the "Learn more" CTA. */
	learnMoreHref: string;
}

export const FEATURE_UPSELLS: Record<GatedFeature, FeatureUpsellMeta> = {
	teams: {
		requiredPlan: "enterprise",
		icon: UsersRound,
		title: "Create and manage teams",
		blurb:
			"Group members into teams and grant access to the whole group at once, instead of one member at a time.",
		learnMoreHref: "/docs/access-control/teams",
	},
	access: {
		requiredPlan: "enterprise",
		icon: KeyRound,
		title: "Fine-grained access",
		blurb:
			"Grant scoped access to projects, runners and cloud identities with custom roles — least privilege by default.",
		learnMoreHref: "/docs/access-control/access-portal",
	},
	roles: {
		requiredPlan: "enterprise",
		icon: ShieldCheck,
		title: "Custom roles",
		blurb:
			"Define your own roles with precise permission sets, beyond the built-in owner / admin / operator / viewer.",
		learnMoreHref: "/docs/access-control/roles-and-permissions",
	},
	sso: {
		requiredPlan: "enterprise",
		icon: KeyRound,
		title: "Single Sign-On",
		blurb:
			"Connect your identity provider (Okta, Entra ID, …) over SAML or OIDC and provision members automatically.",
		learnMoreHref: "/docs/access-control/sso",
	},
	invite: {
		requiredPlan: "team",
		icon: UserPlus,
		title: "Invite team members",
		blurb:
			"Collaborate with your team — invite teammates and assign them roles in this organization.",
		learnMoreHref: "/docs/access-control/members-and-invitations",
	},
	alerting: {
		requiredPlan: "team",
		icon: BellRing,
		title: "Alerts & notifications",
		blurb:
			"Route deploys, drift, access changes and identity events to Slack, email or webhooks with granular, per-event policies.",
		learnMoreHref: "/docs/console/alerts",
	},
	byoRunners: {
		requiredPlan: "team",
		icon: Workflow,
		title: "Bring your own runners",
		blurb:
			"Run provisioning jobs on runners you control — deploy one into your own cloud account or register an existing one, instead of the shared managed fleet.",
		learnMoreHref: "/docs/runner/self-hosted",
	},
};
