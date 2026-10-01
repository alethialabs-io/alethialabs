// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeDigests is an ociDigestResolver over a fixed table; a missing entry is an error.
type fakeDigests map[string]string

// ResolveDigest returns the table's digest for repoURL:tag.
func (f fakeDigests) ResolveDigest(_ context.Context, repoURL, tag string) (string, error) {
	if d, ok := f[repoURL+":"+tag]; ok {
		return d, nil
	}
	return "", errors.New("manifest unknown")
}

// addonYAML renders an addons/<app>.yaml the way starter-ai writes one.
func addonYAML(repoURL, chart, rev string) string {
	s := "apiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: x\nspec:\n  project: addons\n  source:\n" +
		"    repoURL: " + repoURL + "\n    path: .\n    targetRevision: \"" + rev + "\"\n"
	if chart != "" {
		s += "    chart: " + chart + "\n"
	}
	return s
}

// templateFiles serves addons/*.yaml from testCharts() at shaAI, and nothing at any other commit.
func templateFiles(override map[string]string) templateFileFetcher {
	return func(_ context.Context, repo, commit, file string) ([]byte, error) {
		if repo != starterAIRepo || commit != shaAI {
			return nil, fmt.Errorf("unexpected read %s@%s", repo, commit)
		}
		if body, ok := override[file]; ok {
			return []byte(body), nil
		}
		for _, pin := range testCharts() {
			if pin.File == file {
				return []byte(addonYAML(pin.RepoURL, "", pin.Tag)), nil
			}
		}
		return nil, errors.New("404")
	}
}

// registryOf is the fake registry serving testCharts()' digests.
func registryOf() fakeDigests {
	f := fakeDigests{}
	for _, pin := range testCharts() {
		f[pin.RepoURL+":"+pin.Tag] = pin.Digest
	}
	return f
}

func TestResolveTemplateChartPins(t *testing.T) {
	got, err := resolveTemplateChartPins(context.Background(), templateFiles(nil), registryOf(), templatesPhaseAExpect(), testCommits())
	if err != nil {
		t.Fatal(err)
	}
	want := testCharts()
	if len(got) != len(want) {
		t.Fatalf("got %d pins, want %d: %+v", len(got), len(want), got)
	}
	for app, w := range want {
		if got[app] != w {
			t.Errorf("%s: got %+v, want %+v", app, got[app], w)
		}
	}
	// Every OCI Application names its pin file — else the preflight above would have skipped it.
	for _, e := range templatesPhaseAExpect() {
		if e.Source == templateSourceOCI && (e.PinFile == "" || e.Repo == "") {
			t.Errorf("%s: an OCI expectation without a repo and pin file", e.Application)
		}
	}
}

// Each way the preflight could proceed without knowing what it expects must stop it — before spend.
func TestResolveTemplateChartPinsRefusals(t *testing.T) {
	cases := []struct {
		name, mustSay string
		files         map[string]string
		reg           fakeDigests
		commits       map[string]string
	}{
		{name: "the pre-#2 form: chart beside an oci:// repoURL", mustSay: "ArgoCD 3.x ignores",
			files: map[string]string{"addons/kserve.yaml": addonYAML("oci://ghcr.io/kserve/charts", "kserve", "v0.15.2")}},
		{name: "not an oci:// source", mustSay: "not an oci://",
			files: map[string]string{"addons/kueue.yaml": addonYAML("https://kubernetes-sigs.github.io/kueue", "", "0.19.5")}},
		{name: "a constraint instead of a pin", mustSay: "constraint",
			files: map[string]string{"addons/kueue.yaml": addonYAML("oci://registry.k8s.io/kueue/charts/kueue", "", "0.19.*")}},
		{name: "no targetRevision", mustSay: "no targetRevision",
			files: map[string]string{"addons/kueue.yaml": addonYAML("oci://registry.k8s.io/kueue/charts/kueue", "", "")}},
		{name: "a tag the registry does not have", mustSay: "manifest digest",
			reg: fakeDigests{}},
		{name: "a registry answer that is not a digest", mustSay: "not a sha256 digest",
			reg: func() fakeDigests {
				f := registryOf()
				f["oci://ghcr.io/kserve/charts/kserve:v0.15.2"] = "v0.15.2"
				return f
			}()},
		{name: "no resolved commit", mustSay: "no commit resolved", commits: map[string]string{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			reg, commits := c.reg, c.commits
			if reg == nil {
				reg = registryOf()
			}
			if commits == nil {
				commits = testCommits()
			}
			pins, err := resolveTemplateChartPins(context.Background(), templateFiles(c.files), reg, templatesPhaseAExpect(), commits)
			if err == nil || !strings.Contains(err.Error(), c.mustSay) {
				t.Fatalf("want a refusal saying %q, got pins=%v err=%v", c.mustSay, pins, err)
			}
		})
	}
}

// The comparison itself: the tag, the digest, anything else, and an expectation that was never
// resolved.
func TestJudgeOCIRevision(t *testing.T) {
	pin := testCharts()["kserve"]
	synced := func(rev string) templateAppObserved {
		return templateAppObserved{Revision: rev, RepoURL: pin.RepoURL, TargetRevision: pin.Tag}
	}
	if why := judgeOCIRevision(synced(pin.Digest), pin, true); why != nil {
		t.Errorf("digest match refused: %v", why)
	}
	if why := judgeOCIRevision(synced(pin.Tag), pin, true); why != nil {
		t.Errorf("tag match refused: %v", why)
	}
	other := "sha256:" + strings.Repeat("0", 64)
	refusals := []struct {
		name, mustSay string
		o             templateAppObserved
		pin           ociChartPin
		have          bool
	}{
		{"a different digest", "nor its manifest digest", synced(other), pin, true},
		{"a different tag", "not the pinned chart version", synced("v0.16.0"), pin, true},
		{"an empty revision", "not the pinned chart version", synced(""), pin, true},
		{"unresolved digest", "never resolved to a manifest digest", synced(pin.Tag), ociChartPin{File: pin.File, RepoURL: pin.RepoURL, Tag: pin.Tag}, true},
		{"no pin at all", "no chart pin was resolved", synced(pin.Digest), ociChartPin{}, false},
		{"the parent path (the old form)", "not the OCI chart the template pins",
			templateAppObserved{Revision: pin.Digest, RepoURL: "oci://ghcr.io/kserve/charts", TargetRevision: pin.Tag}, pin, true},
		{"a targetRevision the template did not write", "not the version the template pins",
			templateAppObserved{Revision: pin.Digest, RepoURL: pin.RepoURL, TargetRevision: "v0.16.0"}, pin, true},
	}
	for _, c := range refusals {
		why := judgeOCIRevision(c.o, c.pin, c.have)
		if len(why) == 0 || !strings.Contains(strings.Join(why, ";"), c.mustSay) {
			t.Errorf("%s: want a refusal saying %q, got %v", c.name, c.mustSay, why)
		}
	}
	// Trailing slash and host case are ArgoCD-equivalent.
	o := synced(pin.Digest)
	o.RepoURL = strings.ToUpper("oci://ghcr.io") + "/kserve/charts/kserve/"
	if why := judgeOCIRevision(o, pin, true); why != nil {
		t.Errorf("a normalised-equal repoURL refused: %v", why)
	}
}

// The recorded row carries both halves of the expectation.
func TestTemplatesOCIRowRecordsTagAndDigest(t *testing.T) {
	results, err := evaluateTemplateApps(templatesPhaseAExpect(), greenPhaseA(), testCommits(), testCharts())
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range results {
		if r.Source != templateSourceOCI {
			continue
		}
		pin := testCharts()[r.Application]
		if r.ExpectedRevision != pin.Tag || r.ExpectedDigest != pin.Digest || r.Revision != pin.Digest {
			t.Errorf("%s: row %+v, want expected_revision %q and expected_digest %q", r.Application, r, pin.Tag, pin.Digest)
		}
	}
	// No pins resolved: every OCI row fails, and says why.
	_, err = evaluateTemplateApps(templatesPhaseAExpect(), greenPhaseA(), testCommits(), nil)
	for _, app := range []string{"kserve-crd", "kserve", "kueue"} {
		if err == nil || !strings.Contains(err.Error(), app+" (ai): no chart pin") {
			t.Errorf("%s passed with no resolved pin: %v", app, err)
		}
	}
}

// The network resolver, against a registry that challenges for an anonymous token (ghcr.io's
// shape) and one that redirects to a mirror (registry.k8s.io's).
func TestRegistryDigestResolver(t *testing.T) {
	manifest := []byte(`{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json"}`)
	sum := sha256.Sum256(manifest)
	digest := "sha256:" + hex.EncodeToString(sum[:])

	var srv *httptest.Server
	var lieDigest bool
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/token":
			if r.URL.Query().Get("scope") != "repository:kserve/charts/kserve:pull" || r.URL.Query().Get("service") != "reg" {
				http.Error(w, "bad scope "+r.URL.RawQuery, http.StatusBadRequest)
				return
			}
			_, _ = w.Write([]byte(`{"token":"anon"}`))
		case r.URL.Path == "/v2/kserve/charts/kserve/manifests/v0.15.2":
			if r.Header.Get("Authorization") != "Bearer anon" {
				w.Header().Set("Www-Authenticate", `Bearer realm="`+srv.URL+`/token",service="reg",scope="repository:kserve/charts/kserve:pull"`)
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			fallthrough
		case r.URL.Path == "/mirror/kueue/charts/kueue/manifests/0.19.5":
			if !strings.Contains(r.Header.Get("Accept"), "application/vnd.oci.image.manifest.v1+json") {
				http.Error(w, "no OCI accept", http.StatusNotAcceptable)
				return
			}
			if lieDigest {
				w.Header().Set("Docker-Content-Digest", "sha256:"+strings.Repeat("1", 64))
			} else {
				w.Header().Set("Docker-Content-Digest", digest)
			}
			_, _ = w.Write(manifest)
		case r.URL.Path == "/v2/kueue/charts/kueue/manifests/0.19.5":
			http.Redirect(w, r, "/mirror/kueue/charts/kueue/manifests/0.19.5", http.StatusTemporaryRedirect)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	host := strings.TrimPrefix(srv.URL, "http://")
	res := registryDigestResolver{client: srv.Client(), scheme: "http"}
	ctx := context.Background()

	for _, ref := range [][2]string{{"oci://" + host + "/kserve/charts/kserve", "v0.15.2"}, {"oci://" + host + "/kueue/charts/kueue", "0.19.5"}} {
		got, err := res.ResolveDigest(ctx, ref[0], ref[1])
		if err != nil || got != digest {
			t.Errorf("%s:%s → %q %v, want %q", ref[0], ref[1], got, err, digest)
		}
	}
	if _, err := res.ResolveDigest(ctx, "oci://"+host+"/kserve/charts/kserve", "v9.9.9"); err == nil {
		t.Error("an unknown tag resolved")
	}
	if _, err := res.ResolveDigest(ctx, "oci://"+host, "v0.15.2"); err == nil {
		t.Error("a repoURL with no repository resolved")
	}
	lieDigest = true
	if _, err := res.ResolveDigest(ctx, "oci://"+host+"/kueue/charts/kueue", "0.19.5"); err == nil || !strings.Contains(err.Error(), "hashes to") {
		t.Errorf("a Docker-Content-Digest that disagrees with the body passed: %v", err)
	}
}

func TestParseBearerChallenge(t *testing.T) {
	p, err := parseBearerChallenge(`Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:kserve/charts/kserve:pull"`)
	if err != nil || p["realm"] != "https://ghcr.io/token" || p["service"] != "ghcr.io" || p["scope"] != "repository:kserve/charts/kserve:pull" {
		t.Fatalf("got %v %v", p, err)
	}
	for _, bad := range []string{`Basic realm="x"`, `Bearer service="x"`, `Bearer realm="unterminated`} {
		if _, err := parseBearerChallenge(bad); err == nil {
			t.Errorf("%q parsed", bad)
		}
	}
}
