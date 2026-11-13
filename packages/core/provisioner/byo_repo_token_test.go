// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"encoding/base64"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

const (
	sharedTokenCanary  = "CANARY-shared-apps-token-3b9f"
	perRepoTokenCanary = "CANARY-per-repo-token-a71c"
)

// gitByoChartConfig is a project with one git-source BYO chart whose repo is repo.
func gitByoChartConfig(repo string) *types.ProjectConfig {
	return &types.ProjectConfig{
		ProjectName: "Acme Corp",
		AddOns: []types.AddOnInstall{
			{ID: "api", Mode: "managed", Source: "git", ChartRepo: repo, Path: "charts/api", Version: "HEAD", Namespace: "payments"},
		},
	}
}

// appliedText is everything the scripted kubectl was asked to apply, as one string.
func appliedText(t *testing.T, c *byoCluster) string {
	t.Helper()
	raw, err := os.ReadFile(c.applied)
	if err != nil {
		t.Fatalf("nothing was applied: %v", err)
	}
	return string(raw)
}

// TestConfigureByoCharts_NoPerRepoTokenRegistersNoCredential pins #6600: when the runner has no token
// for a chart's own repo (the console refused it, or the owner has no link for that provider), the
// shared apps-repo token is NOT registered for the chart repo. That token belongs to another repo's
// provider, and ArgoCD would send it to the chart repo's host. The chart is treated as public, and the
// warning names only the host.
func TestConfigureByoCharts_NoPerRepoTokenRegistersNoCredential(t *testing.T) {
	c := newByoCluster(t, "")
	repo := "https://user:pw@charts.example.net/acme/charts.git"
	var errOut strings.Builder
	got := configureByoCharts(gitByoChartConfig(repo), sharedTokenCanary, nil, nil, io.Discard, &errOut)
	if !got.Configured {
		t.Fatal("the BYO chart was not configured; a chart with no credential must still deploy as a public one")
	}
	if _, ok := appliedObjects(t, c.applied)["Secret/"+argocd.ByoRepoSecretName(repo)]; ok {
		t.Error("a repository credential was registered for a chart repo that has no per-repo token")
	}
	if text := appliedText(t, c); strings.Contains(text, base64.StdEncoding.EncodeToString([]byte(sharedTokenCanary))) {
		t.Error("the shared apps-repo token reached the cluster for a chart repo it does not belong to")
	}
	warn := errOut.String()
	if !strings.Contains(warn, "no git access token for BYO repo on host charts.example.net") {
		t.Errorf("stderr = %q, want the no-token warning naming the host", warn)
	}
	if strings.Contains(warn, "acme/charts") || strings.Contains(warn, "pw@") {
		t.Errorf("stderr = %q, the warning must name only the host", warn)
	}
}

// TestConfigureByoCharts_PerRepoTokenIsTheOneRegistered: a chart repo with its own token gets exactly
// that token, never the shared one.
func TestConfigureByoCharts_PerRepoTokenIsTheOneRegistered(t *testing.T) {
	c := newByoCluster(t, "")
	repo := "https://bitbucket.org/acme/charts.git"
	configureByoCharts(gitByoChartConfig(repo), sharedTokenCanary, map[string]string{repo: perRepoTokenCanary}, nil, io.Discard, io.Discard)
	if _, ok := appliedObjects(t, c.applied)["Secret/"+argocd.ByoRepoSecretName(repo)]; !ok {
		t.Fatal("no repository credential was registered for a chart repo with its own token")
	}
	text := appliedText(t, c)
	if !strings.Contains(text, base64.StdEncoding.EncodeToString([]byte(perRepoTokenCanary))) {
		t.Error("the per-repo token was not the one registered")
	}
	if strings.Contains(text, base64.StdEncoding.EncodeToString([]byte(sharedTokenCanary))) {
		t.Error("the shared apps-repo token was registered alongside the per-repo one")
	}
}

// TestRepoHostForLog reads the host out of each remote form a repo can take, and prints the
// placeholder — never other text from the URL — when the host is not a plain hostname.
func TestRepoHostForLog(t *testing.T) {
	for in, want := range map[string]string{
		"https://user:pw@Charts.Example.net:8443/a/b.git": "charts.example.net",
		"ssh://git@github.com/a/b.git":                    "github.com",
		"git@GitLab.com:a/b.git":                          "gitlab.com",
		"https://[::1]:8443/a/b.git":                      "[::1]",
		"git@github.com:org/repo@v1.git":                  "github.com",
		"git@tok-5d1e@evil.example:a/b.git":               UnparsedRepoHost,
		"ssh://git@gh%2Fx/a/b.git":                        UnparsedRepoHost,
		"not a url":                                       UnparsedRepoHost,
		"https://":                                        UnparsedRepoHost,
	} {
		if got := RepoHostForLog(in); got != want {
			t.Errorf("RepoHostForLog(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestByoIacCloneToken_IsTheModuleReposOwnToken pins #6611: a BYO IaC module is cloned with the token
// requested for exactly its repo, never with the apps repo's GitAccessToken, and with none when the
// runner has no token for it.
func TestByoIacCloneToken_IsTheModuleReposOwnToken(t *testing.T) {
	const module = "https://bitbucket.org/acme/infra.git"
	vc := &types.ProjectConfig{IacSource: &types.ProjectIacSourceConfig{RepoURL: module}}
	params := DeployParams{ProjectConfig: vc, GitAccessToken: sharedTokenCanary, GitRepoTokens: map[string]string{module: perRepoTokenCanary}}
	if got := byoIacCloneToken(params); got != perRepoTokenCanary {
		t.Errorf("byoIacCloneToken = %q, want the module repo's own token", got)
	}
	params.GitRepoTokens = nil
	if got := byoIacCloneToken(params); got != "" {
		t.Errorf("byoIacCloneToken with no per-repo token = %q, want none (never the apps repo's token)", got)
	}
	if got := byoIacCloneToken(DeployParams{ProjectConfig: &types.ProjectConfig{}, GitAccessToken: sharedTokenCanary}); got != "" {
		t.Errorf("byoIacCloneToken without an IaC source = %q, want none", got)
	}
}
