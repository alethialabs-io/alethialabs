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
	if _, err := releaseCloudLoadBalancers(context.Background(), &buf); err != nil {
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
	if _, err := releaseCloudLoadBalancers(context.Background(), &buf); err != nil {
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
	if _, err := releaseCloudLoadBalancers(context.Background(), &buf); err != nil {
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
	_, err := releaseCloudLoadBalancers(context.Background(), &buf)
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
	_, err := releaseCloudLoadBalancers(context.Background(), &buf)
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
	_, err := releaseCloudLoadBalancers(context.Background(), &buf)
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
	_, err := releaseCloudLoadBalancers(context.Background(), &buf)
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
	if _, err := releaseCloudLoadBalancers(context.Background(), &buf); err != nil {
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
	const want = "https://ABC123.gr7.eu-west-1.eks.amazonaws.com"

	stubKubectlRaw(t, `case "$*" in
	  *"--raw /version"*) echo '{"gitVersion":"v1.31.0"}'; exit 0;;
	  *"config view"*) echo 'https://ABC123.gr7.eu-west-1.eks.amazonaws.com'; exit 0;;
	esac; exit 1`)
	if ok, why := clusterReachable(context.Background(), want); !ok {
		t.Errorf("a cluster that answered /version AS ITSELF was reported unreachable: %s", why)
	}

	// The shape aws/addons run 33271997812 actually produced: a kubeconfig in place, and every call
	// through it dying in the credential plugin.
	stubKubectlRaw(t, `echo 'error: getting credentials: exec: executable /tmp/go-build/e2e.test failed with exit code 1' >&2; exit 1`)
	ok, why := clusterReachable(context.Background(), want)
	if ok {
		t.Error("a kubeconfig whose credential plugin fails was reported reachable")
	}
	if !strings.Contains(why, "getting credentials") {
		t.Errorf("the reason was discarded — a plugin failure, a DNS failure and a 401 must not "+
			"read alike: %q", why)
	}
}

// THE ONE THAT MATTERS. A working kubeconfig pointed at a DIFFERENT cluster answers /version
// perfectly, and the caller then runs `kubectl delete applications --all-namespaces --all` —
// whose Applications carry `resources-finalizer.argocd.argoproj.io`, so the delete cascades to
// everything ArgoCD manages there.
//
// The ambient KUBECONFIG makes this the ordinary case, not a corner: ConfigureKubeconfig sets it
// process-wide, `workerHome` is a stable per-slot path, and the default isolation backend is
// in-process — so one worker deploying env A and later destroying env B carries A's kubeconfig in.
func TestClusterReachableRefusesADifferentCluster(t *testing.T) {
	stubKubectlRaw(t, `case "$*" in
	  *"--raw /version"*) echo '{"gitVersion":"v1.31.0"}'; exit 0;;
	  *"config view"*) echo 'https://OTHER.gr7.eu-west-1.eks.amazonaws.com'; exit 0;;
	esac; exit 1`)
	ok, why := clusterReachable(context.Background(), "https://ABC123.gr7.eu-west-1.eks.amazonaws.com")
	if ok {
		t.Fatal("a kubeconfig pointing at ANOTHER cluster was accepted — the release would have " +
			"deleted every ArgoCD Application there")
	}
	if !strings.Contains(why, "OTHER") || !strings.Contains(why, "ABC123") {
		t.Errorf("the reason does not name both clusters, which is the whole diagnosis: %q", why)
	}
}

// A state with no endpoint output cannot be checked, so it must fail TOWARD reconfiguring the
// credential this job can vouch for. Reporting "reachable" there would restore the defect for
// exactly the BYO-IaC environments that have no endpoint to compare.
func TestClusterReachableWithNoEndpointToCheckAgainstIsNotReachable(t *testing.T) {
	stubKubectlRaw(t, `echo '{"gitVersion":"v1.31.0"}'; exit 0`)
	ok, why := clusterReachable(context.Background(), "")
	if ok {
		t.Fatal("with no endpoint to compare, the probe claimed the cluster was verified")
	}
	if !strings.Contains(why, "no API endpoint") {
		t.Errorf("the reason does not say why the check could not be made: %q", why)
	}
}

// Providers emit the endpoint with and without a scheme and sometimes with a trailing slash;
// kubectl always prints a scheme. Those must compare equal, or every real destroy reconfigures
// needlessly — and a needless reconfigure is what #3413 was written to stop.
func TestSameAPIServerToleratesSchemeAndTrailingSlash(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{
		{"https://abc.eks.amazonaws.com", "abc.eks.amazonaws.com", true},
		{"https://abc.eks.amazonaws.com/", "https://abc.eks.amazonaws.com", true},
		{"https://ABC.eks.amazonaws.com", "abc.eks.amazonaws.com", true},
		{"https://abc.eks.amazonaws.com", "https://other.eks.amazonaws.com", false},
		{"", "abc.eks.amazonaws.com", false},
		{"", "", false},
	} {
		if got := sameAPIServer(c.a, c.b); got != c.want {
			t.Errorf("sameAPIServer(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

// The two renderers carry the caller's decision, and the caller cannot be driven in a unit test —
// it holds a *tofu.TofuCLI, a concrete type with no seam. Leaving them inline is how every branch
// of this decision would be reachable only from a real destroy against a real cluster, which is
// precisely how "reachable" came to mean "something answered".
func TestKubeconfigDecisionLineSaysWhichPathAndWhy(t *testing.T) {
	if got := kubeconfigDecisionLine(true, ""); !strings.Contains(got, "not reconfiguring") {
		t.Errorf("the reachable line does not say it skipped the reconfigure: %q", got)
	}

	got := kubeconfigDecisionLine(false, `the kubeconfig points at "https://OTHER" but this state's cluster is "https://ABC"`)
	if !strings.Contains(got, "Reconfiguring") {
		t.Errorf("the unreachable line does not say what it is about to do: %q", got)
	}
	if !strings.Contains(got, "OTHER") || !strings.Contains(got, "ABC") {
		t.Errorf("the reason was dropped — a wrong-cluster answer must name both: %q", got)
	}

	// No reason captured must not produce a sentence ending in a dangling colon.
	bare := kubeconfigDecisionLine(false, "   ")
	if strings.Contains(bare, ":") {
		t.Errorf("an empty reason left a dangling clause: %q", bare)
	}
	if !strings.HasSuffix(bare, "\n") {
		t.Errorf("the line is not newline-terminated: %q", bare)
	}
}

// A kubeconfig that was written and still does not answer is a BILLING warning, not a skip
// notice. #3413 replaced the warning with a neutral "the cluster does not answer with it", which
// reads as "already gone" — and nothing outside CI sweeps cloud load balancers after a failed
// destroy, so this line is the only signal a customer gets.
func TestPostConfigureFailureLineIsABillingWarning(t *testing.T) {
	got := postConfigureFailureLine("getting credentials: exec: executable e2e.test failed")
	for _, want := range []string{"WARNING", "still bill", "getting credentials"} {
		if !strings.Contains(got, want) {
			t.Errorf("the post-configure failure line is missing %q: %q", want, got)
		}
	}
	if bare := postConfigureFailureLine(""); !strings.Contains(bare, "WARNING") ||
		!strings.Contains(bare, "still bill") || strings.HasSuffix(strings.TrimSpace(bare), "but") {
		t.Errorf("with no reason the warning degrades or dangles: %q", bare)
	}
}

// THE ONLY BACKSTOP A CUSTOMER HAS. The scope-locked sweepers live in `scripts/e2e/*-cleanup.sh`
// and are the e2e workflow's; nothing in apps/runner or packages/core sweeps cloud load balancers
// after a failed destroy. So when the destroy fails with objects still held, this text is the whole
// signal that something is running and charging — #3395.
func TestBillingWarningNamesWhatIsStillHeldAndThatNothingSweepsIt(t *testing.T) {
	clean := releaseOutcome{Clean: true}
	if got := clean.billingWarning(); got != "" {
		t.Errorf("a clean release must warn about nothing, got %q", got)
	}

	held := releaseOutcome{Remaining: []cloudBackedObject{
		{Kind: "service", Namespace: "ingress-nginx", Name: "controller"},
		{Kind: "ingress", Namespace: "alethia", Name: "console"},
	}}
	got := held.billingWarning()
	for _, want := range []string{
		"STILL BILL",
		"service/ingress-nginx/controller",
		"ingress/alethia/console",
		"NOTHING SWEEPS THESE AUTOMATICALLY",
		"cloud console",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("the warning does not carry %q:\n%s", want, got)
		}
	}

	// "We could not look" must not render as a complete list — the difference between a bounded
	// clean-up list and an unbounded one is the whole reason Unknown exists.
	unknown := releaseOutcome{Unknown: true, Remaining: []cloudBackedObject{{Kind: "service", Namespace: "x", Name: "y"}}}
	if u := unknown.billingWarning(); !strings.Contains(u, "not a complete list") {
		t.Errorf("an unconfirmed release must say the list may be incomplete:\n%s", u)
	}

	// And a step that never ran says WHY, because "nothing was released" and "nothing needed
	// releasing" are opposite facts.
	skipped := releaseOutcome{Skipped: "the cluster could not be reached (dial tcp: timeout)"}
	s := skipped.billingWarning()
	if !strings.Contains(s, "did not run") || !strings.Contains(s, "dial tcp: timeout") {
		t.Errorf("a skipped release must say it was skipped and why:\n%s", s)
	}
	if !strings.Contains(s, "NOTHING SWEEPS") {
		t.Errorf("a skipped release still warns about billing:\n%s", s)
	}
}

// The outcome is what the retry branches on, so the values it can take are pinned here rather than
// inferred from the one path a test happens to drive.
func TestReleaseOutcomeCleanIsOnlyForAnEstablishedRelease(t *testing.T) {
	for _, tc := range []struct {
		name string
		o    releaseOutcome
		want bool
	}{
		{"released", releaseOutcome{Clean: true}, true},
		{"objects still held", releaseOutcome{Remaining: []cloudBackedObject{{Kind: "service"}}}, false},
		{"could not confirm", releaseOutcome{Unknown: true}, false},
		{"never ran", releaseOutcome{Skipped: "no cluster access"}, false},
		{"zero value", releaseOutcome{}, false},
	} {
		if tc.o.Clean != tc.want {
			t.Errorf("%s: Clean = %v, want %v — the destroy retries on this field, so a false "+
				"positive pays for a second full destroy that cannot succeed", tc.name, tc.o.Clean, tc.want)
		}
	}
}

// An undecodable SERVICES list must be an error for the same reason the Ingress one is: "could not
// parse" rendering as "there are none" is the answer that skips the release entirely and walks the
// destroy into the failure.
func TestListCloudBackedObjectsFailsOnAnUndecodableServiceList(t *testing.T) {
	stubKubectlForRelease(t, []string{"not json"}, true, emptyList, 0, "")
	if _, err := listCloudBackedObjects(context.Background()); err == nil {
		t.Fatal("an undecodable Service list must be an error, not an empty result")
	} else if !strings.Contains(err.Error(), "parse services") {
		t.Errorf("the error does not name what failed: %v", err)
	}
}

// And the Unknown outcome carries the objects last seen, so the billing warning can name them even
// though the list is not complete.
func TestReleaseReportsWhatItLastSawWhenTheClusterStopsAnswering(t *testing.T) {
	shortWaits(t)
	stubKubectlForRelease(t, []string{svcListJSON}, false, emptyList, 0, "")
	var buf bytes.Buffer
	rel, err := releaseCloudLoadBalancers(context.Background(), &buf)
	if err == nil {
		t.Fatal("a cluster that stopped answering must not be reported as released")
	}
	if rel.Clean {
		t.Error("Clean must be false — the destroy would retry on a release that never happened")
	}
	if !rel.Unknown {
		t.Error("Unknown must be true — the list below it is not complete and the warning says so")
	}
	// THE POINT OF THE TEST, and the assertion whose absence let the defect ship green: the doc
	// comment promises "the Unknown outcome carries the objects last seen, so the billing warning
	// can name them". listCloudBackedObjects returns `nil, err` on every failure, so reporting the
	// failed poll's slice would name nothing at all.
	if len(rel.Remaining) == 0 {
		t.Fatal("Remaining is empty — the outcome carries nothing for the billing warning to name, " +
			"on precisely the path where the operator most needs a starting point")
	}
	if w := rel.billingWarning(); !strings.Contains(w, "controller") {
		t.Errorf("the billing warning does not name the object last seen:\n%s", w)
	}
}

// A cancelled context must not report a release. The teardown's own deadline expiring mid-wait is
// the one moment when "we stopped looking" is easiest to mistake for "there is nothing there", and
// the destroy that follows branches on exactly that.
func TestReleaseOnACancelledContextIsNotARelease(t *testing.T) {
	prevT, prevP := lbReleaseTimeout, lbReleasePoll
	lbReleaseTimeout, lbReleasePoll = time.Minute, 20*time.Millisecond
	t.Cleanup(func() { lbReleaseTimeout, lbReleasePoll = prevT, prevP })

	stubKubectlForRelease(t, []string{svcListJSON}, true, emptyList, 0, "")
	// Long enough that the FIRST list and the deletes complete — each kubectl is a process spawn —
	// so the cancellation lands INSIDE the wait loop rather than on the opening read. A shorter
	// window made this test pass through the early-return path instead, proving something else.
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()

	var buf bytes.Buffer
	rel, err := releaseCloudLoadBalancers(ctx, &buf)
	if err == nil {
		t.Fatal("a cancelled wait must report an error, not a release")
	}
	if rel.Clean {
		t.Error("Clean must be false — the destroy retries on it, and nothing was established here")
	}
	if !rel.Unknown {
		t.Error("Unknown must be true: the wait stopped early, so what it last saw is not a complete list")
	}
	// TIME IS NOT THE GUARD, an assertion is. If the opening list is what dies on the cancelled
	// context, the early return yields {Unknown: true} plus an error and satisfies every assertion
	// above without ever entering the wait loop — so on a loaded runner this test would go green
	// for exactly the reason its own comment says it must not. This line is the difference.
	if !strings.Contains(buf.String(), "cloud-backed object(s) before destroy") {
		t.Fatalf("the run never reached the wait loop, so the cancellation landed on the opening "+
			"read and this test proved something else:\n%s", buf.String())
	}
	if len(rel.Remaining) == 0 {
		t.Error("Remaining is empty — a cancelled wait must still report what it had already seen")
	}
}

// TestShouldRetryReleaseOnlyWhenObjectsWereActuallyObserved drives the retry guard across ALL FOUR
// facts releaseOutcome keeps apart, because the bug it replaced branched on `!Clean` — which is true
// for every one of them and therefore distinguishes none.
func TestShouldRetryReleaseOnlyWhenObjectsWereActuallyObserved(t *testing.T) {
	held := []cloudBackedObject{{Kind: "service", Namespace: "ingress-nginx", Name: "controller"}}
	boom := errors.New("tofu destroy failed")
	cases := []struct {
		name      string
		destroyer error
		rel       releaseOutcome
		ctxErr    error
		want      bool
	}{
		{"objects observed still held is the ONLY retryable case", boom, releaseOutcome{Remaining: held}, nil, true},
		{"unknown with objects last seen is still worth a second look", boom, releaseOutcome{Unknown: true, Remaining: held}, nil, true},
		{"skipped established nothing, so a second pass would learn nothing", boom, releaseOutcome{Skipped: "the cluster could not be reached"}, nil, false},
		{"unknown with nothing observed names no objects to retry for", boom, releaseOutcome{Unknown: true}, nil, false},
		{"a cancelled teardown must stop, not start another wait", boom, releaseOutcome{Remaining: held}, context.Canceled, false},
		{"a destroy that succeeded is not retried", nil, releaseOutcome{Remaining: held}, nil, false},
		{"a clean release has nothing to retry", boom, releaseOutcome{Clean: true}, nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := shouldRetryRelease(tc.destroyer, tc.rel, tc.ctxErr); got != tc.want {
				t.Errorf("shouldRetryRelease = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestAdoptRetryOutcomeNeverErasesTheOnlyListAnyoneHas pins the finding that made the retry worse
// than the bug: both arms did `rel = rel2`, so a second release that established LESS discarded the
// first one's objects and left the billing warning naming nothing.
func TestAdoptRetryOutcomeNeverErasesTheOnlyListAnyoneHas(t *testing.T) {
	held := []cloudBackedObject{{Kind: "service", Namespace: "ingress-nginx", Name: "controller"}}
	fresher := []cloudBackedObject{{Kind: "ingress", Namespace: "alethia", Name: "console"}}
	first := releaseOutcome{Remaining: held}

	// THE MOTIVATING SCENARIO: the control plane is gone by the time the destroy fails, so the
	// second release returns Skipped with no Remaining.
	t.Run("a Skipped second attempt does not erase the first's objects", func(t *testing.T) {
		got, note := adoptRetryOutcome(first, releaseOutcome{Skipped: "the cluster could not be reached"})
		if len(got.Remaining) != 1 || got.Remaining[0].Name != "controller" {
			t.Fatalf("adopted the emptier outcome (%+v) — the billing warning would name nothing, "+
				"which is strictly worse than never having retried", got)
		}
		if w := got.billingWarning(); !strings.Contains(w, "controller") {
			t.Errorf("the warning stopped naming what is still held:\n%s", w)
		}
		// The note and the adoption are ONE decision: a note claiming the second release saw the
		// objects, over an outcome carrying the FIRST one's, is the disagreement that shipped.
		if !strings.Contains(note, "established nothing new") {
			t.Errorf("note %q does not say the second attempt established nothing", note)
		}
	})
	t.Run("an Unknown second attempt that saw nothing does not erase them either", func(t *testing.T) {
		if got, _ := adoptRetryOutcome(first, releaseOutcome{Unknown: true}); len(got.Remaining) != 1 {
			t.Errorf("adopted an outcome that observed nothing: %+v", got)
		}
	})
	// And the other direction, or the function could simply always return `first` — which would
	// make a genuinely successful second release invisible and re-report objects already gone.
	t.Run("a clean second attempt IS adopted", func(t *testing.T) {
		got, note := adoptRetryOutcome(first, releaseOutcome{Clean: true})
		if !strings.Contains(note, "cleared them") {
			t.Errorf("note %q does not say the second release worked", note)
		}
		if !got.Clean {
			t.Error("a second release that cleared everything was discarded")
		}
		if w := got.billingWarning(); w != "" {
			t.Errorf("a clean outcome still warns about billing:\n%s", w)
		}
	})
	t.Run("a second attempt with a fresher list IS adopted", func(t *testing.T) {
		got, note := adoptRetryOutcome(first, releaseOutcome{Remaining: fresher})
		if !strings.Contains(note, "did not clear them either") {
			t.Errorf("note %q does not say the second release also failed", note)
		}
		if len(got.Remaining) != 1 || got.Remaining[0].Name != "console" {
			t.Errorf("kept the stale list instead of the fresher one: %+v", got)
		}
	})
}

// TestBillingWarningDoesNotPromiseAListItDoesNotHave — the Unknown branch used to render
// "what follows is not a complete list" with nothing following it, which reads as "there is
// nothing": the one meaning this type exists to keep apart from "we could not look".
func TestBillingWarningDoesNotPromiseAListItDoesNotHave(t *testing.T) {
	w := releaseOutcome{Unknown: true}.billingWarning()
	if strings.Contains(w, "what follows is not a complete list") {
		t.Errorf("promised a list and named nothing:\n%s", w)
	}
	if !strings.Contains(w, "UNKNOWN") {
		t.Errorf("does not say the objects are unknown rather than absent:\n%s", w)
	}
	if strings.Contains(w, "delete those objects") {
		t.Errorf("says \"delete those objects\" having named none, leaving no first step:\n%s", w)
	}
	// Still an alarm, and still says nothing sweeps it.
	for _, want := range []string{"STILL BILL", "NOTHING SWEEPS THESE AUTOMATICALLY"} {
		if !strings.Contains(w, want) {
			t.Errorf("the warning lost %q:\n%s", want, w)
		}
	}
	// And with objects, the original wording is intact — or this test would pass against a
	// renderer that dropped the list branch entirely.
	held := releaseOutcome{Unknown: true, Remaining: []cloudBackedObject{{Kind: "service", Namespace: "ns", Name: "n"}}}
	if w := held.billingWarning(); !strings.Contains(w, "what follows is not a complete list") || !strings.Contains(w, "delete those objects") {
		t.Errorf("the populated Unknown rendering regressed:\n%s", w)
	}
}

// TestPostDestroySuccessNoticeWarnsOnAGreenTeardownToo pins finding 3, which is the one with a
// live cloud bill behind it: the billing warning used to be interpolated ONLY into a failed
// destroy's error, so a teardown that timed out releasing and then deleted its state-file
// resources cleanly went green and said nothing at all.
func TestPostDestroySuccessNoticeWarnsOnAGreenTeardownToo(t *testing.T) {
	held := []cloudBackedObject{{Kind: "service", Namespace: "ingress-nginx", Name: "controller"}}

	t.Run("objects still held on a SUCCESSFUL destroy still warn", func(t *testing.T) {
		got := postDestroySuccessNotice(releaseOutcome{Remaining: held})
		if got == "" {
			t.Fatal("a green teardown holding a cloud load balancer said nothing — the exact " +
				"silent-billing case this path exists for")
		}
		for _, want := range []string{"STILL BILL", "controller", "NOTHING SWEEPS THESE AUTOMATICALLY"} {
			if !strings.Contains(got, want) {
				t.Errorf("notice does not carry %q:\n%s", want, got)
			}
		}
	})
	t.Run("an unreadable cluster on a SUCCESSFUL destroy still warns", func(t *testing.T) {
		if got := postDestroySuccessNotice(releaseOutcome{Unknown: true}); got == "" {
			t.Error("could-not-look was reported as nothing-to-report")
		}
	})
	// The other direction matters just as much: a warning printed after every teardown is a
	// warning nobody reads, and the repeat destroy of an already-gone environment is the common
	// case that would trigger it.
	t.Run("a clean release says nothing", func(t *testing.T) {
		if got := postDestroySuccessNotice(releaseOutcome{Clean: true}); got != "" {
			t.Errorf("a teardown that released everything still warned:\n%s", got)
		}
	})
	t.Run("a bare Skipped is stated but not alarmed", func(t *testing.T) {
		got := postDestroySuccessNotice(releaseOutcome{Skipped: "the state outputs could not be read"})
		if got == "" {
			t.Fatal("the release step never ran and nothing said so — silence is what this fixes")
		}
		if strings.Contains(got, "STILL BILL") {
			t.Errorf("a repeat teardown of a gone environment raises the full alarm, which is how "+
				"the alarm that matters gets scrolled past:\n%s", got)
		}
		if !strings.Contains(got, "did not run") {
			t.Errorf("the notice does not say what failed to happen:\n%s", got)
		}
	})
	// One renderer, not two: the success notice must speak THROUGH billingWarning, or the two can
	// drift into disagreeing about what is still held.
	t.Run("the warning text is the same one the error path uses", func(t *testing.T) {
		rel := releaseOutcome{Remaining: held}
		if postDestroySuccessNotice(rel) != rel.billingWarning() {
			t.Error("the success path renders its own warning text, which can now drift from the " +
				"error path's")
		}
	})
}

// TestRetryReleaseAndDestroyDrivesTheWholePolicy covers the branch that shipped in #3433 with no
// test at all — the one where the fix was worse than the bug. The collaborators are closures, so
// none of this needs a tofu binary or a cluster; what it asserts is the POLICY.
func TestRetryReleaseAndDestroyDrivesTheWholePolicy(t *testing.T) {
	held := []cloudBackedObject{{Kind: "service", Namespace: "ingress-nginx", Name: "controller"}}
	boom := errors.New("tofu destroy failed")

	t.Run("a second release that clears them re-runs the destroy", func(t *testing.T) {
		destroys := 0
		var buf bytes.Buffer
		rel, err := retryReleaseAndDestroy(context.Background(), &buf, releaseOutcome{Remaining: held}, boom,
			func() releaseOutcome { return releaseOutcome{Clean: true} },
			func() error { destroys++; return nil })
		if destroys != 1 {
			t.Errorf("the destroy was re-run %d time(s), want exactly 1", destroys)
		}
		if err != nil {
			t.Errorf("a successful second destroy still returned %v", err)
		}
		if !rel.Clean {
			t.Error("the cleared outcome was not adopted, so a green teardown would still warn")
		}
	})

	t.Run("a second release that establishes LESS keeps the first list and does NOT re-destroy", func(t *testing.T) {
		destroys := 0
		var buf bytes.Buffer
		rel, err := retryReleaseAndDestroy(context.Background(), &buf, releaseOutcome{Remaining: held}, boom,
			func() releaseOutcome { return releaseOutcome{Skipped: "the cluster could not be reached"} },
			func() error { destroys++; return nil })
		if destroys != 0 {
			t.Errorf("the destroy was re-run %d time(s) after a release that cleared nothing — "+
				"paying twice for the same failure", destroys)
		}
		if err == nil {
			t.Fatal("the original destroy error was dropped")
		}
		if len(rel.Remaining) != 1 {
			t.Fatalf("the first release's object list was erased: %+v", rel)
		}
		if w := rel.billingWarning(); !strings.Contains(w, "controller") {
			t.Errorf("the billing warning names nothing after the retry:\n%s", w)
		}
	})

	// The cases that must NOT retry at all. Each one used to cost a full Output + reachability +
	// ConfigureKubeconfig round to learn nothing.
	for _, tc := range []struct {
		name string
		rel  releaseOutcome
		err  error
	}{
		{"a destroy that succeeded", releaseOutcome{Remaining: held}, nil},
		{"a release that was skipped entirely", releaseOutcome{Skipped: "no state outputs"}, boom},
		{"a clean release", releaseOutcome{Clean: true}, boom},
	} {
		t.Run(tc.name+" does not retry", func(t *testing.T) {
			releases, destroys := 0, 0
			var buf bytes.Buffer
			got, err := retryReleaseAndDestroy(context.Background(), &buf, tc.rel, tc.err,
				func() releaseOutcome { releases++; return releaseOutcome{Clean: true} },
				func() error { destroys++; return nil })
			if releases != 0 || destroys != 0 {
				t.Errorf("released %d and destroyed %d times, want 0 and 0", releases, destroys)
			}
			if err != nil && tc.err == nil || err == nil && tc.err != nil {
				t.Errorf("the destroy error changed: got %v, want %v", err, tc.err)
			}
			if buf.Len() != 0 {
				t.Errorf("a teardown that did not retry still narrated one:\n%s", buf.String())
			}
			if got.Clean != tc.rel.Clean {
				t.Errorf("the outcome was replaced by the un-run release: %+v", got)
			}
		})
	}

	t.Run("a cancelled context does not start another wait", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		releases := 0
		var buf bytes.Buffer
		if _, err := retryReleaseAndDestroy(ctx, &buf, releaseOutcome{Remaining: held}, boom,
			func() releaseOutcome { releases++; return releaseOutcome{Clean: true} },
			func() error { return nil }); err == nil {
			t.Error("the destroy error was dropped on a cancelled teardown")
		}
		if releases != 0 {
			t.Errorf("a cancelled teardown started %d more release(s)", releases)
		}
	})
}
