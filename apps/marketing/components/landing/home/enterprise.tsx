// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { disp, Icon, mono, SecMark, Wrap } from "./primitives";

const TILES: [string, string][] = [
	["Organizations & teams", "Multi-tenant orgs with teams and group-based grants. Invite members; target a grant at a whole team."],
	["SSO — OIDC & SAML", "Bring your identity provider — Okta, Entra ID, AWS IAM Identity Center. New users land least-privileged."],
	["Custom roles & RBAC", "owner · admin · operator · viewer, plus roles you define. OpenFGA relationship checks over Postgres RBAC."],
	["Granular IAM", "Allow and deny grants down to a single Project. A self-serve Access portal handles requests."],
	["Audit log", "Every authorization decision recorded — who, what, allowed or denied — and exportable for compliance."],
	["Plans & metering", "community → team → enterprise. Job concurrency, runner-minutes, and AI credits scale per plan."],
];

/** 09 · Enterprise — orgs, SSO, RBAC, IAM, audit, and metered plans. */
export function Enterprise() {
	return (
		<section style={{ padding: "84px 0", borderTop: "1px solid var(--border)" }}>
			<Wrap>
				<SecMark n="09" label="Enterprise" />
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, flexWrap: "wrap", marginBottom: 36 }}>
					<h2 style={{ ...disp, fontSize: 38, fontWeight: 600, letterSpacing: "-0.035em", margin: 0, maxWidth: 560, color: "var(--text-primary)" }}>Built for teams that answer for production.</h2>
					<p style={{ fontSize: 15, color: "var(--text-tertiary)", maxWidth: 400, margin: 0, lineHeight: 1.6 }}>Organizations, single sign-on, fine-grained authorization, and a complete audit trail — so access maps to who actually needs it, and every decision is on the record.</p>
				</div>
				<div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16 }} className="ah-3col">
					{TILES.map(([title, body], i) => (
						<div key={title} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--surface)", padding: "22px 20px" }}>
							<div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 12 }}>
								<span style={{ ...mono, fontSize: 11, color: "var(--text-disabled)", letterSpacing: "0.1em" }}>0{i + 1}</span>
								<span style={{ width: 16, height: 1, background: "var(--border-strong)" }} />
							</div>
							<h3 style={{ ...disp, fontSize: 16, fontWeight: 600, margin: "0 0 7px", color: "var(--text-primary)" }}>{title}</h3>
							<p style={{ fontSize: 12.5, color: "var(--text-tertiary)", margin: 0, lineHeight: 1.55 }}>{body}</p>
						</div>
					))}
				</div>
				<div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 24, ...mono, fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.6 }}>
					<Icon k="git" size={13} sw={1.7} />
					<span>Open core — community RBAC ships free under AGPL-3.0. Organizations, SSO, custom roles, OpenFGA, and granular IAM are the commercial <code style={{ color: "var(--text-secondary)" }}>ee/</code> tier.</span>
				</div>
			</Wrap>
		</section>
	);
}
