// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// Pins #6611: every runner path that clones or pushes asks the console for a git token NAMING the
// repo it will use it for, and uses each token for that repo alone. A request with an empty repo is
// the old "one token for the whole job" request, so every test also asserts none was made.

const (
	tokAppsRepo  = "https://github.com/acme/apps.git"
	tokIacRepo   = "https://bitbucket.org/acme/infra.git"
	tokChartRepo = "https://code.acme.example/acme/chart.git"
	// tokUnreachable is a repo no clone can reach, so the scan paths stop right after the token
	// request. Its path is a canary: a log line that prints it printed more than the host.
	tokUnreachable = "https://127.0.0.1:9/acme/canary-path-5d1e.git"
)

// tokenRecorder answers every git-token request with a token derived from the repo it names, and
// records each repo asked for.
type tokenRecorder struct {
	mu    sync.Mutex
	repos []string
}

// fn is the covRunAPI.gitTokenFn hook.
func (r *tokenRecorder) fn(_ string, repo string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.repos = append(r.repos, repo)
	return "token-for:" + repo, nil
}

// asked returns the repos requested so far.
func (r *tokenRecorder) asked() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.repos...)
}

// assertNoUnnamedRequest fails when any git-token request named no repo.
func assertNoUnnamedRequest(t *testing.T, repos []string) {
	t.Helper()
	for _, r := range repos {
		if r == "" {
			t.Errorf("a git-token request named no repo (requests: %q)", repos)
		}
	}
}

// joinedLogs is every log chunk the mock received. Close the loggers first.
func joinedLogs(api *covRunAPI) string {
	var b strings.Builder
	for _, c := range api.getLogChunks() {
		b.WriteString(c.chunk)
	}
	return b.String()
}

// TestDeploy_RequestsATokenPerRepoAndUsesEachForItsOwnRepo: a BYO IaC deploy with an apps repo and
// two git charts (one of them on the apps repo) asks once per distinct repo, each by name, and hands
// the sandbox the apps repo's token as GitToken and every other repo's own token in GitTokens.
func TestDeploy_RequestsATokenPerRepoAndUsesEachForItsOwnRepo(t *testing.T) {
	rec := &tokenRecorder{}
	api := newCovRunAPI()
	api.gitTokenFn = rec.fn
	sb := &covRunSandbox{}
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-tokens"}, api)
	w.sandbox = sb

	snap := covRunSnapshot()
	snap["repositories"] = map[string]any{"apps_destination_repo": tokAppsRepo}
	snap["iac_source"] = map[string]any{"repo_url": tokIacRepo, "commit_sha": "abc123"}
	snap["addons"] = []any{
		map[string]any{"id": "c1", "source": "git", "chartRepo": tokChartRepo},
		map[string]any{"id": "c2", "source": "git", "chartRepo": tokAppsRepo},
		map[string]any{"id": "c3", "source": "git", "chartRepo": tokChartRepo},
	}
	stdout := NewJobLogger(api, "tok-deploy", "STDOUT")
	stderr := NewJobLogger(api, "tok-deploy", "STDERR")
	err := w.executeDeploy(t.Context(), &Job{ID: "tok-deploy", JobType: string(types.JobTypeDeploy), ConfigSnapshot: snap}, "aws", nil, nil, stdout, stderr)
	stdout.Close()
	stderr.Close()
	if err != nil {
		t.Fatalf("deploy: %v", err)
	}

	asked := rec.asked()
	assertNoUnnamedRequest(t, asked)
	if want := []string{tokAppsRepo, tokIacRepo, tokChartRepo}; !reflect.DeepEqual(asked, want) {
		t.Errorf("requested repos = %q, want one request per distinct repo: %q", asked, want)
	}
	got := childSecrets(t, sb.lastSpec())
	if got.GitToken != "token-for:"+tokAppsRepo {
		t.Errorf("GitToken = %q, want the apps repo's own token", got.GitToken)
	}
	want := map[string]string{
		tokIacRepo:   "token-for:" + tokIacRepo,
		tokChartRepo: "token-for:" + tokChartRepo,
		tokAppsRepo:  "token-for:" + tokAppsRepo,
	}
	if !reflect.DeepEqual(got.GitTokens, want) {
		t.Errorf("GitTokens = %v, want each repo mapped to its own token: %v", got.GitTokens, want)
	}
}

// TestDeploy_IgnoresASnapshotGitToken: a token on the snapshot's git_access_token is not used for
// the apps repo in place of the one requested for it by name.
func TestDeploy_IgnoresASnapshotGitToken(t *testing.T) {
	rec := &tokenRecorder{}
	api := newCovRunAPI()
	api.gitTokenFn = rec.fn
	sb := &covRunSandbox{}
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-tokens"}, api)
	w.sandbox = sb

	snap := covRunSnapshot()
	snap["repositories"] = map[string]any{"apps_destination_repo": tokAppsRepo}
	snap["git_access_token"] = "frozen-snapshot-token"
	stdout := NewJobLogger(api, "tok-snap", "STDOUT")
	stderr := NewJobLogger(api, "tok-snap", "STDERR")
	err := w.executeDeploy(t.Context(), &Job{ID: "tok-snap", JobType: string(types.JobTypeDeploy), ConfigSnapshot: snap}, "aws", nil, nil, stdout, stderr)
	stdout.Close()
	stderr.Close()
	if err != nil {
		t.Fatalf("deploy: %v", err)
	}
	if asked := rec.asked(); !reflect.DeepEqual(asked, []string{tokAppsRepo}) {
		t.Errorf("requested repos = %q, want one request naming the apps repo", asked)
	}
	if got := childSecrets(t, sb.lastSpec()).GitToken; got != "token-for:"+tokAppsRepo {
		t.Errorf("GitToken = %q, want the token requested for the apps repo", got)
	}
}

// TestPlan_RequestsOnlyTheIacModulesToken: a BYO IaC plan asks for the module repo's token by name
// and carries it in GitTokens only; the apps repo, which a plan never touches, is not asked for.
func TestPlan_RequestsOnlyTheIacModulesToken(t *testing.T) {
	rec := &tokenRecorder{}
	api := newCovRunAPI()
	api.gitTokenFn = rec.fn
	sb := &covRunSandbox{}
	w := NewWithAPI(Config{Operator: "self"}, api)
	w.sandbox = sb

	snap := covRunSnapshot()
	snap["repositories"] = map[string]any{"apps_destination_repo": tokAppsRepo}
	snap["iac_source"] = map[string]any{"repo_url": tokIacRepo, "commit_sha": "abc123"}
	stdout := NewJobLogger(api, "tok-plan", "STDOUT")
	stderr := NewJobLogger(api, "tok-plan", "STDERR")
	err := w.executePlan(t.Context(), &Job{ID: "tok-plan", ConfigSnapshot: snap}, "", nil, nil, stdout, stderr)
	stdout.Close()
	stderr.Close()
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if asked := rec.asked(); !reflect.DeepEqual(asked, []string{tokIacRepo}) {
		t.Errorf("requested repos = %q, want only the IaC module repo", asked)
	}
	got := childSecrets(t, sb.lastSpec())
	if got.GitToken != "" {
		t.Errorf("GitToken = %q, want none: a plan clones no apps repo", got.GitToken)
	}
	if want := map[string]string{tokIacRepo: "token-for:" + tokIacRepo}; !reflect.DeepEqual(got.GitTokens, want) {
		t.Errorf("GitTokens = %v, want %v", got.GitTokens, want)
	}
}

// TestDrift_RequestsTheIacModulesTokenByName: BYO drift clones only the module, and names it.
func TestDrift_RequestsTheIacModulesTokenByName(t *testing.T) {
	api := covDriftNewAPI()
	sb := &covDriftSandbox{resultJSON: covDriftPostureResult}
	w := covDriftRunner(t, api, "self", sb)
	out, errl := covDriftLoggers(t, api)

	vc := types.ProjectConfig{
		IacSource:    &types.ProjectIacSourceConfig{RepoURL: tokIacRepo, CommitSHA: "a"},
		Repositories: types.ProjectRepositoriesConfig{AppsDestinationRepo: tokAppsRepo},
	}
	if err := w.executeDriftDetection(context.Background(), covDriftJob(covDriftSnapshot(t, vc)), "aws", nil, out, errl); err != nil {
		t.Fatalf("drift: %v", err)
	}
	if !reflect.DeepEqual(api.gitTokenRepos, []string{tokIacRepo}) {
		t.Errorf("requested repos = %q, want only the IaC module repo", api.gitTokenRepos)
	}
}

// scanCase is one scan-style path: it requests a token for its target repo and then clones it.
type scanCase struct {
	name string
	run  func(w *Runner, api *covRunAPI, stdout, stderr *JobLogger) error
}

// TestScanPaths_RequestTheTargetReposTokenAndLogItsHostOnly covers CHART_SCAN, IAC_SCAN,
// ANALYZE_REPO and a BUILD's commit pin: each names its target repo in the token request, and
// its log lines print the repo's host, never its path or URL.
func TestScanPaths_RequestTheTargetReposTokenAndLogItsHostOnly(t *testing.T) {
	cases := []scanCase{
		{"CHART_SCAN", func(w *Runner, _ *covRunAPI, stdout, stderr *JobLogger) error {
			job := &Job{ID: "tok-scan", JobType: "CHART_SCAN", ConfigSnapshot: map[string]any{"chart_path": "charts/api"}}
			_, err := w.fetchGitChart(t.Context(), job, tokUnreachable, "main", t.TempDir(), stdout, stderr)
			return err
		}},
		{"IAC_SCAN", func(w *Runner, _ *covRunAPI, stdout, stderr *JobLogger) error {
			job := &Job{ID: "tok-scan", JobType: "IAC_SCAN", ConfigSnapshot: map[string]any{"repo_url": tokUnreachable, "ref": "main"}}
			return w.executeIacScan(t.Context(), job, stdout, stderr)
		}},
		{"ANALYZE_REPO", func(w *Runner, _ *covRunAPI, stdout, stderr *JobLogger) error {
			job := &Job{ID: "tok-scan", JobType: "ANALYZE_REPO", ConfigSnapshot: map[string]any{"repo_url": tokUnreachable}}
			return w.executeAnalyzeRepo(t.Context(), job, stdout, stderr)
		}},
		{"BUILD", func(w *Runner, _ *covRunAPI, _, stderr *JobLogger) error {
			_, err := w.resolveHeadSHA(t.Context(), "tok-scan", tokUnreachable, stderr)
			return err
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("ALETHIA_SANDBOX_BACKEND", "")
			t.Setenv("ALETHIA_SANDBOX_ENFORCE_MANAGED", "")
			rec := &tokenRecorder{}
			api := newCovRunAPI()
			api.gitTokenFn = rec.fn
			w := NewWithAPI(Config{Operator: "self"}, api)
			w.sandbox = &covRunSandbox{}
			stdout := NewJobLogger(api, "tok-scan", "STDOUT")
			stderr := NewJobLogger(api, "tok-scan", "STDERR")
			err := tc.run(w, api, stdout, stderr)
			stdout.Close()
			stderr.Close()
			if err == nil {
				t.Fatal("the clone of an unreachable repo succeeded; the test repo is not unreachable")
			}
			if asked := rec.asked(); !reflect.DeepEqual(asked, []string{tokUnreachable}) {
				t.Errorf("requested repos = %q, want exactly the target repo", asked)
			}
			if logs := joinedLogs(api); strings.Contains(logs, "canary-path-5d1e") {
				t.Errorf("a log line printed the repo path, not just its host: %q", logs)
			}
		})
	}
}

// TestFetchRepoToken_WarnsWithTheHostOnly: a refused request is a warning naming the host (or the
// placeholder when there is none to read), and is answered with no token; an empty repo makes no
// request at all.
func TestFetchRepoToken_WarnsWithTheHostOnly(t *testing.T) {
	var asked []string
	api := newCovRunAPI()
	api.gitTokenFn = func(_ string, repo string) (string, error) {
		asked = append(asked, repo)
		return "", errors.New("refused")
	}
	w := NewWithAPI(Config{Operator: "self"}, api)

	var errOut strings.Builder
	if got := w.fetchRepoToken("j", "https://user:pw@github.com/acme/apps.git", &errOut); got != "" {
		t.Errorf("token = %q after a refusal, want none", got)
	}
	if got := w.fetchRepoToken("j", "git@tok-5d1e@evil.example:acme/apps.git", &errOut); got != "" {
		t.Errorf("token = %q after a refusal, want none", got)
	}
	if got := w.fetchRepoToken("j", "", &errOut); got != "" {
		t.Errorf("token = %q for an empty repo, want none", got)
	}
	if len(asked) != 2 {
		t.Errorf("requests = %q, want two (an empty repo makes no request)", asked)
	}
	warn := errOut.String()
	if !strings.Contains(warn, "on host github.com: refused") || !strings.Contains(warn, "on host (unparsed repo URL): refused") {
		t.Errorf("warnings = %q, want the host, then the placeholder", warn)
	}
	for _, leak := range []string{"pw@", "acme/apps", "tok-5d1e", "evil.example"} {
		if strings.Contains(warn, leak) {
			t.Errorf("warnings = %q, printed %q from the repo URL", warn, leak)
		}
	}
}
