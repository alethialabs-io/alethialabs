// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Fragment, type ReactNode } from "react";
import { disp, eyebrow, ExampleTag, Icon, type IconKey, mono, Prov, SecMark, Wrap } from "./primitives";

const SECTIONS: [string, string][] = [
	["Project basics", "done"],
	["Network", "done"],
	["Cluster", "active"],
	["Databases", "1"],
	["Caches", "1"],
	["NoSQL", ""],
	["Messaging", ""],
	["DNS", "done"],
	["Secrets", "2"],
	["Repositories", "1"],
	["Registries", ""],
];

const FIELDS: [string, string, "select" | "chips"][] = [
	["Kubernetes version", "1.31", "select"],
	["Instance types", "m6i.large · m6i.xlarge", "chips"],
	["Nodes", "min 2 · desired 3 · max 6", "select"],
	["Autoscaler", "Karpenter", "select"],
];

const NODES: [IconKey, string][] = [
	["grid", "Project"],
	["node", "Cluster"],
	["layers", "Aurora"],
	["server", "Redis"],
	["shield", "Secrets"],
];

/** Browser chrome wrapping the designer, with a Form/Canvas view toggle. */
function DesignerChrome({ children }: { children: ReactNode }) {
	return (
		<div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-xl)", overflow: "hidden", background: "var(--surface)", boxShadow: "var(--shadow-lg)" }}>
			<div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderBottom: "1px solid var(--border)", background: "var(--surface-muted)" }}>
				<div style={{ display: "flex", gap: 6 }}>
					{[0, 1, 2].map((i) => <span key={i} style={{ width: 10, height: 10, borderRadius: 999, border: "1px solid var(--border-strong)" }} />)}
				</div>
				<div style={{ flex: 1, display: "flex", justifyContent: "center" }}>
					<div style={{ display: "flex", alignItems: "center", gap: 7, padding: "4px 14px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--surface-sunken)", ...mono, fontSize: 11, color: "var(--text-tertiary)" }}>
						<Icon k="lock" size={11} sw={1.7} />alethialabs.io/design
					</div>
				</div>
				<div style={{ display: "inline-flex", gap: 2, padding: 3, border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--surface)" }}>
					{([["node", "Form", true], ["layers", "Canvas", false]] as [IconKey, string, boolean][]).map(([ic, l, on]) => (
						<span key={l} style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 8px", borderRadius: "var(--radius-xs)", ...mono, fontSize: 10, color: on ? "var(--text-primary)" : "var(--text-tertiary)", background: on ? "var(--surface-muted)" : "transparent" }}>
							<Icon k={ic} size={12} sw={1.7} />{l}
						</span>
					))}
				</div>
			</div>
			{children}
		</div>
	);
}

/** 03 · Project designer — eleven guided sections compile to OpenTofu with live cost. */
export function ProjectDesigner() {
	return (
		<section style={{ padding: "84px 0", borderTop: "1px solid var(--border)", background: "var(--surface-sunken)" }}>
			<Wrap>
				<SecMark n="03" label="Project designer" />
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, flexWrap: "wrap", marginBottom: 36 }}>
					<h2 style={{ ...disp, fontSize: 38, fontWeight: 600, letterSpacing: "-0.035em", margin: 0, maxWidth: 560, color: "var(--text-primary)" }}>Design production infrastructure. No YAML.</h2>
					<p style={{ fontSize: 15, color: "var(--text-tertiary)", maxWidth: 400, margin: 0, lineHeight: 1.6 }}>A Project is one configuration across eleven guided sections. Fill a form or wire a canvas — either way it compiles to OpenTofu for AWS, GCP, or Azure, with a live cost as you go.</p>
				</div>
				<DesignerChrome>
					<div style={{ display: "grid", gridTemplateColumns: "212px 1fr 232px", minHeight: 372 }} className="ah-3col">
						{/* section list */}
						<div style={{ borderRight: "1px solid var(--border)", background: "var(--surface-sunken)", padding: "14px 10px" }}>
							<div style={{ ...eyebrow, fontSize: 8.5, padding: "0 8px 10px" }}>Sections</div>
							{SECTIONS.map(([name, st]) => {
								const active = st === "active";
								return (
									<div key={name} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 9px", borderRadius: "var(--radius-sm)", background: active ? "var(--surface-muted)" : "transparent", marginBottom: 1 }}>
										<span style={{ display: "grid", placeItems: "center", width: 15, height: 15, flexShrink: 0 }}>
											{st === "done" ? <Icon k="check" size={12} sw={2.2} /> : <span style={{ width: 6, height: 6, borderRadius: 999, border: active ? "none" : "1px solid var(--border-strong)", background: active ? "var(--text-primary)" : "transparent" }} />}
										</span>
										<span style={{ fontSize: 12.5, fontWeight: active ? 600 : 400, color: active ? "var(--text-primary)" : "var(--text-secondary)" }}>{name}</span>
										{st && st !== "done" && st !== "active" && (
											<span style={{ marginLeft: "auto", ...mono, fontSize: 9.5, color: "var(--text-tertiary)", border: "1px solid var(--border)", borderRadius: "var(--radius-xs)", padding: "0 5px" }}>{st}</span>
										)}
									</div>
								);
							})}
						</div>
						{/* form */}
						<div style={{ padding: "20px 24px", minWidth: 0 }}>
							<div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
								<span style={{ display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: "var(--surface-muted)", color: "var(--text-primary)" }}><Icon k="node" size={16} /></span>
								<div>
									<div style={{ ...disp, fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>Cluster</div>
									<div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Managed Kubernetes · EKS</div>
								</div>
								<span style={{ marginLeft: "auto" }}><Prov id="aws" size={18} /></span>
							</div>
							<div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
								{FIELDS.map(([label, val, kind]) => (
									<div key={label}>
										<div style={{ fontSize: 11.5, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 5 }}>{label}</div>
										{kind === "chips" ? (
											<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
												{val.split(" · ").map((c) => (
													<span key={c} style={{ ...mono, fontSize: 11, color: "var(--text-primary)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-xs)", padding: "4px 9px", background: "var(--surface-muted)" }}>{c}</span>
												))}
												<span style={{ ...mono, fontSize: 11, color: "var(--text-tertiary)", border: "1px dashed var(--border-strong)", borderRadius: "var(--radius-xs)", padding: "4px 9px" }}>+ add</span>
											</div>
										) : (
											<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-xs)", padding: "9px 12px", background: "var(--surface)" }}>
												<span style={{ fontSize: 12.5, color: "var(--text-primary)", ...mono }}>{val}</span>
												<span style={{ color: "var(--text-tertiary)" }}><Icon k="chev" size={13} sw={2} /></span>
											</div>
										)}
									</div>
								))}
							</div>
						</div>
						{/* cost sidebar */}
						<div style={{ borderLeft: "1px solid var(--border)", background: "var(--surface-sunken)", padding: "18px 16px", display: "flex", flexDirection: "column" }}>
							<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
								<div style={{ ...eyebrow, fontSize: 8.5 }}>Estimated monthly</div>
								<ExampleTag />
							</div>
							<div style={{ ...disp, fontSize: 30, fontWeight: 600, letterSpacing: "-0.03em", color: "var(--text-primary)", lineHeight: 1 }}>≈ $600<span style={{ fontSize: 15, color: "var(--text-tertiary)", fontWeight: 500 }}> /mo</span></div>
							<p style={{ fontSize: 11.5, color: "var(--text-tertiary)", lineHeight: 1.5, margin: "12px 0 0" }}>A live estimate as you design — every section you add updates it.</p>
							<div style={{ marginTop: "auto", paddingTop: 16, display: "flex", alignItems: "center", gap: 7, ...mono, fontSize: 9.5, color: "var(--text-disabled)" }}><Icon k="gauge" size={12} sw={1.7} />Infracost refines on plan</div>
						</div>
					</div>
					{/* canvas teaser */}
					<div style={{ borderTop: "1px solid var(--border)", background: "var(--surface)", padding: "14px 18px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
						<span style={{ ...eyebrow, fontSize: 8.5, whiteSpace: "nowrap" }}>Canvas view</span>
						<div style={{ display: "flex", alignItems: "center", gap: 0, flexWrap: "wrap" }}>
							{NODES.map(([ic, l], i) => (
								<Fragment key={l}>
									{i > 0 && <span style={{ width: 22, height: 1, background: "var(--border-strong)" }} />}
									<span style={{ display: "inline-flex", alignItems: "center", gap: 7, border: "1px solid var(--border-strong)", borderRadius: "var(--radius-sm)", padding: "6px 11px", background: "var(--surface-muted)", color: "var(--text-secondary)" }}>
										<Icon k={ic} size={13} sw={1.7} /><span style={{ fontSize: 11.5, color: "var(--text-primary)" }}>{l}</span>
									</span>
								</Fragment>
							))}
						</div>
						<span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-tertiary)" }} className="ah-hide-sm">Same Project, wired as a graph.</span>
					</div>
				</DesignerChrome>
			</Wrap>
		</section>
	);
}
