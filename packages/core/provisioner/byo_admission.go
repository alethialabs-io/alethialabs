// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The runner's half of a BYO namespace's admission (#6495): it decides each namespace's mode,
// applies the policy, and reports what a namespace in "warn" lets through. What the modes mean and
// when a namespace that runs a chart is switched to refusal (only by the environment's setting, or a
// person) is on argocd.ByoAdmissionModeLabel.

// decideByoAdmission decides the admission mode of every accepted BYO namespace this environment
// renders from the history of the charts in it (argocd.DecideByoAdmission, #6541), and returns a
// refusal for each chart of a namespace the decision refuses. It removes those namespaces from
// chartsByNS, so what is left is exactly the set the caller renders. A namespace another environment
// holds (held, #6562) is not decided at all: it is not rendered, so neither the history rule nor the
// environment's setting may relabel it.
//
// # Where history comes from
//
// From the CLUSTER, read on this deploy: each chart's live ArgoCD Application (liveByoDestination).
// An Application whose destination is the chart's namespace is the only thing that lets the chart
// into an existing namespace that is not this environment's (RunsHere). An Application with any
// destination, a #6446 move, or the console's record (vc.ByoAdmission.DeployedCharts — charts the
// console last read in a state that has resources) is history for choosing "warn" over "enforce" in
// a namespace that is new or this environment's own. The console's record covers what the cluster
// can no longer say: a re-provisioned cluster has no Applications.
//
// # A read that fails fails the DEPLOY
//
// If the namespaces or any chart's Application cannot be read (after retryByoRead), this returns an
// error and the caller applies nothing — as #6562 does for its own reads. It never refuses a chart
// on an unread cluster (a refusal withdraws a running chart's bindings), and it never renders an
// admission label it could not decide (an "enforce" written without its source label would make the
// setting's off switch stop working for that namespace).
func decideByoAdmission(vc *types.ProjectConfig, chartsByNS map[string][]string, moved []byoMove, held map[string]bool) (map[string]argocd.ByoAdmissionDecision, []byoRefusal, error) {
	namespaces := make([]string, 0, len(chartsByNS))
	for ns := range chartsByNS {
		if !held[ns] {
			namespaces = append(namespaces, ns)
		}
	}
	sort.Strings(namespaces)
	in := argocd.ByoAdmissionInput{Namespaces: namespaces, Owner: byoBindingOwner(vc), History: map[string]bool{}, RunsHere: map[string]bool{}}
	ran := map[string]bool{}
	for _, m := range moved {
		ran[m.ID] = true
	}
	if cfg := vc.ByoAdmission; cfg != nil {
		in.Enforce = cfg.Enforce
		for _, id := range cfg.DeployedCharts {
			ran[id] = true
		}
	}
	var live map[string]map[string]string
	if err := retryByoRead(func() error {
		var rerr error
		live, rerr = argocd.ReadByoNamespaceLabels(namespaces)
		return rerr
	}); err != nil {
		return nil, nil, fmt.Errorf("could not read the BYO namespaces to decide their admission mode, so nothing was applied for any bring-your-own chart and no binding was withdrawn; deploy again once the cluster can be read: %w", err)
	}
	in.Live = live
	for _, ns := range namespaces {
		for _, id := range chartsByNS[ns] {
			var dest string
			if err := retryByoRead(func() error {
				var rerr error
				dest, rerr = liveByoDestination(id)
				return rerr
			}); err != nil {
				return nil, nil, fmt.Errorf("could not read BYO chart %q's Application to tell whether it already runs in namespace %q, so nothing was applied for any bring-your-own chart and no binding was withdrawn; deploy again once the cluster can be read: %w", id, ns, err)
			}
			if dest == ns {
				in.RunsHere[ns] = true
			}
			if dest != "" || ran[id] {
				in.History[ns] = true
			}
		}
	}
	decisions := argocd.DecideByoAdmission(in)
	var refused []byoRefusal
	for _, ns := range namespaces {
		if !decisions[ns].Refused {
			continue
		}
		reason := fmt.Sprintf("namespace %q already exists, is not a bring-your-own namespace of this environment, and no Application of this environment deploys into it, so a chart may not take it over: something else may be using it (a blank namespace gives the chart its own, byo-<chart id>)", ns)
		ids := append([]string(nil), chartsByNS[ns]...)
		sort.Strings(ids)
		for _, id := range ids {
			refused = append(refused, byoRefusal{ID: id, Namespace: ns, Reason: reason})
		}
		delete(chartsByNS, ns)
	}
	return decisions, refused, nil
}

// acceptedByoSources rebuilds the repos and namespaces configureByoCharts collects, in its order,
// from the charts still in chartsByNS: what remains after decideByoAdmission refused a namespace.
func acceptedByoSources(addOns []types.AddOnInstall, chartsByNS map[string][]string) (repos, gitRepos, namespaces []string) {
	accepted := map[string]bool{}
	for _, ids := range chartsByNS {
		for _, id := range ids {
			accepted[id] = true
		}
	}
	for _, a := range addOns {
		if !a.IsByo() || !accepted[a.ID] {
			continue
		}
		repos = append(repos, a.ChartRepo)
		if a.IsGitSource() {
			gitRepos = append(gitRepos, a.ChartRepo)
		}
		namespaces = append(namespaces, a.Namespace)
	}
	return repos, gitRepos, namespaces
}

// keepAcceptedCharts is items without those whose chart (id) is no longer in chartsByNS.
func keepAcceptedCharts[T any](items []T, id func(T) string, chartsByNS map[string][]string) []T {
	accepted := map[string]bool{}
	for _, ids := range chartsByNS {
		for _, c := range ids {
			accepted[c] = true
		}
	}
	var out []T
	for _, it := range items {
		if accepted[id(it)] {
			out = append(out, it)
		}
	}
	return out
}

// byoAdmissionStatuses is the Deploy tab's per-namespace view of this deploy's decisions (#6541):
// every decided namespace with its mode, the mode it had before, why, and what its report found.
// A refused namespace is listed too, with mode "refused", so the tab says why its charts are absent.
func byoAdmissionStatuses(decisions map[string]argocd.ByoAdmissionDecision, chartsByNS map[string][]string, refused []byoRefusal, reports []byoAdmissionReport) []argocd.ByoAdmissionNamespaceStatus {
	charts := map[string][]string{}
	for ns, ids := range chartsByNS {
		charts[ns] = ids
	}
	for _, r := range refused {
		if decisions[r.Namespace].Refused {
			charts[r.Namespace] = append(charts[r.Namespace], r.ID)
		}
	}
	byNS := map[string]byoAdmissionReport{}
	for _, r := range reports {
		byNS[r.Namespace] = r
	}
	namespaces := make([]string, 0, len(decisions))
	for ns := range decisions {
		namespaces = append(namespaces, ns)
	}
	sort.Strings(namespaces)
	out := make([]argocd.ByoAdmissionNamespaceStatus, 0, len(namespaces))
	for _, ns := range namespaces {
		d := decisions[ns]
		st := argocd.ByoAdmissionNamespaceStatus{
			Namespace: ns,
			Charts:    append([]string{}, charts[ns]...),
			Mode:      string(d.Mode),
			Previous:  string(d.Previous),
			Reason:    string(d.Reason),
		}
		if d.Refused {
			st.Mode = argocd.ByoAdmissionStatusRefused
		}
		sort.Strings(st.Charts)
		if r, ok := byNS[ns]; ok {
			st.PolicyUnavailable = r.PolicyUnavailable
			for _, o := range r.Objects {
				st.Findings = append(st.Findings, o.String())
			}
			for _, p := range r.Pods {
				st.Findings = append(st.Findings, "Pod Security baseline: "+p)
			}
			st.Checks = r.Checks
		}
		out = append(out, st)
	}
	return out
}

// byoAdmissionChange is one namespace whose mode this deploy changed (#6541). Only the environment's
// setting changes a mode that is already set, so each one is the setting taking effect, or being
// undone; the Deploy tab shows it as a warning so that the change is never silent.
type byoAdmissionChange struct {
	Namespace string
	From, To  argocd.ByoAdmissionMode
}

// byoAdmissionChanges lists the namespaces whose decided mode differs from the live one, sorted.
func byoAdmissionChanges(decisions map[string]argocd.ByoAdmissionDecision) []byoAdmissionChange {
	var out []byoAdmissionChange
	for ns, d := range decisions {
		if !d.Refused && d.Previous != "" && d.Previous != d.Mode {
			out = append(out, byoAdmissionChange{Namespace: ns, From: d.Previous, To: d.Mode})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Namespace < out[j].Namespace })
	return out
}

// warning is the Deploy-tab text for the change.
func (c byoAdmissionChange) warning() string {
	if c.To == argocd.ByoAdmissionEnforce {
		return fmt.Sprintf("BYO namespace %q now refuses what bring-your-own namespaces refuse (admission %s → %s), because this environment's setting turns refusal on. "+
			"A pod or object change that breaks the rules is refused from now on; what already runs keeps running until it is replaced. Turn the setting off to return the namespace to %s.",
			c.Namespace, c.From, c.To, argocd.ByoAdmissionWarn)
	}
	return fmt.Sprintf("BYO namespace %q only reports what bring-your-own namespaces refuse again (admission %s → %s), because this environment's setting that turned refusal on is off.",
		c.Namespace, c.From, c.To)
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
// refuse once the namespace is in "enforce", and which checks produced that answer. A namespace with
// findings becomes a Deploy-tab warning (warns), so that a user learns it before refusal applies to
// them rather than from a failed rollout; every namespace's report also rides the Deploy tab's
// status, so the admission setting's consent step can tell "nothing found" from "not checked".
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
	// Checks are which kinds were checked, which failed, and Pod Security "enforced" in an enforce
	// namespace (argocd.ByoAdmissionCheck).
	Checks []argocd.ByoAdmissionCheck
}

// warns reports whether the report is a Deploy-tab warning: something was found that nothing on
// the cluster refuses yet — a "warn" namespace, or an "enforce" one on a cluster without the policy.
// An "enforce" namespace under the policy only records its findings (objects created before refusal
// was on, which the API server refuses at their next change).
func (r byoAdmissionReport) warns() bool {
	if len(r.Objects) == 0 && len(r.Pods) == 0 {
		return false
	}
	return r.Mode != argocd.ByoAdmissionEnforce || r.PolicyUnavailable != ""
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
		"This namespace only reports them, because a chart in it ran before they were refused; a namespace created for a chart that has never run refuses them. "+
		"Once refusal is turned on for this environment's BYO namespaces (the environment's BYO admission setting, or %s=%s on this namespace), the next change to these objects, and the next pod that breaks the rule, is refused. "+
		"Change the chart so it no longer declares them.",
		subject, strings.Join(found, "; "), argocd.ByoAdmissionModeLabel, argocd.ByoAdmissionEnforce)
}

// reportByoAdmission checks every decided, non-refused BYO namespace against the admission rules
// and returns one report per namespace (#6541): its findings, and per kind whether it was checked.
//
//   - Services, Ingresses and Secrets are read in EVERY namespace, "enforce" included — one the
//     setting moved still runs what it ran before, and the next change to it is refused.
//   - Pod Security is previewed (a server-side dry run of enforce=baseline) in a "warn" namespace; in
//     an "enforce" namespace its label already enforces, so the check is "enforced".
//
// A kind that cannot be read is recorded as "failed" and logged. It is never read as clean: the
// console's admission setting refuses consent on a report with a failed check.
func reportByoAdmission(chartsByNS map[string][]string, modes map[string]argocd.ByoAdmissionMode, policyUnavailable string, stderr io.Writer) []byoAdmissionReport {
	namespaces := make([]string, 0, len(chartsByNS))
	for ns := range chartsByNS {
		if _, decided := modes[ns]; decided {
			namespaces = append(namespaces, ns)
		}
	}
	sort.Strings(namespaces)
	var out []byoAdmissionReport
	for _, ns := range namespaces {
		mode := modes[ns]
		r := byoAdmissionReport{Namespace: ns, Charts: append([]string(nil), chartsByNS[ns]...), Mode: mode, PolicyUnavailable: policyUnavailable}
		sort.Strings(r.Charts)
		objs, errs := argocd.ReadByoAdmissionObjectsByKind(ns)
		for _, kind := range argocd.ByoAdmissionObjectKinds {
			state := argocd.ByoAdmissionCheckChecked
			if err := errs[kind]; err != nil {
				state = argocd.ByoAdmissionCheckFailed
				fmt.Fprintf(stderr, "Warning: could not check the %ss in BYO namespace %q against its admission rules: %v\n", kind, ns, err)
			}
			r.Checks = append(r.Checks, argocd.ByoAdmissionCheck{Kind: kind, State: state})
		}
		r.Objects = argocd.ByoAdmissionViolations(objs)
		psa := argocd.ByoAdmissionCheckEnforced
		if mode != argocd.ByoAdmissionEnforce {
			psa = argocd.ByoAdmissionCheckChecked
			pods, err := argocd.PreviewByoPodSecurity(ns)
			if err != nil {
				psa = argocd.ByoAdmissionCheckFailed
				fmt.Fprintf(stderr, "Warning: could not check BYO namespace %q against Pod Security baseline: %v\n", ns, err)
			}
			r.Pods = pods
		}
		r.Checks = append(r.Checks, argocd.ByoAdmissionCheck{Kind: "PodSecurity", State: psa})
		out = append(out, r)
	}
	return out
}
