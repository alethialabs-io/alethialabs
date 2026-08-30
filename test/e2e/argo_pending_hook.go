// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// DID THE HOOK ARGOCD IS WAITING FOR EVER REACH THE CLUSTER?
//
// When a sync stalls, ArgoCD names the hook it is waiting on and stops there:
//
//	phase=Running waiting for completion of hook
//	rbac.authorization.k8s.io/ClusterRole/addon-kube-prometheus-stac-admission and 1 more hooks
//
// That sentence is compatible with two opposite faults, and everything downstream of the diagnosis
// depends on which:
//
//   - the object is NOT in the cluster — the apply never landed, so the fault is on the way in
//     (RBAC, an admission webhook, a quota, a malformed manifest) and the controller's log has it;
//   - the object IS in the cluster — ArgoCD applied it and is not observing it, so the fault is in
//     what the controller can watch, and its log will say nothing because nothing failed.
//
// One `kubectl get` separates them, and it is derived from ArgoCD's own message rather than from a
// list of resources we think a chart has — so it works for the next chart too, and cannot drift
// away from what the controller is actually waiting on.

// pendingHookRE captures the resource reference out of the message. Anchored on the exact phrase
// gitops-engine emits; a message it does not recognise yields nothing and is reported as such,
// rather than being pattern-matched into a plausible-looking wrong answer.
var pendingHookRE = regexp.MustCompile(`waiting for completion of hook (\S+)`)

// hookRef is a resource reference parsed out of a sync message.
type hookRef struct {
	Group string
	Kind  string
	Name  string
}

// Target renders the reference the way kubectl addresses it: `Kind.group`, or bare `Kind` for the
// core group. Not lowercased — kubectl accepts the CamelCase kind, and lowercasing a group would
// be wrong for the ones that are not already lower.
func (h hookRef) Target() string {
	if h.Group == "" {
		return h.Kind
	}
	return h.Kind + "." + h.Group
}

func (h hookRef) String() string {
	return strings.TrimPrefix(h.Group+"/", "/") + h.Kind + "/" + h.Name
}

// parsePendingHook pulls the waited-on resource out of an operationState message.
//
// Tolerant about the number of segments because the renderer is not ours: gitops-engine writes
// `group/Kind/name` for a grouped resource and can write an EMPTY group for a core one, which
// renders with a leading slash. Taking the name and kind from the END rather than the group from
// the front is what makes both shapes parse, and a name is never split on a slash because names
// cannot contain one.
func parsePendingHook(message string) (hookRef, bool) {
	m := pendingHookRE.FindStringSubmatch(message)
	if m == nil {
		return hookRef{}, false
	}
	parts := strings.Split(m[1], "/")
	if len(parts) < 2 {
		return hookRef{}, false
	}
	ref := hookRef{
		Name: parts[len(parts)-1],
		Kind: parts[len(parts)-2],
	}
	if len(parts) >= 3 {
		ref.Group = strings.Join(parts[:len(parts)-2], "/")
	}
	if ref.Kind == "" || ref.Name == "" {
		return hookRef{}, false
	}
	return ref, true
}

// hookLiveState is what the cluster says about one waited-on hook.
type hookLiveState struct {
	Exists    bool
	Created   string
	Managers  []string
	ReadError string
}

// parseHookLiveState reads the fields that separate "never applied" from "applied and unobserved".
//
// The field managers are included because they name WHO wrote it: an object created by something
// other than argocd-controller is a different story again — a chart's own Job, a cluster add-on, or
// a leftover from a previous install that the hook's delete policy could not remove.
func parseHookLiveState(objJSON []byte) (hookLiveState, error) {
	var obj struct {
		Metadata struct {
			CreationTimestamp string `json:"creationTimestamp"`
			ManagedFields     []struct {
				Manager string `json:"manager"`
			} `json:"managedFields"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(objJSON, &obj); err != nil {
		return hookLiveState{}, err
	}
	st := hookLiveState{Exists: true, Created: obj.Metadata.CreationTimestamp}
	seen := map[string]bool{}
	for _, f := range obj.Metadata.ManagedFields {
		if f.Manager == "" || seen[f.Manager] {
			continue
		}
		seen[f.Manager] = true
		st.Managers = append(st.Managers, f.Manager)
	}
	return st, nil
}

// renderPendingHook states the verdict in the words the reader needs, never as a bare fact.
//
// ⚠️ THREE OUTCOMES, NOT TWO, AND THE THIRD IS WHY THIS COMMENT EXISTS. The first version of this
// probe read an absent object as "the apply never landed" and said so with confidence. On
// azure/addons run 33266338989 that was WRONG, and wrong in the most expensive direction: it sent
// the reader to RBAC, admission and quotas while the Application's own sync result said
//
//	ClusterRole/…-admission  Synced … serverside-applied
//
// The object was applied and then REMOVED — kube-prometheus-stack's admission hooks carry
// `helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded`, so ArgoCD deletes them the
// moment they succeed. Absence from the cluster is the NORMAL end state for such a hook.
//
// So the cluster cannot answer this alone. What separates the two is whether the Application
// RECORDED a result for that hook, and that is read from the same list this dump already fetches.
func renderPendingHook(app string, s stalledApp, st hookLiveState) string {
	var b strings.Builder
	fmt.Fprintf(&b, "\n  ──── %s is waiting on %s ────\n", app, s.Ref)
	switch {
	case st.ReadError != "":
		fmt.Fprintf(&b, "    could not be looked up (%s) — this says nothing about whether it exists\n", st.ReadError)
	case st.Exists:
		fmt.Fprintf(&b, "    EXISTS, created %s, field managers: %s.\n", orNone(st.Created), orNone(strings.Join(st.Managers, ", ")))
		b.WriteString("    So the apply DID land and ArgoCD is not observing it. The fault is in what " +
			"the controller can watch or cache, not in what the API server accepted — and its log " +
			"will be quiet, because from its side nothing failed.\n")
	case s.Recorded && s.recordedFailure():
		fmt.Fprintf(&b, "    NOT in the cluster, and the sync recorded it as FAILED: %q.\n", s.SyncResult)
		b.WriteString("    So the apply was ATTEMPTED and REFUSED. The message above is the API " +
			"server's own reason — read it first; if it says `is forbidden`, that is RBAC and the " +
			"answer is in the ServiceAccount's Role, not in hook lifecycle.\n")
	case s.Recorded:
		fmt.Fprintf(&b, "    NOT in the cluster NOW, but the sync RECORDED it as succeeding: %q.\n", s.SyncResult)
		b.WriteString("    So the apply landed and the object was removed afterwards — the NORMAL " +
			"end state for a hook carrying `hook-delete-policy: hook-succeeded`. Absence is not " +
			"evidence the apply failed here. Look at why the hook's COMPLETION was never recorded " +
			"(a hook declared in two phases, a delete-and-recreate loop), not at RBAC.\n")
	default:
		b.WriteString("    NOT IN THE CLUSTER, and the sync recorded NO result for it. The apply " +
			"never landed, so the fault is on the way in — RBAC, an admission webhook, a quota, a " +
			"manifest the API server refused. The application-controller log above carries the API " +
			"error; this is not a watch problem.\n")
	}
	return b.String()
}

// stalledApp pairs one Application's waited-on hook with the namespace to look it up in.
type stalledApp struct {
	App       string
	Ref       hookRef
	Namespace string
	// SyncResult is what the Application RECORDED for this exact hook, empty when it recorded
	// nothing. It is the difference between "the apply never landed" and "the apply landed and the
	// object was removed afterwards", which the cluster alone cannot tell you.
	SyncResult string
	// Recorded says whether a result EXISTS, which non-emptiness of SyncResult cannot: a hook whose
	// result carries no ResultCode, no phase and no message renders as "" and would otherwise be
	// reported as "the sync recorded NO result for it" — nothing-found read as nothing-wrong.
	Recorded bool
	// Status and HookPhase are the two fields that say whether the recorded result was a SUCCESS.
	// They were parsed and folded into SyncResult's text without ever being branched on, which is
	// how a recorded FAILURE came to be rendered as "the apply landed … not at RBAC".
	Status    string
	HookPhase string
}

// recordedFailure reports whether the sync recorded this hook as having FAILED.
//
// ArgoCD writes a ResourceResult for a failed apply exactly as it does for a successful one: the
// object is absent AND recorded, with `status: SyncFailed` and a message carrying the API server's
// refusal (`clusterroles.rbac… is forbidden: …`), or `hookPhase: Failed|Error` for a hook that ran
// and failed. Presence of a record is therefore not evidence the apply landed.
func (s stalledApp) recordedFailure() bool {
	switch s.HookPhase {
	case "Failed", "Error":
		return true
	}
	return s.Status == "SyncFailed"
}

// stalledHooksFromList finds every loser that is waiting on a hook, in ONE list.
//
// The Application list carries `status.operationState.message` and `spec.destination.namespace` for
// every app, so a per-app fetch would be N calls for data one call already returned — and on the
// failing path, inside a budget that is already spent, N calls is the difference between a dump
// that finishes and a context that cancels before teardown.
//
// Returns the number of losers it could FIND in the list as well, because "no loser is waiting on a
// hook" and "we could not find the losers" are different findings.
func stalledHooksFromList(appsJSON []byte, losers []string) (stalled []stalledApp, found int, err error) {
	var list struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Spec struct {
				Destination struct {
					Namespace string `json:"namespace"`
				} `json:"destination"`
			} `json:"spec"`
			Status struct {
				OperationState struct {
					Message    string `json:"message"`
					SyncResult struct {
						Resources []struct {
							Group     string `json:"group"`
							Kind      string `json:"kind"`
							Name      string `json:"name"`
							Status    string `json:"status"`
							HookPhase string `json:"hookPhase"`
							Message   string `json:"message"`
						} `json:"resources"`
					} `json:"syncResult"`
				} `json:"operationState"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(appsJSON, &list); err != nil {
		return nil, 0, err
	}
	want := make(map[string]bool, len(losers))
	for _, n := range losers {
		want[n] = true
	}
	for _, it := range list.Items {
		if !want[it.Metadata.Name] {
			continue
		}
		found++
		ref, ok := parsePendingHook(it.Status.OperationState.Message)
		if !ok {
			continue
		}
		entry := stalledApp{App: it.Metadata.Name, Ref: ref, Namespace: it.Spec.Destination.Namespace}
		for _, r := range it.Status.OperationState.SyncResult.Resources {
			if r.Kind != ref.Kind || r.Name != ref.Name || r.Group != ref.Group {
				continue
			}
			entry.SyncResult = strings.TrimSpace(strings.Join([]string{r.Status, r.HookPhase, r.Message}, " "))
			entry.Recorded = true
			entry.Status, entry.HookPhase = r.Status, r.HookPhase
			// A result is keyed by resource AND PHASE, so one object declared as both a pre- and a
			// post-install hook produces TWO entries with identical group/kind/name. Taking the
			// first would take the PreSync `Succeeded` one and never see the PostSync entry the
			// sync is actually stuck on. Keep scanning and let a failure win.
			if entry.recordedFailure() {
				break
			}
		}
		stalled = append(stalled, entry)
	}
	return stalled, found, nil
}

// dumpPendingHooks looks up whatever each stalled Application says it is waiting for.
func dumpPendingHooks(ctx context.Context, kubeconfigPath string, losers []string) string {
	if len(losers) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n──── the hook each stalled sync names: is it in the cluster at all? ────\n")

	actx, acancel := context.WithTimeout(ctx, 20*time.Second)
	out, err := exec.CommandContext(actx, "kubectl", "--kubeconfig", kubeconfigPath,
		"get", "applications.argoproj.io", "-n", "argocd", "-o", "json").Output()
	acancel()
	if err != nil {
		fmt.Fprintf(&b, "  could not read the Applications (%v)\n", err)
		return b.String()
	}
	stalled, found, perr := stalledHooksFromList(out, losers)
	if perr != nil {
		fmt.Fprintf(&b, "  could not parse the Applications (%v)\n", perr)
		return b.String()
	}
	switch {
	case found == 0:
		fmt.Fprintf(&b, "  FINDING: none of the %d failing Application(s) is in the list at all — "+
			"they were deleted, or the losers were named from something other than this cluster\n", len(losers))
		return b.String()
	case len(stalled) == 0:
		// NOT silence: no loser is waiting on a hook, which rules out this whole failure mode and
		// points the reader back at the sync errors and the health checks.
		fmt.Fprintf(&b, "  none of the %d failing Application(s) is waiting on a hook — their syncs "+
			"finished, so look at health rather than at what did not apply\n", found)
		return b.String()
	}

	const maxHooks = 20
	for i, s := range stalled {
		if i == maxHooks {
			fmt.Fprintf(&b, "\n  … %d more stalled Application(s) not looked up\n", len(stalled)-i)
			break
		}
		b.WriteString(renderPendingHook(s.App, s, lookupHook(ctx, kubeconfigPath, s.Ref, s.Namespace)))
	}
	return b.String()
}

// lookupHook asks the cluster whether one referenced object is there.
func lookupHook(ctx context.Context, kubeconfigPath string, ref hookRef, namespace string) hookLiveState {
	args := []string{"--kubeconfig", kubeconfigPath, "get", ref.Target(), ref.Name, "-o", "json", "--show-managed-fields"}
	if namespace != "" {
		// Harmless for a cluster-scoped kind — kubectl ignores it — and required for a namespaced
		// one, whose namespace the message does not carry.
		args = append(args, "-n", namespace)
	}
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var stderr strings.Builder
	cmd := exec.CommandContext(cctx, "kubectl", args...)
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		// A NotFound is the ANSWER, not a failure to answer, and it is the more interesting of the
		// two verdicts — so it must not be reported as "could not be looked up".
		if strings.Contains(stderr.String(), "NotFound") || strings.Contains(stderr.String(), "not found") {
			return hookLiveState{Exists: false}
		}
		msg := strings.TrimSpace(stderr.String())
		if i := strings.IndexByte(msg, '\n'); i >= 0 {
			msg = msg[:i]
		}
		return hookLiveState{ReadError: fmt.Sprintf("%v: %s", err, msg)}
	}
	st, perr := parseHookLiveState(out)
	if perr != nil {
		return hookLiveState{ReadError: perr.Error()}
	}
	return st
}
