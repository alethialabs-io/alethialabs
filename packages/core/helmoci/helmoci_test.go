// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package helmoci

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestParseChartRef locks the reference grammar. It is the first thing a hostile or fat-fingered
// chart_repo value hits, so each rejection is asserted individually rather than as "some error".
func TestParseChartRef(t *testing.T) {
	tests := []struct {
		name     string
		repo     string
		version  string
		wantHost string
		wantRepo string
		wantVer  string
		wantErr  string
	}{
		{
			name: "namespaced chart", repo: "oci://ghcr.io/acme/charts/redis", version: "1.2.3",
			wantHost: "ghcr.io", wantRepo: "acme/charts/redis", wantVer: "1.2.3",
		},
		{
			name: "host with port", repo: "oci://registry.acme.io:5000/team/app", version: "0.1.0",
			wantHost: "registry.acme.io:5000", wantRepo: "team/app", wantVer: "0.1.0",
		},
		{
			name: "empty version becomes latest", repo: "oci://ghcr.io/acme/redis", version: "",
			wantHost: "ghcr.io", wantRepo: "acme/redis", wantVer: LatestVersion,
		},
		{
			name: "explicit star stays latest", repo: "oci://ghcr.io/acme/redis", version: "*",
			wantHost: "ghcr.io", wantRepo: "acme/redis", wantVer: LatestVersion,
		},
		{
			name: "uppercase host is normalised", repo: "oci://GHCR.IO/acme/redis", version: "1.0.0",
			wantHost: "ghcr.io", wantRepo: "acme/redis", wantVer: "1.0.0",
		},
		{name: "https is not OCI", repo: "https://charts.acme.io", wantErr: "not an OCI chart reference"},
		{name: "git URL is not OCI", repo: "git@github.com:acme/charts.git", wantErr: "not an OCI chart reference"},
		{name: "no chart segment", repo: "oci://ghcr.io", wantErr: "no repository path"},
		{name: "trailing slash only", repo: "oci://ghcr.io/", wantErr: "no repository path"},
		{name: "inline credentials", repo: "oci://user:pw@ghcr.io/acme/redis", wantErr: "must not embed credentials"},
		{name: "query string", repo: "oci://ghcr.io/acme/redis?a=b", wantErr: "query or fragment"},
		{name: "fragment", repo: "oci://ghcr.io/acme/redis#frag", wantErr: "query or fragment"},
		{name: "uppercase repository", repo: "oci://ghcr.io/Acme/Redis", wantErr: "must be lowercase"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseChartRef(tc.repo, tc.version)
			if tc.wantErr != "" {
				if err == nil {
					t.Fatalf("ParseChartRef(%q) = %+v, want error containing %q", tc.repo, got, tc.wantErr)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("error = %v, want it to contain %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.Registry != tc.wantHost || got.Repository != tc.wantRepo || got.Version != tc.wantVer {
				t.Fatalf("got %+v, want host=%s repo=%s version=%s", got, tc.wantHost, tc.wantRepo, tc.wantVer)
			}
		})
	}
}

// TestRefString locks the canonical form, which must equal the URL a helm_registry connector's
// RepoCred produces — ArgoCD and the scan have to agree on the same string.
func TestRefString(t *testing.T) {
	ref, err := ParseChartRef("oci://ghcr.io/acme/charts/redis", "1.0.0")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got, want := ref.String(), "oci://ghcr.io/acme/charts/redis"; got != want {
		t.Fatalf("String() = %q, want %q", got, want)
	}
}

// TestPull_Anonymous covers the public-chart path: a project need not connect a chart-repo
// connector to scan a public chart, so an empty credential must still produce a chart dir.
func TestPull_Anonymous(t *testing.T) {
	reg := newFakeRegistry(t, "acme/charts/demo")
	reg.addChart("1.2.3", chartFixture{
		Name: "demo", Version: "1.2.3",
		Files: map[string]string{"templates/cm.yaml": "kind: ConfigMap\n"},
	})

	res := mustPull(t, reg.ref(), "1.2.3", Creds{})
	if res.Version != "1.2.3" {
		t.Fatalf("resolved version = %q, want 1.2.3", res.Version)
	}
	if !strings.HasPrefix(res.Digest, "sha256:") {
		t.Fatalf("digest = %q, want a sha256 digest", res.Digest)
	}
	assertFile(t, filepath.Join(res.ChartDir, "Chart.yaml"), "name: demo")
	assertFile(t, filepath.Join(res.ChartDir, "templates", "cm.yaml"), "ConfigMap")
	if filepath.Base(res.ChartDir) != "demo" {
		t.Fatalf("chart dir = %q, want it to end in the chart name", res.ChartDir)
	}
}

// TestPull_Authenticated proves the connector credential actually reaches the registry's token
// endpoint — the whole point of routing helm_registry credentials to the scan.
func TestPull_Authenticated(t *testing.T) {
	reg := newFakeRegistry(t, "acme/charts/private")
	reg.requireAuth = true
	reg.wantUser, reg.wantPass = "chart-bot", "s3cret-pat"
	reg.addChart("2.0.0", chartFixture{Name: "private", Version: "2.0.0"})

	res := mustPull(t, reg.ref(), "2.0.0", Creds{Username: "chart-bot", Password: "s3cret-pat"})
	assertFile(t, filepath.Join(res.ChartDir, "Chart.yaml"), "name: private")
	if reg.sawBasic != "chart-bot:s3cret-pat" {
		t.Fatalf("registry saw Basic %q, want the connector credential", reg.sawBasic)
	}
}

// TestPull_AuthenticatedRegistryRejectsAnonymous is the negative half: without a credential the
// private chart must fail rather than silently scan nothing.
func TestPull_AuthenticatedRegistryRejectsAnonymous(t *testing.T) {
	reg := newFakeRegistry(t, "acme/charts/private")
	reg.requireAuth = true
	reg.wantUser, reg.wantPass = "chart-bot", "s3cret-pat"
	reg.addChart("2.0.0", chartFixture{Name: "private", Version: "2.0.0"})

	if _, err := pull(t, reg.ref(), "2.0.0", Creds{}); err == nil {
		t.Fatal("anonymous pull of a private chart succeeded, want an error")
	}
}

// TestPull_LatestResolvesHighestRelease locks `*` resolution: the OCI spec orders tags lexically, so
// "9.0.0" sorts above "10.0.0" as a string — only semver ordering gives the right answer.
// Pre-releases are excluded because the deploy path would not install one.
func TestPull_LatestResolvesHighestRelease(t *testing.T) {
	reg := newFakeRegistry(t, "acme/charts/demo")
	for _, v := range []string{"1.0.0", "9.0.0", "0.9.9"} {
		reg.addTagOnly(v)
	}
	reg.addTagOnly("11.0.0-rc.1")
	reg.addTagOnly("not-a-version")
	reg.addChart("10.0.0", chartFixture{Name: "demo", Version: "10.0.0"})

	res := mustPull(t, reg.ref(), LatestVersion, Creds{})
	if res.Version != "10.0.0" {
		t.Fatalf("resolved %q, want 10.0.0 (highest release, not lexical max and not the rc)", res.Version)
	}
}

// TestPull_LatestWithNoReleaseTags fails closed rather than guessing when a repository publishes
// only pre-releases or non-semver tags.
func TestPull_LatestWithNoReleaseTags(t *testing.T) {
	reg := newFakeRegistry(t, "acme/charts/demo")
	reg.addTagOnly("latest")
	reg.addTagOnly("2.0.0-rc.1")

	_, err := pull(t, reg.ref(), LatestVersion, Creds{})
	if err == nil || !strings.Contains(err.Error(), "no released semver version") {
		t.Fatalf("error = %v, want a 'no released semver version' failure", err)
	}
}

// TestPull_RejectsNonHelmArtifact is the fail-closed media-type gate: an oci:// reference addresses
// a container image just as readily as a chart, and rendering an image's layers would be nonsense.
func TestPull_RejectsNonHelmArtifact(t *testing.T) {
	reg := newFakeRegistry(t, "acme/images/app")
	reg.addNonChart("1.0.0")

	_, err := pull(t, reg.ref(), "1.0.0", Creds{})
	if err == nil || !strings.Contains(err.Error(), "is not a Helm chart") {
		t.Fatalf("error = %v, want a 'not a Helm chart' failure", err)
	}
}

// TestPull_RejectsCorruptedLayer proves the chart bytes are verified against the descriptor digest,
// so a registry that serves different content than it advertised cannot get it rendered.
func TestPull_RejectsCorruptedLayer(t *testing.T) {
	reg := newFakeRegistry(t, "acme/charts/demo")
	tgz := reg.addChart("1.0.0", chartFixture{Name: "demo", Version: "1.0.0"})
	reg.corruptBlob = digestOf(tgz)

	_, err := pull(t, reg.ref(), "1.0.0", Creds{})
	if err == nil {
		t.Fatal("pull of a corrupted chart layer succeeded, want a digest failure")
	}
}

// TestPull_RejectsMissingVersion surfaces a clear error for a version that was never published,
// instead of falling back to some other tag.
func TestPull_RejectsMissingVersion(t *testing.T) {
	reg := newFakeRegistry(t, "acme/charts/demo")
	reg.addChart("1.0.0", chartFixture{Name: "demo", Version: "1.0.0"})

	if _, err := pull(t, reg.ref(), "9.9.9", Creds{}); err == nil {
		t.Fatal("pull of an unpublished version succeeded, want an error")
	}
}

// TestPull_ChartWithoutChartYAML rejects an archive that is not a packaged chart — `helm template`
// would fail anyway, and failing here gives the operator a comprehensible reason.
func TestPull_ChartWithoutChartYAML(t *testing.T) {
	reg := newFakeRegistry(t, "acme/charts/demo")
	reg.addChart("1.0.0", chartFixture{Name: "demo", Version: "1.0.0", OmitChartYAML: true})

	_, err := pull(t, reg.ref(), "1.0.0", Creds{})
	if err == nil || !strings.Contains(err.Error(), "not a packaged Helm chart") {
		t.Fatalf("error = %v, want a 'not a packaged Helm chart' failure", err)
	}
}

// TestVersionTagEncoding locks Helm's `+` → `_` build-metadata encoding in both directions; getting
// it wrong means a chart pinned to a build-metadata version can never be found.
func TestVersionTagEncoding(t *testing.T) {
	if got, want := versionToTag("1.2.3+build.5"), "1.2.3_build.5"; got != want {
		t.Fatalf("versionToTag = %q, want %q", got, want)
	}
	if got, want := tagToSemver("1.2.3_build.5"), "v1.2.3+build.5"; got != want {
		t.Fatalf("tagToSemver = %q, want %q", got, want)
	}
	if got, want := tagToSemver("v2.0.0"), "v2.0.0"; got != want {
		t.Fatalf("tagToSemver = %q, want %q", got, want)
	}
}

// TestHighestReleaseTag covers the ordering rules without a registry round trip.
func TestHighestReleaseTag(t *testing.T) {
	tests := []struct {
		name string
		tags []string
		want string
	}{
		{name: "semver beats lexical", tags: []string{"9.0.0", "10.0.0"}, want: "10.0.0"},
		{name: "prereleases excluded", tags: []string{"1.0.0", "2.0.0-rc.1"}, want: "1.0.0"},
		{name: "non-semver ignored", tags: []string{"latest", "stable", "1.4.0"}, want: "1.4.0"},
		{name: "v prefix accepted", tags: []string{"v1.0.0", "v1.2.0"}, want: "v1.2.0"},
		{name: "build metadata tolerated", tags: []string{"1.0.0", "1.0.1_build.2"}, want: "1.0.1_build.2"},
		{name: "nothing usable", tags: []string{"latest", "edge"}, want: ""},
		{name: "empty", tags: nil, want: ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := highestReleaseTag(tc.tags); got != tc.want {
				t.Fatalf("highestReleaseTag(%v) = %q, want %q", tc.tags, got, tc.want)
			}
		})
	}
}

// TestCredsEmpty documents when a pull is anonymous — a partially-filled credential still counts as
// present, because sending half a credential should fail loudly at the registry, not silently
// downgrade to anonymous.
func TestCredsEmpty(t *testing.T) {
	if !(Creds{}).empty() {
		t.Fatal("zero Creds should be empty")
	}
	if (Creds{Username: "u"}).empty() || (Creds{Password: "p"}).empty() {
		t.Fatal("partially-filled Creds should not be treated as anonymous")
	}
}

// pull runs a Pull into a fresh temp dir, returning the result and error.
func pull(t *testing.T, chartRepo, version string, creds Creds) (Result, error) {
	t.Helper()
	ref, err := ParseChartRef(chartRepo, version)
	if err != nil {
		return Result{}, err
	}
	return Pull(context.Background(), ref, creds, t.TempDir())
}

// mustPull runs a Pull and fails the test on error.
func mustPull(t *testing.T, chartRepo, version string, creds Creds) Result {
	t.Helper()
	res, err := pull(t, chartRepo, version, creds)
	if err != nil {
		t.Fatalf("Pull(%s@%s): %v", chartRepo, version, err)
	}
	return res
}

// assertFile checks a file exists and contains a substring.
func assertFile(t *testing.T, path, want string) {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if !strings.Contains(string(b), want) {
		t.Fatalf("%s = %q, want it to contain %q", path, string(b), want)
	}
}
