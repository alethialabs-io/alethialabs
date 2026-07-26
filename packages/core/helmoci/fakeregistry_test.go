// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package helmoci

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/opencontainers/go-digest"
	specs "github.com/opencontainers/image-spec/specs-go"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

// ocispecVersioned is the schema-version stanza every OCI manifest carries.
func ocispecVersioned() specs.Versioned { return specs.Versioned{SchemaVersion: 2} }

// digestFrom converts a canonical digest string into the typed digest oras descriptors use.
func digestFrom(s string) digest.Digest { return digest.Digest(s) }

// fakeRegistry is an in-process OCI distribution v2 registry, enough of one to exercise the pull
// path end to end without a network or a container runtime. It speaks the four endpoints a chart
// pull touches (token, tag list, manifest, blob) and can be told to require a bearer token so the
// authenticated path is covered too.
type fakeRegistry struct {
	t *testing.T
	// repo is the repository path served, e.g. "acme/charts/demo".
	repo string
	// tags maps a tag to its manifest bytes.
	tags map[string][]byte
	// blobs maps a digest string to its content.
	blobs map[string][]byte
	// requireAuth turns on the WWW-Authenticate token dance.
	requireAuth bool
	// wantUser/wantPass are the Basic credentials the token endpoint accepts.
	wantUser, wantPass string
	// corruptBlob, when set, is a digest whose body is served altered — used to prove the pull
	// verifies content rather than trusting the registry.
	corruptBlob string

	// sawBasic records the Basic credential presented at the token endpoint, so a test can assert
	// the connector credential actually reached the registry.
	sawBasic string
	srv      *httptest.Server
}

// newFakeRegistry starts a fake registry serving one chart repository.
func newFakeRegistry(t *testing.T, repo string) *fakeRegistry {
	t.Helper()
	f := &fakeRegistry{t: t, repo: repo, tags: map[string][]byte{}, blobs: map[string][]byte{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

// host returns the registry host:port to use in an oci:// reference.
func (f *fakeRegistry) host() string {
	u, err := url.Parse(f.srv.URL)
	if err != nil {
		f.t.Fatalf("parse fake registry URL: %v", err)
	}
	return u.Host
}

// ref builds the oci:// chart reference clients should use.
func (f *fakeRegistry) ref() string { return "oci://" + f.host() + "/" + f.repo }

// addBlob stores content and returns its descriptor.
func (f *fakeRegistry) addBlob(mediaType string, content []byte) ocispec.Descriptor {
	dgst := digestOf(content)
	f.blobs[dgst] = content
	return ocispec.Descriptor{MediaType: mediaType, Digest: digestFrom(dgst), Size: int64(len(content))}
}

// addChart publishes a packaged chart at the given tag and returns the chart tarball bytes.
func (f *fakeRegistry) addChart(tag string, chart chartFixture) []byte {
	f.t.Helper()
	tgz := chart.tarGz(f.t)
	cfg := f.addBlob(ConfigMediaType, []byte(`{"name":"`+chart.Name+`","version":"`+chart.Version+`"}`))
	layer := f.addBlob(ChartLayerMediaType, tgz)
	f.publish(tag, ocispec.Manifest{
		Versioned: ocispecVersioned(),
		MediaType: ocispec.MediaTypeImageManifest,
		Config:    cfg,
		Layers:    []ocispec.Descriptor{layer},
	})
	return tgz
}

// addNonChart publishes an artifact that is NOT a Helm chart (a container image config), so the
// fail-closed media-type check can be exercised.
func (f *fakeRegistry) addNonChart(tag string) {
	f.t.Helper()
	cfg := f.addBlob(ocispec.MediaTypeImageConfig, []byte(`{}`))
	layer := f.addBlob(ocispec.MediaTypeImageLayerGzip, []byte("not-a-chart"))
	f.publish(tag, ocispec.Manifest{
		Versioned: ocispecVersioned(),
		MediaType: ocispec.MediaTypeImageManifest,
		Config:    cfg,
		Layers:    []ocispec.Descriptor{layer},
	})
}

// addTagOnly registers a tag in the tag list without a resolvable manifest, for tag-resolution tests.
func (f *fakeRegistry) addTagOnly(tag string) { f.tags[tag] = nil }

// publish marshals and stores a manifest under a tag.
func (f *fakeRegistry) publish(tag string, m ocispec.Manifest) {
	f.t.Helper()
	raw, err := json.Marshal(m)
	if err != nil {
		f.t.Fatalf("marshal manifest: %v", err)
	}
	f.tags[tag] = raw
}

// handle routes the distribution-spec endpoints.
func (f *fakeRegistry) handle(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/token" {
		f.serveToken(w, r)
		return
	}
	if f.requireAuth && r.Header.Get("Authorization") != "Bearer good-token" {
		w.Header().Set("WWW-Authenticate",
			fmt.Sprintf(`Bearer realm="%s/token",service="fake"`, f.srv.URL))
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	switch {
	case r.URL.Path == "/v2/":
		w.WriteHeader(http.StatusOK)
	case r.URL.Path == "/v2/"+f.repo+"/tags/list":
		f.serveTagList(w)
	case strings.HasPrefix(r.URL.Path, "/v2/"+f.repo+"/manifests/"):
		f.serveManifest(w, r, strings.TrimPrefix(r.URL.Path, "/v2/"+f.repo+"/manifests/"))
	case strings.HasPrefix(r.URL.Path, "/v2/"+f.repo+"/blobs/"):
		f.serveBlob(w, strings.TrimPrefix(r.URL.Path, "/v2/"+f.repo+"/blobs/"))
	default:
		http.NotFound(w, r)
	}
}

// serveToken implements the bearer-token exchange, recording the Basic credential it was given.
func (f *fakeRegistry) serveToken(w http.ResponseWriter, r *http.Request) {
	if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Basic ") {
		raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(auth, "Basic "))
		if err == nil {
			f.sawBasic = string(raw)
		}
	}
	if f.wantUser != "" && f.sawBasic != f.wantUser+":"+f.wantPass {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"token":"good-token"}`))
}

// serveTagList returns the repository's tags in the lexical order the spec mandates.
func (f *fakeRegistry) serveTagList(w http.ResponseWriter) {
	tags := make([]string, 0, len(f.tags))
	for t := range f.tags {
		tags = append(tags, t)
	}
	sortStrings(tags)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"name": f.repo, "tags": tags})
}

// serveManifest returns a manifest by tag or digest, with the headers oras needs to build a
// descriptor (content type, length, and Docker-Content-Digest).
func (f *fakeRegistry) serveManifest(w http.ResponseWriter, r *http.Request, ref string) {
	raw, ok := f.tags[ref]
	if !ok || raw == nil {
		http.NotFound(w, r)
		return
	}
	var probe struct {
		MediaType string `json:"mediaType"`
	}
	_ = json.Unmarshal(raw, &probe)
	if probe.MediaType == "" {
		probe.MediaType = ocispec.MediaTypeImageManifest
	}
	w.Header().Set("Content-Type", probe.MediaType)
	w.Header().Set("Docker-Content-Digest", digestOf(raw))
	w.Header().Set("Content-Length", fmt.Sprint(len(raw)))
	_, _ = w.Write(raw)
}

// serveBlob returns blob content, optionally corrupted to prove digest verification bites.
func (f *fakeRegistry) serveBlob(w http.ResponseWriter, dgst string) {
	content, ok := f.blobs[dgst]
	if !ok {
		http.Error(w, "no such blob", http.StatusNotFound)
		return
	}
	if f.corruptBlob == dgst {
		content = append(append([]byte(nil), content...), 'X')
		content = content[1:] // same length, different bytes
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", fmt.Sprint(len(content)))
	_, _ = w.Write(content)
}

// chartFixture describes a packaged chart to synthesize for a test.
type chartFixture struct {
	Name    string
	Version string
	// Files are extra paths (relative to the chart dir) and their contents.
	Files map[string]string
	// OmitChartYAML drops Chart.yaml, so the "not a packaged chart" guard can be tested.
	OmitChartYAML bool
	// Raw, when non-nil, replaces the generated archive entirely (used for hostile archives).
	Raw []byte
}

// tarGz renders the fixture as a gzipped tar in the layout `helm package` produces.
func (c chartFixture) tarGz(t *testing.T) []byte {
	t.Helper()
	if c.Raw != nil {
		return c.Raw
	}
	entries := map[string]string{}
	if !c.OmitChartYAML {
		entries[c.Name+"/Chart.yaml"] = fmt.Sprintf("apiVersion: v2\nname: %s\nversion: %s\n", c.Name, c.Version)
	}
	entries[c.Name+"/values.yaml"] = "replicas: 1\n"
	for p, body := range c.Files {
		entries[c.Name+"/"+p] = body
	}
	return tarGzOf(t, entries)
}

// tarGzOf builds a gzipped tar from a path→content map.
func tarGzOf(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	names := make([]string, 0, len(entries))
	for n := range entries {
		names = append(names, n)
	}
	sortStrings(names)
	for _, n := range names {
		body := entries[n]
		if err := tw.WriteHeader(&tar.Header{
			Name: n, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg,
		}); err != nil {
			t.Fatalf("tar header %s: %v", n, err)
		}
		if _, err := tw.Write([]byte(body)); err != nil {
			t.Fatalf("tar write %s: %v", n, err)
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

// tarGzWithHeaders builds an archive from explicit tar headers, for the hostile-entry tests.
func tarGzWithHeaders(t *testing.T, hdrs []*tar.Header, bodies []string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for i, h := range hdrs {
		if err := tw.WriteHeader(h); err != nil {
			t.Fatalf("tar header %s: %v", h.Name, err)
		}
		if i < len(bodies) && bodies[i] != "" {
			if _, err := tw.Write([]byte(bodies[i])); err != nil {
				t.Fatalf("tar write %s: %v", h.Name, err)
			}
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

// digestOf returns the canonical "sha256:<hex>" digest of content.
func digestOf(b []byte) string {
	return fmt.Sprintf("sha256:%x", sha256.Sum256(b))
}

// sortStrings sorts in place; a tiny helper so the fixtures don't import sort everywhere.
func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}
