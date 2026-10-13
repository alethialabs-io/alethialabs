// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

// TestT1ArgoBudgetDefaultsFit pins the #5947 inequality on the DEFAULTS: the ArgoCD helm --wait T1
// hands the runner is strictly below the T1 wait minus the pre-ArgoCD budget.
func TestT1ArgoBudgetDefaultsFit(t *testing.T) {
	t.Setenv(t1WaitEnv, "")
	t.Setenv(t1ArgoInstallTimeoutEnv, "")
	argo, wait := t1ArgoInstallTimeout(), t1WaitTimeout()
	if argo != t1ArgoInstallDefault || wait != t1WaitDefault {
		t.Fatalf("defaults not used: argo=%s wait=%s", argo, wait)
	}
	if argo >= wait-t1PreArgoBudget {
		t.Fatalf("argo %s is not strictly below wait %s - pre-argo %s", argo, wait, t1PreArgoBudget)
	}
	if err := t1ArgoBudgetFits(argo, wait); err != nil {
		t.Fatalf("defaults rejected: %v", err)
	}
}

// TestT1ArgoBudgetFitsMutationControl proves the check can FAIL: an ArgoCD timeout at or above the
// harness wait, or exactly at the wait minus the pre-ArgoCD budget, is refused; one tick below is
// accepted.
func TestT1ArgoBudgetFitsMutationControl(t *testing.T) {
	wait := t1WaitDefault
	limit := wait - t1PreArgoBudget
	cases := []struct {
		name string
		argo time.Duration
		ok   bool
	}{
		{"the runner's own 20m default", 20 * time.Minute, false},
		{"equal to the harness wait", wait, false},
		{"above the harness wait", wait + time.Minute, false},
		{"exactly at the limit", limit, false},
		{"one tick below the limit", limit - time.Nanosecond, true},
	}
	for _, c := range cases {
		err := t1ArgoBudgetFits(c.argo, wait)
		if (err == nil) != c.ok {
			t.Errorf("%s: t1ArgoBudgetFits(%s, %s) err=%v, want ok=%v", c.name, c.argo, wait, err, c.ok)
		}
		if err != nil && !strings.Contains(err.Error(), t1ArgoInstallTimeoutEnv) {
			t.Errorf("%s: error does not name the override env: %v", c.name, err)
		}
	}
}

// TestT1TimeoutEnvOverrides proves the env values change the durations, and that malformed or
// non-positive values fall back to the defaults.
func TestT1TimeoutEnvOverrides(t *testing.T) {
	cases := []struct {
		env, val string
		read     func() time.Duration
		want     time.Duration
	}{
		{t1ArgoInstallTimeoutEnv, "90s", t1ArgoInstallTimeout, 90 * time.Second},
		{t1ArgoInstallTimeoutEnv, "nope", t1ArgoInstallTimeout, t1ArgoInstallDefault},
		{t1ArgoInstallTimeoutEnv, "0s", t1ArgoInstallTimeout, t1ArgoInstallDefault},
		{t1WaitEnv, "12m", t1WaitTimeout, 12 * time.Minute},
		{t1WaitEnv, "-1m", t1WaitTimeout, t1WaitDefault},
	}
	for _, c := range cases {
		t.Setenv(c.env, c.val)
		if got := c.read(); got != c.want {
			t.Errorf("%s=%q: got %s, want %s", c.env, c.val, got, c.want)
		}
	}
}

// TestT1ArgoDiagArgv pins the exact kubectl argv the failure dump runs.
func TestT1ArgoDiagArgv(t *testing.T) {
	cases := []struct {
		got, want []string
	}{
		{t1ArgoGetArgv(), []string{"get", "pods,events", "-n", "argocd", "-o", "wide"}},
		{t1ArgoPodsJSONArgv(), []string{"get", "pods", "-n", "argocd", "-o", "json"}},
		{t1ArgoDescribeArgv("argo-cd-repo-server-7d9f"), []string{"describe", "pod", "argo-cd-repo-server-7d9f", "-n", "argocd"}},
	}
	for _, c := range cases {
		if !reflect.DeepEqual(c.got, c.want) {
			t.Errorf("argv = %q, want %q", c.got, c.want)
		}
	}
}

// t1ArgoPodsJSON is a `kubectl get pods -n argocd -o json` shape with one Ready pod, one stuck in
// ImagePullBackOff, one Pending and unscheduled, and one Succeeded hook pod.
const t1ArgoPodsJSON = `{"items":[
 {"metadata":{"name":"argo-cd-server-1"},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}},
 {"metadata":{"name":"argo-cd-repo-server-2"},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"False"}],
   "containerStatuses":[{"name":"repo-server","ready":false,"state":{"waiting":{"reason":"ImagePullBackOff"}}}]}},
 {"metadata":{"name":"argo-cd-redis-3"},"status":{"phase":"Pending","conditions":[{"type":"PodScheduled","status":"False","reason":"Unschedulable"}]}},
 {"metadata":{"name":"argo-cd-redis-secret-init-4"},"status":{"phase":"Succeeded","conditions":[{"type":"Ready","status":"False"}]}}
]}`

// TestNotReadyPodNames proves the describe set is exactly the non-terminal, non-Ready pods.
func TestNotReadyPodNames(t *testing.T) {
	got, err := notReadyPodNames([]byte(t1ArgoPodsJSON))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"argo-cd-repo-server-2", "argo-cd-redis-3"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("notReadyPodNames = %q, want %q", got, want)
	}
	if _, err := notReadyPodNames([]byte("not json")); err == nil {
		t.Fatal("malformed JSON was accepted")
	}
}
