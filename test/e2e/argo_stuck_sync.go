// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"time"
)

// WHY A SYNC THAT IS STILL *RUNNING* DID NOT FINISH.
//
// argo_sync_failure.go asks the Application what it says about its last sync. On azure/addons run
// 33255369578 it worked exactly as designed and printed, for the one loser of twenty:
//
//	addon-kube-prometheus-stack: health=Missing sync=OutOfSync
//	  phase=Running waiting for completion of hook
//	  rbac.authorization.k8s.io/ClusterRole/addon-kube-prometheus-stac-admission and 1 more hooks
//	  ServiceAccount/…-admission in monitoring:  …-admission created
//	  ClusterRoleBinding/…-admission in monitoring:  …-admission created
//	  Role/…-admission in monitoring:  …-admission created
//	  RoleBinding/…-admission in monitoring:  …-admission created
//
// That is a real answer, and it is the reason this file exists rather than another guess: four of
// the chart's six pre-install hooks went in, two did not, and the Application has NOTHING FURTHER
// TO SAY about the two. A resource with no sync result recorded has no message, no status and no
// condition — the object cannot explain a step it never reached.
//
// Two things can, and neither was being asked:
//
//   - the argocd-application-controller's own log, which records the API error it got when it tried
//     to apply that hook. This is the single line the run needed and did not have.
//   - the cluster's Warning events in the destination namespace, which record the OTHER shape of
//     this failure: the hook object was created fine and its POD could not run (image pull, quota,
//     an admission webhook, no schedulable node).
//
// THE CHART IS NOT THE VARIABLE, and that was measured rather than assumed. The identical
// Application — same chart 61.9.0, same argo-cd 9.5.11 (v3.3.9), same
// `CreateNamespace=true,ServerSideApply=true,RespectIgnoreDifferences=true` — was applied to a
// throwaway kind cluster before this file was written. It was PAST the hook phase 31 seconds later
// and Healthy+Synced at 61. aws/addons run 33249968471 syncs it too. So the hook phase clears
// everywhere we can watch it for free, and what is left is something the AKS cluster did: an answer
// only the controller's log and the cluster's events hold, neither of which anything was reading.

// controllerComponentSelector selects the application-controller pod.
//
// On COMPONENT, not on `app.kubernetes.io/name`: the name label carries the Helm release name in
// some chart versions, so a release not called `argocd` would silently match nothing — the worst
// failure a diagnostic can have. `component=application-controller` is release-independent.
// Verified against a live argo-cd 9.5.11 install rather than read off the chart source.
const controllerComponentSelector = "app.kubernetes.io/component=application-controller"

// maxControllerLines caps what is PRINTED, keeping the most recent matches — a stuck sync retries,
// so the interesting line is repeated and the last copy is as good as the first.
const maxControllerLines = 60

// controllerTailLines is how far back the read reaches. It is a WINDOW, and the scan reports when
// it was filled — see controllerLogScan.WindowFull.
const controllerTailLines = 4000

// controllerLogScan is everything the filter learned, kept together because the verdict needs all
// of it. Three separate empties look identical in the output and mean opposite things:
//
//	Scanned == 0   no log at all — nothing has been syncing anything
//	Levelled low   a format this filter cannot read — it cannot tell an error from an info line
//	Matched == 0   read fine, nothing to report — the controller does not consider this a failure
//
// Matched is counted BEFORE the print cap, so the verdict can say how many it is not showing
// instead of quietly reporting the cap as the total.
type controllerLogScan struct {
	Kept       []string
	Scanned    int
	Levelled   int
	Matched    int
	Pods       int
	WindowFull bool
}

// filterControllerLines keeps the controller lines that speak about the failing Applications.
func filterControllerLines(raw []byte, losers []string, max, tail int) controllerLogScan {
	if max <= 0 {
		max = maxControllerLines
	}
	if tail <= 0 {
		tail = controllerTailLines
	}
	var sc controllerLogScan
	// Per-pod LINE COUNTS, not a set: the window is per pod, so the count is what decides whether
	// any of them was truncated. The empty key holds a log with no --prefix blocks, which is one
	// window's worth by definition.
	pods := map[string]int{}
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		sc.Scanned++
		if m := podPrefixRE.FindStringSubmatch(line); m != nil {
			pods[m[1]]++
		} else {
			pods[""]++
		}
		if hasKnownLevel(line) {
			sc.Levelled++
		}
		if !controllerLineMatters(line, losers) {
			continue
		}
		sc.Matched++
		sc.Kept = append(sc.Kept, line)
	}
	if len(sc.Kept) > max {
		sc.Kept = sc.Kept[len(sc.Kept)-max:]
	}
	sc.Pods = len(pods)
	if sc.Pods == 0 {
		sc.Pods = 1
	}
	// ANY POD AT ITS LIMIT, not the aggregate against the sum.
	//
	// `kubectl logs -l` applies --tail to EACH selected pod, so `Scanned >= Pods*tail` fires only
	// when EVERY pod filled its window. Two controller shards — one genuinely truncated at 4000 and
	// one idle at 10 — would report a complete read, and the caveat would be withdrawn on exactly
	// the case it exists for: a busy pod whose first failure is off the top.
	//
	// One pod's window is full ⇒ something was cut. That is the honest bound.
	for _, n := range pods {
		if n >= tail {
			sc.WindowFull = true
			break
		}
	}
	return sc
}

// podPrefixRE matches the `[pod/<name>/<container>]` prefix `kubectl logs --prefix` writes.
var podPrefixRE = regexp.MustCompile(`^\[pod/([^/\]]+)`)

// Unreadable reports whether the log is in a format this filter does not understand.
//
// A ZERO CHECK, not a ratio — and the strictness lives in `anyLevelRE` instead, which is the right
// place for it. A ratio was the first attempt and it is wrong for the case this dump exists for: a
// panicking application-controller emits ONE `level=panic` line followed by dozens of un-levelled
// stack-trace lines, and a window dominated by those would drop below any majority and tell the
// reader to distrust a log the filter had parsed perfectly. Continuation lines are not a foreign
// format. One line that really is logrus-shaped is proof the filter can read this log.
func (s controllerLogScan) Unreadable() bool { return s.Levelled == 0 }

// levelMarkers are the shapes a log level takes in argo-cd's two output formats.
//
// argo-cd 9.5.11 (v3.3.9) defaults to logrus TEXT — `time="…" level=info msg="…"` — which is what
// this repo installs and what was read off a live cluster. But the format is one Helm value away
// from JSON, and a filter that silently matched nothing under JSON would print "not one line
// carries an error" about a log full of them.
//
// FATAL AND PANIC ARE HERE BECAUSE THIS REPO HAS ONE. `argocd_assert_test.go` carries a captured
// `"level":"fatal"` line off hetzner/addons run 33059349873 — an RBAC refusal. A severity list of
// error+warning treats a controller that FATALED as running and not complaining, which is the
// precise verdict this file exists to stop printing.
// ⚠️ THE SAME MATCHER AS hasKnownLevel, NARROWED TO THE SEVERITIES WORTH KEEPING. These were
// literal substrings while hasKnownLevel was widened to whitespace-tolerant regexes, and the gap
// between the two is a false verdict: `{"level": "error", …}` — one space, which logrus writes if
// anything downstream re-marshals — counted as READABLE and matched NOTHING, so `Unreadable()` was
// false, `Matched` was zero, and the confident "the controller is not complaining" printed over a
// log full of errors. Two matchers over one format must not be written twice.
const keptSeverities = `(warn|warning|error|fatal|panic)`

var keptTextRE = regexp.MustCompile(`^(\[[^\]]*\]\s+)?(time="[^"]*"\s+)?level=` + keptSeverities + `\b`)

var keptJSONRE = regexp.MustCompile(`"level"\s*:\s*"` + keptSeverities + `"`)

// severities is every level logrus can emit, as an alternation for the two format regexes.
const severities = `(trace|debug|info|warn|warning|error|fatal|panic)`

// levelTextRE matches logrus TEXT at the START of a record: an optional `[pod/…]` block from
// `kubectl logs --prefix`, an optional `time="…"` field, then `level=<severity>`.
//
// ANCHORED, and that is the whole point. `strings.Contains(line, "level=")` — and even a
// `\slevel=<severity>` — is satisfied by a marker sitting inside a quoted `msg=` or `error=`, which
// lets one line vouch for four thousand it says nothing about and switches the blindness check off
// in exactly the log it exists to flag. A level field only appears in this position when the line
// really is a logrus record.
var levelTextRE = regexp.MustCompile(`^(\[[^\]]*\]\s+)?(time="[^"]*"\s+)?level=` + severities + `\b`)

// levelJSONRE matches logrus JSON. Unanchored because the JSON formatter marshals a map and the
// key order is not ours to predict — a record with an `app` field sorts it before `level`. A
// JSON-quoted `"level":"error"` inside a MESSAGE would be escaped (`\"level\"`), so this cannot be
// satisfied from inside one.
var levelJSONRE = regexp.MustCompile(`"level"\s*:\s*"` + severities + `"`)

// hasKnownLevel reports whether a line carries a level marker in a format this filter understands.
func hasKnownLevel(line string) bool {
	return levelTextRE.MatchString(line) || levelJSONRE.MatchString(line)
}

// controllerLineMatters reports whether a controller log line is about a failing Application, or is
// an error the operator should see regardless of which app it names.
//
// The error/warning half is deliberate: the line that explains a failed hook apply is sometimes
// logged with the RESOURCE's name and not the Application's, and dropping it because it did not
// contain "addon-kube-prometheus-stack" would discard the answer while reporting success.
func controllerLineMatters(line string, losers []string) bool {
	for _, name := range losers {
		if name != "" && strings.Contains(line, name) {
			return true
		}
	}
	return keptTextRE.MatchString(line) || keptJSONRE.MatchString(line)
}

// renderControllerLog states the verdict, with every caveat that invalidates it printed FIRST.
//
// Pure, and separate from the shell-out, because the ORDER and the completeness of these branches
// is the whole substance of this file — and a rendering that only runs behind a live cluster is a
// rendering nothing tests.
func renderControllerLog(sc controllerLogScan) string {
	var b strings.Builder
	if sc.Scanned == 0 {
		fmt.Fprintf(&b, "  FINDING: the controller log is EMPTY. Either no pod matched %q "+
			"(the label changed) or the controller has not started — and in both cases nothing "+
			"has been syncing anything.\n", controllerComponentSelector)
		return b.String()
	}
	// The caveats come before the verdict and NOT INSTEAD OF IT. Making these a switch case would
	// discard the matched lines in exactly the log that most needs them printed.
	if sc.Unreadable() {
		fmt.Fprintf(&b, "  FINDING: only %d of %d line(s) carry a level marker in a format this "+
			"filter knows (`level=…` or `\"level\":…`). It cannot reliably tell an error from an "+
			"info line here, so read the raw log — do not read an absence below as calm.\n",
			sc.Levelled, sc.Scanned)
	}
	if sc.WindowFull {
		fmt.Fprintf(&b, "  FINDING: the read filled its %d-line window, and --tail keeps the "+
			"NEWEST lines. A sync stuck for the whole budget has its first failure at the far end, "+
			"which may be outside this window — an absence below is not evidence it never happened.\n",
			controllerTailLines)
	}
	if sc.Matched == 0 {
		// THE VERDICT IS ONLY A VERDICT WHEN NOTHING ABOVE CONTRADICTS IT. Under Unreadable() the
		// filter has just said it cannot tell an error from an info line, and under WindowFull that
		// the first failure may be outside what it read — so "is not complaining" is a claim it is
		// not entitled to make. Removing the switch was right for the matched case and wrong here,
		// where the rendering IS the verdict.
		if sc.Unreadable() || sc.WindowFull {
			fmt.Fprintf(&b, "  %d line(s) read and none matched — but see the finding(s) above. "+
				"This is NOT evidence that the controller is calm; it is what a filter that cannot "+
				"read this log, or could not see all of it, produces either way.\n", sc.Scanned)
			return b.String()
		}
		fmt.Fprintf(&b, "  %d line(s) read (%d with a level marker), and NOT ONE names a failing "+
			"Application or is an error. The controller is running and is not complaining — so "+
			"whatever is holding the sync is not something it considers a failure.\n",
			sc.Scanned, sc.Levelled)
		return b.String()
	}
	if hidden := sc.Matched - len(sc.Kept); hidden > 0 {
		fmt.Fprintf(&b, "  %d of %d line(s) name a loser or carry an error; the %d most recent are "+
			"shown and %d OLDER match(es) are not:\n", sc.Matched, sc.Scanned, len(sc.Kept), hidden)
	} else {
		fmt.Fprintf(&b, "  %d of %d line(s) name a loser or carry an error; most recent last:\n",
			sc.Matched, sc.Scanned)
	}
	for _, line := range sc.Kept {
		fmt.Fprintf(&b, "    %s\n", line)
	}
	return b.String()
}

// dumpArgoControllerLog asks the application-controller why it could not finish.
func dumpArgoControllerLog(ctx context.Context, kubeconfigPath string, losers []string) string {
	if len(losers) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n──── argocd-application-controller: what it logged about the losers ────\n")

	// One call, bounded. --tail rather than --since because a --since window sized for the poll
	// interval would cut the whole wait off — but --tail is a window too, keeping the NEWEST lines,
	// so filling it is reported rather than assumed away.
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var stderr strings.Builder
	cmd := exec.CommandContext(cctx, "kubectl", "--kubeconfig", kubeconfigPath, "-n", "argocd",
		"logs", "-l", controllerComponentSelector,
		fmt.Sprintf("--tail=%d", controllerTailLines), "--prefix")
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	// THE PARTIAL OUTPUT IS STILL THE ANSWER. `kubectl logs -l` reads the selected pods in sequence
	// and stops at the first one it cannot open, having already written the ones before it. On a
	// cluster unhealthy enough to be in this dump, an unopenable pod is likely — and discarding what
	// came back would lose the controller's account on exactly the runs this exists for.
	if err != nil && len(strings.TrimSpace(string(out))) == 0 {
		fmt.Fprintf(&b, "  could not be read (%s) — this says nothing about the sync\n",
			execFailure(err, stderr.String()))
		return b.String()
	}
	if err != nil {
		fmt.Fprintf(&b, "  PARTIAL: the read stopped early (%s). What follows is what came back "+
			"before it stopped, and an absence in it is not evidence.\n",
			execFailure(err, stderr.String()))
	}
	b.WriteString(renderControllerLog(filterControllerLines(out, losers, maxControllerLines, controllerTailLines)))
	return b.String()
}

// warningEvent is one Warning the cluster recorded, flattened for printing.
type warningEvent struct {
	Namespace string
	Object    string
	Reason    string
	Message   string
	Count     int
	Last      string
}

// loserNamespaces maps each failing Application to the namespace it deploys into.
//
// Read from the Applications themselves rather than assumed from the add-on id: the destination is
// the chart's, not ours, and an add-on whose namespace we guessed wrong would silently produce an
// empty event list — which reads as "no warnings" and is the opposite of the truth.
func loserNamespaces(appsJSON []byte, losers []string) (map[string]string, error) {
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
		} `json:"items"`
	}
	if err := json.Unmarshal(appsJSON, &list); err != nil {
		return nil, err
	}
	want := make(map[string]bool, len(losers))
	for _, n := range losers {
		want[n] = true
	}
	out := make(map[string]string, len(losers))
	for _, it := range list.Items {
		if want[it.Metadata.Name] && it.Spec.Destination.Namespace != "" {
			out[it.Metadata.Name] = it.Spec.Destination.Namespace
		}
	}
	return out, nil
}

// filterWarningEvents keeps the Warnings raised in the losers' namespaces.
//
// Filtered by NAMESPACE and never by object name. The chart's own resources are named from a
// TRUNCATED release name — the Application is `addon-kube-prometheus-stack` and its objects are
// `addon-kube-prometheus-stac-…` — so a substring match on the Application's name matches none of
// its own resources. That trap is the reason this takes a namespace set.
//
// Returns the count scanned so an empty result can say which of the two things it means.
func filterWarningEvents(eventsJSON []byte, namespaces map[string]bool, max int) (events []warningEvent, scanned int, err error) {
	var list struct {
		Items []struct {
			Metadata struct {
				Namespace string `json:"namespace"`
			} `json:"metadata"`
			InvolvedObject struct {
				Kind string `json:"kind"`
				Name string `json:"name"`
			} `json:"involvedObject"`
			Reason        string `json:"reason"`
			Message       string `json:"message"`
			Type          string `json:"type"`
			Count         int    `json:"count"`
			LastTimestamp string `json:"lastTimestamp"`
		} `json:"items"`
	}
	if err := json.Unmarshal(eventsJSON, &list); err != nil {
		return nil, 0, err
	}
	for _, it := range list.Items {
		scanned++
		// `--field-selector type=Warning` is applied server-side, but it is re-checked here so the
		// pure function is correct on its own and a caller that drops the selector cannot quietly
		// turn this into a dump of every Normal event in the cluster.
		if !strings.EqualFold(it.Type, "Warning") {
			continue
		}
		if !namespaces[it.Metadata.Namespace] {
			continue
		}
		events = append(events, warningEvent{
			Namespace: it.Metadata.Namespace,
			Object:    it.InvolvedObject.Kind + "/" + it.InvolvedObject.Name,
			Reason:    it.Reason,
			Message:   strings.TrimSpace(it.Message),
			Count:     it.Count,
			Last:      it.LastTimestamp,
		})
	}
	// Most recent last, so the tail of the dump is the newest state — the same order the controller
	// log is printed in, because two diagnostics that disagree about direction are read wrong.
	sort.SliceStable(events, func(i, j int) bool { return events[i].Last < events[j].Last })
	if max > 0 && len(events) > max {
		events = events[len(events)-max:]
	}
	return events, scanned, nil
}

// maxWarningEvents caps the printed Warnings. A crash-looping pod produces one every few seconds.
const maxWarningEvents = 40

// dumpDestinationWarnings prints the cluster's Warning events in the losers' namespaces.
//
// This is the half of a stuck sync the Application cannot see: a hook object that applied fine and
// whose POD never ran leaves the Application saying "waiting for completion" and nothing else,
// while the cluster has been recording FailedCreate / ImagePullBackOff / FailedScheduling for it
// the whole time.
func dumpDestinationWarnings(ctx context.Context, kubeconfigPath string, losers []string) string {
	if len(losers) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n──── cluster Warnings in the losers' destination namespaces ────\n")

	appsOut, err := kubectlValue(ctx, 20*time.Second, kubeconfigPath,
		"get", "applications.argoproj.io", "-n", "argocd", "-o", "json")
	if err != nil {
		fmt.Fprintf(&b, "  could not read the Applications to learn their namespaces (%v)\n", err)
		return b.String()
	}
	byApp, err := loserNamespaces(appsOut, losers)
	if err != nil {
		fmt.Fprintf(&b, "  could not parse the Applications (%v)\n", err)
		return b.String()
	}
	if len(byApp) == 0 {
		fmt.Fprintf(&b, "  FINDING: not one of the %d failing Application(s) declares a destination "+
			"namespace. Nothing could have been deployed anywhere.\n", len(losers))
		return b.String()
	}
	nsSet := make(map[string]bool, len(byApp))
	names := make([]string, 0, len(byApp))
	for app, ns := range byApp {
		nsSet[ns] = true
		names = append(names, app+" → "+ns)
	}
	sort.Strings(names)
	fmt.Fprintf(&b, "  %s\n", strings.Join(names, ", "))
	if len(byApp) < len(losers) {
		fmt.Fprintf(&b, "  (%d of %d loser(s) had no readable destination and are NOT covered below)\n",
			len(losers)-len(byApp), len(losers))
	}

	evOut, err := kubectlValue(ctx, 30*time.Second, kubeconfigPath,
		"get", "events", "--all-namespaces", "--field-selector", "type=Warning", "-o", "json")
	if err != nil {
		fmt.Fprintf(&b, "  could not read events (%v)\n", err)
		return b.String()
	}
	events, scanned, perr := filterWarningEvents(evOut, nsSet, maxWarningEvents)
	if perr != nil {
		fmt.Fprintf(&b, "  could not parse events (%v)\n", perr)
		return b.String()
	}
	switch {
	case scanned == 0:
		b.WriteString("  FINDING: the cluster holds NO Warning events at all. Events expire after " +
			"an hour by default, so on a wait this long that is expected — it is not evidence " +
			"that nothing went wrong.\n")
	case len(events) == 0:
		fmt.Fprintf(&b, "  %d Warning(s) in the cluster, NONE in these namespaces — so whatever is "+
			"holding these Applications did not reach the point of a workload complaining.\n", scanned)
	default:
		fmt.Fprintf(&b, "  %d of %d cluster Warning(s) are in these namespaces; most recent last:\n", len(events), scanned)
		for _, e := range events {
			fmt.Fprintf(&b, "    [%s] %s/%s %s ×%d: %s\n", e.Last, e.Namespace, e.Object, e.Reason, e.Count, truncateLine(e.Message, 300))
		}
	}
	return b.String()
}

// kubectlValue runs one kubectl read and returns STDOUT, with stderr folded into the error.
//
// `exec.Output()` alone gives the caller `exit status 1` for a missing CRD, an RBAC refusal and an
// unreachable API server alike — three faults with three different next steps, rendered as one
// number. And CombinedOutput is not the answer either: this stdout is a VALUE, and kubectl writes
// to stderr on calls that SUCCEED.
func kubectlValue(ctx context.Context, timeout time.Duration, kubeconfigPath string, args ...string) ([]byte, error) {
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	full := append([]string{"--kubeconfig", kubeconfigPath}, args...)
	var stderr strings.Builder
	cmd := exec.CommandContext(cctx, "kubectl", full...)
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		// The bytes already collected are returned alongside the error. Both callers here parse
		// JSON, so a partial document is unusable to them today — but this is the package's shared
		// kubectl read and its contract should not be "a command that half-succeeded produced
		// nothing", which is the shape #3378 had to remove from the Job-log read.
		if msg := kubectlErrorLine(stderr.String()); msg != "" {
			return out, fmt.Errorf("%w: %s", err, msg)
		}
		return out, err
	}
	return out, nil
}

// execFailure renders a command failure as one string, with kubectl's own words when it left any.
// Kept separate so an empty stderr does not produce a message ending in a bare colon.
func execFailure(err error, stderr string) string {
	if msg := kubectlErrorLine(stderr); msg != "" {
		return fmt.Sprintf("%v: %s", err, msg)
	}
	return fmt.Sprintf("%v", err)
}

// errorLineRE matches the shapes kubectl uses for an ERROR, as opposed to the warnings it routinely
// writes to the same stream on calls that succeed.
var errorLineRE = regexp.MustCompile(`(?m)^\s*(error:|Error from server|The connection to the server|Unable to connect)`)

// kubectlErrorLine picks the line of stderr that says what went wrong.
//
// NOT the first line. kubectl's first stderr line on a managed cluster is routinely a warning —
// #3338 measured `WARNING: the gcp auth plugin is deprecated in v1.22+…` as the ordinary shape of
// authenticating to EKS, GKE and AKS. Taking it makes a missing CRD, an RBAC refusal and an
// unreachable API server render identically, which is the defect this selection exists to prevent.
//
// Falls back to the whole trimmed stderr rather than to the first line: if no line matches a shape
// we recognise, showing everything is the honest answer, and it is bounded because the caller reads
// one command's stderr.
func kubectlErrorLine(stderr string) string {
	for _, line := range strings.Split(stderr, "\n") {
		if errorLineRE.MatchString(line) {
			return strings.TrimSpace(line)
		}
	}
	return strings.TrimSpace(stderr)
}

// firstLine returns s up to its first newline, for one-line error rendering.
func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// truncateLine bounds one printed message without hiding that it was cut.
func truncateLine(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "…(truncated)"
}
