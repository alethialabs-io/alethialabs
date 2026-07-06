// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	disp,
	eyebrow,
	IntegrationLogo,
	type IntegrationId,
	Prov,
	type ProviderId,
	Wrap,
} from "./primitives";

const PROVS: [ProviderId, string][] = [
	["aws", "AWS"],
	["gcp", "GCP"],
	["azure", "Azure"],
];

const INTEGRATIONS: IntegrationId[] = [
	"github",
	"gitlab",
	"bitbucket",
	"cloudflare",
	"datadog",
	"grafana",
	"prometheus",
	"dockerhub",
];

/** "Runs on your cloud" — supported clouds and integration logos. */
export function RunsOn() {
	return (
		<section style={{ borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)", padding: "30px 0", background: "var(--surface-sunken)" }}>
			<Wrap style={{ display: "flex", alignItems: "center", gap: 40, flexWrap: "wrap", justifyContent: "space-between" }}>
				<div style={{ display: "flex", alignItems: "center", gap: 28 }}>
					<span style={{ ...eyebrow, fontSize: 10 }}>Runs on<br />your cloud</span>
					<div style={{ display: "flex", alignItems: "center", gap: 22 }}>
						{PROVS.map(([k, label]) => (
							<div key={k} style={{ display: "flex", alignItems: "center", gap: 9 }}>
								<Prov id={k} size={20} />
								<span style={{ ...disp, fontSize: 14, fontWeight: 500, color: "var(--text-secondary)" }}>{label}</span>
							</div>
						))}
					</div>
				</div>
				<div style={{ height: 24, width: 1, background: "var(--border)" }} className="ah-hide-sm" />
				<div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
					{INTEGRATIONS.map((k) => (
						<IntegrationLogo key={k} id={k} size={19} className="grayscale opacity-[0.55]" />
					))}
				</div>
			</Wrap>
		</section>
	);
}
