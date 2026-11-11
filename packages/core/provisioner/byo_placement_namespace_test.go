// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"errors"
	"io"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// #6562, the runner's half: a host BYO chart may not be deployed into a namespace that another
// environment holds — a namespace placement's (it carries alethia.io/placement=namespace) or one
// carrying another environment's alethia.io/environment-id. A chart with no Application is refused
// before anything is written; one whose Application already runs there is kept and reported; one
// whose Application runs elsewhere is kept where it runs. A failed read applies nothing.

// placedNS is the namespace the tests' "legacy" chart is stored in.
const placedNS = "team-web"

// clusterReads answers the runner's namespace and Application reads for the tests below, and counts
// them. Every other read goes to the PATH stub newByoCluster installs.
type clusterReads struct {
	namespaces map[string]string // ns → `kubectl get namespace -o json` answer ("" = absent)
	nsErr      error             // returned by the namespace reads (all, or only the first failFirst)
	failFirst  int               // > 0: only the first failFirst reads of each namespace fail
	dest       string            // the "legacy" chart's live Application destination ("" = none)
	appErr     error
	nsRead     map[string]int
	appRead    int
}

func (r *clusterReads) install(t *testing.T) {
	t.Helper()
	r.nsRead = map[string]int{}
	orig, origBackoff := executeCommandWithOutput, byoReadBackoff
	byoReadBackoff = 0
	t.Cleanup(func() { executeCommandWithOutput, byoReadBackoff = orig, origBackoff })
	executeCommandWithOutput = func(cmd, dir string, env []string) (string, error) {
		if rest, ok := strings.CutPrefix(cmd, "kubectl get namespace "); ok && strings.HasSuffix(cmd, " --ignore-not-found -o json") {
			ns := strings.TrimSuffix(rest, " --ignore-not-found -o json")
			if !strings.Contains(ns, " ") {
				r.nsRead[ns]++
				if r.nsErr != nil && (r.failFirst == 0 || r.nsRead[ns] <= r.failFirst) {
					return "", r.nsErr
				}
				return r.namespaces[ns], nil
			}
		}
		if strings.HasPrefix(cmd, "kubectl get applications.argoproj.io "+argocd.AddOnAppName("legacy")+" ") {
			r.appRead++
			return r.dest, r.appErr
		}
		return orig(cmd, dir, env)
	}
}

// placedConfigFor is legacyByoConfig with the "legacy" chart in placedNS, for environment env-1.
func placedConfigFor() *types.ProjectConfig {
	vc := legacyByoConfig(placedNS)
	vc.EnvironmentID = "env-1"
	return vc
}

// labelledAs is a namespace answer for ns carrying labels.
func labelledAs(ns, labels string) string {
	return `{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"` + ns + `","labels":{` + labels + `}}}`
}

// labelled is labelledAs for placedNS.
func labelled(labels string) string { return labelledAs(placedNS, labels) }

const placementLabels = `"alethia.io/placement":"namespace","alethia.io/environment-id":"env-2"`

// appliedNamespaces is the names of every Namespace the deploy applied, sorted.
func appliedNamespaces(t *testing.T, c *byoCluster) []string {
	t.Helper()
	var out []string
	for _, d := range c.docs(t) {
		if d.Kind == "Namespace" {
			out = append(out, d.Metadata.Name)
		}
	}
	sort.Strings(out)
	return out
}

// nothingApplied fails the test when the fake cluster received any write.
func nothingApplied(t *testing.T, c *byoCluster) {
	t.Helper()
	if raw, err := os.ReadFile(c.applied); err == nil && strings.TrimSpace(string(raw)) != "" {
		t.Errorf("nothing may be applied after a failed read, got:\n%s", raw)
	}
}

func TestConfigureByoCharts_RefusesANewChartInANamespaceAnotherEnvironmentHolds(t *testing.T) {
	for _, tc := range []struct{ name, answer, want string }{
		{"a namespace placement's", labelled(placementLabels), "held by the namespace-placed environment \"env-2\""},
		{"a placement's, with no owner label", labelled(`"alethia.io/placement":"namespace"`), "held by a namespace-placed environment"},
		{"another environment's", labelled(`"alethia.io/environment-id":"env-2"`), "belongs to the environment \"env-2\""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newByoCluster(t, "")
			(&clusterReads{namespaces: map[string]string{placedNS: tc.answer}}).install(t)
			got := configureByoCharts(placedConfigFor(), "tok", nil, nil, io.Discard, io.Discard)
			if got.Err != nil {
				t.Fatalf("Err = %v", got.Err)
			}
			if len(got.Refused) != 1 || got.Refused[0].ID != "legacy" || !strings.Contains(got.Refused[0].Reason, tc.want) || !strings.Contains(got.Refused[0].Reason, `"`+placedNS+`"`) {
				t.Fatalf("want the legacy chart refused naming %q and the holder, got %+v", placedNS, got.Refused)
			}
			if len(got.PlacementOverlaps) != 0 || len(got.HeldMoves) != 0 {
				t.Errorf("a refused chart is not also kept: overlaps=%+v moves=%+v", got.PlacementOverlaps, got.HeldMoves)
			}
			if dests := c.lastAppProjectDestinations(t, "byo-acme-corp"); !reflect.DeepEqual(dests, []string{"payments"}) {
				t.Errorf("AppProject destinations = %v, want only payments", dests)
			}
			if ns := appliedNamespaces(t, c); !reflect.DeepEqual(ns, []string{"payments"}) {
				t.Errorf("applied Namespaces = %v; the held namespace must not be written", ns)
			}
		})
	}
}

func TestConfigureByoCharts_AChartAlreadyRunningInAHeldNamespaceIsKeptAndReported(t *testing.T) {
	for _, tc := range []struct {
		name, answer string
		placement    bool
		want         []string
	}{
		{"the placement's label", labelled(placementLabels), true, []string{`the namespace-placed environment "env-2"`, "that environment's deploys are refused"}},
		// An earlier deploy of this environment stamped its own id over the placement's.
		{"this environment's label over a placement's", labelled(`"alethia.io/placement":"namespace","alethia.io/environment-id":"env-1"`), true, []string{"a namespace-placed environment"}},
		// Held only through the owner label: the warning says what the label says, and claims nothing
		// about that environment's deploys.
		{"another environment's label", labelled(`"alethia.io/environment-id":"env-2"`), false, []string{`owner label names the environment "env-2"`}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newByoCluster(t, "")
			(&clusterReads{namespaces: map[string]string{placedNS: tc.answer}, dest: placedNS}).install(t)
			got := configureByoCharts(placedConfigFor(), "tok", nil, nil, io.Discard, io.Discard)
			if got.Err != nil || len(got.Refused) != 0 {
				t.Fatalf("a running chart must not be refused: err=%v refused=%+v", got.Err, got.Refused)
			}
			if len(got.PlacementOverlaps) != 1 || got.PlacementOverlaps[0].ID != "legacy" || got.PlacementOverlaps[0].Namespace != placedNS {
				t.Fatalf("PlacementOverlaps = %+v, want the legacy chart in %q", got.PlacementOverlaps, placedNS)
			}
			dests := c.lastAppProjectDestinations(t, "byo-acme-corp")
			sort.Strings(dests)
			if !reflect.DeepEqual(dests, []string{"payments", placedNS}) {
				t.Errorf("AppProject destinations = %v, want both: the kept chart keeps deploying", dests)
			}
			if ns := appliedNamespaces(t, c); !reflect.DeepEqual(ns, []string{"payments"}) {
				t.Errorf("applied Namespaces = %v; the held namespace's labels must be left as they are", ns)
			}
			w := got.PlacementOverlaps[0].warning()
			for _, want := range append([]string{`"legacy"`, `"` + placedNS + `"`, "binding secrets unchanged", `"byo-legacy"`}, tc.want...) {
				if !strings.Contains(w, want) {
					t.Errorf("the Deploy-tab warning must contain %q, got: %s", want, w)
				}
			}
			if !tc.placement && strings.Contains(w, "deploys are refused") {
				t.Errorf("an owner-label hold must not claim that environment's deploys are refused: %s", w)
			}
			// #6575: a placement's teardown is refused while the chart runs in its namespace, so the
			// warning says to move the chart first. An owner-label holder need not be a placement, so
			// the warning claims nothing about its teardown.
			const teardown = "before that environment is torn down"
			if tc.placement && !strings.Contains(w, teardown) {
				t.Errorf("a placement hold's warning must say to move the chart %s: %s", teardown, w)
			}
			if !tc.placement && strings.Contains(w, "torn down") {
				t.Errorf("an owner-label hold must not claim anything about that environment's teardown: %s", w)
			}
		})
	}
}

// TestConfigureByoCharts_AMoveIntoAHeldNamespaceIsRefusedAndTheChartKeptWhereItRuns: the chart's
// stored namespace was changed to a held one, but its Application still runs in its old namespace.
// The chart is NOT refused (that would withdraw its secrets where it runs): it keeps deploying in
// the old namespace, with its bindings, and the Deploy tab says the move was refused.
func TestConfigureByoCharts_AMoveIntoAHeldNamespaceIsRefusedAndTheChartKeptWhereItRuns(t *testing.T) {
	c := newByoCluster(t, "")
	(&clusterReads{namespaces: map[string]string{placedNS: labelled(placementLabels)}, dest: "old-home"}).install(t)
	vc := placedConfigFor()
	got := configureByoCharts(vc, "tok", nil, nil, io.Discard, io.Discard)
	if got.Err != nil || len(got.Refused) != 0 {
		t.Fatalf("the chart must not be refused: err=%v refused=%+v", got.Err, got.Refused)
	}
	if len(got.HeldMoves) != 1 || got.HeldMoves[0].Requested != placedNS || got.HeldMoves[0].Kept != "old-home" {
		t.Fatalf("HeldMoves = %+v, want legacy kept in old-home", got.HeldMoves)
	}
	if vc.AddOns[1].Namespace != "old-home" {
		t.Errorf("the chart must render into old-home, got %q", vc.AddOns[1].Namespace)
	}
	dests := c.lastAppProjectDestinations(t, "byo-acme-corp")
	sort.Strings(dests)
	if !reflect.DeepEqual(dests, []string{"old-home", "payments"}) {
		t.Errorf("AppProject destinations = %v, want old-home kept and the held namespace absent", dests)
	}
	w := got.HeldMoves[0].warning()
	for _, want := range []string{`"legacy"`, `not moved into namespace "` + placedNS + `"`, `"env-2"`, `keeps deploying in "old-home"`} {
		if !strings.Contains(w, want) {
			t.Errorf("the Deploy-tab warning must contain %q, got: %s", want, w)
		}
	}
	t.Run("an old namespace the validator refuses is refused as before", func(t *testing.T) {
		newByoCluster(t, "")
		(&clusterReads{namespaces: map[string]string{placedNS: labelled(placementLabels)}, dest: "kube-system"}).install(t)
		got := configureByoCharts(placedConfigFor(), "tok", nil, nil, io.Discard, io.Discard)
		if len(got.Refused) != 1 || len(got.HeldMoves) != 0 {
			t.Fatalf("want a refusal, got refused=%+v moves=%+v", got.Refused, got.HeldMoves)
		}
	})
}

func TestConfigureByoCharts_ACoLocatedNamespaceWithoutTheMarkersPasses(t *testing.T) {
	for _, tc := range []struct{ name, answer string }{
		{"absent", ""},
		{"no labels", `{"metadata":{"name":"` + placedNS + `"}}`},
		{"the host's own GitOps labels", labelled(`"team":"payments"`)},
		{"this environment's own label", labelled(`"alethia.io/environment-id":"env-1"`)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newByoCluster(t, "")
			(&clusterReads{namespaces: map[string]string{placedNS: tc.answer}}).install(t)
			got := configureByoCharts(placedConfigFor(), "tok", nil, nil, io.Discard, io.Discard)
			if got.Err != nil || len(got.Refused) != 0 || len(got.PlacementOverlaps) != 0 || len(got.HeldMoves) != 0 {
				t.Fatalf("want the chart configured untouched, got err=%v refused=%+v overlaps=%+v moves=%+v", got.Err, got.Refused, got.PlacementOverlaps, got.HeldMoves)
			}
			if ns := appliedNamespaces(t, c); !reflect.DeepEqual(ns, []string{"payments", placedNS}) {
				t.Errorf("applied Namespaces = %v, want both", ns)
			}
		})
	}
}

func TestConfigureByoCharts_AFailedReadAppliesNothing(t *testing.T) {
	for _, tc := range []struct {
		name  string
		reads clusterReads
		want  string
	}{
		{"the namespace read fails", clusterReads{nsErr: errors.New("forbidden")}, "could not read namespace"},
		{"the namespace answer is unreadable", clusterReads{namespaces: map[string]string{placedNS: "not json"}}, "could not parse namespace"},
		{"the Application read fails", clusterReads{namespaces: map[string]string{placedNS: labelled(placementLabels)}, appErr: errors.New("timeout")}, "could not read BYO chart \"legacy\"'s Application"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newByoCluster(t, "")
			reads := tc.reads
			reads.install(t)
			got := configureByoCharts(placedConfigFor(), "tok", nil, nil, io.Discard, io.Discard)
			if got.Err == nil || !strings.Contains(got.Err.Error(), tc.want) || !strings.Contains(got.Err.Error(), "no binding was withdrawn") {
				t.Fatalf("want a fail-closed Err containing %q, got %v", tc.want, got.Err)
			}
			if len(got.Refused) != 0 {
				t.Errorf("a failed read refuses no chart (that would withdraw its bindings): %+v", got.Refused)
			}
			nothingApplied(t, c)
		})
	}
}

// TestConfigureByoCharts_TheReadsAreRetriedBeforeFailingClosed: a transient failure is retried
// (byoReadAttempts), and only an exhausted retry fails closed.
func TestConfigureByoCharts_TheReadsAreRetriedBeforeFailingClosed(t *testing.T) {
	t.Run("two failures then an answer", func(t *testing.T) {
		newByoCluster(t, "")
		reads := &clusterReads{nsErr: errors.New("etcdserver: leader changed"), failFirst: 2}
		reads.install(t)
		got := configureByoCharts(placedConfigFor(), "tok", nil, nil, io.Discard, io.Discard)
		if got.Err != nil {
			t.Fatalf("a read that succeeds on its third attempt must pass, got %v", got.Err)
		}
		if reads.nsRead[placedNS] != 3 {
			t.Errorf("%s read %d times, want 3", placedNS, reads.nsRead[placedNS])
		}
	})
	t.Run("every attempt fails", func(t *testing.T) {
		c := newByoCluster(t, "")
		reads := &clusterReads{nsErr: errors.New("forbidden"), failFirst: byoReadAttempts}
		reads.install(t)
		got := configureByoCharts(placedConfigFor(), "tok", nil, nil, io.Discard, io.Discard)
		if got.Err == nil {
			t.Fatal("an exhausted retry must fail closed")
		}
		nothingApplied(t, c)
	})
	t.Run("the Application read too", func(t *testing.T) {
		newByoCluster(t, "")
		reads := &clusterReads{namespaces: map[string]string{placedNS: labelled(placementLabels)}, appErr: errors.New("timeout")}
		reads.install(t)
		configureByoCharts(placedConfigFor(), "tok", nil, nil, io.Discard, io.Discard)
		if reads.appRead != byoReadAttempts {
			t.Errorf("Application read %d times, want %d", reads.appRead, byoReadAttempts)
		}
	})
}

// TestConfigureByoCharts_ByoAndNewlyReservedNamespacesAreReadToo: the runner reaches a byo- name with
// no console check (the legacy move chooses byo-<chart id> itself), and a placement created before
// #6551 may hold one, so these are read and held like any other.
func TestConfigureByoCharts_ByoAndNewlyReservedNamespacesAreReadToo(t *testing.T) {
	t.Run("the legacy move's target is held", func(t *testing.T) {
		c := newByoCluster(t, "")
		reads := &clusterReads{namespaces: map[string]string{"byo-legacy": labelledAs("byo-legacy", placementLabels)}}
		reads.install(t)
		vc := placedConfigFor()
		vc.AddOns[1].Namespace = "" // attached before #6446: moved to byo-legacy on this deploy
		got := configureByoCharts(vc, "tok", nil, nil, io.Discard, io.Discard)
		if len(got.Refused) != 1 || got.Refused[0].ID != "legacy" || got.Refused[0].Namespace != "byo-legacy" {
			t.Fatalf("want the moved chart refused in byo-legacy, got %+v", got.Refused)
		}
		if ns := appliedNamespaces(t, c); !reflect.DeepEqual(ns, []string{"payments"}) {
			t.Errorf("applied Namespaces = %v; byo-legacy must not be written", ns)
		}
	})
	t.Run("a newly reserved name is read", func(t *testing.T) {
		newByoCluster(t, "")
		reads := &clusterReads{}
		reads.install(t)
		vc := legacyByoConfig("databases")
		vc.AddOns[0].Namespace = "byo-api"
		if got := configureByoCharts(vc, "tok", nil, nil, io.Discard, io.Discard); got.Err != nil {
			t.Fatal(got.Err)
		}
		if reads.nsRead["databases"] != 1 || reads.nsRead["byo-api"] != 1 {
			t.Errorf("namespaces read: %v; want databases and byo-api once each", reads.nsRead)
		}
	})
	t.Run("a refused name is never read", func(t *testing.T) {
		newByoCluster(t, "")
		reads := &clusterReads{}
		reads.install(t)
		configureByoCharts(legacyByoConfig("kube-system"), "tok", nil, nil, io.Discard, io.Discard)
		if reads.nsRead["kube-system"] != 0 {
			t.Errorf("kube-system was read; a refused name is refused before the read")
		}
	})
}

// TestRunAddOnStage_PlacementHolds drives the stage: a failed read fails it before anything is
// applied; a kept chart gets one Deploy-tab warning, its Application and its binding secret.
func TestRunAddOnStage_PlacementHolds(t *testing.T) {
	stage := func(t *testing.T, reads *clusterReads) (*byoCluster, addOnStageResult, error) {
		t.Helper()
		c := newByoCluster(t, "")
		reads.install(t)
		vc := placedConfigFor()
		for i := range vc.AddOns {
			vc.AddOns[i].Workloads = byoBindingConfig("env-1", true).AddOns[0].Workloads
		}
		out, err := runAddOnStage(context.Background(), addOnStageInput{
			VC:             vc,
			Facts:          &argocd.InfraFacts{},
			Outputs:        map[string]interface{}{"rds_master_credentials_secret_name": bindingOutputsSecret},
			Provider:       "aws",
			GitAccessToken: "tok",
			Refresh:        func(context.Context, string) error { return nil },
		}, io.Discard, io.Discard)
		return c, out, err
	}
	keptAndBound := func(t *testing.T, c *byoCluster, ns string) {
		t.Helper()
		applied, bound := false, false
		for _, d := range c.docs(t) {
			if d.Kind == "Application" && d.Metadata.Name == argocd.AddOnAppName("legacy") {
				applied = true
			}
			if d.Kind == "ExternalSecret" && d.Metadata.Namespace == ns {
				bound = true
			}
		}
		if !applied || !bound {
			t.Errorf("the chart must keep deploying and keep its bindings: Application applied=%v, ExternalSecret in %s=%v", applied, ns, bound)
		}
	}
	t.Run("a failed read fails the stage and applies nothing", func(t *testing.T) {
		c, _, err := stage(t, &clusterReads{nsErr: errors.New("forbidden")})
		if err == nil || !strings.Contains(err.Error(), "could not read namespace") {
			t.Fatalf("want the stage to fail closed, got %v", err)
		}
		nothingApplied(t, c)
	})
	t.Run("a kept chart is warned about and still bound", func(t *testing.T) {
		c, out, err := stage(t, &clusterReads{namespaces: map[string]string{placedNS: labelled(placementLabels)}, dest: placedNS})
		if err != nil {
			t.Fatal(err)
		}
		if len(out.Warnings) != 1 || !strings.Contains(out.Warnings[0], `"env-2"`) || !strings.Contains(out.Warnings[0], `"legacy"`) {
			t.Errorf("want one Deploy-tab warning naming both sides, got %v", out.Warnings)
		}
		keptAndBound(t, c, placedNS)
	})
	t.Run("a refused move keeps the chart, and its bindings, where it runs", func(t *testing.T) {
		c, out, err := stage(t, &clusterReads{namespaces: map[string]string{placedNS: labelled(placementLabels)}, dest: "old-home"})
		if err != nil {
			t.Fatal(err)
		}
		if len(out.Refused) != 0 || len(out.Warnings) != 1 || !strings.Contains(out.Warnings[0], "not moved into") {
			t.Errorf("want no refusal and one move warning, got refused=%+v warnings=%v", out.Refused, out.Warnings)
		}
		keptAndBound(t, c, "old-home")
		found := false
		for _, ref := range out.Bindings.Declared {
			if ref.Namespace == "old-home" {
				found = true
			}
		}
		if !found {
			t.Errorf("the binding in old-home must stay in the prune's keep set, got %+v", out.Bindings.Declared)
		}
	})
}

// TestNamespacePlacementLabelIsTheTenantRenders pins the label the runner looks for to the one the
// namespace-placement render stamps on its Namespace.
func TestNamespacePlacementLabelIsTheTenantRenders(t *testing.T) {
	vc := placedConfig("team-web", &[]string{})
	vc.EnvironmentID = "11111111-2222-4333-8444-555555555555"
	m, err := argocd.RenderNamespaceTenant(namespaceTenantInput(vc, "team-web"))
	if err != nil {
		t.Fatal(err)
	}
	ns := strings.SplitN(m.Isolation, "\n---\n", 2)[0]
	if !strings.Contains(ns, "kind: Namespace") || !strings.Contains(ns, namespacePlacementLabel+`: "`+namespacePlacementValue+`"`) {
		t.Fatalf("the rendered Namespace must carry %s=%s, got:\n%s", namespacePlacementLabel, namespacePlacementValue, ns)
	}
}

// TestConfigureByoCharts_AKeptChartIsNotReadmittedIntoAnotherChartsOwnNamespace: the chart's
// Application runs in byo-api, chart "api"'s own default namespace, which a chart other than "api"
// may never share (byoNamespaceCollisions). Its stored namespace is now a held one, so the runner
// would keep it where its Application runs; the collision rule is re-run on that namespace and
// refuses it instead of re-admitting it there.
func TestConfigureByoCharts_AKeptChartIsNotReadmittedIntoAnotherChartsOwnNamespace(t *testing.T) {
	c := newByoCluster(t, "")
	(&clusterReads{namespaces: map[string]string{placedNS: labelled(placementLabels)}, dest: "byo-api"}).install(t)
	vc := placedConfigFor()
	vc.AddOns[0].Namespace = "byo-api"
	got := configureByoCharts(vc, "tok", nil, nil, io.Discard, io.Discard)
	if len(got.HeldMoves) != 0 {
		t.Fatalf("the chart must not be kept in another chart's own namespace: %+v", got.HeldMoves)
	}
	if len(got.Refused) != 1 || got.Refused[0].ID != "legacy" || !got.Refused[0].Shared || !strings.Contains(got.Refused[0].Reason, `"byo-api"`) {
		t.Fatalf("want legacy refused for sharing byo-api, got %+v", got.Refused)
	}
	if dests := c.lastAppProjectDestinations(t, "byo-acme-corp"); !reflect.DeepEqual(dests, []string{"byo-api"}) {
		t.Errorf("AppProject destinations = %v, want only api's byo-api", dests)
	}
}
