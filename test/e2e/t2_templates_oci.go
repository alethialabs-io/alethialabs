// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The STARTER-TEMPLATES proof (#4113) — the OCI chart pins. Untagged, like t2_templates.go.
//
// # What ArgoCD reports for an OCI source
//
// The AI template's addons/ pull KServe and Kueue as `oci://` sources. The ArgoCD this repo
// installs (argo-cd chart 9.5.11 → app v3.3.9, packages/core/compat/matrix.json) treats any
// `oci://` repoURL as a NATIVE OCI source (ApplicationSource.IsOCI is a prefix test), and its
// repo-server resolves the revision before rendering:
//
//	reposerver/repository/repository.go  runRepoOperation → newOCIClientResolveRevision
//	util/oci/client.go                    resolveRevision → resolveDigest → descriptor.Digest.String()
//
// and passes THAT to the manifest response, so `status.sync.revision` is the manifest DIGEST
// (`sha256:…`), never the tag the Application names. Comparing it to `targetRevision` therefore
// fails every correctly-synced chart.
//
// # How the expectation is formed — and why not from the cluster
//
// The pin (repoURL + tag) is read from the template repository itself, at the commit resolved by
// `git ls-remote` — `addons/<app>.yaml` over raw.githubusercontent.com — and the tag is resolved to
// its manifest digest against the registry, anonymously, all BEFORE any spend. The synced revision
// is accepted when it equals the tag OR that digest. Nothing here is taken from the cluster's own
// claim: a digest learned from the Application would prove only that ArgoCD agrees with itself.
//
// A registry can move a tag between the preflight and the sync. That fails the row, loudly, naming
// both — which is the correct verdict: the proof would otherwise record a chart nobody pinned.
package e2e

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// ociChartPin is one chart a template commit pins, and the manifest digest the registry resolved
// its tag to before the run.
type ociChartPin struct {
	File    string `json:"file"`
	RepoURL string `json:"repo_url"`
	Tag     string `json:"tag"`
	Digest  string `json:"digest"`
}

// ociDigestResolver resolves an OCI tag to its manifest digest. The network implementation is
// registryDigestResolver; tests substitute a fake.
type ociDigestResolver interface {
	ResolveDigest(ctx context.Context, repoURL, tag string) (string, error)
}

// templateFileFetcher reads one file of a template repository at a commit.
type templateFileFetcher func(ctx context.Context, repo, commit, file string) ([]byte, error)

// normOCIRepo normalises an oci:// repoURL for comparison (case of the host, a trailing slash).
func normOCIRepo(s string) string {
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(s)), "/")
}

// parseAddonPin reads the chart pin out of one addons/<app>.yaml Application manifest, refusing any
// shape ArgoCD 3.x would not sync as the pinned chart.
func parseAddonPin(file string, raw []byte) (ociChartPin, error) {
	var app struct {
		Kind string `yaml:"kind"`
		Spec struct {
			Source struct {
				RepoURL        string `yaml:"repoURL"`
				Chart          string `yaml:"chart"`
				TargetRevision string `yaml:"targetRevision"`
			} `yaml:"source"`
		} `yaml:"spec"`
	}
	if err := yaml.Unmarshal(raw, &app); err != nil {
		return ociChartPin{}, fmt.Errorf("%s: %w", file, err)
	}
	src := app.Spec.Source
	switch {
	case app.Kind != "Application":
		return ociChartPin{}, fmt.Errorf("%s: kind %q, want Application", file, app.Kind)
	case !strings.HasPrefix(src.RepoURL, "oci://"):
		return ociChartPin{}, fmt.Errorf("%s: repoURL %q is not an oci:// chart", file, src.RepoURL)
	case src.Chart != "":
		// ArgoCD 3.x reads an oci:// repoURL as the ARTIFACT and ignores `chart:`, so this would pull
		// the parent path — the failure of hetzner run 36715371148.
		return ociChartPin{}, fmt.Errorf("%s: sets chart %q beside an oci:// repoURL, which ArgoCD 3.x ignores — the repoURL must name the chart itself", file, src.Chart)
	case src.TargetRevision == "":
		return ociChartPin{}, fmt.Errorf("%s: no targetRevision — the template must pin every chart", file)
	case strings.ContainsAny(src.TargetRevision, "*^~<>=|, "):
		return ociChartPin{}, fmt.Errorf("%s: targetRevision %q is a constraint, not a pin", file, src.TargetRevision)
	}
	return ociChartPin{File: file, RepoURL: src.RepoURL, Tag: src.TargetRevision}, nil
}

// resolveTemplateChartPins reads every OCI Application's pin from its template at the resolved
// commit and resolves the tag to a digest. Keyed by Application name. Any failure is an error: a
// run that cannot say what it expects must not spend.
func resolveTemplateChartPins(ctx context.Context, fetch templateFileFetcher, res ociDigestResolver, expect []templateAppExpect, commits map[string]string) (map[string]ociChartPin, error) {
	out := map[string]ociChartPin{}
	for _, e := range expect {
		if e.Source != templateSourceOCI {
			continue
		}
		if e.Repo == "" || e.PinFile == "" {
			return nil, fmt.Errorf("%s: an OCI Application must name its template repo and pin file", e.Application)
		}
		commit := commits[e.Repo]
		if commit == "" {
			return nil, fmt.Errorf("%s: no commit resolved for %s", e.Application, e.Repo)
		}
		raw, err := fetch(ctx, e.Repo, commit, e.PinFile)
		if err != nil {
			return nil, fmt.Errorf("%s: read %s@%s: %w", e.Application, e.PinFile, commit, err)
		}
		pin, err := parseAddonPin(e.PinFile, raw)
		if err != nil {
			return nil, fmt.Errorf("%s@%s: %w", e.Repo, commit, err)
		}
		digest, err := res.ResolveDigest(ctx, pin.RepoURL, pin.Tag)
		if err != nil {
			return nil, fmt.Errorf("%s: resolve %s:%s to a manifest digest: %w", e.Application, pin.RepoURL, pin.Tag, err)
		}
		if !isSHA256Digest(digest) {
			return nil, fmt.Errorf("%s: %s:%s resolved to %q, not a sha256 digest", e.Application, pin.RepoURL, pin.Tag, digest)
		}
		pin.Digest = digest
		out[e.Application] = pin
	}
	return out, nil
}

// isSHA256Digest reports whether s is `sha256:` followed by 64 lowercase hex characters.
func isSHA256Digest(s string) bool {
	h, ok := strings.CutPrefix(s, "sha256:")
	return ok && len(h) == 64 && strings.Trim(h, "0123456789abcdef") == ""
}

// judgeOCIRevision is the verdict over one OCI Application against its pre-spend pin. Empty means
// proven.
func judgeOCIRevision(o templateAppObserved, pin ociChartPin, have bool) []string {
	switch {
	case !have || pin.Tag == "":
		return []string{"no chart pin was resolved from the template before the run — cannot say which version it pins"}
	case pin.Digest == "":
		return []string{fmt.Sprintf("the pinned version %q was never resolved to a manifest digest — cannot judge a synced revision", pin.Tag)}
	case normOCIRepo(o.RepoURL) != normOCIRepo(pin.RepoURL):
		return []string{fmt.Sprintf("source %q is not the OCI chart the template pins (%q in %s)", o.RepoURL, pin.RepoURL, pin.File)}
	case o.TargetRevision != pin.Tag:
		return []string{fmt.Sprintf("targetRevision %q is not the version the template pins (%q in %s)", o.TargetRevision, pin.Tag, pin.File)}
	case o.Revision != pin.Tag && o.Revision != pin.Digest:
		return []string{fmt.Sprintf("synced revision %q is not the pinned chart version %q nor its manifest digest %q", o.Revision, pin.Tag, pin.Digest)}
	}
	return nil
}

// fetchTemplateFileRaw reads a public GitHub template file at a commit, anonymously.
func fetchTemplateFileRaw(ctx context.Context, repo, commit, file string) ([]byte, error) {
	slug, ok := strings.CutPrefix(strings.TrimSuffix(repo, ".git"), "https://github.com/")
	if !ok {
		return nil, fmt.Errorf("%s is not a github.com repository", repo)
	}
	u := "https://raw.githubusercontent.com/" + slug + "/" + commit + "/" + file
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: %s", u, resp.Status)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 1<<20))
}

// ociManifestAccept is the manifest media types an OCI client (oras-go, which ArgoCD uses) asks
// for when resolving a tag.
const ociManifestAccept = "application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, " +
	"application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json"

// registryDigestResolver resolves a tag over the registry v2 API, anonymously: a bearer-token
// challenge is answered with an anonymous token, and redirects (registry.k8s.io → Artifact
// Registry) are followed.
type registryDigestResolver struct {
	client *http.Client
	// scheme is "https" when empty; tests point it at an httptest server.
	scheme string
}

// ResolveDigest returns the sha256 of the manifest the registry serves for tag — computed over the
// bytes, and cross-checked against Docker-Content-Digest when the registry sends one.
func (r registryDigestResolver) ResolveDigest(ctx context.Context, repoURL, tag string) (string, error) {
	ref, ok := strings.CutPrefix(repoURL, "oci://")
	host, repo, cut := strings.Cut(strings.TrimSuffix(ref, "/"), "/")
	if !ok || !cut || host == "" || repo == "" {
		return "", fmt.Errorf("%q is not oci://<host>/<repository>", repoURL)
	}
	client := r.client
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	scheme := r.scheme
	if scheme == "" {
		scheme = "https"
	}
	u := scheme + "://" + host + "/v2/" + repo + "/manifests/" + url.PathEscape(tag)

	resp, err := r.getManifest(ctx, client, u, "")
	if err != nil {
		return "", err
	}
	if resp.StatusCode == http.StatusUnauthorized {
		challenge := resp.Header.Get("Www-Authenticate")
		resp.Body.Close()
		token, terr := anonymousRegistryToken(ctx, client, challenge)
		if terr != nil {
			return "", terr
		}
		if resp, err = r.getManifest(ctx, client, u, token); err != nil {
			return "", err
		}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GET %s: %s", u, resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(body)
	digest := "sha256:" + hex.EncodeToString(sum[:])
	if h := resp.Header.Get("Docker-Content-Digest"); strings.HasPrefix(h, "sha256:") && h != digest {
		return "", fmt.Errorf("GET %s: Docker-Content-Digest %s but the body hashes to %s", u, h, digest)
	}
	return digest, nil
}

// getManifest issues one manifest GET, with a bearer token when one is given.
func (registryDigestResolver) getManifest(ctx context.Context, client *http.Client, u, token string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", ociManifestAccept)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return client.Do(req)
}

// parseBearerChallenge reads `Bearer realm="…",service="…",scope="…"` into its parameters.
func parseBearerChallenge(h string) (map[string]string, error) {
	rest, ok := strings.CutPrefix(strings.TrimSpace(h), "Bearer ")
	if !ok {
		return nil, fmt.Errorf("unsupported auth challenge %q", h)
	}
	params := map[string]string{}
	for rest = strings.TrimSpace(rest); rest != ""; {
		k, v, found := strings.Cut(rest, "=")
		if !found {
			break
		}
		k = strings.TrimSpace(k)
		if strings.HasPrefix(v, `"`) {
			end := strings.Index(v[1:], `"`)
			if end < 0 {
				return nil, fmt.Errorf("unterminated quote in auth challenge %q", h)
			}
			params[k], rest = v[1:end+1], v[end+2:]
		} else {
			val, after, _ := strings.Cut(v, ",")
			params[k], rest = val, ","+after
		}
		rest = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(rest), ","))
	}
	if params["realm"] == "" {
		return nil, fmt.Errorf("auth challenge %q names no realm", h)
	}
	return params, nil
}

// anonymousRegistryToken answers a bearer challenge with an anonymous pull token.
func anonymousRegistryToken(ctx context.Context, client *http.Client, challenge string) (string, error) {
	p, err := parseBearerChallenge(challenge)
	if err != nil {
		return "", err
	}
	q := url.Values{}
	for _, k := range []string{"service", "scope"} {
		if p[k] != "" {
			q.Set(k, p[k])
		}
	}
	u := p["realm"]
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("anonymous token from %s: %s", p["realm"], resp.Status)
	}
	var tok struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&tok); err != nil {
		return "", fmt.Errorf("anonymous token from %s: %w", p["realm"], err)
	}
	switch {
	case tok.Token != "":
		return tok.Token, nil
	case tok.AccessToken != "":
		return tok.AccessToken, nil
	}
	return "", errors.New("anonymous token response carried no token")
}
