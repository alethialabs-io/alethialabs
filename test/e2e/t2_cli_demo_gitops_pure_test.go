// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// #5109: on the cli-demo path the A0.6 repos reach the project only through the CLI.
//
// Run 36141504059 deployed a CLI-authored project to SUCCESS and then failed A0.6 on "apps" missing,
// because no beat wired the apps repo or the BYO chart. These tests pin, without a cloud:
//   - the two beats carry the SAME coordinates the seeded path's applyToSnapshot writes, under the
//     seeded chart id, into the run's own environment, in the authoring window;
//   - each read-back accepts only what the beat sent, field by field;
//   - a run without the A0.6 inputs is refused rather than driven with empty values.

import (
	"slices"
	"strings"
	"testing"
)

// gitOpsRun is a run as the spine leaves it after project-env, with the nightly's A0.6 inputs.
// The values are literals, not read from the functions under test.
func gitOpsRun() *CLIDemoRun {
	r := namingRun()
	r.GitOps = t2ArgoRepos{
		appsRepo:     "https://github.com/alethialabs-io/alethia-e2e-apps",
		byoChartRepo: "https://github.com/alethialabs-io/alethia-e2e-chart",
		byoChartPath: "chart",
		byoRevision:  "HEAD",
		byoNamespace: "byo-e2e",
		tokenPresent: true,
	}
	return r
}

// TestCLIDemoGitOpsBeatsWireTheSeededRepos: both beats run in the authoring window, address the
// run's project and environment, and send the coordinates the seeded path writes.
func TestCLIDemoGitOpsBeatsWireTheSeededRepos(t *testing.T) {
	r := gitOpsRun()

	for _, id := range []string{"apps-repo", "chart-attach"} {
		b := cliDemoBeatByID(t, id)
		if b.Phase != CLIDemoAuthoring {
			t.Errorf("beat %q runs in phase %q; the PLAN and DEPLOY snapshot the project when they are enqueued, so it must be %q",
				id, b.Phase, CLIDemoAuthoring)
		}
		if b.ReadBack == nil || b.After == nil {
			t.Errorf("beat %q has no read-back; a wrong stored value would surface only after the cluster was bought", id)
		}
	}

	apps := beatArgs(t, "apps-repo", r)
	if !slices.Equal(apps[:3], []string{"project", "component", "add"}) {
		t.Errorf("apps-repo argv = %v, want `project component add …`", apps)
	}
	for flag, want := range map[string]string{
		"--project": r.ProjectID,
		"--env":     r.EnvName,
		"--kind":    "repositories",
		"--set":     "apps_destination_repo=https://github.com/alethialabs-io/alethia-e2e-apps",
	} {
		if got, _ := flagValue(apps, flag); got != want {
			t.Errorf("apps-repo %s = %q, want %q (argv %v)", flag, got, want, apps)
		}
	}

	chart := beatArgs(t, "chart-attach", r)
	if len(chart) < 3 || !slices.Equal(chart[:2], []string{"chart", "attach"}) || chart[2] != "byo-e2e" {
		t.Errorf("chart-attach argv = %v, want `chart attach byo-e2e …`. The seeded id is what the A0.6 assertions address as addon-byo-e2e", chart)
	}
	for flag, want := range map[string]string{
		"--project":    r.ProjectID,
		"--env":        r.EnvName,
		"--repo":       "https://github.com/alethialabs-io/alethia-e2e-chart",
		"--chart-path": "chart",
		"--ref":        "HEAD",
		"--namespace":  "byo-e2e",
	} {
		if got, _ := flagValue(chart, flag); got != want {
			t.Errorf("chart-attach %s = %q, want %q (argv %v)", flag, got, want, chart)
		}
	}
	// The spine asserts these two names. They must be the ones the attached chart produces.
	if got := r.GitOps.byoAppName(); got != "addon-byo-e2e" {
		t.Errorf("byoAppName = %q, want addon-byo-e2e", got)
	}
}

// TestAssertAppsRepoWired: the read-back accepts only the exact repo the beat set.
func TestAssertAppsRepoWired(t *testing.T) {
	const want = "https://github.com/alethialabs-io/alethia-e2e-apps"
	for name, tc := range map[string]struct {
		out     string
		wantErr string
	}{
		"stored exactly": {
			out: `[{"id":"c1","kind":"repositories","name":"repositories","status":"",` +
				`"cloud_identity_id":null,"config":{"apps_destination_repo":"` + want + `","apps_path":null}}]`,
		},
		"stored with a different value": {
			out:     `[{"kind":"repositories","config":{"apps_destination_repo":"https://github.com/acme/other"}}]`,
			wantErr: `want "` + want + `"`,
		},
		"stored empty": {
			out:     `[{"kind":"repositories","config":{"apps_destination_repo":null}}]`,
			wantErr: `stores apps_destination_repo ""`,
		},
		"no repositories component": {
			out:     `[{"kind":"cluster","config":{"node_min_size":1}}]`,
			wantErr: "lists no repositories component",
		},
		"empty list": {
			out:     `[]`,
			wantErr: "lists no repositories component",
		},
		"not JSON": {
			out:     "No components found.",
			wantErr: "no JSON array",
		},
	} {
		t.Run(name, func(t *testing.T) {
			err := assertAppsRepoWired(gitOpsRun(), tc.out)
			checkErr(t, err, tc.wantErr)
		})
	}

	// A run with no apps repo is a precondition failure, not a pass on an empty value.
	r := gitOpsRun()
	r.GitOps.appsRepo = ""
	checkErr(t, assertAppsRepoWired(r, `[{"kind":"repositories","config":{"apps_destination_repo":""}}]`), "carries no apps repo")
}

// TestAssertByoChartAttached: the read-back compares every coordinate the deploy renders from.
func TestAssertByoChartAttached(t *testing.T) {
	chart := func(id, repo, path, ref, ns string) string {
		return `{"id":"` + id + `","repo_url":"` + repo + `","chart_path":"` + path + `","ref":"` + ref +
			`","namespace":"` + ns + `","status":"PENDING","health":null,"sync":null,"scan_status":"scanning","scanned_at":null}`
	}
	const repo = "https://github.com/alethialabs-io/alethia-e2e-chart"
	view := func(env string, charts ...string) string {
		return `{"environment":"` + env + `","charts":[` + strings.Join(charts, ",") + `]}`
	}
	const env = "36135826614-1"
	for name, tc := range map[string]struct {
		out     string
		wantErr string
	}{
		"attached as sent": {
			out: view(env, chart("byo-e2e", repo, "chart", "HEAD", "byo-e2e")),
		},
		"attached alongside another chart": {
			out: view(env, chart("api", "https://github.com/acme/charts", "charts/api", "main", "default"),
				chart("byo-e2e", repo, "chart", "HEAD", "byo-e2e")),
		},
		"namespace fell back to the server default": {
			out:     view(env, chart("byo-e2e", repo, "chart", "HEAD", "default")),
			wantErr: `namespace="default" (want "byo-e2e")`,
		},
		"a different repo": {
			out:     view(env, chart("byo-e2e", "https://github.com/acme/charts", "chart", "HEAD", "byo-e2e")),
			wantErr: "repo_url=",
		},
		"a different path and ref": {
			out:     view(env, chart("byo-e2e", repo, "charts/x", "main", "byo-e2e")),
			wantErr: `chart_path="charts/x" (want "chart"), ref="main" (want "HEAD")`,
		},
		"stored under another id": {
			out:     view(env, chart("byo-e2e-1", repo, "chart", "HEAD", "byo-e2e")),
			wantErr: "lists no chart with that id",
		},
		"another environment answered": {
			out:     view("development", chart("byo-e2e", repo, "chart", "HEAD", "byo-e2e")),
			wantErr: `answered for environment "development"`,
		},
		"not JSON": {
			out:     "No BYO charts attached.",
			wantErr: "no JSON object",
		},
	} {
		t.Run(name, func(t *testing.T) {
			checkErr(t, assertByoChartAttached(gitOpsRun(), tc.out), tc.wantErr)
		})
	}

	r := gitOpsRun()
	r.GitOps.byoChartRepo = ""
	checkErr(t, assertByoChartAttached(r, view(env)), "carries no BYO chart repo")
}

// TestCLIDemoGitOpsRefusesAnUnwiredRun: all three A0.6 inputs, or the run is refused before a beat.
func TestCLIDemoGitOpsRefusesAnUnwiredRun(t *testing.T) {
	full := gitOpsRun().GitOps
	got, err := cliDemoGitOps(full)
	if err != nil {
		t.Fatalf("a fully wired run was refused: %v", err)
	}
	if got != full {
		t.Errorf("cliDemoGitOps returned %+v, want the inputs unchanged %+v", got, full)
	}

	// Nothing wired and not required: decide() calls that a clean opt-out, but here it is a refusal.
	if _, err := cliDemoGitOps(t2ArgoRepos{}); err == nil || !strings.Contains(err.Error(), "not wired") {
		t.Errorf("an unwired run = %v, want a refusal naming the missing inputs", err)
	}

	// Partially wired: decide()'s own error comes through.
	partial := full
	partial.tokenPresent = false
	if _, err := cliDemoGitOps(partial); err == nil || !strings.Contains(err.Error(), envArgoGitToken) {
		t.Errorf("a run with no git token = %v, want an error naming %s", err, envArgoGitToken)
	}
}

// checkErr fails unless err matches the expectation: nil when wantErr is empty, otherwise an error
// containing wantErr.
func checkErr(t *testing.T, err error, wantErr string) {
	t.Helper()
	if wantErr == "" {
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		return
	}
	if err == nil || !strings.Contains(err.Error(), wantErr) {
		t.Fatalf("error = %v, want one containing %q", err, wantErr)
	}
}
