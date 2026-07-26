// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package helmoci

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
	"golang.org/x/mod/semver"
	"oras.land/oras-go/v2/content"
	"oras.land/oras-go/v2/registry/remote"
	"oras.land/oras-go/v2/registry/remote/auth"
)

const (
	// maxManifestBytes caps the manifest JSON we will read. Manifests are a few KiB; this only
	// stops a hostile registry from streaming an unbounded "manifest" into memory.
	maxManifestBytes = 4 << 20 // 4 MiB
	// maxChartLayerBytes caps the compressed chart layer. Real charts are KiB-to-low-MiB; a chart
	// larger than this is not something we want to render in a scan.
	maxChartLayerBytes = 64 << 20 // 64 MiB
	// tagPageSize keeps tag-list pagination predictable across registries.
	tagPageSize = 100
	// maxTagsScanned bounds `*` resolution on a repository with a pathological number of tags.
	maxTagsScanned = 10000
)

// newRepository builds an authenticated (or deliberately anonymous) OCI client for the chart's
// repository. The credential is held only in this client's closure — it is never written to a
// registry config file, never placed on a command line, and never crosses into the sandbox.
func newRepository(ref Ref, creds Creds) (*remote.Repository, error) {
	repo, err := remote.NewRepository(ref.Registry + "/" + ref.Repository)
	if err != nil {
		return nil, fmt.Errorf("invalid OCI reference %s: %w", ref, err)
	}
	repo.TagListPageSize = tagPageSize
	// TLS always, for every customer-supplied reference. Plain HTTP is reachable only from this
	// package's own tests (see egress.go) — a chart reference can never select it, so a chart-repo
	// credential cannot be talked into going out in the clear.
	repo.PlainHTTP = allowInsecureLocalRegistries

	client := &auth.Client{
		// registryHTTPClient wraps oras's retry policy in a dialer that refuses loopback,
		// link-local (cloud metadata) and — by default — private addresses. See egress.go.
		Client: registryHTTPClient(),
		// A scan pulls from exactly one repository, which is what this cache is documented for.
		Cache: auth.NewSingleContextCache(),
	}
	if !creds.empty() {
		// StaticCredential already maps the docker.io alias onto registry-1.docker.io, the host our
		// oci-docker-hub provider's RepoCred URL names.
		client.Credential = auth.StaticCredential(ref.Registry, auth.Credential{
			Username: creds.Username,
			Password: creds.Password,
		})
	}
	// Leaving Credential nil is what makes an anonymous pull work: the client still performs the
	// WWW-Authenticate token dance (ghcr.io and Docker Hub require a bearer token even for public
	// content), it just presents no Basic credential when asking for one.
	repo.Client = client
	return repo, nil
}

// resolveVersion turns a chart version spec into a concrete registry tag. A literal version is used
// as-is (with Helm's `+` → `_` tag encoding applied, since OCI tags cannot contain `+`);
// LatestVersion is resolved to the highest released semver tag in the repository.
func resolveVersion(ctx context.Context, repo *remote.Repository, version string) (string, error) {
	if version != LatestVersion {
		return versionToTag(version), nil
	}

	tags, err := listTags(ctx, repo)
	if err != nil {
		return "", err
	}
	best := highestReleaseTag(tags)
	if best == "" {
		return "", fmt.Errorf("no released semver version found among %d chart tag(s) — pin an explicit chart version", len(tags))
	}
	return best, nil
}

// versionToTag applies Helm's tag encoding: semver build metadata is introduced by `+`, which the
// OCI tag grammar forbids, so Helm stores it as `_`.
func versionToTag(version string) string {
	return strings.ReplaceAll(strings.TrimSpace(version), "+", "_")
}

// tagToSemver reverses that encoding and adds the `v` prefix golang.org/x/mod/semver requires, so
// registry tags can be ordered with the standard comparator.
func tagToSemver(tag string) string {
	v := strings.ReplaceAll(tag, "_", "+")
	if !strings.HasPrefix(v, "v") {
		v = "v" + v
	}
	return v
}

// errTagLimit stops tag pagination once maxTagsScanned is reached; it never reaches the caller.
var errTagLimit = errors.New("tag scan limit reached")

// listTags pages through the repository's tag list. The OCI spec orders tags lexically, not by
// version, so `*` resolution has to read them all rather than take the last page's last entry.
func listTags(ctx context.Context, repo *remote.Repository) ([]string, error) {
	var tags []string
	err := repo.Tags(ctx, "", func(page []string) error {
		tags = append(tags, page...)
		if len(tags) >= maxTagsScanned {
			return errTagLimit
		}
		return nil
	})
	if err != nil && !errors.Is(err, errTagLimit) {
		return nil, fmt.Errorf("list chart versions: %w", err)
	}
	return tags, nil
}

// highestReleaseTag picks the greatest valid semver tag, skipping pre-releases. Resolving `*` to a
// pre-release would scan something the deploy path would not install — Helm and ArgoCD both exclude
// pre-releases from a `*` constraint, and the scan verdict has to describe what actually ships.
func highestReleaseTag(tags []string) string {
	var best string
	for _, t := range tags {
		v := tagToSemver(t)
		if !semver.IsValid(v) || semver.Prerelease(v) != "" {
			continue
		}
		if best == "" {
			best = t
			continue
		}
		switch semver.Compare(v, tagToSemver(best)) {
		case 1:
			best = t
		case 0:
			// Same precedence (build metadata differs) — keep a deterministic winner.
			if t > best {
				best = t
			}
		}
	}
	return best
}

// chartManifest is the subset of an OCI manifest a chart pull needs.
type chartManifest struct {
	// Layer is the descriptor of the packaged chart tarball.
	Layer ocispec.Descriptor
	// Digest is the manifest digest the tag resolved to, for the job log.
	Digest string
}

// resolveChartManifest fetches the artifact manifest for a tag and returns the descriptor of its
// chart tarball layer. It fails closed on anything that is not a Helm chart: an `oci://` reference
// addresses a container image just as readily as a chart, and rendering an image's layers as a
// chart is not a meaningful operation — better a clear error than a confusing empty scan.
func resolveChartManifest(ctx context.Context, repo *remote.Repository, tag string) (chartManifest, error) {
	desc, body, err := repo.FetchReference(ctx, tag)
	if err != nil {
		return chartManifest{}, fmt.Errorf("resolve chart version %q: %w", tag, err)
	}
	defer func() { _ = body.Close() }()

	if desc.Size > maxManifestBytes {
		return chartManifest{}, fmt.Errorf("chart manifest is %d bytes, over the %d byte limit", desc.Size, int64(maxManifestBytes))
	}
	// ReadAll verifies the body against the descriptor's size AND digest, so a substituted or
	// truncated manifest is a read error rather than something we parse.
	raw, err := content.ReadAll(body, desc)
	if err != nil {
		return chartManifest{}, fmt.Errorf("read chart manifest: %w", err)
	}

	if desc.MediaType == ocispec.MediaTypeImageIndex {
		// Helm's own pull tolerates an index, but selecting a child is a platform decision that has
		// no meaning for a chart. Explicit, documented exclusion rather than an arbitrary pick.
		return chartManifest{}, errors.New("multi-manifest (image index) chart artifacts are not supported by the scanner — pin a single-manifest chart version")
	}

	var manifest ocispec.Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return chartManifest{}, fmt.Errorf("parse chart manifest: %w", err)
	}
	if manifest.Config.MediaType != ConfigMediaType {
		return chartManifest{}, fmt.Errorf(
			"%s:%s is not a Helm chart (config media type %q, want %q)",
			repo.Reference.Repository, tag, manifest.Config.MediaType, ConfigMediaType)
	}

	// Select by media type, never by index: `helm push` uploads the provenance layer alongside the
	// chart, so Layers[0] is not reliably the chart.
	for _, layer := range manifest.Layers {
		if layer.MediaType != ChartLayerMediaType && layer.MediaType != LegacyChartLayerMediaType {
			continue
		}
		if layer.Size <= 0 {
			return chartManifest{}, errors.New("chart layer declares no size")
		}
		if layer.Size > maxChartLayerBytes {
			return chartManifest{}, fmt.Errorf(
				"chart layer is %d bytes, over the %d byte scan limit", layer.Size, int64(maxChartLayerBytes))
		}
		return chartManifest{Layer: layer, Digest: desc.Digest.String()}, nil
	}
	return chartManifest{}, fmt.Errorf("chart manifest has no %s layer", ChartLayerMediaType)
}

// fetchChartTarball downloads the chart layer, verified against its descriptor (size + digest) by
// oras. The layer is bounded by maxChartLayerBytes at manifest-resolution time, so holding it in
// memory is safe and lets the extractor work from a verified byte slice rather than a live stream.
func fetchChartTarball(ctx context.Context, repo *remote.Repository, layer ocispec.Descriptor) ([]byte, error) {
	data, err := content.FetchAll(ctx, repo.Blobs(), layer)
	if err != nil {
		return nil, fmt.Errorf("fetch chart layer: %w", err)
	}
	return data, nil
}
