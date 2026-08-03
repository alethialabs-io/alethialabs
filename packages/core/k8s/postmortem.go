// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"strconv"
	"strings"
)

// podStatesJSONPath emits one TAB-separated `name<TAB>phase<TAB>ready-flags<TAB>waiting-reasons`
// line per pod.
//
// Deliberately a jsonpath rather than `-o json | jq`: jq is not guaranteed to be on the runner
// image. It carries the per-container READY flags as well as the phase because the likeliest cause
// of a `helm --wait` expiry is a pod that is Running but whose readiness probe never passes — a
// state `get pods -o wide` shows only as an easily-missed "1/2" in its READY column. Contains no
// single quote, so it survives the single-quoting NamespacePostMortem wraps it in for `bash -c`.
const podStatesJSONPath = `{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\t"}` +
	`{range .status.containerStatuses[*]}{.ready}{" "}{end}{"\t"}` +
	`{range .status.containerStatuses[*]}{.state.waiting.reason}{" "}{end}{"\n"}{end}`

// NamespacePostMortem collects and formats the state of a namespace whose workloads never became
// ready — the evidence a `helm --wait` timeout otherwise takes to the grave.
//
// A `--wait` that blows its deadline reports only "context deadline exceeded": it never says WHICH
// pod stalled or why, and the e2e teardown destroys the cluster moments later. Three nights of the
// aws nightly failed on exactly that with nothing to act on (#1734). Best-effort by construction —
// this runs on a path that has already failed, so a broken kubectl must still produce a readable
// report rather than mask the original error.
func NamespacePostMortem(namespace string) string {
	// The namespace interpolates into a `bash -c` command string, so fail closed on anything that
	// is not an RFC-1123 label rather than let it reach the shell (same guard as Apply).
	if !k8sNameRe.MatchString(namespace) {
		return "\n(post-mortem skipped: " + namespace + " is not a valid namespace name)\n"
	}
	pods := collectOut("kubectl -n " + namespace + " get pods -o wide")
	states := collectOut("kubectl -n " + namespace + " get pods -o jsonpath='" + podStatesJSONPath + "'")
	events := collectOut("kubectl -n " + namespace + " get events --sort-by=.lastTimestamp")
	return namespaceEvidence(namespace, pods, podStallVerdicts(states), events)
}

// namespaceEvidence formats the collected post-mortem sections.
//
// Empty sections are labelled rather than dropped, for the same reason probeEvidence labels its
// own: "kubectl returned nothing" is itself a finding (no pods at all means the chart's manifests
// never landed), while a silently missing section reads as if the command was never run.
// Pure/unit-tested.
func namespaceEvidence(namespace, pods, verdicts, events string) string {
	section := func(title, body string) string {
		body = strings.TrimSpace(body)
		if body == "" {
			body = "(nothing returned)"
		}
		return "\n── " + title + " ──\n" + body + "\n"
	}
	return "\nCollecting namespace " + namespace + " state before teardown destroys it:\n" +
		section("kubectl get pods -o wide -n "+namespace, pods) +
		section("stalled pods", verdicts) +
		section("kubectl get events -n "+namespace, events)
}

// podStallVerdicts turns the raw podStatesJSONPath output into one diagnosis line per pod that is
// holding up the wait, and nothing at all for the pods that are fine.
//
// The point is to name the culprit: a `--wait` timeout is caused by the pods listed here, and a
// reader should not have to correlate two kubectl dumps by hand to find them. The two degenerate
// cases get their own explicit text rather than an empty section, because they mean opposite
// things — no pods at all says the chart's manifests never landed, whereas every pod healthy says
// the wait expired on a resource kind that is not a pod. Pure/unit-tested.
func podStallVerdicts(raw string) string {
	var lines []string
	pods := 0
	for _, line := range strings.Split(raw, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		pods++
		name, phase, ready, waiting := parsePodState(line)
		if v := podStallVerdict(phase, ready, waiting); v != "" {
			lines = append(lines, name+": "+v)
		}
	}
	switch {
	case pods == 0:
		return ""
	case len(lines) == 0:
		return "every pod is Running and Ready — the wait did NOT expire on a pod; check the " +
			"non-pod resources in the release (Jobs, hooks, StatefulSet/Deployment rollout status)"
	}
	return strings.Join(lines, "\n")
}

// parsePodState splits one podStatesJSONPath line into its fields, tolerating a short line.
//
// Tolerant on purpose: a pod that has not been scheduled yet has no containerStatuses at all, so
// its trailing fields are legitimately absent — treating that as malformed would drop the single
// most interesting pod in an unschedulable namespace. Pure/unit-tested.
func parsePodState(line string) (name, phase, ready, waiting string) {
	fields := strings.Split(line, "\t")
	get := func(i int) string {
		if i < len(fields) {
			return strings.TrimSpace(fields[i])
		}
		return ""
	}
	return get(0), get(1), get(2), get(3)
}

// podStallVerdict maps one pod's phase, per-container ready flags and container waiting reason to
// why it is holding up a `--wait`, or "" when the pod is not the problem.
//
// The waiting reason is what distinguishes the failure modes a bare phase conflates: a Pending pod
// with no reason is unschedulable (no capacity / an untolerated taint), whereas a Pending pod
// pulling an image is merely slow — on a 2-vCPU burstable node with a cold image cache those want
// opposite fixes. Pure/unit-tested.
func podStallVerdict(phase, ready, waiting string) string {
	phase = strings.TrimSpace(phase)
	reason := strings.TrimSpace(waiting)
	switch {
	case containsAny(reason, "ImagePullBackOff", "ErrImagePull", "InvalidImageName"):
		return "image pull is FAILING (" + reason + ") — check the image ref, registry reachability and node disk space"
	case containsAny(reason, "CrashLoopBackOff", "RunContainerError"):
		return "the container starts then crashes (" + reason + ") — read its logs; --wait can never succeed"
	case containsAny(reason, "CreateContainerConfigError", "CreateContainerError"):
		return "the container cannot be created (" + reason + ") — a referenced Secret/ConfigMap is probably missing"
	case containsAny(reason, "ContainerCreating", "PodInitializing"):
		return "still creating containers (" + reason + ") — image pull or volume attach in progress; this one may just need a longer wait"
	case phase == "Succeeded":
		return ""
	case phase == "Running":
		if allReady(ready) {
			return ""
		}
		return "Running but NOT Ready (" + readyDetail(ready) + ") — its readiness probe is not passing; " +
			"check its logs and whatever it depends on (redis, the API server)"
	case phase == "Pending" && reason == "":
		return "Pending with no container state — UNSCHEDULABLE; no node has the capacity or tolerates its taints (see events)"
	}
	detail := phase
	if reason != "" {
		if detail != "" {
			detail += "/" + reason
		} else {
			detail = reason
		}
	}
	if detail == "" {
		detail = "no state reported"
	}
	return "not running (" + detail + ")"
}

// allReady reports whether every container in a pod reported ready=true.
//
// An EMPTY flag list is NOT ready: it means the pod has no containerStatuses at all, i.e. it was
// never scheduled. Reading absence as readiness would silently drop exactly the pods a stuck
// namespace is made of. Pure/unit-tested.
func allReady(ready string) bool {
	flags := strings.Fields(ready)
	if len(flags) == 0 {
		return false
	}
	for _, f := range flags {
		if f != "true" {
			return false
		}
	}
	return true
}

// readyDetail renders the per-container ready flags as "N/M containers ready" for the verdict line.
func readyDetail(ready string) string {
	flags := strings.Fields(ready)
	n := 0
	for _, f := range flags {
		if f == "true" {
			n++
		}
	}
	return strconv.Itoa(n) + "/" + strconv.Itoa(len(flags)) + " containers ready"
}
