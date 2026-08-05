// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"strings"
	"testing"
)

// itemsJSON builds a `kubectl get … -o json` list payload of namespace/name pairs.
func itemsJSON(pairs ...[2]string) string {
	var b strings.Builder
	b.WriteString(`{"items":[`)
	for i, p := range pairs {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`{"metadata":{"namespace":"` + p[0] + `","name":"` + p[1] + `"}}`)
	}
	b.WriteString(`]}`)
	return b.String()
}

// pruneFn is the shared shape of every label-listing prune in this package.
type pruneFn func(desired []string, stdout, stderr *bytes.Buffer)

// TestPrunesDeleteOnlyUndesiredAndFailClosedOnOddNames drives every label-listing prune through the
// same three cases: a desired object is kept, an undesired one is deleted, and an object whose
// name/namespace is not a DNS label is REFUSED (it would interpolate into a kubectl command).
func TestPrunesDeleteOnlyUndesiredAndFailClosedOnOddNames(t *testing.T) {
	list := itemsJSON(
		[2]string{"apps", "keep-me"},
		[2]string{"apps", "drop-me"},
		[2]string{"apps", "bad;name"},
	)

	tests := []struct {
		name        string
		listMatch   string
		deleteMatch string
		run         pruneFn
	}{
		{
			name:        "registry pull secrets",
			listMatch:   "get secrets -A",
			deleteMatch: "delete secret -n apps drop-me",
			run:         func(d []string, so, se *bytes.Buffer) { PruneRegistryPullSecrets(d, so, se) },
		},
		{
			name:        "helm repo credentials",
			listMatch:   "get secrets -n argocd",
			deleteMatch: "delete secret -n apps drop-me",
			run:         func(d []string, so, se *bytes.Buffer) { PruneHelmRepoCredentials(d, so, se) },
		},
		{
			name:        "vcluster cluster secrets",
			listMatch:   "get secrets -n argocd",
			deleteMatch: "delete secret -n apps drop-me",
			run:         func(d []string, so, se *bytes.Buffer) { PruneVClusterClusterSecrets(d, so, se) },
		},
		{
			name:        "BYO binding ExternalSecrets",
			listMatch:   "get externalsecrets -A",
			deleteMatch: "delete externalsecret -n apps drop-me",
			run:         func(d []string, so, se *bytes.Buffer) { PruneChartBindingSecrets(d, so, se) },
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			stub := newKubectlStub(t, 0, stubRule{Match: tc.listMatch, Stdout: list})
			var stdout, stderr bytes.Buffer
			tc.run([]string{"keep-me"}, &stdout, &stderr)

			if !stub.calledWith(tc.deleteMatch) {
				t.Errorf("undesired object was not deleted; calls: %v", stub.calls())
			}
			if stub.calledWith("keep-me --ignore-not-found") {
				t.Errorf("a desired object was deleted; calls: %v", stub.calls())
			}
			if stub.calledWith("bad;name") {
				t.Errorf("an oddly-named object reached a kubectl command; calls: %v", stub.calls())
			}
			if !strings.Contains(stderr.String(), "oddly-named") {
				t.Errorf("the refusal was not reported on stderr: %q", stderr.String())
			}
		})
	}
}

// TestPrunesAreBestEffortOnUnreadableList locks the fail-soft contract: a list that cannot be run or
// cannot be parsed warns and issues NO delete, rather than failing the deploy or deleting blindly.
func TestPrunesAreBestEffortOnUnreadableList(t *testing.T) {
	tests := []struct {
		name      string
		listMatch string
		stdout    string
		exit      int
		wantWarn  string
		run       pruneFn
	}{
		{
			name: "add-on secrets: list command fails", listMatch: "get secrets -A", exit: 1,
			wantWarn: "could not list add-on secrets to prune",
			run:      func(d []string, so, se *bytes.Buffer) { PruneAddOnSecrets(d, so, se) },
		},
		{
			name: "add-on secrets: unparseable list", listMatch: "get secrets -A", stdout: "not json",
			wantWarn: "could not parse add-on secret list to prune",
			run:      func(d []string, so, se *bytes.Buffer) { PruneAddOnSecrets(d, so, se) },
		},
		{
			name: "registry pull secrets: list command fails", listMatch: "get secrets -A", exit: 1,
			wantWarn: "could not list registry pull secrets to prune",
			run:      func(d []string, so, se *bytes.Buffer) { PruneRegistryPullSecrets(d, so, se) },
		},
		{
			name: "helm repo refreshers: unparseable list", listMatch: "get deployment -n argocd", stdout: "not json",
			wantWarn: "could not parse deployment list to prune Helm repo refreshers",
			run:      func(d []string, so, se *bytes.Buffer) { PruneHelmRepoRefreshers(d, so, se) },
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			stub := newKubectlStub(t, 0, stubRule{Match: tc.listMatch, Stdout: tc.stdout, Exit: tc.exit})
			var stdout, stderr bytes.Buffer
			tc.run(nil, &stdout, &stderr)

			if !strings.Contains(stderr.String(), tc.wantWarn) {
				t.Errorf("stderr = %q, want it to contain %q", stderr.String(), tc.wantWarn)
			}
			if stub.calledWith("delete ") {
				t.Errorf("an unreadable list must issue no delete; calls: %v", stub.calls())
			}
		})
	}
}

// TestPruneAddOnSecretsKeepsEnabledAddOns covers the add-on-id label match: the Secret of a still
// enabled add-on stays, the Secret of a disabled one is deleted across whatever namespace it lives in.
func TestPruneAddOnSecretsKeepsEnabledAddOns(t *testing.T) {
	list := `{"items":[
	 {"metadata":{"namespace":"obs","name":"grafana-creds","labels":{"alethia.io/addon-secret":"grafana"}}},
	 {"metadata":{"namespace":"data","name":"pg-creds","labels":{"alethia.io/addon-secret":"postgres"}}}
	]}`
	stub := newKubectlStub(t, 0, stubRule{Match: "get secrets -A", Stdout: list})

	var stdout, stderr bytes.Buffer
	PruneAddOnSecrets([]string{"grafana"}, &stdout, &stderr)

	if !stub.calledWith("delete secret -n data pg-creds") {
		t.Errorf("the disabled add-on's secret was not pruned; calls: %v", stub.calls())
	}
	if stub.calledWith("grafana-creds") {
		t.Errorf("an enabled add-on's secret was pruned; calls: %v", stub.calls())
	}
	if !strings.Contains(stdout.String(), "data/pg-creds") {
		t.Errorf("the prune was not reported on stdout: %q", stdout.String())
	}
}

// TestPruneHelmRepoRefreshersSweepsAllThreeKinds locks that one desired-name set covers the
// Deployment, Role and RoleBinding a refresher ships as (they share the name).
func TestPruneHelmRepoRefreshersSweepsAllThreeKinds(t *testing.T) {
	list := itemsJSON([2]string{"argocd", "stale-refresher"})
	stub := newKubectlStub(t, 0,
		stubRule{Match: "get deployment -n argocd", Stdout: list},
		stubRule{Match: "get role -n argocd", Stdout: list},
		stubRule{Match: "get rolebinding -n argocd", Stdout: list},
	)

	var stdout, stderr bytes.Buffer
	PruneHelmRepoRefreshers(nil, &stdout, &stderr)

	for _, kind := range []string{"deployment", "role", "rolebinding"} {
		if !stub.calledWith("delete " + kind + " -n argocd stale-refresher") {
			t.Errorf("%s was not pruned; calls: %v", kind, stub.calls())
		}
	}
}

// TestPruneManagedAddOnsDeletesDisabledApplications covers the Application prune: a disabled add-on's
// Application is deleted, an enabled one is untouched, and an unreadable list is non-fatal.
func TestPruneManagedAddOnsDeletesDisabledApplications(t *testing.T) {
	list := `{"items":[{"metadata":{"name":"addon-keep"}},{"metadata":{"name":"addon-drop"}}]}`
	stub := newKubectlStub(t, 0, stubRule{Match: "get applications.argoproj.io", Stdout: list})

	var stdout, stderr bytes.Buffer
	if err := PruneManagedAddOns([]string{"addon-keep"}, &stdout, &stderr); err != nil {
		t.Fatalf("PruneManagedAddOns returned %v, want nil (best-effort)", err)
	}
	if !stub.calledWith("delete applications.argoproj.io -n argocd addon-drop") {
		t.Errorf("the disabled add-on Application was not pruned; calls: %v", stub.calls())
	}
	if stub.calledWith("addon-keep --ignore-not-found") {
		t.Errorf("an enabled add-on Application was pruned; calls: %v", stub.calls())
	}
}
