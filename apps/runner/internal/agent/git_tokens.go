// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"fmt"
	"io"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// Every git token this runner uses is requested for the exact repo it will clone or push
// (#6611): the console mints it from that repo's own provider, and the runner uses it for that
// repo only. No path asks for a token without naming its repo, and no token minted for one repo
// is handed to another — a repo whose token could not be had is cloned without a credential.

// fetchRepoToken requests the job owner's git token for exactly repoURL, with the provider the
// console named for it. It returns the zero GitToken (and makes no request) for an empty repo, and
// the zero GitToken with a warning naming only the repo's host when the console refuses or the
// request fails: the caller then clones without a credential.
func (w *Runner) fetchRepoToken(jobID, repoURL string, stderr io.Writer) GitToken {
	if strings.TrimSpace(repoURL) == "" {
		return GitToken{}
	}
	token, err := w.api.FetchGitToken(jobID, repoURL)
	if err != nil {
		fmt.Fprintf(stderr, "Warning: failed to fetch git token for the repo on host %s: %v\n", provisioner.RepoHostForLog(repoURL), err)
		return GitToken{}
	}
	return token
}

// deployGitTokens resolves the git tokens a DEPLOY needs, one request per distinct repo:
//   - appsToken is the token for the apps-destination repo (DeployParams.GitAccessToken). The
//     snapshot's own git_access_token is not read: the console always writes it empty, and a
//     token there would not be scoped to any one repo;
//   - repoTokens maps the BYO IaC module repo and each BYO git chart repo to its own token
//     (DeployParams.GitRepoTokens). A repo with no token has no entry;
//   - providers maps every repo that got a token, the apps repo included, to the provider the
//     console named for it (ProjectConfig.GitProviders), which picks the username sent with it.
func (w *Runner) deployGitTokens(jobID string, vc *types.ProjectConfig, stderr io.Writer) (appsToken string, repoTokens, providers map[string]string) {
	fetched := map[string]GitToken{}
	providers = map[string]string{}
	tokenFor := func(repo string) string {
		if t, done := fetched[repo]; done {
			return t.Token
		}
		t := w.fetchRepoToken(jobID, repo, stderr)
		fetched[repo] = t
		if t.Token != "" && t.Provider != "" {
			providers[repo] = t.Provider
		}
		return t.Token
	}

	appsToken = tokenFor(vc.Repositories.AppsDestinationRepo)

	repoTokens = map[string]string{}
	add := func(repo string) {
		if repo == "" {
			return
		}
		if t := tokenFor(repo); t != "" {
			repoTokens[repo] = t
		}
	}
	if vc.IacSource != nil {
		add(vc.IacSource.RepoURL)
	}
	for i := range vc.AddOns {
		if vc.AddOns[i].IsGitSource() {
			add(vc.AddOns[i].ChartRepo)
		}
	}
	return appsToken, repoTokens, providers
}

// iacRepoTokens is the GitRepoTokens a PLAN needs: the BYO IaC module repo's own token, or an
// empty map when the plan clones no customer module (a bundled-template plan touches no repo).
// providers maps that repo to the provider the console named for its token, as in deployGitTokens.
func (w *Runner) iacRepoTokens(jobID string, vc *types.ProjectConfig, stderr io.Writer) (tokens, providers map[string]string) {
	tokens, providers = map[string]string{}, map[string]string{}
	if vc.IacSource == nil {
		return tokens, providers
	}
	if t := w.fetchRepoToken(jobID, vc.IacSource.RepoURL, stderr); t.Token != "" {
		tokens[vc.IacSource.RepoURL] = t.Token
		if t.Provider != "" {
			providers[vc.IacSource.RepoURL] = t.Provider
		}
	}
	return tokens, providers
}
