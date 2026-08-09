// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package helmoci

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
	"oras.land/oras-go/v2/registry/remote"
)

// tailRepoFor builds the authenticated-or-anonymous oras client the production pull uses, pointed
// at a fake registry, so the registry.go helpers can be driven directly.
func tailRepoFor(t *testing.T, f *fakeRegistry) *remote.Repository {
	t.Helper()
	repo, err := newRepository(Ref{Registry: f.host(), Repository: f.repo}, Creds{})
	if err != nil {
		t.Fatalf("newRepository: %v", err)
	}
	return repo
}

// TestTail_ParseChartRefRejectsUnusableReferences covers the two remaining fail-closed arms of
// ParseChartRef: a reference url.Parse itself refuses, and one with no registry host at all.
func TestTail_ParseChartRefRejectsUnusableReferences(t *testing.T) {
	for _, tt := range []struct {
		name string
		in   string
		want string
	}{
		{"control character", "oci://ghcr.io/acme/\x7fchart", "parse chart reference"},
		{"no host", "oci:///acme/chart", "no registry host"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ParseChartRef(tt.in, "1.0.0")
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("ParseChartRef(%q) error = %v, want %q", tt.in, err, tt.want)
			}
		})
	}
}

// TestTail_PullRejectsUnbuildableReference covers Pull's newRepository error arm: a registry host
// oras cannot turn into a repository reference never reaches the network.
func TestTail_PullRejectsUnbuildableReference(t *testing.T) {
	_, err := Pull(context.Background(), Ref{Registry: "not a host", Repository: "acme/chart", Version: "1.0.0"}, Creds{}, t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "invalid OCI reference") {
		t.Fatalf("Pull error = %v, want the invalid-reference failure", err)
	}
}

// TestTail_PullReportsUnusableDestination covers Pull's MkdirAll arm: a destDir that is a regular
// file cannot hold the per-pull "chart" subdirectory.
func TestTail_PullReportsUnusableDestination(t *testing.T) {
	f := newFakeRegistry(t, "acme/charts/demo")
	f.addChart("1.0.0", chartFixture{Name: "demo", Version: "1.0.0"})

	dest := filepath.Join(t.TempDir(), "a-file")
	if err := os.WriteFile(dest, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := Pull(context.Background(), Ref{Registry: f.host(), Repository: f.repo, Version: "1.0.0"}, Creds{}, dest)
	if err == nil || !strings.Contains(err.Error(), "create chart dir") {
		t.Fatalf("Pull error = %v, want the chart-dir failure", err)
	}
}

// TestTail_ResolveVersionSurfacesTagListFailure covers listTags' error wrap and resolveVersion's
// propagation: a registry whose tag list 500s must fail the `*` resolution, not silently yield "".
func TestTail_ResolveVersionSurfacesTagListFailure(t *testing.T) {
	allowLocalRegistriesForTest(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v2/" {
			w.WriteHeader(http.StatusOK)
			return
		}
		// 404 rather than 5xx: oras's retry transport would re-issue a 5xx several times, which
		// would make this test slow for no extra coverage.
		http.Error(w, "no such repository", http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)

	repo, err := newRepository(Ref{Registry: strings.TrimPrefix(srv.URL, "http://"), Repository: "acme/chart"}, Creds{})
	if err != nil {
		t.Fatalf("newRepository: %v", err)
	}
	if _, err := resolveVersion(context.Background(), repo, LatestVersion); err == nil ||
		!strings.Contains(err.Error(), "list chart versions") {
		t.Fatalf("resolveVersion error = %v, want the tag-list failure", err)
	}
}

// TestTail_ListTagsStopsAtTheScanLimit covers the pagination bound: a repository advertising more
// than maxTagsScanned tags stops the walk and still returns what it read, rather than erroring or
// reading forever.
func TestTail_ListTagsStopsAtTheScanLimit(t *testing.T) {
	allowLocalRegistriesForTest(t)
	tags := make([]string, 0, maxTagsScanned+5)
	for i := 0; i < maxTagsScanned+5; i++ {
		tags = append(tags, fmt.Sprintf("t%05d", i))
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v2/" {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"name": "acme/chart", "tags": tags})
	}))
	t.Cleanup(srv.Close)

	repo, err := newRepository(Ref{Registry: strings.TrimPrefix(srv.URL, "http://"), Repository: "acme/chart"}, Creds{})
	if err != nil {
		t.Fatalf("newRepository: %v", err)
	}
	got, err := listTags(context.Background(), repo)
	if err != nil {
		t.Fatalf("listTags: %v", err)
	}
	if len(got) < maxTagsScanned {
		t.Fatalf("listTags returned %d tags, want at least the %d-tag scan limit", len(got), maxTagsScanned)
	}
}

// TestTail_HighestReleaseTagBreaksBuildMetadataTies covers the equal-precedence arm: two tags whose
// semver precedence is identical (they differ only in build metadata) must resolve to ONE
// deterministic winner, or `*` would resolve differently run to run.
func TestTail_HighestReleaseTagBreaksBuildMetadataTies(t *testing.T) {
	// Helm encodes "+" as "_" in a tag, so these are v1.0.0+build1 / v1.0.0+build2.
	if got := highestReleaseTag([]string{"1.0.0_build1", "1.0.0_build2"}); got != "1.0.0_build2" {
		t.Fatalf("highestReleaseTag = %q, want the lexically greater build metadata", got)
	}
	// And the reverse input order must give the same answer — that is what "deterministic" means.
	if got := highestReleaseTag([]string{"1.0.0_build2", "1.0.0_build1"}); got != "1.0.0_build2" {
		t.Fatalf("highestReleaseTag (reversed input) = %q, want 1.0.0_build2", got)
	}
}

// TestTail_ResolveChartManifestRejectsUnresolvableTag covers the FetchReference error arm.
func TestTail_ResolveChartManifestRejectsUnresolvableTag(t *testing.T) {
	f := newFakeRegistry(t, "acme/charts/demo")
	f.addChart("1.0.0", chartFixture{Name: "demo", Version: "1.0.0"})

	_, err := resolveChartManifest(context.Background(), tailRepoFor(t, f), "9.9.9")
	if err == nil || !strings.Contains(err.Error(), "resolve chart version") {
		t.Fatalf("resolveChartManifest error = %v, want the resolve failure", err)
	}
}

// TestTail_ResolveChartManifestRejectsImageIndex covers the documented multi-manifest exclusion:
// selecting a child of an index is a platform decision with no meaning for a chart.
func TestTail_ResolveChartManifestRejectsImageIndex(t *testing.T) {
	f := newFakeRegistry(t, "acme/charts/demo")
	raw, err := json.Marshal(ocispec.Index{
		Versioned: ocispecVersioned(),
		MediaType: ocispec.MediaTypeImageIndex,
	})
	if err != nil {
		t.Fatal(err)
	}
	f.tags["1.0.0"] = raw

	_, err = resolveChartManifest(context.Background(), tailRepoFor(t, f), "1.0.0")
	if err == nil || !strings.Contains(err.Error(), "image index") {
		t.Fatalf("resolveChartManifest error = %v, want the image-index refusal", err)
	}
}

// TestTail_ResolveChartManifestRejectsUnparseableManifest covers the json.Unmarshal arm: a body
// that content-verifies but is not a manifest.
func TestTail_ResolveChartManifestRejectsUnparseableManifest(t *testing.T) {
	f := newFakeRegistry(t, "acme/charts/demo")
	f.tags["1.0.0"] = []byte("{not json")

	_, err := resolveChartManifest(context.Background(), tailRepoFor(t, f), "1.0.0")
	if err == nil || !strings.Contains(err.Error(), "parse chart manifest") {
		t.Fatalf("resolveChartManifest error = %v, want the parse failure", err)
	}
}

// tailPublishLayers publishes a Helm-config manifest carrying exactly the given layers, bypassing
// addChart so a test can pin a hostile descriptor (zero size, oversized, wrong media type).
func tailPublishLayers(f *fakeRegistry, tag string, layers []ocispec.Descriptor) {
	cfg := f.addBlob(ConfigMediaType, []byte(`{"name":"demo"}`))
	f.publish(tag, ocispec.Manifest{
		Versioned: ocispecVersioned(),
		MediaType: ocispec.MediaTypeImageManifest,
		Config:    cfg,
		Layers:    layers,
	})
}

// TestTail_ResolveChartManifestLayerSelection covers the layer walk's fail-closed arms: a
// provenance-only artifact has no chart layer; a chart layer that declares no size, or one larger
// than the scan limit, is refused BEFORE any bytes are fetched.
func TestTail_ResolveChartManifestLayerSelection(t *testing.T) {
	for _, tt := range []struct {
		name   string
		layers []ocispec.Descriptor
		want   string
	}{
		{
			name:   "provenance only",
			layers: []ocispec.Descriptor{{MediaType: ProvLayerMediaType, Size: 10}},
			want:   "no " + ChartLayerMediaType + " layer",
		},
		{
			// The prov layer must be SKIPPED (not treated as the chart) and the real chart layer
			// selected by media type — helm push uploads them together.
			name: "zero-size chart layer after a prov layer",
			layers: []ocispec.Descriptor{
				{MediaType: ProvLayerMediaType, Size: 10},
				{MediaType: ChartLayerMediaType, Size: 0},
			},
			want: "declares no size",
		},
		{
			name:   "oversized chart layer",
			layers: []ocispec.Descriptor{{MediaType: ChartLayerMediaType, Size: maxChartLayerBytes + 1}},
			want:   "over the",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			f := newFakeRegistry(t, "acme/charts/demo")
			tailPublishLayers(f, "1.0.0", tt.layers)
			_, err := resolveChartManifest(context.Background(), tailRepoFor(t, f), "1.0.0")
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("resolveChartManifest error = %v, want %q", err, tt.want)
			}
		})
	}
}

// TestTail_ResolveChartManifestRejectsOversizedManifest covers the manifest size ceiling. oras's
// own MaxMetadataBytes is raised here so the package's OWN limit is the one under test.
func TestTail_ResolveChartManifestRejectsOversizedManifest(t *testing.T) {
	f := newFakeRegistry(t, "acme/charts/demo")
	// A manifest whose JSON exceeds maxManifestBytes (its content is irrelevant — the size check
	// runs on the descriptor, before the body is read).
	pad := strings.Repeat("p", maxManifestBytes+1024)
	f.tags["1.0.0"] = []byte(`{"schemaVersion":2,"annotations":{"pad":"` + pad + `"}}`)

	repo := tailRepoFor(t, f)
	repo.MaxMetadataBytes = int64(maxManifestBytes) * 4

	_, err := resolveChartManifest(context.Background(), repo, "1.0.0")
	if err == nil || !strings.Contains(err.Error(), "chart manifest is") {
		t.Fatalf("resolveChartManifest error = %v, want the manifest-size refusal", err)
	}
}

// TestTail_ExtractRejectsNonGzipStream covers extractChartTarGz's gzip arm.
func TestTail_ExtractRejectsNonGzipStream(t *testing.T) {
	_, err := extractChartTarGz(strings.NewReader("plain text, not gzip"), t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "not gzip") {
		t.Fatalf("extractChartTarGz error = %v, want the gzip refusal", err)
	}
}

// TestTail_ExtractRejectsUnresolvableRoot covers the EvalSymlinks arm: a destination directory
// that does not exist must be reported, never silently created outside the containment check.
func TestTail_ExtractRejectsUnresolvableRoot(t *testing.T) {
	good := tarGzOf(t, map[string]string{"demo/Chart.yaml": "name: demo\n"})
	_, err := extractChartTarGz(bytes.NewReader(good), filepath.Join(t.TempDir(), "absent"))
	if err == nil || !strings.Contains(err.Error(), "resolve chart dir") {
		t.Fatalf("extractChartTarGz error = %v, want the resolve failure", err)
	}
}

// TestTail_ResolveChartManifestVerifiesTheManifestBody covers content.ReadAll's arm: a registry
// that serves a manifest whose bytes do not match the digest it advertised is a READ error, not
// something the scanner goes on to parse.
func TestTail_ResolveChartManifestVerifiesTheManifestBody(t *testing.T) {
	allowLocalRegistriesForTest(t)
	body := []byte(`{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json"}`)
	// A same-length, different-bytes body: the size matches the descriptor, the digest does not.
	other := append([]byte(nil), body...)
	other[2] ^= 0xff

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v2/" {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.Header().Set("Content-Type", ocispec.MediaTypeImageManifest)
		w.Header().Set("Docker-Content-Digest", digestOf(other))
		w.Header().Set("Content-Length", fmt.Sprint(len(body)))
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)

	repo, err := newRepository(Ref{Registry: strings.TrimPrefix(srv.URL, "http://"), Repository: "acme/chart"}, Creds{})
	if err != nil {
		t.Fatalf("newRepository: %v", err)
	}
	if _, err := resolveChartManifest(context.Background(), repo, "1.0.0"); err == nil ||
		!strings.Contains(err.Error(), "read chart manifest") {
		t.Fatalf("resolveChartManifest error = %v, want the manifest-read failure", err)
	}
}

// TestTail_ExtractRejectsTruncatedArchive covers the tar.Reader.Next error arm: a gzip stream whose
// tar payload stops mid-header.
func TestTail_ExtractRejectsTruncatedArchive(t *testing.T) {
	good := tarGzOf(t, map[string]string{"demo/Chart.yaml": "name: demo\n"})
	// Cut the gzip stream in half: the gzip reader yields what it can and the tar reader then sees
	// a partial header rather than a clean end-of-archive.
	_, err := extractChartTarGz(bytes.NewReader(good[:len(good)/2]), t.TempDir())
	if err == nil {
		t.Fatal("extractChartTarGz accepted a truncated archive")
	}
}

// TestTail_ExtractHandlesDirectoriesAndRootEntry covers two arms `helm package` output exercises
// but the existing fixtures do not: the archive's own "./" entry (skipped) and explicit directory
// entries (created).
func TestTail_ExtractHandlesDirectoriesAndRootEntry(t *testing.T) {
	body := "apiVersion: v2\nname: demo\nversion: 1.0.0\n"
	archive := tarGzWithHeaders(t,
		[]*tar.Header{
			{Name: "./", Mode: 0o755, Typeflag: tar.TypeDir},
			{Name: "demo/", Mode: 0o755, Typeflag: tar.TypeDir},
			{Name: "demo/templates/", Mode: 0o755, Typeflag: tar.TypeDir},
			{Name: "demo/Chart.yaml", Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg},
		},
		[]string{"", "", "", body},
	)
	root := t.TempDir()
	dir, err := extractChartTarGz(bytes.NewReader(archive), root)
	if err != nil {
		t.Fatalf("extractChartTarGz: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "templates")); err != nil {
		t.Fatalf("directory entry was not created: %v", err)
	}
}

// TestTail_ExtractRefusesEntriesThatCollideWithAFile covers the two MkdirAll arms: a directory
// entry, and a regular file's parent, that a previously-written FILE already occupies.
func TestTail_ExtractRefusesEntriesThatCollideWithAFile(t *testing.T) {
	for _, tt := range []struct {
		name    string
		second  *tar.Header
		body    string
		wantSub string
	}{
		{
			name:    "directory over a file",
			second:  &tar.Header{Name: "demo/x/", Mode: 0o755, Typeflag: tar.TypeDir},
			wantSub: `create "demo/x"`,
		},
		{
			name:    "file under a file",
			second:  &tar.Header{Name: "demo/x/y", Mode: 0o644, Size: 1, Typeflag: tar.TypeReg},
			body:    "z",
			wantSub: "create parent of ",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			archive := tarGzWithHeaders(t,
				[]*tar.Header{
					{Name: "demo/x", Mode: 0o644, Size: 1, Typeflag: tar.TypeReg},
					tt.second,
				},
				[]string{"a", tt.body},
			)
			_, err := extractChartTarGz(bytes.NewReader(archive), t.TempDir())
			if err == nil || !strings.Contains(err.Error(), tt.wantSub) {
				t.Fatalf("extractChartTarGz error = %v, want %q", err, tt.wantSub)
			}
		})
	}
}

// TestTail_WithinRootRejectsIncomparablePaths covers withinRoot's filepath.Rel error arm — the
// belt to safeEntryName's braces must fail CLOSED when the two paths cannot be related at all.
func TestTail_WithinRootRejectsIncomparablePaths(t *testing.T) {
	if withinRoot("relative/root", "/absolute/target") {
		t.Fatal("withinRoot accepted paths filepath.Rel cannot relate — the containment check must fail closed")
	}
}

// tailFailingReader errors on the first read, so writeEntry's io.Copy arm is reachable.
type tailFailingReader struct{}

func (tailFailingReader) Read([]byte) (int, error) { return 0, errors.New("archive read exploded") }

// TestTail_WriteEntryFailureArms covers writeEntry's three refusals: an exhausted byte budget, a
// destination that already exists (O_EXCL — an archive must never overwrite a written entry), and
// a source stream that fails mid-copy.
func TestTail_WriteEntryFailureArms(t *testing.T) {
	dir := t.TempDir()

	t.Run("budget exhausted", func(t *testing.T) {
		if _, err := writeEntry(filepath.Join(dir, "a"), strings.NewReader("x"), 0); err == nil ||
			!strings.Contains(err.Error(), "expands beyond") {
			t.Fatalf("writeEntry error = %v, want the budget refusal", err)
		}
	})

	t.Run("destination exists", func(t *testing.T) {
		p := filepath.Join(dir, "b")
		if err := os.WriteFile(p, []byte("already here"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := writeEntry(p, strings.NewReader("x"), 100); err == nil {
			t.Fatal("writeEntry overwrote an existing file — O_EXCL must refuse it")
		}
	})

	t.Run("source read fails", func(t *testing.T) {
		if _, err := writeEntry(filepath.Join(dir, "c"), tailFailingReader{}, 100); err == nil ||
			!strings.Contains(err.Error(), "archive read exploded") {
			t.Fatalf("writeEntry error = %v, want the copy failure", err)
		}
	})
}
