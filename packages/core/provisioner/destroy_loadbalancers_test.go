// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const svcListJSON = `{"items":[
 {"metadata":{"name":"ingress-nginx-controller","namespace":"ingress-nginx"},"spec":{"type":"LoadBalancer"}},
 {"metadata":{"name":"kubernetes","namespace":"default"},"spec":{"type":"ClusterIP"}},
 {"metadata":{"name":"nodeport-thing","namespace":"default"},"spec":{"type":"NodePort"}},
 {"metadata":{"name":"harbor","namespace":"harbor"},"spec":{"type":"LoadBalancer"}}
]}`

func TestParseLoadBalancerServicesTakesOnlyTheCloudBackedOnes(t *testing.T) {
	got, err := parseLoadBalancerServices([]byte(svcListJSON))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d, want the two LoadBalancer Services: %+v", len(got), got)
	}
	// A ClusterIP Service owns no cloud resource; deleting it would tear down working DNS for
	// nothing. NodePort likewise.
	for _, o := range got {
		if o.Name == "kubernetes" || o.Name == "nodeport-thing" {
			t.Errorf("a Service that owns no cloud load balancer was selected: %s", o)
		}
	}
	if got[0].String() != "service/ingress-nginx/ingress-nginx-controller" {
		t.Errorf("unexpected first entry: %s", got[0])
	}
}

func TestParseIngressesTakesAllOfThem(t *testing.T) {
	// Including one with no load-balancer status: a controller that has not finished provisioning
	// still owns a partially-created cloud resource, and that is the one most likely to block a
	// subnet.
	got, err := parseIngresses([]byte(`{"items":[
	  {"metadata":{"name":"console","namespace":"alethia"},"status":{"loadBalancer":{"ingress":[{"hostname":"x"}]}}},
	  {"metadata":{"name":"pending","namespace":"alethia"}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d, want both: %+v", len(got), got)
	}
}

func TestParseLoadBalancerServicesFailsLoudlyOnGarbage(t *testing.T) {
	// "Could not parse" must never render as "there are none" — that is the answer that skips the
	// whole step and lets the destroy walk into the failure.
	if _, err := parseLoadBalancerServices([]byte("not json")); err == nil {
		t.Fatal("want an error for an undecodable list")
	}
}

// stubKubectlSequence puts a `kubectl` on PATH that answers `get` from a numbered sequence of files:
// the first `get services` gets seq-0, the second seq-1, and so on. Everything else exits 0.
//
// A SEQUENCE because the behaviour under test is a wait — "the objects are still there, and then
// they are not" cannot be expressed by a stub with one answer.
func stubKubectlSequence(t *testing.T, svcAnswers []string, repeatLast bool, ingAnswer string, ingExit int) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the stub kubectl is a shell script")
	}
	dir := t.TempDir()
	for i, a := range svcAnswers {
		if err := os.WriteFile(filepath.Join(dir, "svc-"+string(rune('0'+i))), []byte(a), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "ing"), []byte(ingAnswer), 0o600); err != nil {
		t.Fatal(err)
	}
	// Each `get services` consumes one answer. Past the end it either repeats the last one — a
	// controller that never releases — or fails, which is a cluster that went away.
	repeat := "0"
	if repeatLast {
		repeat = "1"
	}
	script := "#!/bin/sh\n" +
		"case \"$*\" in\n" +
		"  *'get services'*)\n" +
		"    n=$(cat " + dir + "/count 2>/dev/null || echo 0)\n" +
		"    echo $((n+1)) > " + dir + "/count\n" +
		"    f=" + dir + "/svc-$n\n" +
		"    if [ ! -f \"$f\" ] && [ " + repeat + " -eq 1 ]; then f=$(ls " + dir + "/svc-* 2>/dev/null | tail -1); fi\n" +
		"    if [ -n \"$f\" ] && [ -f \"$f\" ]; then cat \"$f\"; exit 0; else echo 'error: the server could not find the requested resource' >&2; exit 1; fi;;\n" +
		"  *'get ingresses'*) cat " + dir + "/ing; exit " + string(rune('0'+ingExit)) + ";;\n" +
		"esac\nexit 0\n"
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

func shortWaits(t *testing.T) {
	t.Helper()
	pt, pp := lbReleaseTimeout, lbReleasePoll
	lbReleaseTimeout, lbReleasePoll = 300*time.Millisecond, 10*time.Millisecond
	t.Cleanup(func() { lbReleaseTimeout, lbReleasePoll = pt, pp })
}

func TestReleaseCloudLoadBalancersOnAClusterWithNone(t *testing.T) {
	shortWaits(t)
	stubKubectlSequence(t, []string{`{"items":[]}`}, true, `{"items":[]}`, 0)
	var buf bytes.Buffer
	if err := releaseCloudLoadBalancers(context.Background(), &buf); err != nil {
		t.Fatalf("a cluster with no LoadBalancer Services is not a failure: %v", err)
	}
	if !strings.Contains(buf.String(), "nothing outside the state file") {
		t.Errorf("the no-op case must say so:\n%s", buf.String())
	}
}

// The finalizer is the clock: the objects survive their own deletion until the controller has
// removed the cloud resource, so their disappearance IS the release.
func TestReleaseCloudLoadBalancersWaitsUntilTheObjectsAreGone(t *testing.T) {
	shortWaits(t)
	stubKubectlSequence(t, []string{svcListJSON, svcListJSON, `{"items":[]}`}, true, `{"items":[]}`, 0)
	var buf bytes.Buffer
	if err := releaseCloudLoadBalancers(context.Background(), &buf); err != nil {
		t.Fatalf("the objects were released and this reported a failure: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "Releasing 2 cloud-backed object(s)") {
		t.Errorf("the objects were not named before deletion:\n%s", out)
	}
	if !strings.Contains(out, "All cloud-backed objects released") {
		t.Errorf("the success is not stated:\n%s", out)
	}
}

// A controller that never releases must not hold the teardown open — and the give-up must NAME what
// is still held, because the destroy is about to fail on whatever those are attached to.
func TestReleaseCloudLoadBalancersGivesUpAndNamesWhatIsHeld(t *testing.T) {
	shortWaits(t)
	stubKubectlSequence(t, []string{svcListJSON}, true, `{"items":[]}`, 0)
	var buf bytes.Buffer
	err := releaseCloudLoadBalancers(context.Background(), &buf)
	if err == nil {
		t.Fatal("want an error when the objects are never released")
	}
	if !strings.Contains(err.Error(), "ingress-nginx-controller") {
		t.Errorf("the error does not name what is still held: %v", err)
	}
	if !strings.Contains(err.Error(), "the destroy that follows will fail") {
		t.Errorf("the error does not say what happens next: %v", err)
	}
}

// The common case for a repeated destroy: the cluster is already gone. That is a perfectly good
// outcome — there is nothing left to hold anything — and it must not read as a failure.
func TestReleaseCloudLoadBalancersOnAnUnreachableClusterIsAnError(t *testing.T) {
	shortWaits(t)
	stubKubectlSequence(t, nil, false, `{"items":[]}`, 0) // the FIRST `get services` fails
	var buf bytes.Buffer
	err := releaseCloudLoadBalancers(context.Background(), &buf)
	if err == nil {
		t.Fatal("an unreachable cluster must be reported, not read as 'there are none'")
	}
	if !strings.Contains(err.Error(), "list services") {
		t.Errorf("the error does not say which read failed: %v", err)
	}
}

// And a cluster that goes away DURING the wait is a success: whatever held the load balancers is
// gone with it.
func TestReleaseCloudLoadBalancersTreatsAVanishedClusterAsReleased(t *testing.T) {
	shortWaits(t)
	stubKubectlSequence(t, []string{svcListJSON}, false, `{"items":[]}`, 0) // the SECOND list fails
	var buf bytes.Buffer
	if err := releaseCloudLoadBalancers(context.Background(), &buf); err != nil {
		t.Fatalf("a cluster that vanished mid-wait is not a failure: %v", err)
	}
	if !strings.Contains(buf.String(), "no longer reachable") {
		t.Errorf("the reason is not stated:\n%s", buf.String())
	}
}
