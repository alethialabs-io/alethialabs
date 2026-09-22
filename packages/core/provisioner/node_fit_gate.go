// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"fmt"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/catalog"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The gate that tells a user their node is too small BEFORE they pay for it.
//
// #3855 cause B. Until this existed, a GCP project on the product's own default machine type
// provisioned a cluster that looked completely healthy — apply green, nodes Ready, receipt sealed —
// and then spent roughly thirty-five minutes failing to install ArgoCD, on a cluster whose
// NetworkPolicy enforcement had silently never started either. The user's first and only signal was
// `ArgoCD install failed` at the end, against a bill they had already incurred.
//
// Everything about that is avoidable offline. catalog.ControlPlaneNodeFit computes the shape's
// allocatable CPU from GKE's published reservation formula and compares it to the one shape that
// has actually been measured failing; it reads an embedded JSON document and nothing else. The only
// thing missing was somebody asking it before the apply.
//
// ── Why this is its own gate and NOT a rule in cloud/validate.go ──
//
// validate.go states its first rule plainly: "Every rule must be STRICTLY NARROWER than what the
// templates already accept … a rule that is even slightly wider than the template starts refusing
// projects that deploy fine today." An `e2-medium` cluster DOES apply cleanly — tofu is perfectly
// happy, and so is GKE. What fails is what we install onto it afterwards. So this belongs where the
// other gates that block a healthy-looking apply for a reason outside the template live: beside the
// cost ceiling, the verify gate and the compat gate, in deploy.go.
//
// ── Refusal on apply, warning on plan, silence never ──
//
// A plan spends nothing, so a plan WARNS: telling someone their shape is wrong while they are still
// designing is the whole point, and refusing to even price a config would be hostile.
//
// A real apply REFUSES, because the alternative is the thirty-five minutes above. This is the same
// posture as the ArgoCD version preflight's governing rule (argocd/version_preflight.go): refuse
// only what is KNOWN broken, proceed on anything unknown, and ship an escape hatch. All three
// halves matter here — FitUnknown is by far the most common verdict (it covers every cloud but GCP
// and every machine type the catalog does not carry) and it never blocks anything.
//
// ── The escape hatch ──
//
// ALETHIA_SKIP_NODE_FIT_GATE exists for the same reason ALETHIA_ARGOCD_SKIP_VERSION_PREFLIGHT does.
// The evidence behind the refusal is one measured cluster configuration; if a user has changed
// something that makes it not apply to them — a node pool with the network-policy addon off, their
// own smaller add-on set — the product should not be the thing standing in their way. Setting it
// still prints the finding, so the decision is recorded in the job log rather than hidden.

// SkipNodeFitGateEnv disables the node-fit refusal for one deploy. It never silences the finding.
const SkipNodeFitGateEnv = "ALETHIA_SKIP_NODE_FIT_GATE"

// nodeFitFinding is the outcome of the gate: whether to block, and what to say either way.
//
// Message is non-empty whenever there is anything at all to report, and empty only when the shape
// passed or could not be modelled — on those, there is nothing a reader would act on, and a line
// per deploy saying "your node is fine" is noise in a log people scan for problems. That is a
// deliberate difference from catalog.NodeFit, whose Detail is always populated: the catalog's job
// is to be auditable, this one's is to be read.
type nodeFitFinding struct {
	Blocked bool
	Message string
}

// nodeFitBlock decides whether a deploy may proceed onto the node shape it asked for.
//
// Pure apart from the one environment read, and side-effect free, so the whole decision table is
// unit-testable offline. `dryRun` is the plan/apply split.
func nodeFitBlock(provider string, config *types.ProjectConfig, dryRun bool) nodeFitFinding {
	if config == nil {
		return nodeFitFinding{}
	}
	// A project that pins no machine type gets the template's own default, which this gate has no
	// view of — resolveInstanceTypes returns nil in that case and never substitutes the catalog
	// default. Checking the catalog default here would be checking a value the deploy will not use.
	if len(config.Cluster.InstanceTypes) == 0 {
		return nodeFitFinding{}
	}

	c, err := catalog.Load()
	if err != nil {
		// The catalog is embedded, so this cannot fail in a shipped binary. If it somehow does,
		// the gate has no evidence and must not be the reason an apply is refused.
		return nodeFitFinding{}
	}

	// Every pinned type is checked, not just the first. A node pool with a mixed instance list can
	// place a pod on ANY of them, so one too-small entry is enough to reproduce the defect — and it
	// would be the hardest version of it to diagnose, because most pods would schedule.
	var refused []catalog.NodeFit
	for _, instanceType := range config.Cluster.InstanceTypes {
		if fit := c.ControlPlaneNodeFit(provider, instanceType); fit.Verdict == catalog.FitTooSmall {
			refused = append(refused, fit)
		}
	}
	if len(refused) == 0 {
		return nodeFitFinding{}
	}

	var b strings.Builder
	for _, fit := range refused {
		fmt.Fprintf(&b, "\n  · %s", fit.Detail)
		if fit.Suggestion != "" {
			fmt.Fprintf(&b, "\n    Use %q instead — the smallest shape in the catalog with room for the add-ons.", fit.Suggestion)
		}
	}
	findings := b.String()

	switch {
	case dryRun:
		return nodeFitFinding{Message: "node fit WARNING (plan only — nothing is blocked): this cluster's node shape cannot host the add-ons the product installs onto it. An apply of this plan will be refused." + findings}
	case skipNodeFitGate():
		return nodeFitFinding{Message: fmt.Sprintf("node fit override (%s is set): proceeding onto a node shape measured unable to host the add-ons. Expect ArgoCD not to converge.%s", SkipNodeFitGateEnv, findings)}
	default:
		return nodeFitFinding{
			Blocked: true,
			Message: fmt.Sprintf(
				"node fit gate BLOCKED apply: this cluster's node shape cannot host the add-ons the product installs onto it, so the cluster would provision cleanly and then fail at ArgoCD.%s\n  Refused before anything was created — set %s to proceed anyway.",
				findings, SkipNodeFitGateEnv),
		}
	}
}

// skipNodeFitGate reads the escape hatch. Any non-empty value that is not an explicit falsehood
// turns it on: somebody who sets it to `0` meant to turn it off, and somebody who sets it to
// anything else meant to turn it on.
func skipNodeFitGate() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(SkipNodeFitGateEnv)))
	switch v {
	case "", "0", "false", "no", "off":
		return false
	default:
		return true
	}
}
