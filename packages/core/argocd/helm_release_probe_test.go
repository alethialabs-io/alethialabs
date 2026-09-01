// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"errors"
	"strings"
	"testing"
)

// helmListRow is helm's own `list -o json` row shape, kept as a raw literal so the fixtures below
// are the document helm emits rather than the fields this classifier happens to read. A classifier
// tested only against the two keys it already parses cannot notice the day one of them is renamed.
const helmListRow = `[{"name":"argo-cd","namespace":"argocd","revision":"3",` +
	`"updated":"2026-08-30 09:10:11.123456 +0000 UTC","status":"deployed",` +
	`"chart":"argo-cd-9.9.1","app_version":"v3.5.0"}]`

// The failure shape is VERBATIM from a real `helm list -n argocd -o json` (helm v3.19.0) with no
// cluster reachable: exit 1, stdout empty, the message on stderr. Copied rather than imagined,
// because "what does helm do when it cannot answer" is exactly the question a made-up fixture
// answers the way its author expects.
const helmUnreachableStderr = `Error: Kubernetes cluster unreachable: Get "http://localhost:8080/version": dial tcp [::1]:8080: connect: connection refused`

func TestClassifyLiveArgoHelmRelease(t *testing.T) {
	t.Run("a real row is read for its chart version", func(t *testing.T) {
		got := classifyLiveArgoHelmRelease([]byte(helmListRow), nil, nil)
		if !got.Answered || !got.Found {
			t.Fatalf("want answered+found, got %+v", got)
		}
		if got.ChartVersion != "9.9.1" {
			t.Errorf("ChartVersion = %q, want 9.9.1", got.ChartVersion)
		}
		if got.Chart != "argo-cd-9.9.1" {
			t.Errorf("Chart = %q — the raw field must be kept so a message can quote it", got.Chart)
		}
	})

	t.Run("an EMPTY list is an ANSWER, not a failure", func(t *testing.T) {
		// The whole reason this probe exists: "helm knows this namespace and has no such release"
		// is the ArgoCD-installed-from-manifests case, and it must not read as "could not ask".
		for _, body := range []string{"[]", "null"} {
			got := classifyLiveArgoHelmRelease([]byte(body), nil, nil)
			if !got.Answered {
				t.Errorf("%s must be an answer, got %+v", body, got)
			}
			if got.Found {
				t.Errorf("%s must not report a release, got %+v", body, got)
			}
		}
	})

	t.Run("a non-zero exit is NOT an answer, and carries helm's own words", func(t *testing.T) {
		got := classifyLiveArgoHelmRelease(nil, []byte(helmUnreachableStderr), errors.New("exit status 1"))
		if got.Answered || got.Found {
			t.Fatalf("a failed call must answer nothing, got %+v", got)
		}
		if !strings.Contains(got.Reason, "cluster unreachable") {
			t.Errorf("Reason = %q, want helm's own diagnostic", got.Reason)
		}
	})

	t.Run("a zero exit whose body is not a list is not an answer either", func(t *testing.T) {
		// `{}` is valid JSON and would unmarshal into a nil slice — indistinguishable from an empty
		// list, i.e. from "ArgoCD was not installed by helm", which CHANGES WHAT GETS INSTALLED.
		for _, body := range []string{"{}", "not json at all", ""} {
			got := classifyLiveArgoHelmRelease([]byte(body), nil, nil)
			if got.Answered {
				t.Errorf("body %q must not be read as an answer, got %+v", body, got)
			}
		}
	})

	t.Run("a row for a DIFFERENT release is ignored", func(t *testing.T) {
		// `--filter` is a regex helm applies itself. If it ever loosened, another release's chart
		// version would decide what this deploy installs.
		other := `[{"name":"argo-cd-notifications","namespace":"argocd","chart":"argo-cd-notifications-1.2.3"}]`
		got := classifyLiveArgoHelmRelease([]byte(other), nil, nil)
		if !got.Answered {
			t.Fatalf("helm answered; got %+v", got)
		}
		if got.Found || got.ChartVersion != "" {
			t.Errorf("a different release must not be adopted: %+v", got)
		}
	})

	t.Run("stderr on a SUCCESSFUL call does not corrupt the answer", func(t *testing.T) {
		// helm writes warnings to stderr on calls that succeed. CombinedOutput would fold that line
		// into the JSON; capturing the streams separately is what keeps this an answer.
		got := classifyLiveArgoHelmRelease([]byte(helmListRow), []byte("WARNING: skipped value for x\n"), nil)
		if !got.Answered || got.ChartVersion != "9.9.1" {
			t.Errorf("a warning on stderr must not change a successful read: %+v", got)
		}
	})
}

func TestChartVersionFromHelmChart(t *testing.T) {
	// The LAST hyphen, because the chart NAME contains one. Splitting on the first yields
	// "cd-9.9.1", which is not a version and would be handed straight to `helm --version`.
	if got := chartVersionFromHelmChart("argo-cd-9.9.1"); got != "9.9.1" {
		t.Errorf("argo-cd-9.9.1 → %q, want 9.9.1", got)
	}
	if got := chartVersionFromHelmChart("argo-cd-9.5.11-rc.1"); got != "rc.1" {
		// RECORDED, not endorsed: a pre-release suffix splits at its own hyphen. It is reported
		// here so the behaviour is known rather than discovered; the shipped chart carries no such
		// tag, and a wrong version is caught by helm itself ("chart not found") rather than
		// installed. Tightening this needs a semver parse, which is a bigger change than #3521.
		t.Errorf("pre-release suffix behaviour changed: got %q, the recorded behaviour is rc.1", got)
	}
	for _, bad := range []string{"", "argocd", "argo-cd-", "   "} {
		if got := chartVersionFromHelmChart(bad); got != "" {
			t.Errorf("%q must yield no version (got %q) — a guess here is installed", bad, got)
		}
	}
}

// The three ways of NOT having a chart version send an operator to three different places, so they
// must not render alike. Collapsing them into "no release" would report an unreachable helm as a
// statement about the cluster.
func TestDescribeArgoHelmReleaseSeparatesItsThreeSilences(t *testing.T) {
	unreachable := describeArgoHelmRelease(LiveArgoHelmRelease{Reason: "cluster unreachable"})
	none := describeArgoHelmRelease(LiveArgoHelmRelease{Answered: true})
	unreadable := describeArgoHelmRelease(LiveArgoHelmRelease{Answered: true, Found: true, Chart: "argocd"})
	found := describeArgoHelmRelease(LiveArgoHelmRelease{Answered: true, Found: true, Chart: "argo-cd-9.9.1", ChartVersion: "9.9.1"})

	if !strings.Contains(unreachable, "could not be asked") || !strings.Contains(unreachable, "cluster unreachable") {
		t.Errorf("unreachable = %q", unreachable)
	}
	if !strings.Contains(none, "no \"argo-cd\" release") {
		t.Errorf("none = %q", none)
	}
	if !strings.Contains(unreadable, "could not be read") || !strings.Contains(unreadable, "argocd") {
		t.Errorf("unreadable = %q", unreadable)
	}
	if !strings.Contains(found, "argo-cd-9.9.1") {
		t.Errorf("found = %q", found)
	}
	for _, pair := range [][2]string{{unreachable, none}, {unreachable, unreadable}, {none, unreadable}, {none, found}} {
		if pair[0] == pair[1] {
			t.Errorf("two different silences render identically: %q", pair[0])
		}
	}
}
