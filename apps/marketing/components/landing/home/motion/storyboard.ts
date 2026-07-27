// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The single source of homepage copy. Every section imports its own slice from
 * here so wording (and the honesty labels — "Coming", "reproducible given the
 * same plan") lives in exactly one place. Kept as a plain typed const (no `as`
 * cast); `Story` is the inferred shape section builders can reference.
 */
export const STORY = {
	brand:
		"Alethia = the multi-cloud Kubernetes control plane by Alethia Labs. North star: repos to a verified, GitOps Kubernetes cluster on YOUR cloud — keyless, with a signed per-apply evidence receipt, and it keeps re-proving it. Lead with the RECEIPT, not the run. Zero stored keys.",
	hero: {
		kicker: "alethia · control plane",
		status: "holding zero keys",
		h1: "From a repo to a cluster you own.",
		h1b: "Proven. Holding zero keys.",
		sub: "Alethia turns a repository into an owned, running Kubernetes cluster on AWS, GCP, Azure, or Hetzner — provisioned keyless, with a signed receipt for every change.",
		ctaPrimary: "Deploy your repo",
		ctaSecondary: "Read the docs",
		strip: "the plan to apply gate, one job · catalog elench-controls-0.4.0 · ed25519 signed",
		pipeline: ["repo", "plan", "verify", "apply", "cluster"],
	},
	keyless: {
		n: "01",
		label: "Own it",
		title: "Your clouds. Your accounts. Zero stored keys.",
		line: "Short-lived federated identity — AssumeRole, workload-identity federation, Azure federated identity. Alethia mints a token per operation and holds nothing.",
		points: [
			"Keyless federated identity",
			"Multi-cloud from one control plane",
			"Self-hostable — you host it, or we do",
		],
		clouds: ["aws", "gcp", "azure", "hetzner"],
	},
	spine: {
		n: "02",
		label: "The spine",
		title: "From a commit to a proven, running cluster.",
		line: "Your Project compiles to a plan, the plan is verified, the apply runs sandboxed, and ArgoCD reconciles the cluster to Git — every step streamed and audited.",
		stages: ["repo", "plan", "verify", "apply", "cluster"],
	},
	canvas: {
		n: "03",
		label: "Design",
		title: "The canvas is the design surface.",
		line: "Every service and dependency on one canvas — see it, configure it in place, prove it. No YAML, no separate form. It compiles down with a live cost estimate.",
		cost: "847.23",
		points: [
			"Network, cluster, databases, caches, DNS",
			"Configure in the node inspector",
			"Live Infracost estimate",
		],
	},
	verify: {
		n: "04",
		label: "Verification",
		title: "Prove it. Then keep proving it.",
		line: "Between plan and apply a deterministic, fail-closed gate verifies the plan. The LLM proposes; the deterministic gate disposes. Verdicts are reproducible given the same plan.",
	},
	parity: {
		n: "05",
		label: "Multi-cloud",
		title: "One design. Every cloud.",
		line: "The same project provisions across clouds with workload identity rendered automatically. A config change, not a rewrite.",
		clouds: [
			["aws", "IRSA"],
			["gcp", "GKE Workload Identity"],
			["azure", "Azure Federated Identity"],
			["hetzner", "OIDC"],
		],
	},
	fleet: {
		n: "06",
		label: "Operate",
		title: "A fleet that keeps itself sized.",
		line: "A self-healing pool of runners executes every plan and apply — sized to demand, replacing dead nodes, rolling itself with zero downtime. And a drift reconciler keeps re-proving the cluster: in_sync vs drifted.",
		points: [
			"Warm pools sized to demand",
			"Self-healing",
			"Zero-downtime rollouts",
		],
	},
	flows: {
		n: "07",
		label: "Two flows",
		bTitle: "Bring your own IaC, audited.",
		bLine: "Attach a git repo with your own OpenTofu root module — Alethia provisions from your module behind the same fail-closed gate, or grades your existing Terraform and proposes fixes.",
		aTitle: "Generate from a repo scan.",
		aLine: "Point Elench at a repository; it reads the code, infers the backing infra, and proposes a ready-to-shape Project.",
		aBadge: "Coming",
	},
	positioning: {
		n: "08",
		label: "Why Alethia",
		title: "Guardrails that hold zero keys.",
		line: "Verified, evidence-backed, keyless provisioning and delivery — that you own. Not rented, not key-holding.",
		diffs: [
			"You hold the keys — we hold none",
			"Proof, not just generation",
			"One control plane, infra and apps",
		],
	},
	openSource: {
		label: "Open source · AGPL-3.0",
		title: "Yours to run.",
		line: "Self-host the whole control plane. We host nothing.",
	},
	enterprise: {
		title: "Built for teams that answer for production.",
		line: "Organizations, SSO (OIDC & SAML), custom roles & RBAC (OpenFGA), granular IAM, audit log, plans & metering. Open core — community RBAC ships free under AGPL-3.0.",
	},
	roadmap: {
		n: "09",
		label: "Roadmap",
		title: "Where this is going.",
		items: [
			["Service & workload model", "Coming"],
			["Build & push from your repo", "Coming"],
			["Generate from a repo scan", "Coming"],
		],
	},
	cta: {
		title: "Ship it. Prove it. Keep proving it.",
		line: "Open source and self-hostable. Provision into your own cloud with zero stored credentials, and carry a signed receipt for every change.",
		ctas: ["Create an account", "Book a demo", "Read the docs"],
	},
};

/** The inferred shape of the homepage copy tree. */
export type Story = typeof STORY;
