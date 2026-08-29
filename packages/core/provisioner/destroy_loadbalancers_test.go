// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
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

const emptyList = `{"items":[]}`

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

// A cluster with no Ingress API contributes nothing; a cluster that REFUSED the read contributes an
// error. Collapsing them is the trap the field-selector comment is about.
func TestNoIngressAPISeparatesAbsenceFromRefusal(t *testing.T) {
	for _, msg := range []string{
		`error: the server doesn't have a resource type "ingresses"`,
		"Error from server (NotFound): the server could not find the requested resource",
	} {
		if !noIngressAPI(errors.New(msg)) {
			t.Errorf("an absent Ingress API was read as a failure: %s", msg)
		}
	}
	for _, msg := range []string{
		"Error from server (Forbidden): ingresses is forbidden",
		"error: Get \"https://x\": net/http: request canceled (Client.Timeout exceeded)",
		"Error from server (TooManyRequests): please try again later",
	} {
		if noIngressAPI(errors.New(msg)) {
			t.Errorf("a failed read was swallowed as 'no Ingress API': %s", msg)
		}
	}
}

// kubectlRecorder is a `kubectl` on PATH that records every argv, answers `get services` from a
// sequence and `get ingresses` from one fixed answer.
//
// A SEQUENCE because the behaviour under test is a wait: "the objects are still there, and then
// they are not" cannot be expressed by a stub with one answer. A RECORDER because the decisive fix
// is an ORDERING — the ArgoCD Applications must be deleted before anything is listed — and an
// ordering is only observable in the argv.
type kubectlRecorder struct{ dir string }

func stubKubectlForRelease(t *testing.T, svcAnswers []string, repeatLast bool, ingAnswer string, ingExit int, ingErr string) *kubectlRecorder {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the stub kubectl is a shell script")
	}
	dir := t.TempDir()
	for i, a := range svcAnswers {
		if err := os.WriteFile(filepath.Join(dir, "svc-"+strconv.Itoa(i)), []byte(a), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("ing", ingAnswer)
	write("ingerr", ingErr)
	repeat := "0"
	if repeatLast {
		repeat = "1"
	}
	script := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> " + dir + "/calls\n" +
		"case \"$*\" in\n" +
		"  *'get services'*)\n" +
		"    n=$(cat " + dir + "/count 2>/dev/null || echo 0)\n" +
		"    echo $((n+1)) > " + dir + "/count\n" +
		"    f=" + dir + "/svc-$n\n" +
		"    if [ ! -f \"$f\" ] && [ " + repeat + " -eq 1 ]; then f=$(ls " + dir + "/svc-* 2>/dev/null | sort -V | tail -1); fi\n" +
		"    if [ -n \"$f\" ] && [ -f \"$f\" ]; then cat \"$f\"; exit 0; fi\n" +
		"    echo 'Error from server (TooManyRequests): please try again later' >&2; exit 1;;\n" +
		"  *'get ingresses'*) cat " + dir + "/ing; cat " + dir + "/ingerr >&2; exit " + strconv.Itoa(ingExit) + ";;\n" +
		"esac\nexit 0\n"
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return &kubectlRecorder{dir: dir}
}

func (k *kubectlRecorder) calls(t *testing.T) []string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(k.dir, "calls"))
	if err != nil {
		return nil
	}
	return strings.Split(strings.TrimRight(string(b), "\n"), "\n")
}

// Generous relative to six process spawns, small relative to a test run. 300ms was one loaded
// runner away from firing the deadline branch on the first iteration and blaming the wrong thing.
func shortWaits(t *testing.T) {
	t.Helper()
	pt, pp := lbReleaseTimeout, lbReleasePoll
	lbReleaseTimeout, lbReleasePoll = 3*time.Second, 20*time.Millisecond
	t.Cleanup(func() { lbReleaseTimeout, lbReleasePoll = pt, pp })
}

// THE DECISIVE ONE. The add-ons that own these load balancers run under Applications with
// `selfHeal: true`, so deleting a Service without stopping ArgoCD first is out-of-band drift: the
// controller puts it back, the CCM creates a NEW load balancer, and the environment ends up with
// more orphans than it started with.
func TestReleaseCloudLoadBalancersStopsArgoCDBeforeItListsAnything(t *testing.T) {
	shortWaits(t)
	rec := stubKubectlForRelease(t, []string{svcListJSON, emptyList}, true, emptyList, 0, "")
	var buf bytes.Buffer
	if err := releaseCloudLoadBalancers(context.Background(), &buf); err != nil {
		t.Fatalf("release: %v", err)
	}
	calls := rec.calls(t)
	appsAt, listAt := -1, -1
	for i, c := range calls {
		if appsAt < 0 && strings.Contains(c, "delete applications.argoproj.io") {
			appsAt = i
		}
		if listAt < 0 && strings.Contains(c, "get services") {
			listAt = i
		}
	}
	if appsAt < 0 {
		t.Fatalf("the ArgoCD Applications were never deleted:\n%s", strings.Join(calls, "\n"))
	}
	if listAt < 0 || appsAt > listAt {
		t.Errorf("Applications deleted at %d, first list at %d — self-heal re-creates whatever is "+
			"deleted after that point:\n%s", appsAt, listAt, strings.Join(calls, "\n"))
	}
}

func TestReleaseCloudLoadBalancersOnAClusterWithNone(t *testing.T) {
	shortWaits(t)
	stubKubectlForRelease(t, []string{emptyList}, true, emptyList, 0, "")
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
	rec := stubKubectlForRelease(t, []string{svcListJSON, svcListJSON, emptyList}, true, emptyList, 0, "")
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
	// The deletes are RE-ISSUED while the objects persist — that is what recovers a delete that
	// failed once (an evicted admission webhook, a throttled apiserver) instead of waiting the
	// whole budget on an object nothing successfully asked to remove.
	var deletes int
	for _, c := range rec.calls(t) {
		if strings.Contains(c, "delete service ingress-nginx-controller") {
			deletes++
		}
	}
	if deletes < 2 {
		t.Errorf("the delete was issued %d time(s); it must be re-issued while the object persists", deletes)
	}
}

// A controller that never releases must not hold the teardown open — and the give-up must NAME what
// is still held, because the destroy is about to fail on whatever those are attached to.
func TestReleaseCloudLoadBalancersGivesUpAndNamesWhatIsHeld(t *testing.T) {
	shortWaits(t)
	stubKubectlForRelease(t, []string{svcListJSON}, true, emptyList, 0, "")
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

// An unreachable cluster is reported, never read as "there are none".
func TestReleaseCloudLoadBalancersOnAnUnreachableClusterIsAnError(t *testing.T) {
	shortWaits(t)
	stubKubectlForRelease(t, nil, false, emptyList, 0, "") // the FIRST `get services` fails
	var buf bytes.Buffer
	err := releaseCloudLoadBalancers(context.Background(), &buf)
	if err == nil {
		t.Fatal("an unreachable cluster must be reported, not read as 'there are none'")
	}
	if !strings.Contains(err.Error(), "list services") {
		t.Errorf("the error does not say which read failed: %v", err)
	}
}

// AND A FAILURE MID-WAIT IS NOT A RELEASE. A teardown is exactly when an apiserver throttles or a
// control plane restarts; calling any of those "the cluster is gone, therefore released" claims a
// release over live load balancers.
func TestReleaseCloudLoadBalancersDoesNotCallAnUnreadableClusterReleased(t *testing.T) {
	shortWaits(t)
	stubKubectlForRelease(t, []string{svcListJSON}, false, emptyList, 0, "") // every list after the first fails
	var buf bytes.Buffer
	err := releaseCloudLoadBalancers(context.Background(), &buf)
	if err == nil {
		t.Fatalf("a cluster that stopped answering was reported as released:\n%s", buf.String())
	}
	if !strings.Contains(err.Error(), "could not confirm") {
		t.Errorf("the verdict is not stated as unconfirmed: %v", err)
	}
	if !strings.Contains(err.Error(), "may still be live") {
		t.Errorf("the error does not say what is at stake: %v", err)
	}
}

// A failed Ingress read must not render as "nothing to release" — the exact trap the Services
// field-selector comment warns about, on the kind that is MORE likely to hold an ALB.
func TestReleaseCloudLoadBalancersFailsOnARefusedIngressRead(t *testing.T) {
	shortWaits(t)
	stubKubectlForRelease(t, []string{emptyList}, true, "", 1, "Error from server (Forbidden): ingresses is forbidden")
	var buf bytes.Buffer
	err := releaseCloudLoadBalancers(context.Background(), &buf)
	if err == nil {
		t.Fatalf("a refused Ingress read was reported as nothing to do:\n%s", buf.String())
	}
	if !strings.Contains(err.Error(), "list ingresses") {
		t.Errorf("the error does not name the read that failed: %v", err)
	}
	if strings.Contains(buf.String(), "nothing outside the state file") {
		t.Errorf("a failed read printed the no-op verdict:\n%s", buf.String())
	}
}

// A cluster with no Ingress API at all is a fact, not a failure.
func TestReleaseCloudLoadBalancersToleratesAClusterWithNoIngressAPI(t *testing.T) {
	shortWaits(t)
	stubKubectlForRelease(t, []string{emptyList}, true, "", 1, `error: the server doesn't have a resource type "ingresses"`)
	var buf bytes.Buffer
	if err := releaseCloudLoadBalancers(context.Background(), &buf); err != nil {
		t.Fatalf("a cluster with no Ingress API is not a failure: %v", err)
	}
}

// stubKubectlRaw installs a `kubectl` whose whole behaviour is the given shell body, for the
// branches the sequence stub cannot express — a delete that fails, a CRD that is not there.
func stubKubectlRaw(t *testing.T, body string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the stub kubectl is a shell script")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte("#!/bin/sh\n"+body), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// A cluster with no ArgoCD CRD has nothing to stop reconciling, and that is a fact rather than a
// warning — saying "could not delete Applications" there would send a reader looking for ArgoCD.
func TestStopArgoCDReconcilingOnAClusterWithoutTheCRD(t *testing.T) {
	stubKubectlRaw(t, `echo 'error: the server doesn'"'"'t have a resource type "applications"' >&2; exit 1`)
	var buf bytes.Buffer
	stopArgoCDReconciling(context.Background(), &buf)
	if !strings.Contains(buf.String(), "no CRD") {
		t.Errorf("an absent CRD must be reported as absent, not as a failure:\n%s", buf.String())
	}
}

// And a delete that FAILED is the most likely reason the wait below fails, so it says so.
func TestStopArgoCDReconcilingWarnsWhenTheDeleteFails(t *testing.T) {
	stubKubectlRaw(t, `echo 'Error from server (Forbidden): applications.argoproj.io is forbidden' >&2; exit 1`)
	var buf bytes.Buffer
	stopArgoCDReconciling(context.Background(), &buf)
	out := buf.String()
	if !strings.Contains(out, "Forbidden") {
		t.Errorf("the reason was dropped:\n%s", out)
	}
	if !strings.Contains(out, "re-create the objects deleted below") {
		t.Errorf("the consequence is not stated — this is why the wait will fail:\n%s", out)
	}
}

func TestStopArgoCDReconcilingSaysWhenItWorked(t *testing.T) {
	stubKubectlRaw(t, `exit 0`)
	var buf bytes.Buffer
	stopArgoCDReconciling(context.Background(), &buf)
	if !strings.Contains(buf.String(), "marked for deletion") {
		t.Errorf("the success is not stated:\n%s", buf.String())
	}
}

// A delete that fails is NAMED on the first pass and silent afterwards: a warning per object per
// poll would bury the outcome under its own noise.
func TestDeleteAllNamesAFailureOnceAndIsQuietOnRetries(t *testing.T) {
	stubKubectlRaw(t, `echo 'Error from server (Forbidden): services is forbidden' >&2; exit 1`)
	objs := []cloudBackedObject{{Kind: "service", Namespace: "ingress-nginx", Name: "controller"}}

	var loud bytes.Buffer
	deleteAll(context.Background(), &loud, objs, false)
	if !strings.Contains(loud.String(), "could not delete service/ingress-nginx/controller") {
		t.Errorf("the first failure must name the object:\n%s", loud.String())
	}

	var quiet bytes.Buffer
	deleteAll(context.Background(), &quiet, objs, true)
	if quiet.String() != "" {
		t.Errorf("the retry pass must be silent, got:\n%s", quiet.String())
	}
}

// "Could not parse" must never render as "there are none" for Ingresses either — the kind more
// likely to hold an ALB.
func TestParseIngressesFailsLoudlyOnGarbage(t *testing.T) {
	if _, err := parseIngresses([]byte("not json")); err == nil {
		t.Fatal("want an error for an undecodable list")
	}
}

func TestListCloudBackedObjectsFailsOnAnUndecodableIngressList(t *testing.T) {
	stubKubectlForRelease(t, []string{emptyList}, true, "not json", 0, "")
	if _, err := listCloudBackedObjects(context.Background()); err == nil {
		t.Fatal("an undecodable Ingress list must be an error, not an empty result")
	} else if !strings.Contains(err.Error(), "parse ingresses") {
		t.Errorf("the error does not name what failed: %v", err)
	}
}

// `kubectl get --raw /version` is the reachability question, and it must be answered by the
// CLUSTER rather than by whether a kubeconfig file exists — the exec-plugin case writes a
// kubeconfig happily and then fails on every call through it.
func TestClusterReachableAsksTheClusterNotTheFile(t *testing.T) {
	stubKubectlRaw(t, `case "$*" in *"--raw /version"*) echo '{"gitVersion":"v1.31.0"}'; exit 0;; esac; exit 1`)
	if !clusterReachable(context.Background()) {
		t.Error("a cluster that answered /version was reported unreachable")
	}

	// The shape aws/addons run 33271997812 actually produced: a kubeconfig in place, and every call
	// through it dying in the credential plugin.
	stubKubectlRaw(t, `echo 'error: getting credentials: exec: executable /tmp/go-build/e2e.test failed with exit code 1' >&2; exit 1`)
	if clusterReachable(context.Background()) {
		t.Error("a kubeconfig whose credential plugin fails was reported reachable")
	}
}
