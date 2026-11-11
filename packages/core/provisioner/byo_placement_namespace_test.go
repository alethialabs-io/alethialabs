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
// carrying another environment's alethia.io/environment-id. A chart that is not yet running there is
// refused before anything is written; one an earlier deploy already runs there is kept and reported,
// because refusing it would withdraw its binding secrets. A failed read applies nothing.

// placedNS is the namespace the tests' "legacy" chart is stored in: one a placement may use.
const placedNS = "team-web"

// clusterReads answers the runner's namespace and Application reads for the tests below, and counts
// the namespace reads. Every other read goes to the PATH stub newByoCluster installs.
type clusterReads struct {
	namespaces map[string]string // ns → `kubectl get namespace -o json` answer ("" = absent)
	nsErr      error
	dest       string // the "legacy" chart's live Application destination ("" = no Application)
	appErr     error
	nsRead     map[string]int
}

func (r *clusterReads) install(t *testing.T) {
	t.Helper()
	r.nsRead = map[string]int{}
	orig := executeCommandWithOutput
	t.Cleanup(func() { executeCommandWithOutput = orig })
	executeCommandWithOutput = func(cmd, dir string, env []string) (string, error) {
		if rest, ok := strings.CutPrefix(cmd, "kubectl get namespace "); ok && strings.HasSuffix(cmd, " --ignore-not-found -o json") {
			ns := strings.TrimSuffix(rest, " --ignore-not-found -o json")
			if !strings.Contains(ns, " ") {
				r.nsRead[ns]++
				if r.nsErr != nil {
					return "", r.nsErr
				}
				return r.namespaces[ns], nil
			}
		}
		if strings.HasPrefix(cmd, "kubectl get applications.argoproj.io "+argocd.AddOnAppName("legacy")+" ") {
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

// labelled is a namespace answer carrying labels.
func labelled(labels string) string {
	return `{"apiVersion":"v1","kind":"Namespace","metadata":{"name":"` + placedNS + `","labels":{` + labels + `}}}`
}

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
			if len(got.PlacementOverlaps) != 0 {
				t.Errorf("a refused chart is not also an overlap: %+v", got.PlacementOverlaps)
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
	for _, tc := range []struct{ name, answer, holder string }{
		{"the placement's label", labelled(placementLabels), `the namespace-placed environment "env-2"`},
		// An earlier deploy of this environment stamped its own id over the placement's.
		{"this environment's label over a placement's", labelled(`"alethia.io/placement":"namespace","alethia.io/environment-id":"env-1"`), "a namespace-placed environment"},
		{"another environment's label", labelled(`"alethia.io/environment-id":"env-2"`), `the environment "env-2"`},
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
			for _, want := range []string{`"legacy"`, `"` + placedNS + `"`, tc.holder, "binding secrets unchanged", `"byo-legacy"`} {
				if !strings.Contains(w, want) {
					t.Errorf("the Deploy-tab warning must contain %q, got: %s", want, w)
				}
			}
		})
	}
	t.Run("an Application pointing at another namespace is not running there, and is refused", func(t *testing.T) {
		newByoCluster(t, "")
		(&clusterReads{namespaces: map[string]string{placedNS: labelled(placementLabels)}, dest: "old-home"}).install(t)
		got := configureByoCharts(placedConfigFor(), "tok", nil, nil, io.Discard, io.Discard)
		if len(got.Refused) != 1 || len(got.PlacementOverlaps) != 0 {
			t.Fatalf("want a refusal, got refused=%+v overlaps=%+v", got.Refused, got.PlacementOverlaps)
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
			if got.Err != nil || len(got.Refused) != 0 || len(got.PlacementOverlaps) != 0 {
				t.Fatalf("want the chart configured untouched, got err=%v refused=%+v overlaps=%+v", got.Err, got.Refused, got.PlacementOverlaps)
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
			if raw, err := os.ReadFile(c.applied); err == nil && strings.TrimSpace(string(raw)) != "" {
				t.Errorf("nothing may be applied after a failed read, got:\n%s", raw)
			}
		})
	}
}

// TestConfigureByoCharts_ANamespaceNoPlacementMayUseIsNotRead: a byo- namespace (every chart's own
// default) and a reserved name are refused to every placement by #6551, so they are not read.
func TestConfigureByoCharts_ANamespaceNoPlacementMayUseIsNotRead(t *testing.T) {
	newByoCluster(t, "")
	reads := &clusterReads{nsErr: errors.New("must not be read")}
	reads.install(t)
	vc := legacyByoConfig("databases")
	vc.AddOns[0].Namespace = "byo-api"
	got := configureByoCharts(vc, "tok", nil, nil, io.Discard, io.Discard)
	if got.Err != nil {
		t.Fatalf("Err = %v", got.Err)
	}
	if len(reads.nsRead) != 0 {
		t.Errorf("namespaces read: %v; want none", reads.nsRead)
	}
}

// TestRunAddOnStage_PlacementHolds drives the stage: a failed read fails it before anything is
// applied, and a kept chart gets one Deploy-tab warning, its Application and its binding secret.
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
	t.Run("a failed read fails the stage and applies nothing", func(t *testing.T) {
		c, _, err := stage(t, &clusterReads{nsErr: errors.New("forbidden")})
		if err == nil || !strings.Contains(err.Error(), "could not read namespace") {
			t.Fatalf("want the stage to fail closed, got %v", err)
		}
		if raw, rerr := os.ReadFile(c.applied); rerr == nil && strings.TrimSpace(string(raw)) != "" {
			t.Errorf("nothing may be applied, got:\n%s", raw)
		}
	})
	t.Run("a kept chart is warned about and still bound", func(t *testing.T) {
		c, out, err := stage(t, &clusterReads{namespaces: map[string]string{placedNS: labelled(placementLabels)}, dest: placedNS})
		if err != nil {
			t.Fatal(err)
		}
		if len(out.Warnings) != 1 || !strings.Contains(out.Warnings[0], `"env-2"`) || !strings.Contains(out.Warnings[0], `"legacy"`) {
			t.Errorf("want one Deploy-tab warning naming both sides, got %v", out.Warnings)
		}
		applied, bound := false, false
		for _, d := range c.docs(t) {
			if d.Kind == "Application" && d.Metadata.Name == argocd.AddOnAppName("legacy") {
				applied = true
			}
			if d.Kind == "ExternalSecret" && d.Metadata.Namespace == placedNS {
				bound = true
			}
		}
		if !applied || !bound {
			t.Errorf("the chart must keep deploying and keep its bindings: Application applied=%v, ExternalSecret in %s=%v", applied, placedNS, bound)
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
