// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package helmoci pulls a Helm chart from an OCI registry in pure Go — no `helm` binary, no
// `helm registry login`, and no on-disk registry config. It exists so the runner's CHART_SCAN can
// see bring-your-own charts attached as `oci://<host>/<ns>/<chart>`, which the git-clone scan path
// structurally cannot reach.
//
// The trust boundary it is built for: the PULL runs in the runner's trusted parent (which holds the
// chart-repo credential and has egress) and lands a plain chart directory in the per-job workdir;
// the untrusted `helm template` render then happens in the deny-all-egress sandbox over that
// directory, exactly as it does for a git-cloned chart. Keeping the pull pure-Go means the
// credential never leaves process memory — there is no registry config file to write, leak or
// clean up.
//
// Everything here is fail-closed: the artifact must declare Helm's own config media type, the chart
// layer is content-verified against its descriptor digest, and extraction refuses anything that is
// not a plain file or directory inside the destination.
package helmoci

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// Helm's OCI media types, verbatim from helm/pkg/registry/constants.go. A pulled artifact must
// declare ConfigMediaType or we refuse it — an OCI reference can point at a container image just as
// easily as a chart, and rendering an image's layers as a chart is not a meaningful operation.
const (
	// ConfigMediaType is the config blob media type every Helm chart artifact declares.
	ConfigMediaType = "application/vnd.cncf.helm.config.v1+json"
	// ChartLayerMediaType is the layer holding the packaged chart tarball.
	ChartLayerMediaType = "application/vnd.cncf.helm.chart.content.v1.tar+gzip"
	// ProvLayerMediaType is the optional provenance layer. We ignore it — the scan renders the
	// chart, it does not verify a signature.
	ProvLayerMediaType = "application/vnd.cncf.helm.chart.provenance.v1.prov"
	// LegacyChartLayerMediaType is the pre-3.7 chart layer type, still accepted by Helm itself.
	LegacyChartLayerMediaType = "application/tar+gzip"
)

// LatestVersion is the version spec meaning "resolve the highest released chart version". It is the
// value the console stores for an OCI chart attached without an explicit version, and the same
// token ArgoCD uses as a targetRevision.
const LatestVersion = "*"

// Ref is a parsed `oci://` chart reference: the registry host, the full repository path (namespace
// plus chart name, which is how OCI addresses a chart), and the requested version.
type Ref struct {
	// Registry is the host[:port], e.g. "ghcr.io".
	Registry string
	// Repository is the path under the host, e.g. "acme/charts/redis". The last segment is the
	// chart name — OCI has no separate chart coordinate.
	Repository string
	// Version is a concrete chart version ("1.2.3") or LatestVersion.
	Version string
}

// String renders the reference back to its canonical `oci://host/repo` form (without the version),
// which is also the string ArgoCD prefix-matches a repository credential against.
func (r Ref) String() string {
	return "oci://" + r.Registry + "/" + r.Repository
}

// Creds is a static chart-repo credential. The zero value means an anonymous pull, which is the
// correct behaviour for a public chart: a project need not connect a chart-repo connector to scan
// one.
type Creds struct {
	Username string
	Password string
}

// empty reports whether no credential was supplied, so the caller pulls anonymously rather than
// sending an empty Basic header (which some registries reject outright).
func (c Creds) empty() bool { return c.Username == "" && c.Password == "" }

// ParseChartRef parses an `oci://<host>/<namespace...>/<chart>` chart reference. It is deliberately
// strict — a reference that carries a scheme we do not expect, a port-less bare host with no chart
// segment, or any user-info/query/fragment is rejected rather than coerced, because the result is
// fed straight into a network call.
func ParseChartRef(chartRepo, version string) (Ref, error) {
	raw := strings.TrimSpace(chartRepo)
	if !strings.HasPrefix(strings.ToLower(raw), "oci://") {
		return Ref{}, fmt.Errorf("not an OCI chart reference: %q", raw)
	}
	u, err := url.Parse(raw)
	if err != nil {
		return Ref{}, fmt.Errorf("parse chart reference: %w", err)
	}
	if u.User != nil {
		// Credentials belong in the connector, never inline in a chart URL.
		return Ref{}, errors.New("chart reference must not embed credentials")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return Ref{}, errors.New("chart reference must not carry a query or fragment")
	}
	host := strings.ToLower(u.Host)
	if host == "" {
		return Ref{}, errors.New("chart reference has no registry host")
	}
	repo := strings.Trim(u.Path, "/")
	if repo == "" {
		return Ref{}, errors.New("chart reference has no repository path (expected oci://host/namespace/chart)")
	}
	// OCI repository names are lowercase by spec; registries reject anything else, so fail here with
	// a comprehensible message instead of on a 400 from the registry.
	if repo != strings.ToLower(repo) {
		return Ref{}, fmt.Errorf("OCI repository path must be lowercase: %q", repo)
	}
	v := strings.TrimSpace(version)
	if v == "" {
		v = LatestVersion
	}
	return Ref{Registry: host, Repository: repo, Version: v}, nil
}

// Result describes a completed pull: where the chart was unpacked and which concrete version was
// resolved (which matters when the caller asked for LatestVersion).
type Result struct {
	// ChartDir is the directory containing Chart.yaml — ready for `helm template`.
	ChartDir string
	// Version is the concrete chart version that was pulled.
	Version string
	// Digest is the manifest digest the chart was resolved to, for the job log.
	Digest string
}

// Pull fetches the chart described by ref into destDir and unpacks it, returning the directory that
// holds Chart.yaml. It resolves LatestVersion against the registry's tag list, verifies the artifact
// is genuinely a Helm chart, content-verifies the chart layer against its digest, and extracts it
// under the size/shape limits in extract.go.
//
// destDir must already exist and be owned by the caller; Pull writes only beneath it.
func Pull(ctx context.Context, ref Ref, creds Creds, destDir string) (Result, error) {
	repo, err := newRepository(ref, creds)
	if err != nil {
		return Result{}, err
	}

	tag, err := resolveVersion(ctx, repo, ref.Version)
	if err != nil {
		return Result{}, err
	}

	manifest, err := resolveChartManifest(ctx, repo, tag)
	if err != nil {
		return Result{}, err
	}

	tarball, err := fetchChartTarball(ctx, repo, manifest.Layer)
	if err != nil {
		return Result{}, err
	}

	// Unpack under a per-pull subdirectory so a chart tarball can never collide with anything else
	// the caller keeps in destDir (the runner shares the job workdir with the sandbox stage files).
	root := filepath.Join(destDir, "chart")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return Result{}, fmt.Errorf("create chart dir: %w", err)
	}

	chartDir, err := extractChartTarGz(bytes.NewReader(tarball), root)
	if err != nil {
		return Result{}, err
	}

	return Result{ChartDir: chartDir, Version: tag, Digest: manifest.Digest}, nil
}
