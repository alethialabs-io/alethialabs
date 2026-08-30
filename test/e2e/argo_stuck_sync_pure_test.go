// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build !e2e_t1 && !e2e_t2 && !e2e_b6

package e2e

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The shapes here are copied from a real cluster, not invented: the controller lines are argo-cd
// v3.3.9's logrus format, and the event JSON is `kubectl get events -o json`'s.

func TestFilterControllerLinesKeepsLoserAndErrorLines(t *testing.T) {
	raw := []byte(strings.Join([]string{
		`[pod/argocd-application-controller-0/application-controller] time="2026-08-29T14:07:01Z" level=info msg="Refreshing app addon-loki"`,
		`[pod/argocd-application-controller-0/application-controller] time="2026-08-29T14:07:02Z" level=info msg="Syncing app addon-kube-prometheus-stack"`,
		`[pod/argocd-application-controller-0/application-controller] time="2026-08-29T14:07:03Z" level=error msg="Failed to apply hook" error="clusterroles.rbac.authorization.k8s.io is forbidden"`,
		`[pod/argocd-application-controller-0/application-controller] time="2026-08-29T14:07:04Z" level=info msg="Normalized app spec"`,
		"",
	}, "\n"))

	sc := filterControllerLines(raw, []string{"addon-kube-prometheus-stack"}, 60, 0)
	kept, scanned, levelled := sc.Kept, sc.Scanned, sc.Levelled
	if scanned != 4 {
		t.Fatalf("scanned = %d, want 4 (the blank line is not a line)", scanned)
	}
	if levelled != 4 {
		t.Fatalf("levelled = %d, want 4 — every line here is logrus text", levelled)
	}
	if len(kept) != 2 {
		t.Fatalf("kept %d lines, want 2:\n%s", len(kept), strings.Join(kept, "\n"))
	}
	if !strings.Contains(kept[0], "Syncing app addon-kube-prometheus-stack") {
		t.Errorf("first kept line is not the loser's: %s", kept[0])
	}
	// The error line names no Application at all. Dropping it is the failure mode this half exists
	// to prevent — it is the line that carries the answer.
	if !strings.Contains(kept[1], "is forbidden") {
		t.Errorf("the error line that names no app was dropped: %v", kept)
	}
}

func TestFilterControllerLinesKeepsTheMostRecentWhenCapped(t *testing.T) {
	var lines []string
	for i := 0; i < 10; i++ {
		lines = append(lines, `level=error msg="attempt `+string(rune('0'+i))+`"`)
	}
	sc := filterControllerLines([]byte(strings.Join(lines, "\n")), nil, 3, 0)
	kept, scanned := sc.Kept, sc.Scanned
	if scanned != 10 {
		t.Fatalf("scanned = %d, want 10", scanned)
	}
	if len(kept) != 3 {
		t.Fatalf("kept %d, want 3", len(kept))
	}
	// A stuck sync repeats; the LAST copy is the current state, so the cap must drop the oldest.
	if !strings.Contains(kept[2], "attempt 9") {
		t.Errorf("cap kept the wrong end — last line is %q, want attempt 9", kept[2])
	}
}

func TestFilterControllerLinesEmptyLogIsDistinguishable(t *testing.T) {
	sc := filterControllerLines(nil, []string{"addon-x"}, 60, 0)
	kept, scanned := sc.Kept, sc.Scanned
	if scanned != 0 || len(kept) != 0 {
		t.Fatalf("empty log: scanned=%d kept=%d, want 0/0", scanned, len(kept))
	}
	// And a log that HAS lines but none matching must report a non-zero scan, so the caller can
	// tell "the controller is silent about these apps" from "there is no controller".
	sc = filterControllerLines([]byte("level=info msg=\"all good\"\n"), []string{"addon-x"}, 60, 0)
	kept, scanned = sc.Kept, sc.Scanned
	if scanned != 1 || len(kept) != 0 {
		t.Fatalf("non-matching log: scanned=%d kept=%d, want 1/0", scanned, len(kept))
	}
}

const appsListJSON = `{"items":[
 {"metadata":{"name":"addon-kube-prometheus-stack"},"spec":{"destination":{"namespace":"monitoring"}}},
 {"metadata":{"name":"addon-loki"},"spec":{"destination":{"namespace":"logging"}}},
 {"metadata":{"name":"addon-no-destination"},"spec":{"destination":{}}}
]}`

func TestLoserNamespacesReadsTheDestinationFromTheApplication(t *testing.T) {
	got, err := loserNamespaces([]byte(appsListJSON), []string{"addon-kube-prometheus-stack", "addon-no-destination"})
	if err != nil {
		t.Fatal(err)
	}
	if got["addon-kube-prometheus-stack"] != "monitoring" {
		t.Errorf("destination = %q, want monitoring", got["addon-kube-prometheus-stack"])
	}
	// A loser with no destination is ABSENT rather than mapped to "", so the caller can say how
	// many losers it could not cover instead of silently searching the empty namespace.
	if _, ok := got["addon-no-destination"]; ok {
		t.Errorf("an Application with no destination namespace was mapped anyway: %v", got)
	}
	// And a healthy app is not a loser: its namespace must not widen the event filter.
	if _, ok := got["addon-loki"]; ok {
		t.Errorf("a non-loser was included: %v", got)
	}
}

const eventsJSON = `{"items":[
 {"metadata":{"namespace":"monitoring"},"involvedObject":{"kind":"Pod","name":"addon-kube-prometheus-stac-admission-create-abcde"},
  "reason":"Failed","message":"Error: ImagePullBackOff","type":"Warning","count":9,"lastTimestamp":"2026-08-29T14:30:00Z"},
 {"metadata":{"namespace":"monitoring"},"involvedObject":{"kind":"Job","name":"addon-kube-prometheus-stac-admission-create"},
  "reason":"BackoffLimitExceeded","message":"Job has reached the specified backoff limit","type":"Warning","count":1,"lastTimestamp":"2026-08-29T14:35:00Z"},
 {"metadata":{"namespace":"kube-system"},"involvedObject":{"kind":"Pod","name":"konnectivity"},
  "reason":"Unhealthy","message":"probe failed","type":"Warning","count":3,"lastTimestamp":"2026-08-29T14:36:00Z"},
 {"metadata":{"namespace":"monitoring"},"involvedObject":{"kind":"Pod","name":"whatever"},
  "reason":"Scheduled","message":"assigned","type":"Normal","count":1,"lastTimestamp":"2026-08-29T14:37:00Z"}
]}`

func TestFilterWarningEventsScopesToTheNamespacesAndDropsNormal(t *testing.T) {
	got, scanned, err := filterWarningEvents([]byte(eventsJSON), map[string]bool{"monitoring": true}, 40)
	if err != nil {
		t.Fatal(err)
	}
	if scanned != 4 {
		t.Fatalf("scanned = %d, want 4 (every item, so an empty result can say which kind of empty)", scanned)
	}
	if len(got) != 2 {
		t.Fatalf("kept %d, want 2 (the two monitoring Warnings): %+v", len(got), got)
	}
	// Sorted oldest-first, so the tail of the printed dump is the newest state.
	if got[0].Reason != "Failed" || got[1].Reason != "BackoffLimitExceeded" {
		t.Errorf("order is not oldest-first: %+v", got)
	}
	// The chart's objects are named from a TRUNCATED release name; a filter keyed on the
	// Application's own name would have matched neither of these two.
	if !strings.HasPrefix(got[0].Object, "Pod/addon-kube-prometheus-stac-admission-create") {
		t.Errorf("unexpected object: %s", got[0].Object)
	}
	if got[0].Count != 9 {
		t.Errorf("count lost: %+v", got[0])
	}
}

func TestFilterWarningEventsEmptyResultIsNotSilence(t *testing.T) {
	// Warnings exist, but none in the namespace we care about: scanned must stay non-zero so the
	// renderer prints "N in the cluster, NONE in these namespaces" rather than nothing at all.
	got, scanned, err := filterWarningEvents([]byte(eventsJSON), map[string]bool{"logging": true}, 40)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 || scanned != 4 {
		t.Fatalf("got %d events, scanned %d; want 0 and 4", len(got), scanned)
	}
}

func TestFilterWarningEventsCapKeepsTheNewest(t *testing.T) {
	got, _, err := filterWarningEvents([]byte(eventsJSON), map[string]bool{"monitoring": true}, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Reason != "BackoffLimitExceeded" {
		t.Fatalf("cap kept the wrong end: %+v", got)
	}
}

// JSON is one Helm value away, and a filter that matched nothing under it would print "not one
// line carries an error" about a log full of them.
func TestFilterControllerLinesReadsTheJSONLogFormat(t *testing.T) {
	raw := []byte(`{"level":"error","msg":"Failed to apply hook","error":"clusterroles is forbidden"}` + "\n" +
		`{"level":"info","msg":"Reconciliation completed"}`)
	sc := filterControllerLines(raw, nil, 60, 0)
	kept, scanned, levelled := sc.Kept, sc.Scanned, sc.Levelled
	if scanned != 2 || levelled != 2 {
		t.Fatalf("scanned=%d levelled=%d, want 2/2", scanned, levelled)
	}
	if len(kept) != 1 || !strings.Contains(kept[0], "is forbidden") {
		t.Fatalf("the JSON error line was not kept: %v", kept)
	}
}

// The blindness itself: a log in neither format must be REPORTED as unreadable, not silently
// produce an empty result that reads as calm.
func TestFilterControllerLinesReportsALogItCannotRead(t *testing.T) {
	raw := []byte("2026-08-29 14:07:01 E some other logger entirely\n2026-08-29 14:07:02 I fine")
	sc := filterControllerLines(raw, []string{"addon-x"}, 60, 0)
	kept, scanned, levelled := sc.Kept, sc.Scanned, sc.Levelled
	if scanned != 2 {
		t.Fatalf("scanned = %d, want 2", scanned)
	}
	if levelled != 0 {
		t.Fatalf("levelled = %d, want 0 — neither line is a format this filter knows", levelled)
	}
	if len(kept) != 0 {
		t.Fatalf("kept %v from a format it cannot read", kept)
	}
}

// A `fatal` line is the one this repo has actually captured: argocd_assert_test.go carries a
// `"level":"fatal"` off hetzner/addons run 33059349873, an RBAC refusal. An error+warning list
// treats a controller that fataled as running and not complaining.
func TestFilterControllerLinesKeepsFatalAndPanic(t *testing.T) {
	for _, line := range []string{
		`time="…" level=fatal msg="Failed to establish connection"`,
		`{"level":"fatal","msg":"Failed to establish connection"}`,
		`time="…" level=panic msg="nil map"`,
		`{"level":"panic","msg":"nil map"}`,
	} {
		sc := filterControllerLines([]byte(line), nil, 60, 0)
		if len(sc.Kept) != 1 {
			t.Errorf("%q was dropped — a controller that died reads as one that is not complaining", line)
		}
	}
}

func TestRenderControllerLogEmptyLogIsItsOwnFinding(t *testing.T) {
	out := renderControllerLog(controllerLogScan{})
	if !strings.Contains(out, "log is EMPTY") {
		t.Errorf("an empty log must say so:\n%s", out)
	}
}

// THE REGRESSION THE REVIEW CAUGHT. The unreadable-format caveat used to be a switch CASE, so it
// replaced the rendering — the matched lines were discarded in exactly the log that most needed
// them printed, and "the absence below" referred to nothing.
func TestRenderControllerLogPrintsMatchesEvenWhenTheFormatIsUnreadable(t *testing.T) {
	out := renderControllerLog(controllerLogScan{
		Kept:     []string{"2026-08-29 E something about addon-x"},
		Scanned:  100,
		Levelled: 0,
		Matched:  1,
	})
	if !strings.Contains(out, "cannot reliably tell an error") {
		t.Errorf("the caveat is missing:\n%s", out)
	}
	if !strings.Contains(out, "something about addon-x") {
		t.Errorf("the caveat swallowed the matched line:\n%s", out)
	}
	// And the caveat must come FIRST — a verdict read before its caveat is a verdict believed.
	if strings.Index(out, "cannot reliably tell") > strings.Index(out, "something about addon-x") {
		t.Errorf("the caveat is printed after the lines it qualifies:\n%s", out)
	}
}

// The strictness moved from a RATIO into the marker itself. A `level=` inside a quoted `msg=` is
// not a level marker, and requiring the severity word at a token boundary is what makes one match
// mean the line really is logrus-shaped.
func TestHasKnownLevelRequiresARealSeverity(t *testing.T) {
	for _, line := range []string{
		`time="2026-08-29T14:07:03Z" level=error msg="Failed to apply"`,
		`[pod/argocd-application-controller-0/application-controller] time="…" level=info msg="ok"`,
		`{"app":"addon-x","level":"error","msg":"boom"}`,
		`level=info msg="ok"`,
		`{"level":"fatal","msg":"boom"}`,
		`{"level": "warning", "msg": "x"}`,
	} {
		if !hasKnownLevel(line) {
			t.Errorf("a real level marker was not recognised: %s", line)
		}
	}
	// ⚠️ READABLE AND KEPT MUST AGREE ON THE SAME SPELLING. `hasKnownLevel` was widened to
	// whitespace-tolerant regexes while the keep-list stayed literal substrings, so a spaced JSON
	// record counted as readable and matched nothing — Unreadable() false, Matched zero, and the
	// confident "not complaining" verdict over a log full of errors. Asserting only readability
	// here is what BAKED that in.
	for _, line := range []string{
		`{"level": "error", "msg": "Failed to apply hook"}`,
		`{"level":"fatal","msg":"boom"}`,
		`time="…" level=warning msg="x"`,
	} {
		if !hasKnownLevel(line) {
			t.Errorf("not readable: %s", line)
		}
		if !controllerLineMatters(line, nil) {
			t.Errorf("readable but never kept — this is the gap that prints a calm verdict over "+
				"errors: %s", line)
		}
	}
	// And an INFO line is readable but correctly not kept: the two matchers agree on the format and
	// differ only on severity, which is the whole design.
	if info := `{"level": "info", "msg": "ok"}`; !hasKnownLevel(info) || controllerLineMatters(info, nil) {
		t.Errorf("info must be readable and NOT kept: %s", info)
	}
	// The one that matters: a level marker sitting inside a MESSAGE, on a line that is not a
	// logrus record. Unanchored matching counts it and one such line then vouches for the whole log.
	for _, line := range []string{
		`2026-08-29 14:07 some-other-logger the operator set level=error on the cluster`,
		`some other logger: level=`,
		`{"lvl":"error"}`,
		`2026-08-29 14:07:01 E some other logger entirely`,
	} {
		if hasKnownLevel(line) {
			t.Errorf("a non-marker was counted as one, which lets one line vouch for the log: %s", line)
		}
	}
}

// A panicking controller emits ONE level=panic line and dozens of un-levelled stack-trace lines.
// A majority rule would tell the reader to distrust a log the filter parsed perfectly — on exactly
// the failure this dump exists for.
func TestControllerLogScanTreatsAStackTraceAsReadable(t *testing.T) {
	lines := []string{`time="…" level=panic msg="nil map" app=addon-x`}
	for i := 0; i < 40; i++ {
		lines = append(lines, "\tgithub.com/argoproj/argo-cd/v3/controller.(*ApplicationController).Sync(0x0)")
	}
	sc := filterControllerLines([]byte(strings.Join(lines, "\n")), nil, 60, 0)
	if sc.Unreadable() {
		t.Errorf("a panic plus its stack trace was reported as an unreadable format (%d of %d levelled)",
			sc.Levelled, sc.Scanned)
	}
	if len(sc.Kept) != 1 {
		t.Errorf("the panic line was not kept: %v", sc.Kept)
	}
}

// And a log in a format the filter genuinely cannot read still reports it.
func TestControllerLogScanReportsAFormatItCannotRead(t *testing.T) {
	sc := filterControllerLines([]byte("2026-08-29 E one\n2026-08-29 I two"), []string{"addon-x"}, 60, 0)
	if !sc.Unreadable() {
		t.Errorf("neither line is a format this filter knows, but Unreadable() is false (%+v)", sc)
	}
}

func TestRenderControllerLogSaysWhenTheWindowWasFull(t *testing.T) {
	out := renderControllerLog(controllerLogScan{
		Scanned: controllerTailLines, Levelled: controllerTailLines, Matched: 0, Pods: 1, WindowFull: true,
	})
	if !strings.Contains(out, "keeps the NEWEST lines") {
		t.Errorf("a filled --tail window must be reported — the first failure may be outside it:\n%s", out)
	}
}

// `kubectl logs -l` applies --tail to EACH pod, so the window is per pod — and one pod at its limit
// means something was cut, whatever the others did.
func TestControllerLogScanCountsTheWindowPerPod(t *testing.T) {
	var lines []string
	for _, pod := range []string{"argocd-application-controller-0", "argocd-application-controller-1"} {
		for i := 0; i < 5; i++ {
			lines = append(lines, "[pod/"+pod+"/application-controller] level=info msg=\"x\"")
		}
	}
	// tail=10: two pods, five lines each — neither window was filled.
	sc := filterControllerLines([]byte(strings.Join(lines, "\n")), nil, 60, 10)
	if sc.Pods != 2 {
		t.Fatalf("Pods = %d, want 2 — the --prefix blocks are how the pod count is known", sc.Pods)
	}
	if sc.WindowFull {
		t.Errorf("two pods at half a window each reported a FULL window (%d lines, tail 10)", sc.Scanned)
	}
	// One pod at exactly its tail is a full window.
	if one := filterControllerLines([]byte(strings.Join(lines[:5], "\n")), nil, 60, 5); !one.WindowFull {
		t.Errorf("one pod at exactly its tail is a full window: %+v", one)
	}
}

// ONE BUSY POD IS ENOUGH. Comparing the aggregate against Pods*tail fires only when EVERY pod
// filled its window, so a truncated shard beside an idle one reports a complete read — and the
// caveat is withdrawn on exactly the case it exists for.
func TestControllerLogScanFlagsATruncatedPodBesideAnIdleOne(t *testing.T) {
	var lines []string
	for i := 0; i < 10; i++ {
		lines = append(lines, "[pod/busy/application-controller] level=info msg=\"x\"")
	}
	lines = append(lines, "[pod/idle/application-controller] level=info msg=\"x\"")

	sc := filterControllerLines([]byte(strings.Join(lines, "\n")), nil, 60, 10)
	if !sc.WindowFull {
		t.Errorf("a pod at its 10-line tail beside an idle one reported a complete read: %+v", sc)
	}
}

// A log with no --prefix blocks is one window's worth by definition, and must still be able to
// report itself truncated.
func TestControllerLogScanCountsAnUnprefixedLogAsOneWindow(t *testing.T) {
	var lines []string
	for i := 0; i < 4; i++ {
		lines = append(lines, `level=info msg="x"`)
	}
	if sc := filterControllerLines([]byte(strings.Join(lines, "\n")), nil, 60, 4); !sc.WindowFull {
		t.Errorf("four lines against a tail of four is a full window: %+v", sc)
	}
}

func TestRenderControllerLogCountsMatchesItIsNotShowing(t *testing.T) {
	out := renderControllerLog(controllerLogScan{
		Kept:     []string{"a", "b"},
		Scanned:  500,
		Levelled: 500,
		Matched:  90,
	})
	// 90 matched, 2 shown: reporting "2 of 500" as the match count would understate the evidence by
	// a factor of forty-five.
	if !strings.Contains(out, "90 of 500") {
		t.Errorf("the capped count was reported as the match count:\n%s", out)
	}
	if !strings.Contains(out, "88 OLDER match(es) are not") {
		t.Errorf("the dropped matches are not accounted for:\n%s", out)
	}
}

func TestRenderControllerLogNothingToReportIsStillAVerdict(t *testing.T) {
	out := renderControllerLog(controllerLogScan{Scanned: 200, Levelled: 200, Matched: 0})
	if !strings.Contains(out, "NOT ONE names a failing") {
		t.Errorf("a clean log must still produce a verdict:\n%s", out)
	}
	if strings.Contains(out, "cannot reliably tell") {
		t.Errorf("a fully readable log must not carry the blindness caveat:\n%s", out)
	}
}

// kubectl writes warnings to stderr on calls that SUCCEED, and they come FIRST. #3338 measured the
// gcp-auth-plugin and StorageClass deprecation warnings as the ordinary shape of authenticating to
// EKS, GKE and AKS — so taking line one makes a missing CRD, an RBAC refusal and an unreachable
// API server render identically.
func TestKubectlErrorLinePicksTheErrorNotTheWarning(t *testing.T) {
	stderr := "WARNING: the gcp auth plugin is deprecated in v1.22+, unavailable in v1.26+\n" +
		"Warning: storage.k8s.io/v1beta1 StorageClass is deprecated\n" +
		`Error from server (Forbidden): applications.argoproj.io is forbidden`
	got := kubectlErrorLine(stderr)
	if !strings.Contains(got, "Forbidden") {
		t.Errorf("kubectlErrorLine = %q — the warning was reported as the failure", got)
	}
	if strings.Contains(got, "gcp auth plugin") {
		t.Errorf("the warning came through: %q", got)
	}
	// A shape we do not recognise: show everything rather than an arbitrary line.
	odd := kubectlErrorLine("something unexpected\nand a second line")
	if !strings.Contains(odd, "something unexpected") || !strings.Contains(odd, "second line") {
		t.Errorf("an unrecognised stderr must be shown whole, got %q", odd)
	}
	// Nothing at all must stay nothing, so the caller does not print a dangling colon.
	if got := kubectlErrorLine("   \n  "); got != "" {
		t.Errorf("empty stderr rendered as %q", got)
	}
}

// Under a caveat, the "not complaining" line is a claim the filter is not entitled to make.
func TestRenderControllerLogWithdrawsTheVerdictUnderACaveat(t *testing.T) {
	blind := renderControllerLog(controllerLogScan{Scanned: 4000, Levelled: 0, Matched: 0, Pods: 1})
	if strings.Contains(blind, "is not complaining") {
		t.Errorf("a filter that cannot read the log still claimed the controller is calm:\n%s", blind)
	}
	if !strings.Contains(blind, "NOT evidence") {
		t.Errorf("the withdrawal is not stated:\n%s", blind)
	}
	cut := renderControllerLog(controllerLogScan{
		Scanned: 4000, Levelled: 4000, Matched: 0, Pods: 1, WindowFull: true,
	})
	if strings.Contains(cut, "is not complaining") {
		t.Errorf("a truncated window still produced a calm verdict:\n%s", cut)
	}
	// And with no caveat, the verdict IS stated — withdrawing it always would be its own defect.
	clean := renderControllerLog(controllerLogScan{Scanned: 200, Levelled: 200, Matched: 0, Pods: 1})
	if !strings.Contains(clean, "is not complaining") {
		t.Errorf("a clean, fully readable log must still produce a verdict:\n%s", clean)
	}
}

// ONE READ HELPER FOR THE PACKAGE. There were two, written a day apart for the same purpose, each
// correct about a half of a defect the other had — `kubectlValue` picked the right stderr line and
// discarded partial stdout, `kubectlRead` kept the stdout and took stderr's first line. This pins
// that only one survives, because two helpers over one operation is how they diverged.
func TestOnlyOneKubectlReadHelperExists(t *testing.T) {
	t.Parallel()

	files, err := filepath.Glob("*.go")
	if err != nil || len(files) == 0 {
		t.Fatalf("could not list package sources (%v) — this test cannot check anything", err)
	}
	var defs []string
	sawCanonical := false
	for _, f := range files {
		raw, rerr := os.ReadFile(f)
		if rerr != nil {
			t.Fatalf("could not read %s: %v", f, rerr)
		}
		for _, m := range regexp.MustCompile(`(?m)^func (kubectl[A-Za-z0-9_]*)\(ctx context\.Context, timeout time\.Duration`).FindAllStringSubmatch(string(raw), -1) {
			defs = append(defs, f+":"+m[1])
			if m[1] == "kubectlRead" {
				sawCanonical = true
			}
		}
	}
	// Guards the guard: a rename would empty the scan and report success while checking nothing.
	if !sawCanonical {
		t.Fatal("kubectlRead is not defined in this package — the scan checked nothing")
	}
	if len(defs) != 1 {
		t.Errorf("%d kubectl read helpers with this signature: %v — they diverge, and the divergence "+
			"is a wrong error message on a failing path", len(defs), defs)
	}
}
