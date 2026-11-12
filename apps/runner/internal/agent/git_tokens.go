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

// fetchRepoToken requests the job owner's git token for exactly repoURL. It returns "" (and makes
// no request) for an empty repo, and "" with a warning naming only the repo's host when the
// console refuses or the request fails: the caller then clones without a credential.
func (w *Runner) fetchRepoToken(jobID, repoURL string, stderr io.Writer) string {
	if strings.TrimSpace(repoURL) == "" {
		return ""
	}
	token, err := w.api.FetchGitToken(jobID, repoURL)
	if err != nil {
		fmt.Fprintf(stderr, "Warning: failed to fetch git token for the repo on host %s: %v\n", provisioner.RepoHostForLog(repoURL), err)
		return ""
	}
	return token
}

// deployGitTokens resolves the git tokens a DEPLOY needs, one request per distinct repo:
//   - appsToken is the token for the apps-destination repo (DeployParams.GitAccessToken) — a
//     token the snapshot already carries wins, as before;
//   - repoTokens maps the BYO IaC module repo and each BYO git chart repo to its own token
//     (DeployParams.GitRepoTokens). A repo with no token has no entry.
func (w *Runner) deployGitTokens(jobID string, vc *types.ProjectConfig, stderr io.Writer) (appsToken string, repoTokens map[string]string) {
	fetched := map[string]string{}
	tokenFor := func(repo string) string {
		if t, done := fetched[repo]; done {
			return t
		}
		t := w.fetchRepoToken(jobID, repo, stderr)
		fetched[repo] = t
		return t
	}

	appsToken = vc.GitAccessToken
	if appsToken == "" {
		appsToken = tokenFor(vc.Repositories.AppsDestinationRepo)
	}

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
	return appsToken, repoTokens
}

// iacRepoTokens is the GitRepoTokens a PLAN needs: the BYO IaC module repo's own token, or an
// empty map when the plan clones no customer module (a bundled-template plan touches no repo).
func (w *Runner) iacRepoTokens(jobID string, vc *types.ProjectConfig, stderr io.Writer) map[string]string {
	out := map[string]string{}
	if vc.IacSource == nil {
		return out
	}
	if t := w.fetchRepoToken(jobID, vc.IacSource.RepoURL, stderr); t != "" {
		out[vc.IacSource.RepoURL] = t
	}
	return out
}
