// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// bumpFixture is testdata/addon_bump/cases.json: the "only when sure" table the runner's drift check
// and the console's pull-request edit both read (#6549). The console's half is
// apps/console/tests/lib/addons/gitops-bump/edit.test.ts.
type bumpFixture struct {
	Chart  string `json:"chart"`
	Target string `json:"target"`
	Cases  []struct {
		Name     string `json:"name"`
		File     string `json:"file"`
		Drift    bool   `json:"drift"`
		Edit     string `json:"edit"`
		Expected string `json:"expected"`
	} `json:"cases"`
}

// TestGitopsAddOnDrift_SharedFixture pins the runner's verdict for every file in the shared table,
// and the table's own invariant: the console never edits a file the runner would not report.
func TestGitopsAddOnDrift_SharedFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "addon_bump", "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fx bumpFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	if len(fx.Cases) == 0 {
		t.Fatal("the shared table has no cases")
	}
	want := ingressGitOps(fx.Target)
	want.Chart = fx.Chart
	for _, c := range fx.Cases {
		t.Run(c.Name, func(t *testing.T) {
			body, err := os.ReadFile(filepath.Join("testdata", "addon_bump", c.File))
			if err != nil {
				t.Fatal(err)
			}
			if _, got := gitopsAddOnDrift("ingress-nginx", body, want); got != c.Drift {
				t.Errorf("drift = %v, the table says %v", got, c.Drift)
			}
			if c.Edit == "ok" && !c.Drift {
				t.Errorf("the table lets the console edit a file the runner does not report as behind")
			}
			if (c.Edit == "ok") != (c.Expected != "") {
				t.Errorf("an ok edit needs an expected file, and only an ok edit has one")
			}
		})
	}
}

// TestWriteAddOnGitOps_DeployNeverOpensABumpBranch (#6549): the pull request is opened only when a
// user asks, from the console. A deploy that finds a drifted file reports it and pushes nothing:
// the apps repo keeps exactly its one branch and its one commit, and no `alethia/addon-bump-*`
// branch appears.
func TestWriteAddOnGitOps_DeployNeverOpensABumpBranch(t *testing.T) {
	bare := newBareAppsRepo(t, map[string]string{"addons/ingress-nginx.yaml": seededIngress(t, "4.11.2")})
	vc := &types.ProjectConfig{ProjectName: "acme"}
	vc.Repositories.AppsDestinationRepo = "file://" + bare
	vc.AddOns = []types.AddOnInstall{ingressGitOps("4.15.1")}

	drift, err := writeAddOnGitOps(t.Context(), vc, "tok", nil, io.Discard, io.Discard)
	if err != nil {
		t.Fatalf("writeAddOnGitOps: %v", err)
	}
	if len(drift) != 1 {
		t.Fatalf("want the drift reported, got %+v", drift)
	}
	out, err := exec.Command("git", "--git-dir", bare, "for-each-ref", "--format=%(refname)", "refs/heads/").Output()
	if err != nil {
		t.Fatalf("list branches: %v", err)
	}
	branches := strings.Fields(string(out))
	if len(branches) != 1 || strings.Contains(string(out), "addon-bump") {
		t.Errorf("a deploy changed the repo's branches: %q", branches)
	}
	if got := commitCount(t, bare); got != 1 {
		t.Errorf("commit count = %d, want 1", got)
	}
}
