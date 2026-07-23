// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// GCP namespace keyless-mint (#1127, a per-cloud lane of #1013). The GCP mirror of the AWS EKS
// output-free mint (cloud/aws/eks.go's ResolveEKSClusterConn): resolve an EXISTING shared-Fabric GKE
// cluster BY NAME — with NO tofu outputs — to its control-plane endpoint + CA, so a `namespace`
// placement can mint keyless kube access onto a cluster it did not provision.
//
// It calls the GKE `projects.locations.clusters.get` REST endpoint directly with a keyless bearer
// token (the runner's Workload-Identity-Federated OAuth token — never a stored key), which keeps this
// lane dependency-free (stdlib only — no cloud SDK added to packages/core, so the per-cloud lanes stay
// disjoint and don't contend on go.mod). The returned endpoint + CA feed the GCP provider's
// ConfigureKubeconfig exactly like the tofu-output `gke_cluster_endpoint` / `gke_cluster_ca_certificate`
// values do (it writes the in-process `kube-token --provider gcp` exec-plugin kubeconfig). Wiring this
// resolver into ConfigureKubeconfig + adding "gcp" to the namespaceRemintProviders allowlist lives in
// the provider/dispatch files (out of this lane's single-file scope) and is the activation follow-up.
//
// Keyless + fail-closed: the token is sent as a bearer and NEVER logged; a non-RUNNING cluster or any
// missing connection field returns ErrGKEClusterNotReady (a retry signal), never a partial conn.

// ErrGKEClusterNotReady is returned when a GKE cluster exists but its control-plane connection details
// aren't usable yet — it isn't RUNNING, or the endpoint / CA is still empty. Callers must treat this as
// "retry later", never by using the (empty) fields. Mirrors aws.ErrClusterNotReady.
var ErrGKEClusterNotReady = errors.New("gke cluster is not RUNNING yet")

// gkeContainerAPIBase is the GKE REST base URL. A const in production; tests redirect via the injected
// http.Client's transport (they never mutate this), so the resolver's URL construction is exercised.
const gkeContainerAPIBase = "https://container.googleapis.com"

// GKEClusterConn is the connection detail needed to build a kubeconfig for a ready GKE cluster — the
// GCP twin of aws.EKSClusterConn. Endpoint is the bare control-plane host as GKE reports it (the caller
// prefixes https:// exactly as ConfigureKubeconfig already does); CAData is base64 (a PUBLIC CA cert,
// not a secret).
type GKEClusterConn struct {
	Endpoint string
	CAData   string
}

// GKEClusterResourceName builds the GKE REST resource name projects/<p>/locations/<l>/clusters/<c>.
// Each segment is path-escaped defensively (GKE ids are already restricted, but the cluster name flows
// from the config snapshot — the runner is the trust boundary).
func GKEClusterResourceName(projectID, location, clusterName string) string {
	return fmt.Sprintf(
		"projects/%s/locations/%s/clusters/%s",
		url.PathEscape(projectID),
		url.PathEscape(location),
		url.PathEscape(clusterName),
	)
}

// gkeClusterResponse is the slice of the GKE Cluster resource this mint reads.
type gkeClusterResponse struct {
	Endpoint   string `json:"endpoint"`
	Status     string `json:"status"`
	MasterAuth struct {
		ClusterCaCertificate string `json:"clusterCaCertificate"`
	} `json:"masterAuth"`
}

// ResolveGKEClusterConn resolves an EXISTING GKE cluster BY NAME (no tofu outputs) via the GKE
// clusters.get REST API and safely extracts its endpoint + CA. `accessToken` is a short-lived keyless
// GCP OAuth token (Workload Identity Federation) with a scope that permits container.clusters.get; it
// is sent as a bearer and never logged. Returns ErrGKEClusterNotReady — never a partial conn — when the
// cluster isn't RUNNING or the endpoint/CA is empty. A non-200 or transport error is wrapped (the token
// is never included in the message).
func ResolveGKEClusterConn(
	ctx context.Context,
	client *http.Client,
	accessToken, projectID, location, clusterName string,
) (GKEClusterConn, error) {
	if strings.TrimSpace(accessToken) == "" {
		return GKEClusterConn{}, errors.New("gke mint: empty access token (a keyless WIF OAuth token is required)")
	}
	if projectID == "" || location == "" || clusterName == "" {
		return GKEClusterConn{}, fmt.Errorf(
			"gke mint: project, location and cluster must all be set (got %q / %q / %q)",
			projectID, location, clusterName,
		)
	}
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}

	endpoint := gkeContainerAPIBase + "/v1/" + GKEClusterResourceName(projectID, location, clusterName)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return GKEClusterConn{}, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return GKEClusterConn{}, fmt.Errorf("gke clusters.get %q: %w", clusterName, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return GKEClusterConn{}, fmt.Errorf(
			"gke clusters.get %q: status %d: %s", clusterName, resp.StatusCode, bodySnippet(body),
		)
	}

	var c gkeClusterResponse
	if err := json.Unmarshal(body, &c); err != nil {
		return GKEClusterConn{}, fmt.Errorf("gke clusters.get %q: decode: %w", clusterName, err)
	}
	if c.Status != "RUNNING" ||
		strings.TrimSpace(c.Endpoint) == "" ||
		strings.TrimSpace(c.MasterAuth.ClusterCaCertificate) == "" {
		return GKEClusterConn{}, fmt.Errorf("%w: %q (status %q)", ErrGKEClusterNotReady, clusterName, c.Status)
	}
	return GKEClusterConn{Endpoint: c.Endpoint, CAData: c.MasterAuth.ClusterCaCertificate}, nil
}

// bodySnippet bounds an error-response body for a log-safe message (GKE error bodies carry an error
// message, never credentials — but keep it short regardless).
func bodySnippet(b []byte) string {
	const max = 256
	s := strings.TrimSpace(string(b))
	if len(s) > max {
		return s[:max] + "…"
	}
	return s
}
