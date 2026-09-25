// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The fabric-demo's ArgoCD no-reinstall check (#5082) finds the argocd-server Deployment BY LABEL.
//
// It used to read `deployment argocd-server` by name, and that object does not exist. ArgoCD is
// installed as `helm upgrade --install argo-cd argo/argo-cd`, and the chart prefixes every workload
// with the release name, so the Deployment is `argo-cd-argocd-server`. Nightly run 36114838115
// failed on gcp and aws at "deployments.apps \"argocd-server\" not found", before any placement ran.
//
// The helpers live in a _test.go file with no build tag. The e2e_t2-tagged run test compiles
// together with them, and this file's tests run under a plain `go test ./...`.
package e2e

import (
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// argocdServerSelector is the label selector for the argo-cd chart's API-server Deployment.
//
// Read from the pinned chart (argo-cd 9.5.11, packages/core/argocd/versions.go), not guessed:
// templates/argocd-server/deployment.yaml labels the Deployment through `argo-cd.labels` with
// component = .Values.server.name ("server"), and the helper always adds
// app.kubernetes.io/part-of: argocd. The other workloads use component values such as
// "repo-server" and "dex-server", so an equality match on "server" selects only this one.
// A label names the role and does not depend on the release name, so a release rename cannot
// break it. A literal Deployment name does depend on it, and that is how this check broke.
const argocdServerSelector = "app.kubernetes.io/component=server,app.kubernetes.io/part-of=argocd"

// argocdServerKubectlArgs returns the kubectl arguments that list every Deployment in the argocd
// namespace matching argocdServerSelector, one `<name>\t<creationTimestamp>` line each.
func argocdServerKubectlArgs() []string {
	return []string{
		"get", "deployment", "-n", "argocd",
		"-l", argocdServerSelector,
		"-o", `jsonpath={range .items[*]}{.metadata.name}{"\t"}{.metadata.creationTimestamp}{"\n"}{end}`,
	}
}

// pickArgocdServer reads the output of argocdServerKubectlArgs and returns the single matching
// Deployment's name and creationTimestamp.
//
// It requires EXACTLY one match. Zero means the selector no longer fits the chart, or ArgoCD is
// missing. More than one means two installs share the namespace, and then no single
// creationTimestamp can show that a placement did not reinstall ArgoCD. Each case has its own
// error, and the many case names every match.
func pickArgocdServer(raw string) (name, created string, err error) {
	type match struct{ name, created string }
	var matches []match
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		n, c, _ := strings.Cut(line, "\t")
		matches = append(matches, match{strings.TrimSpace(n), strings.TrimSpace(c)})
	}
	switch len(matches) {
	case 0:
		return "", "", fmt.Errorf("no Deployment in namespace argocd matches %q; the argo-cd chart's server labels changed, or ArgoCD is not installed", argocdServerSelector)
	case 1:
		m := matches[0]
		if m.created == "" {
			return "", "", fmt.Errorf("Deployment %q matched %q but has no creationTimestamp", m.name, argocdServerSelector)
		}
		return m.name, m.created, nil
	default:
		names := make([]string, len(matches))
		for i, m := range matches {
			names[i] = m.name
		}
		return "", "", fmt.Errorf("%d Deployments in namespace argocd match %q (%s); expected exactly one argocd-server", len(matches), argocdServerSelector, strings.Join(names, ", "))
	}
}

// renderedArgoWorkloads is the metadata.labels of every Deployment and StatefulSet that
// `helm template argo-cd argo/argo-cd --version 9.5.11 -n argocd` renders with default values,
// keyed by object name. The version and chart labels are left out because no selector reads them.
var renderedArgoWorkloads = map[string]map[string]string{
	"argo-cd-argocd-applicationset-controller": argoChartLabels("argocd-applicationset-controller", "applicationset-controller"),
	"argo-cd-argocd-notifications-controller":  argoChartLabels("argocd-notifications-controller", "notifications-controller"),
	"argo-cd-argocd-repo-server":               argoChartLabels("argocd-repo-server", "repo-server"),
	"argo-cd-argocd-server":                    argoChartLabels("argocd-server", "server"),
	"argo-cd-argocd-dex-server":                argoChartLabels("argocd-dex-server", "dex-server"),
	"argo-cd-argocd-redis":                     argoChartLabels("argocd-redis", "redis"),
	"argo-cd-argocd-application-controller":    argoChartLabels("argocd-application-controller", "application-controller"),
}

// argoChartLabels returns the labels the argo-cd chart's `argo-cd.labels` helper puts on a
// workload of release "argo-cd".
func argoChartLabels(name, component string) map[string]string {
	return map[string]string{
		"app.kubernetes.io/name":       name,
		"app.kubernetes.io/instance":   "argo-cd",
		"app.kubernetes.io/component":  component,
		"app.kubernetes.io/managed-by": "Helm",
		"app.kubernetes.io/part-of":    "argocd",
	}
}

// equalitySelectorMatches reports whether labels satisfy a comma-separated list of k=v terms,
// the only selector form argocdServerSelector uses. Any other form fails the test that calls it.
func equalitySelectorMatches(t *testing.T, selector string, labels map[string]string) bool {
	t.Helper()
	for _, term := range strings.Split(selector, ",") {
		k, v, ok := strings.Cut(term, "=")
		if !ok || strings.ContainsAny(k, "!<> ") || strings.HasPrefix(v, "=") {
			t.Fatalf("selector term %q is not a plain k=v equality; this test cannot evaluate it", term)
		}
		if labels[k] != v {
			return false
		}
	}
	return true
}

// The selector must select the server Deployment of the rendered chart, and nothing else.
func TestArgocdServerSelectorMatchesExactlyTheRenderedServer(t *testing.T) {
	var got []string
	for name, labels := range renderedArgoWorkloads {
		if equalitySelectorMatches(t, argocdServerSelector, labels) {
			got = append(got, name)
		}
	}
	sort.Strings(got)
	if want := []string{"argo-cd-argocd-server"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("selector %q matches %v in the rendered argo-cd chart; want %v", argocdServerSelector, got, want)
	}
}

// The regression itself: the lookup must not name a Deployment, and the name it used does not
// exist in the rendered chart.
func TestArgocdServerLookupIsNotByName(t *testing.T) {
	if _, ok := renderedArgoWorkloads["argocd-server"]; ok {
		t.Fatal("fixture error: the rendered chart has no Deployment literally named argocd-server")
	}
	args := argocdServerKubectlArgs()
	if len(args) < 3 || args[0] != "get" || args[1] != "deployment" || strings.HasPrefix(args[2], "argocd") {
		t.Fatalf("lookup must be `get deployment` with no object name; got %q", args)
	}
	joined := strings.Join(args, " ")
	for _, want := range []string{"-n argocd", "-l " + argocdServerSelector, ".metadata.creationTimestamp"} {
		if !strings.Contains(joined, want) {
			t.Errorf("kubectl args %q lack %q", joined, want)
		}
	}
}

func TestPickArgocdServer(t *testing.T) {
	const ts = "2026-09-24T10:11:12Z"
	cases := []struct {
		name        string
		raw         string
		wantName    string
		wantCreated string
		wantErr     []string
	}{
		{"exactly one", "argo-cd-argocd-server\t" + ts + "\n", "argo-cd-argocd-server", ts, nil},
		{"one, surrounding whitespace", "\n  argo-cd-argocd-server\t" + ts + "  \n\n", "argo-cd-argocd-server", ts, nil},
		{"zero", "", "", "", []string{"no Deployment", argocdServerSelector}},
		{"zero, blank lines only", "\n \n", "", "", []string{"no Deployment"}},
		{"many names every match", "argo-cd-argocd-server\t" + ts + "\nother-argocd-server\t" + ts + "\n", "", "", []string{"2 Deployments", "argo-cd-argocd-server", "other-argocd-server", "exactly one"}},
		{"one without a timestamp", "argo-cd-argocd-server\t\n", "", "", []string{"argo-cd-argocd-server", "no creationTimestamp"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			name, created, err := pickArgocdServer(c.raw)
			if c.wantErr == nil {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if name != c.wantName || created != c.wantCreated {
					t.Fatalf("got (%q, %q); want (%q, %q)", name, created, c.wantName, c.wantCreated)
				}
				return
			}
			if err == nil {
				t.Fatalf("want an error, got (%q, %q)", name, created)
			}
			for _, w := range c.wantErr {
				if !strings.Contains(err.Error(), w) {
					t.Errorf("error %q lacks %q", err, w)
				}
			}
		})
	}
}

// The value handed to argocdNotReinstalled is the timestamp alone, as before, so the comparison is
// unchanged: equal timestamps pass, different ones fail.
func TestPickedTimestampFeedsTheUnchangedComparison(t *testing.T) {
	_, before, err := pickArgocdServer("argo-cd-argocd-server\t2026-09-24T10:11:12Z\n")
	if err != nil {
		t.Fatal(err)
	}
	_, same, _ := pickArgocdServer("argo-cd-argocd-server\t2026-09-24T10:11:12Z\n")
	_, later, _ := pickArgocdServer("argo-cd-argocd-server\t2026-09-24T11:00:00Z\n")
	if err := argocdNotReinstalled(before, same); err != nil {
		t.Errorf("identical timestamps must pass: %v", err)
	}
	if err := argocdNotReinstalled(before, later); err == nil {
		t.Error("a changed timestamp must fail the no-reinstall check")
	}
}
