// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// The operator rail. Kubernetes operators (RabbitMQ's cluster-operator, and many others) ship as a
// single `kubectl apply` release manifest, NOT a Helm chart — and an ArgoCD Application source can
// only be a git repo, a Helm chart, or a plugin, never a bare https://…yaml. So a manifest-source
// add-on (types.AddOnInstall.Source == "manifest") is fetched from its PINNED url and applied by the
// runner with server-side apply — the same path the Talos/Hetzner CNI+CSI bootstrap manifests
// already take (provisioner.applyBootstrapManifests).
//
// Ordering is the whole point: these install BEFORE RenderManagedAddOns/ApplyAddOns write the Helm
// Applications, and the runner then WAITS for the CRDs they own to become Established. ArgoCD
// sync-waves do NOT order across separate top-level Applications, so without this an operator and a
// CR that needs its schema (a RabbitmqCluster, a CNPG Cluster) race — the CR's first sync fails with
// "no matches for kind" and the deploy's health read sees the failure.

// manifestFetchTimeout bounds the download of one pinned operator manifest.
const manifestFetchTimeout = 60 * time.Second

// crdEstablishTimeout bounds the wait for one CRD to reach condition=Established.
const crdEstablishTimeout = 2 * time.Minute

// ManifestAddOns returns the manifest-source add-ons among `addons` (the operator wave), preserving
// order. Managed-mode only: a gitops-mode add-on is written into the customer's apps repo instead.
func ManifestAddOns(addons []types.AddOnInstall) []types.AddOnInstall {
	out := make([]types.AddOnInstall, 0, len(addons))
	for _, a := range addons {
		if a.Mode == "managed" && a.IsManifestSource() {
			out = append(out, a)
		}
	}
	return out
}

// fetchManifest downloads a pinned manifest URL. The URL must be an explicit, version-pinned
// release artifact — never a floating "latest" — so a deploy is reproducible and an upstream
// re-tag can't silently change what lands in the cluster.
func fetchManifest(ctx context.Context, url string) (string, error) {
	reqCtx, cancel := context.WithTimeout(ctx, manifestFetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return "", fmt.Errorf("bad manifest url %q: %w", url, err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch manifest %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fetch manifest %s: HTTP %d", url, resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read manifest %s: %w", url, err)
	}
	if strings.TrimSpace(string(body)) == "" {
		return "", fmt.Errorf("manifest %s is empty", url)
	}
	return string(body), nil
}

// applyManifestServerSide writes a manifest to a temp file and server-side applies it. Server-side
// apply handles a CRD and its CRs in one pass far more gracefully than a plain apply (same reason
// the bootstrap path uses it), and --force-conflicts makes a re-deploy idempotent when a field is
// already owned by a previous apply.
func applyManifestServerSide(manifest string, stdout, stderr io.Writer) error {
	dir, err := os.MkdirTemp("", "alethia-addon-manifest-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "manifest.yaml")
	if err := os.WriteFile(path, []byte(manifest), 0o600); err != nil {
		return err
	}
	cmd := fmt.Sprintf("kubectl apply --server-side --force-conflicts -f %s", path)
	if err := utils.ExecuteCommand(cmd, ".", nil, stdout, stderr); err != nil {
		return fmt.Errorf("kubectl apply failed: %w", err)
	}
	return nil
}

// waitForCRDEstablished blocks until the named CRD reports condition=Established, so a CR that
// needs its schema can't be synced against an API server that doesn't know the kind yet.
func waitForCRDEstablished(crd string, stdout, stderr io.Writer) error {
	cmd := fmt.Sprintf(
		"kubectl wait --for=condition=established --timeout=%ds crd/%s",
		int(crdEstablishTimeout.Seconds()), crd,
	)
	if err := utils.ExecuteCommand(cmd, ".", nil, stdout, stderr); err != nil {
		return fmt.Errorf("CRD %s never became Established: %w", crd, err)
	}
	return nil
}

// ApplyManifestAddOns installs the operator wave: fetch each pinned manifest, server-side apply it,
// then wait for the CRDs it owns to become Established. Call it BEFORE rendering/applying the Helm
// add-on Applications so a CR never races the operator that owns its schema.
//
// Fail-soft, matching the rest of the add-on stage ("a bad add-on must not fail an otherwise-healthy
// cluster", deploy.go): a failure is reported to stderr and the add-on is skipped — its dependent CR
// will then sit un-synced and surface as unhealthy in the console, which is the honest outcome. The
// returned error is non-nil only if EVERY manifest add-on failed, so a caller can distinguish "the
// operator rail is broken" from "one operator had a bad day".
func ApplyManifestAddOns(ctx context.Context, addons []types.AddOnInstall, stdout, stderr io.Writer) error {
	manifests := ManifestAddOns(addons)
	if len(manifests) == 0 {
		return nil
	}
	fmt.Fprintf(stdout, "Installing %d operator manifest(s) before the add-on Applications...\n", len(manifests))

	failed := 0
	for _, a := range manifests {
		fmt.Fprintf(stdout, "  → %s (%s @ %s)\n", a.ID, a.ChartRepo, a.Version)
		body, err := fetchManifest(ctx, a.ChartRepo)
		if err != nil {
			fmt.Fprintf(stderr, "Warning: add-on %s: %v\n", a.ID, err)
			failed++
			continue
		}
		if err := applyManifestServerSide(body, stdout, stderr); err != nil {
			fmt.Fprintf(stderr, "Warning: add-on %s: %v\n", a.ID, err)
			failed++
			continue
		}
		crdErr := false
		for _, crd := range a.CRDs {
			if err := waitForCRDEstablished(crd, stdout, stderr); err != nil {
				fmt.Fprintf(stderr, "Warning: add-on %s: %v\n", a.ID, err)
				crdErr = true
			}
		}
		if crdErr {
			failed++
			continue
		}
		fmt.Fprintf(stdout, "  ✓ %s installed\n", a.ID)
	}

	if failed == len(manifests) {
		return fmt.Errorf("all %d operator manifest add-on(s) failed to install", failed)
	}
	return nil
}
