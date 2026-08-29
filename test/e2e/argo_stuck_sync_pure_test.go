// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build !e2e_t1 && !e2e_t2 && !e2e_b6

package e2e

import (
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

	sc := filterControllerLines(raw, []string{"addon-kube-prometheus-stack"}, 60)
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
	sc := filterControllerLines([]byte(strings.Join(lines, "\n")), nil, 3)
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
	sc := filterControllerLines(nil, []string{"addon-x"}, 60)
	kept, scanned := sc.Kept, sc.Scanned
	if scanned != 0 || len(kept) != 0 {
		t.Fatalf("empty log: scanned=%d kept=%d, want 0/0", scanned, len(kept))
	}
	// And a log that HAS lines but none matching must report a non-zero scan, so the caller can
	// tell "the controller is silent about these apps" from "there is no controller".
	sc = filterControllerLines([]byte("level=info msg=\"all good\"\n"), []string{"addon-x"}, 60)
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
	sc := filterControllerLines(raw, nil, 60)
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
	sc := filterControllerLines(raw, []string{"addon-x"}, 60)
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
		sc := filterControllerLines([]byte(line), nil, 60)
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

// One stray `level=` inside a quoted message must not vouch for four thousand lines.
func TestRenderControllerLogUnreadableIsARatioNotAZeroCheck(t *testing.T) {
	out := renderControllerLog(controllerLogScan{Scanned: 4000, Levelled: 1, Matched: 0})
	if !strings.Contains(out, "only 1 of 4000") {
		t.Errorf("a single levelled line switched the blindness check off:\n%s", out)
	}
}

func TestRenderControllerLogSaysWhenTheWindowWasFull(t *testing.T) {
	out := renderControllerLog(controllerLogScan{
		Scanned: controllerTailLines, Levelled: controllerTailLines, Matched: 0, WindowFull: true,
	})
	if !strings.Contains(out, "keeps the NEWEST lines") {
		t.Errorf("a filled --tail window must be reported — the first failure may be outside it:\n%s", out)
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
