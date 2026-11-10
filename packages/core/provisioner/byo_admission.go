// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
)

// The runner's half of a BYO namespace's admission (#6495): it decides each namespace's mode,
// applies the policy, and reports what a namespace in "warn" lets through. What the modes mean and
// why a running chart is never switched to refusal by a deploy is on argocd.ByoAdmissionModeLabel.

// byoAdmissionModes decides the admission mode of every accepted BYO namespace. A namespace a chart
// is moved into on this deploy (#6446) inherits "warn": the namespace is new, the chart is not.
//
// When the cluster cannot be read, EVERY namespace is put in "warn" and the deploy goes on. That is
// the direction that cannot cause an outage; the cost is that a namespace created on this deploy
// starts in "warn" and stays there until someone relabels it, which the log line says.
func byoAdmissionModes(namespaces []string, moved []byoMove, stderr io.Writer) map[string]argocd.ByoAdmissionMode {
	inherited := map[string]bool{}
	for _, m := range moved {
		inherited[m.To] = true
	}
	live, err := argocd.ReadByoNamespaceLabels(namespaces)
	if err != nil {
		fmt.Fprintf(stderr, "Warning: could not read the BYO namespaces, so every one is set to report admission violations rather than refuse them: %v\n", err)
		live = make(map[string]map[string]string, len(namespaces))
		for _, ns := range namespaces {
			live[ns] = nil
		}
	}
	return argocd.DecideByoAdmissionModes(namespaces, live, inherited)
}

// applyByoAdmissionPolicy applies the BYO ValidatingAdmissionPolicies and bindings, and returns
// whether they are in force. On a cluster that does not serve the API the policy is SKIPPED with
// the reason, never failed on: the deploy goes on with Pod Security alone, and the runner still
// reports what the policy would refuse (reportByoAdmission).
func applyByoAdmissionPolicy(stdout, stderr io.Writer) (bool, string) {
	if ok, reason := argocd.ByoAdmissionPolicyAvailability(); !ok {
		fmt.Fprintf(stdout, "Skipping the BYO admission policy: %s\n", reason)
		return false, reason
	}
	// Never replace a newer rule set an upgraded runner applied (argocd.ByoAdmissionSchemaAnnotation).
	// That policy is in force, so the enforce namespaces are refused by it and need no report.
	newer, err := argocd.ByoAdmissionPolicyNewerLive()
	if err != nil {
		fmt.Fprintf(stderr, "Warning: not applying the BYO admission policy: %v\n", err)
		return false, "its live version could not be read"
	}
	if newer != "" {
		fmt.Fprintf(stderr, "Warning: not replacing the BYO admission policy: %s. A newer runner applied it; this deploy leaves it in place.\n", newer)
		return true, ""
	}
	policy, err := argocd.RenderByoAdmissionPolicy()
	if err != nil {
		fmt.Fprintf(stderr, "Warning: could not render the BYO admission policy: %v\n", err)
		return false, "it could not be rendered"
	}
	if err := argocd.ApplyManifest(policy, stdout, stderr); err != nil {
		fmt.Fprintf(stderr, "Warning: could not apply the BYO admission policy: %v\n", err)
		return false, "it could not be applied"
	}
	return true, ""
}

// byoAdmissionReport is what one BYO namespace runs that its admission rules refuse, or would
// refuse once the namespace is in "enforce". It is a Deploy-tab warning, so that a user learns it
// before refusal applies to them rather than from a failed rollout.
type byoAdmissionReport struct {
	// Namespace is the BYO namespace.
	Namespace string
	// Charts are the ids of the accepted charts in it, sorted.
	Charts []string
	// Mode is the namespace's admission mode.
	Mode argocd.ByoAdmissionMode
	// PolicyUnavailable is why the cluster runs no admission policy, or "".
	PolicyUnavailable string
	// Objects are the live objects a policy rule refuses.
	Objects []argocd.ByoAdmissionViolation
	// Pods are PSA's own dry-run warnings for enforce=baseline, one per group of pods.
	Pods []string
}

// warning is the Deploy-tab text: the chart, the namespace, each object's kind, name and field, and
// what happens next. It carries no secret value: object names, fields and PSA's pod summaries.
func (r byoAdmissionReport) warning() string {
	charts := make([]string, len(r.Charts))
	for i, c := range r.Charts {
		charts[i] = fmt.Sprintf("%q", c)
	}
	var found []string
	for _, o := range r.Objects {
		found = append(found, o.String())
	}
	for _, p := range r.Pods {
		found = append(found, "Pod Security baseline: "+p)
	}
	subject := fmt.Sprintf("BYO chart %s in namespace %q", strings.Join(charts, ", "), r.Namespace)
	if r.Mode == argocd.ByoAdmissionEnforce {
		return fmt.Sprintf("%s runs what bring-your-own namespaces refuse: %s. "+
			"This cluster runs no admission policy (%s), so these are not refused here. Change the chart so it no longer declares them.",
			subject, strings.Join(found, "; "), r.PolicyUnavailable)
	}
	return fmt.Sprintf("%s runs what bring-your-own namespaces refuse: %s. "+
		"This namespace only reports them, because the chart ran before they were refused; a namespace created for a new chart refuses them. "+
		"Once refusal is turned on for this namespace (%s=%s), the next change to these objects, and the next pod that breaks the rule, is refused. "+
		"Change the chart so it no longer declares them.",
		subject, strings.Join(found, "; "), argocd.ByoAdmissionModeLabel, argocd.ByoAdmissionEnforce)
}

// reportByoAdmission checks the accepted BYO namespaces against the admission rules and returns one
// report per namespace that has something to report:
//
//   - a namespace in "warn" is checked against the policy's rules (live objects) and against PSA
//     baseline (a server-side dry run of the label);
//   - a namespace in "enforce" is checked against the policy's rules only when the cluster runs no
//     policy — otherwise the API server is already refusing, and the chart's sync result names what.
//     PSA is enforced by its label either way.
//
// A namespace that cannot be read is logged and skipped: no report is better than a false one.
func reportByoAdmission(chartsByNS map[string][]string, modes map[string]argocd.ByoAdmissionMode, policyUnavailable string, stderr io.Writer) []byoAdmissionReport {
	namespaces := make([]string, 0, len(chartsByNS))
	for ns := range chartsByNS {
		namespaces = append(namespaces, ns)
	}
	sort.Strings(namespaces)
	var out []byoAdmissionReport
	for _, ns := range namespaces {
		mode := modes[ns]
		if mode == argocd.ByoAdmissionEnforce && policyUnavailable == "" {
			continue
		}
		r := byoAdmissionReport{Namespace: ns, Charts: append([]string(nil), chartsByNS[ns]...), Mode: mode, PolicyUnavailable: policyUnavailable}
		sort.Strings(r.Charts)
		objs, err := argocd.ReadByoAdmissionObjects(ns)
		if err != nil {
			fmt.Fprintf(stderr, "Warning: could not check BYO namespace %q against its admission rules: %v\n", ns, err)
			continue
		}
		r.Objects = argocd.ByoAdmissionViolations(objs)
		if mode != argocd.ByoAdmissionEnforce {
			pods, err := argocd.PreviewByoPodSecurity(ns)
			if err != nil {
				fmt.Fprintf(stderr, "Warning: could not check BYO namespace %q against Pod Security baseline: %v\n", ns, err)
			}
			r.Pods = pods
		}
		if len(r.Objects) > 0 || len(r.Pods) > 0 {
			out = append(out, r)
		}
	}
	return out
}
