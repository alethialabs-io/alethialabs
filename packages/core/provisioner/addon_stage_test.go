// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestRunAddOnStage_UnreadableAppsRepoReachesTheDeployTab (#6971): a deploy that cannot clone the
// apps repository still completes, and says so in the warnings the Deploy tab shows, not only in the
// job log. The stage is driven for real against a repository path that does not exist.
func TestRunAddOnStage_UnreadableAppsRepoReachesTheDeployTab(t *testing.T) {
	newByoCluster(t, "")
	stubSweep(t)
	vc := &types.ProjectConfig{ProjectName: "acme"}
	vc.Repositories.AppsDestinationRepo = "file://" + filepath.Join(t.TempDir(), "no-such-repo.git")

	var stdout, stderr bytes.Buffer
	stage, err := runAddOnStage(context.Background(), addOnStageInput{
		VC:             vc,
		Facts:          &argocd.InfraFacts{},
		Provider:       "aws",
		GitAccessToken: "tok",
		Refresh:        func(context.Context, string) error { return nil },
	}, &stdout, &stderr)
	if err != nil {
		t.Fatalf("an unreadable apps repository must not fail the stage: %v", err)
	}

	var got []string
	for _, w := range stage.Warnings {
		if strings.HasPrefix(w, "The apps repository could not be read or updated: ") {
			got = append(got, w)
		}
	}
	if len(got) != 1 {
		t.Fatalf("want exactly one apps-repository warning, got %d in %q", len(got), stage.Warnings)
	}
	if !strings.Contains(got[0], "clone apps repo") {
		t.Errorf("the warning does not carry the reason: %q", got[0])
	}
	if !strings.Contains(got[0], "The cluster was created") {
		t.Errorf("the warning does not say what the deploy did and did not do: %q", got[0])
	}
	// The job log keeps its line, and it is the same text.
	if !strings.Contains(stderr.String(), got[0]) {
		t.Errorf("the job log does not carry the warning:\n%s", stderr.String())
	}
}

// TestRunAddOnStage_ReadableAppsRepoSaysNothing: the control. A repository the runner can clone
// produces no apps-repository warning, so the test above is measuring the failure and not the stage.
func TestRunAddOnStage_ReadableAppsRepoSaysNothing(t *testing.T) {
	newByoCluster(t, "")
	stubSweep(t)
	vc := &types.ProjectConfig{ProjectName: "acme"}
	vc.Repositories.AppsDestinationRepo = "file://" + newBareAppsRepo(t, map[string]string{"README.md": "apps\n"})

	var stderr bytes.Buffer
	stage, err := runAddOnStage(context.Background(), addOnStageInput{
		VC:             vc,
		Facts:          &argocd.InfraFacts{},
		Provider:       "aws",
		GitAccessToken: "tok",
		Refresh:        func(context.Context, string) error { return nil },
	}, &bytes.Buffer{}, &stderr)
	if err != nil {
		t.Fatalf("runAddOnStage: %v", err)
	}
	if joined := strings.Join(stage.Warnings, "\n"); strings.Contains(joined, "apps repository could not be") {
		t.Errorf("a readable repository produced the warning: %q", stage.Warnings)
	}
	if strings.Contains(stderr.String(), "GitOps add-on sync skipped") {
		t.Errorf("a readable repository logged a skipped sync:\n%s", stderr.String())
	}
}

// TestAppsRepoSyncWarning_CarriesNoCredential: the reason is an error text from git, which can
// repeat the remote URL. Neither a credential written into a URL nor a known token on its own
// reaches the warning.
func TestAppsRepoSyncWarning_CarriesNoCredential(t *testing.T) {
	cases := []struct {
		name    string
		err     error
		token   string
		repo    map[string]string
		absent  []string
		present []string
	}{
		{
			name:    "credential in the URL",
			err:     errors.New("clone apps repo: authentication failed: https://user:secret@git.example.com/acme/apps.git"),
			absent:  []string{"secret", "user:"},
			present: []string{"https://[REDACTED]@git.example.com/acme/apps.git", "authentication failed"},
		},
		{
			name:    "token-only userinfo",
			err:     errors.New("push add-on manifests: https://ghp_abc123@github.com/acme/apps: 403"),
			absent:  []string{"ghp_abc123"},
			present: []string{"https://[REDACTED]@github.com/acme/apps"},
		},
		{
			name:    "the apps token outside a URL",
			err:     errors.New("clone apps repo: remote said: bad credentials for apps-token-1"),
			token:   "apps-token-1",
			absent:  []string{"apps-token-1"},
			present: []string{"[REDACTED]"},
		},
		{
			name:    "a per-repository token outside a URL",
			err:     errors.New("clone apps repo: header Authorization: Bearer byo-token-2 rejected"),
			token:   "apps-token-1",
			repo:    map[string]string{"https://git.example.com/acme/charts": "byo-token-2"},
			absent:  []string{"byo-token-2"},
			present: []string{"[REDACTED]"},
		},
		{
			name:    "a URL with no credential is left readable",
			err:     errors.New("clone apps repo: authentication failed: https://github.com/acme/apps"),
			token:   "apps-token-1",
			present: []string{"https://github.com/acme/apps"},
			absent:  []string{"[REDACTED]"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := appsRepoSyncWarning(tc.err, tc.token, tc.repo)
			for _, s := range tc.absent {
				if strings.Contains(got, s) {
					t.Errorf("the warning carries %q: %q", s, got)
				}
			}
			for _, s := range tc.present {
				if !strings.Contains(got, s) {
					t.Errorf("the warning lacks %q: %q", s, got)
				}
			}
			if !strings.HasPrefix(got, "The apps repository could not be read or updated: ") {
				t.Errorf("unexpected sentence: %q", got)
			}
		})
	}
}
