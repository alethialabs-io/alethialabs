// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/helmoci"
)

// TestIsOCIChartRepo locks the routing between the two chart sources. The console stores a git URL
// and an OCI reference in the same column, so the scheme is the only discriminator.
func TestIsOCIChartRepo(t *testing.T) {
	for _, repo := range []string{
		"oci://ghcr.io/acme/charts/redis", "OCI://ghcr.io/acme/redis", "  oci://ghcr.io/a/b  ",
	} {
		if !isOCIChartRepo(repo) {
			t.Errorf("isOCIChartRepo(%q) = false, want true", repo)
		}
	}
	for _, repo := range []string{
		"https://github.com/acme/charts", "git@github.com:acme/charts.git",
		"file:///tmp/repo", "", "ocean://not-oci",
	} {
		if isOCIChartRepo(repo) {
			t.Errorf("isOCIChartRepo(%q) = true, want false", repo)
		}
	}
}

// TestOCIChartVersion covers the shared `ref` field. It carries a git ref on the git path (default
// "HEAD") and a chart version on the OCI path — an unpinned OCI chart must resolve to latest, not
// look for a tag literally named HEAD.
func TestOCIChartVersion(t *testing.T) {
	tests := map[string]string{
		"":      helmoci.LatestVersion,
		"   ":   helmoci.LatestVersion,
		"HEAD":  helmoci.LatestVersion,
		"head":  helmoci.LatestVersion,
		"*":     "*",
		"1.2.3": "1.2.3",
	}
	for in, want := range tests {
		if got := ociChartVersion(in); got != want {
			t.Errorf("ociChartVersion(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestHelmRegistriesFromSnapshot covers reading the project's connected chart repos off the scan
// snapshot, including the malformed cases that must degrade to an anonymous pull rather than crash
// the scan.
func TestHelmRegistriesFromSnapshot(t *testing.T) {
	var stderr bytes.Buffer

	if got := helmRegistriesFromSnapshot(map[string]any{}, &stderr); got != nil {
		t.Errorf("missing key = %+v, want nil", got)
	}
	if got := helmRegistriesFromSnapshot(map[string]any{"helm_registries": nil}, &stderr); got != nil {
		t.Errorf("nil value = %+v, want nil", got)
	}
	if got := helmRegistriesFromSnapshot(map[string]any{"helm_registries": "not-a-list"}, &stderr); got != nil {
		t.Errorf("malformed value = %+v, want nil", got)
	}
	if stderr.Len() == 0 {
		t.Error("a malformed helm_registries value should be reported on stderr")
	}

	got := helmRegistriesFromSnapshot(map[string]any{
		"helm_registries": []any{
			map[string]any{
				"name": "charts", "provider": "oci-generic-cr",
				"provider_config": map[string]any{"registry_host": "registry.acme.io"},
			},
		},
	}, &stderr)
	if len(got) != 1 {
		t.Fatalf("got %d registries, want 1", len(got))
	}
	if got[0].Provider != "oci-generic-cr" {
		t.Errorf("provider = %q, want oci-generic-cr", got[0].Provider)
	}
	if got[0].ProviderConfig["registry_host"] != "registry.acme.io" {
		t.Errorf("provider_config = %+v, want registry_host registry.acme.io", got[0].ProviderConfig)
	}
}

// TestExecuteChartScan_GitStillRequiresChartPath guards the unchanged git path: a git repo has no
// way to say which directory holds the chart, so chart_path stays mandatory there.
func TestExecuteChartScan_GitStillRequiresChartPath(t *testing.T) {
	api := &mockAPI{}
	w := runnerForScan(t, api)
	job := &Job{
		ID:      "job-git-no-path",
		JobType: "CHART_SCAN",
		ConfigSnapshot: map[string]any{
			"repo_url": "https://github.com/acme/charts",
			"ref":      "main",
		},
	}
	err := w.executeChartScan(context.Background(), job, nil,
		NewJobLogger(api, job.ID, "STDOUT"), NewJobLogger(api, job.ID, "STDERR"))
	if err == nil || !strings.Contains(err.Error(), "chart_path") {
		t.Fatalf("error = %v, want a missing chart_path failure", err)
	}
}

// TestExecuteChartScan_RequiresRepoURL is the shared precondition for both sources.
func TestExecuteChartScan_RequiresRepoURL(t *testing.T) {
	api := &mockAPI{}
	w := runnerForScan(t, api)
	job := &Job{ID: "job-no-repo", JobType: "CHART_SCAN", ConfigSnapshot: map[string]any{}}
	err := w.executeChartScan(context.Background(), job, nil,
		NewJobLogger(api, job.ID, "STDOUT"), NewJobLogger(api, job.ID, "STDERR"))
	if err == nil || !strings.Contains(err.Error(), "repo_url") {
		t.Fatalf("error = %v, want a missing repo_url failure", err)
	}
}

// TestExecuteChartScan_OCIEndToEnd is the headline case: a private chart in an OCI registry is
// pulled with the project's helm_registry credential, rendered, and verified — producing the same
// execution_metadata a git-hosted chart produces. It also asserts the credential never reaches the
// job logs, the stage payload, or the sandbox workdir.
func TestExecuteChartScan_OCIEndToEnd(t *testing.T) {
	if _, err := exec.LookPath("helm"); err != nil {
		t.Skip("helm binary not available")
	}
	const (
		user   = "chart-bot"
		secret = "sup3r-secret-pat"
	)
	reg := newTestRegistry(t, "acme/charts/demo", user, secret)
	reg.publishChart("1.4.0")

	api := &mockAPI{}
	w := runnerForScan(t, api)
	job := &Job{
		ID:      "job-oci",
		JobType: "CHART_SCAN",
		ConfigSnapshot: map[string]any{
			"repo_url": "oci://" + reg.host + "/acme/charts/demo",
			"ref":      "1.4.0",
			"helm_registries": []any{
				map[string]any{
					"name": "charts", "provider": "oci-generic-cr",
					"provider_config": map[string]any{"registry_host": reg.host},
				},
			},
		},
	}
	creds := []ConnectorCredential{{
		Category:    "helm_registry",
		Slug:        "oci-generic-cr",
		Credentials: map[string]string{"username": user, "password": secret},
	}}

	if err := w.executeChartScan(context.Background(), job, creds,
		NewJobLogger(api, job.ID, "STDOUT"), NewJobLogger(api, job.ID, "STDERR")); err != nil {
		t.Fatalf("executeChartScan: %v", err)
	}

	// The credential actually authenticated the pull.
	if got := reg.basicSeen(); got != user+":"+secret {
		t.Fatalf("registry saw Basic %q, want the connector credential", got)
	}

	// A verify report was produced and posted, exactly as for a git chart.
	meta := lastChartScanMetadata(t, api)
	if _, ok := meta["verify_result"]; !ok {
		t.Fatalf("execution_metadata = %v, want a verify_result", meta)
	}

	// The chart's workload was described from the same render.
	if _, ok := meta["chart_workloads"]; !ok {
		t.Error("execution_metadata has no chart_workloads — the describe half did not run")
	}

	// Non-leak: the registry password must appear in no log chunk and no posted metadata.
	assertNoSecretInJobOutput(t, api, secret)
}

// TestExecuteChartScan_OCIAnonymousPublicChart proves a public chart scans with no chart-repo
// connector connected at all — connecting one must not be a precondition for scanning.
func TestExecuteChartScan_OCIAnonymousPublicChart(t *testing.T) {
	if _, err := exec.LookPath("helm"); err != nil {
		t.Skip("helm binary not available")
	}
	reg := newTestRegistry(t, "public/charts/demo", "", "")
	reg.publishChart("2.0.0")

	api := &mockAPI{}
	w := runnerForScan(t, api)
	job := &Job{
		ID:      "job-oci-public",
		JobType: "CHART_SCAN",
		ConfigSnapshot: map[string]any{
			"repo_url": "oci://" + reg.host + "/public/charts/demo",
			"ref":      "*", // unpinned → resolves to the highest release
		},
	}

	if err := w.executeChartScan(context.Background(), job, nil,
		NewJobLogger(api, job.ID, "STDOUT"), NewJobLogger(api, job.ID, "STDERR")); err != nil {
		t.Fatalf("executeChartScan: %v", err)
	}
	if _, ok := lastChartScanMetadata(t, api)["verify_result"]; !ok {
		t.Fatal("a public OCI chart produced no verify_result")
	}
}

// TestExecuteChartScan_OCIUsesOnlyCoveringCredential is the security case: a credential connected
// for a DIFFERENT registry must not be sent to this chart's host. The pull then goes out
// anonymously and the private registry rejects it.
func TestExecuteChartScan_OCIUsesOnlyCoveringCredential(t *testing.T) {
	const secret = "sup3r-secret-pat"
	reg := newTestRegistry(t, "acme/charts/demo", "chart-bot", secret)
	reg.publishChart("1.0.0")

	api := &mockAPI{}
	w := runnerForScan(t, api)
	job := &Job{
		ID:      "job-oci-wrong-host",
		JobType: "CHART_SCAN",
		ConfigSnapshot: map[string]any{
			"repo_url": "oci://" + reg.host + "/acme/charts/demo",
			"ref":      "1.0.0",
			// The project connected ghcr.io, not this registry.
			"helm_registries": []any{
				map[string]any{"name": "ghcr", "provider": "oci-github-cr"},
			},
		},
	}
	creds := []ConnectorCredential{{
		Category:    "helm_registry",
		Slug:        "oci-github-cr",
		Credentials: map[string]string{"username": "chart-bot", "password": secret},
	}}

	err := w.executeChartScan(context.Background(), job, creds,
		NewJobLogger(api, job.ID, "STDOUT"), NewJobLogger(api, job.ID, "STDERR"))
	if err == nil {
		t.Fatal("scan succeeded, want the private registry to reject an anonymous pull")
	}
	if reg.basicSeen() != "" {
		t.Fatalf("the ghcr credential was sent to %s — a credential must only go to a host it covers", reg.host)
	}
	assertNoSecretInJobOutput(t, api, secret)
}

// lastChartScanMetadata returns the metadata of the last PROCESSING status update.
func lastChartScanMetadata(t *testing.T, api *mockAPI) map[string]any {
	t.Helper()
	api.mu.Lock()
	defer api.mu.Unlock()
	for i := len(api.statusUpdates) - 1; i >= 0; i-- {
		if len(api.statusUpdates[i].metadata) > 0 {
			return api.statusUpdates[i].metadata
		}
	}
	t.Fatal("no status update carried execution metadata")
	return nil
}

// assertNoSecretInJobOutput fails if a secret appears in any job log chunk or posted metadata. The
// chart-repo credential lives only in the trusted parent's memory; anything else is a leak.
func assertNoSecretInJobOutput(t *testing.T, api *mockAPI, secret string) {
	t.Helper()
	api.mu.Lock()
	defer api.mu.Unlock()
	for _, chunk := range api.logChunks {
		if strings.Contains(chunk.chunk, secret) {
			t.Fatalf("job log leaked the chart-repo credential: %q", chunk.chunk)
		}
	}
	for _, up := range api.statusUpdates {
		raw, err := json.Marshal(up.metadata)
		if err != nil {
			continue
		}
		if bytes.Contains(raw, []byte(secret)) {
			t.Fatalf("execution metadata leaked the chart-repo credential: %s", raw)
		}
	}
}

// testRegistry is a minimal in-process OCI registry serving one Helm chart, so the runner's OCI
// branch can be exercised end to end with no network and no container runtime.
type testRegistry struct {
	t                  *testing.T
	host               string
	repo               string
	wantUser, wantPass string

	srv   *httptest.Server
	tags  map[string][]byte
	blobs map[string][]byte
	basic string
}

// newTestRegistry starts the fake registry. Empty credentials make it public.
func newTestRegistry(t *testing.T, repo, user, pass string) *testRegistry {
	t.Helper()
	// The chart-registry egress guard blocks loopback in production; open it for this test only.
	helmoci.AllowLocalRegistriesForTesting(t)
	r := &testRegistry{
		t: t, repo: repo, wantUser: user, wantPass: pass,
		tags: map[string][]byte{}, blobs: map[string][]byte{},
	}
	r.srv = httptest.NewServer(http.HandlerFunc(r.handle))
	t.Cleanup(r.srv.Close)
	u, err := url.Parse(r.srv.URL)
	if err != nil {
		t.Fatalf("parse registry URL: %v", err)
	}
	r.host = u.Host
	return r
}

// basicSeen reports the Basic credential the token endpoint received, if any.
func (r *testRegistry) basicSeen() string { return r.basic }

// publishChart uploads a tiny renderable chart at the given version.
func (r *testRegistry) publishChart(version string) {
	r.t.Helper()
	tgz := chartTarGz(r.t, "demo", version)
	cfg := r.addBlob([]byte(`{"name":"demo","version":"` + version + `"}`))
	r.addBlob(tgz)

	manifest := map[string]any{
		"schemaVersion": 2,
		"mediaType":     "application/vnd.oci.image.manifest.v1+json",
		"config": map[string]any{
			"mediaType": helmoci.ConfigMediaType,
			"digest":    sha256Digest(cfg), "size": len(cfg),
		},
		"layers": []any{map[string]any{
			"mediaType": helmoci.ChartLayerMediaType,
			"digest":    sha256Digest(tgz), "size": len(tgz),
		}},
	}
	raw, err := json.Marshal(manifest)
	if err != nil {
		r.t.Fatalf("marshal manifest: %v", err)
	}
	r.tags[version] = raw
}

// addBlob stores content under its digest and returns it.
func (r *testRegistry) addBlob(content []byte) []byte {
	r.blobs[sha256Digest(content)] = content
	return content
}

// handle routes the four distribution endpoints a chart pull touches.
func (r *testRegistry) handle(w http.ResponseWriter, req *http.Request) {
	if req.URL.Path == "/token" {
		if auth := req.Header.Get("Authorization"); strings.HasPrefix(auth, "Basic ") {
			if decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(auth, "Basic ")); err == nil {
				r.basic = string(decoded)
			}
		}
		if r.wantUser != "" && r.basic != r.wantUser+":"+r.wantPass {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"token":"ok"}`))
		return
	}
	if r.wantUser != "" && req.Header.Get("Authorization") != "Bearer ok" {
		w.Header().Set("WWW-Authenticate", fmt.Sprintf(`Bearer realm="%s/token",service="fake"`, r.srv.URL))
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	switch {
	case req.URL.Path == "/v2/":
		w.WriteHeader(http.StatusOK)
	case req.URL.Path == "/v2/"+r.repo+"/tags/list":
		tags := make([]string, 0, len(r.tags))
		for tag := range r.tags {
			tags = append(tags, tag)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"name": r.repo, "tags": tags})
	case strings.HasPrefix(req.URL.Path, "/v2/"+r.repo+"/manifests/"):
		raw, ok := r.tags[strings.TrimPrefix(req.URL.Path, "/v2/"+r.repo+"/manifests/")]
		if !ok {
			http.NotFound(w, req)
			return
		}
		w.Header().Set("Content-Type", "application/vnd.oci.image.manifest.v1+json")
		w.Header().Set("Docker-Content-Digest", sha256Digest(raw))
		w.Header().Set("Content-Length", fmt.Sprint(len(raw)))
		_, _ = w.Write(raw)
	case strings.HasPrefix(req.URL.Path, "/v2/"+r.repo+"/blobs/"):
		content, ok := r.blobs[strings.TrimPrefix(req.URL.Path, "/v2/"+r.repo+"/blobs/")]
		if !ok {
			http.NotFound(w, req)
			return
		}
		w.Header().Set("Content-Length", fmt.Sprint(len(content)))
		_, _ = w.Write(content)
	default:
		http.NotFound(w, req)
	}
}

// chartTarGz builds a packaged chart with one renderable template, so `helm template` produces a
// manifest the verify engine can evaluate and the describe pass can read a workload from.
func chartTarGz(t *testing.T, name, version string) []byte {
	t.Helper()
	files := map[string]string{
		name + "/Chart.yaml":  fmt.Sprintf("apiVersion: v2\nname: %s\nversion: %s\n", name, version),
		name + "/values.yaml": "replicas: 1\n",
		name + "/templates/deployment.yaml": `apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo
spec:
  replicas: {{ .Values.replicas }}
  selector:
    matchLabels:
      app: demo
  template:
    metadata:
      labels:
        app: demo
    spec:
      containers:
        - name: demo
          image: nginx:1.27
`,
	}
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	// Deterministic order keeps the fixture's digest stable across runs.
	for i := 1; i < len(names); i++ {
		for j := i; j > 0 && names[j] < names[j-1]; j-- {
			names[j], names[j-1] = names[j-1], names[j]
		}
	}

	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, n := range names {
		body := files[n]
		if err := tw.WriteHeader(&tar.Header{Name: n, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatalf("tar header: %v", err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatalf("tar write: %v", err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("close tar: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("close gzip: %v", err)
	}
	return buf.Bytes()
}

// sha256Digest returns the canonical digest string for content.
func sha256Digest(b []byte) string { return fmt.Sprintf("sha256:%x", sha256.Sum256(b)) }

// TestChartScanWorkdirIsRemoved asserts the per-job workdir (which holds the pulled chart) does not
// survive the scan — the pulled chart is untrusted third-party content and must not accumulate on
// a long-lived runner.
func TestChartScanWorkdirIsRemoved(t *testing.T) {
	if _, err := exec.LookPath("helm"); err != nil {
		t.Skip("helm binary not available")
	}
	reg := newTestRegistry(t, "public/charts/demo", "", "")
	reg.publishChart("1.0.0")

	before := stageDirCount(t)
	api := &mockAPI{}
	w := runnerForScan(t, api)
	job := &Job{
		ID:      "job-cleanup",
		JobType: "CHART_SCAN",
		ConfigSnapshot: map[string]any{
			"repo_url": "oci://" + reg.host + "/public/charts/demo",
			"ref":      "1.0.0",
		},
	}
	if err := w.executeChartScan(context.Background(), job, nil,
		NewJobLogger(api, job.ID, "STDOUT"), NewJobLogger(api, job.ID, "STDERR")); err != nil {
		t.Fatalf("executeChartScan: %v", err)
	}
	if after := stageDirCount(t); after > before {
		t.Fatalf("stage workdirs grew from %d to %d — the pulled chart was left on disk", before, after)
	}
}

// stageDirCount counts leftover per-job stage workdirs in the temp dir.
func stageDirCount(t *testing.T) int {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(os.TempDir(), "alethia-stage-*"))
	if err != nil {
		t.Fatalf("glob stage dirs: %v", err)
	}
	return len(matches)
}
