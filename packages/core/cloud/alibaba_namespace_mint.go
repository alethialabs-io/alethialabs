// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	yaml "gopkg.in/yaml.v3"
)

// Alibaba namespace keyless-mint (#1129, a per-cloud lane of #1013). The Alibaba mirror of the AWS EKS
// output-free mint (cloud/aws/eks.go ResolveEKSClusterConn) and the GCP/Azure lanes (#1127/#1128):
// resolve an EXISTING shared-Fabric ACK cluster BY ID — with NO tofu outputs — to its control-plane
// endpoint + CA, so a `namespace` placement can mint keyless kube access onto a cluster it did not
// provision.
//
// ACK exposes the cluster's connection details via DescribeClusterUserKubeconfig
// (GET /k8s/<ClusterId>/user_config), which returns a full kubeconfig whose clusters[0].cluster gives
// both the API-server `server` URL and the `certificate-authority-data`. This lane reads both from it.
//
// Auth model difference (why this lane takes a *signing* client, not a bearer token like GCP/Azure):
// Alibaba's OpenAPI SIGNS every request (HMAC over a canonicalized request) with the caller's
// credentials — for keyless that is the RRSA-derived STS credential (from the pod's OIDC token, never a
// stored key). Request signing depends on the whole request, so it cannot be a static bearer header.
// This lane therefore takes an http.Client whose transport performs that RRSA signing (the wiring builds
// it — using the Alibaba SDK or a manual signer), and does the URL construction + response parsing
// itself. That keeps the lane dependency-free (stdlib + the already-present yaml.v3 — no cloud SDK added
// to packages/core/go.mod) and unit-testable (the test injects a plain client against a stub). Wiring the
// signing client + ResolveACKClusterConn into ConfigureKubeconfig + the namespaceRemintProviders
// allowlist lives in the provider/dispatch files (out of this lane's single-file scope) — the follow-up.
//
// Keyless + fail-closed: an empty/undelivered kubeconfig, or a kubeconfig with no server/CA, returns
// ErrACKClusterNotReady (a retry signal), never a partial conn.

// ErrACKClusterNotReady is returned when an ACK cluster's kubeconfig isn't usable yet — no config was
// returned, or its server/CA is empty. Mirrors aws.ErrClusterNotReady / ErrGKEClusterNotReady /
// ErrAKSClusterNotReady.
var ErrACKClusterNotReady = errors.New("ack cluster is not ready yet")

// ackAPIHostFmt is the region-scoped ACK (Container Service) REST host. Tests redirect via the injected
// http.Client's transport, so the URL construction is still exercised.
const ackAPIHostFmt = "https://cs.%s.aliyuncs.com"

// ACKClusterConn is the connection detail needed to build a kubeconfig for a ready ACK cluster — the
// Alibaba twin of aws.EKSClusterConn. Endpoint is the https API-server URL; CAData is base64 (a PUBLIC
// CA cert, not a secret).
type ACKClusterConn struct {
	Endpoint string
	CAData   string
}

// ackUserConfigResponse is the DescribeClusterUserKubeconfig response — `config` is the kubeconfig.
type ackUserConfigResponse struct {
	Config string `json:"config"`
}

// ackKubeconfigYAML is the slice of the ACK kubeconfig this mint reads.
type ackKubeconfigYAML struct {
	Clusters []struct {
		Cluster struct {
			Server                   string `yaml:"server"`
			CertificateAuthorityData string `yaml:"certificate-authority-data"`
		} `yaml:"cluster"`
	} `yaml:"clusters"`
}

// ResolveACKClusterConn resolves an EXISTING ACK cluster BY ID (no tofu outputs) via
// DescribeClusterUserKubeconfig and safely extracts its endpoint + CA. `client` is a request-SIGNING
// http.Client (its transport carries the runner's keyless RRSA-derived STS signature — never a stored
// key); it requests the PUBLIC API-server kubeconfig (PrivateIpAddress=false). Returns
// ErrACKClusterNotReady — never a partial conn — when no kubeconfig is returned or its server/CA is
// empty. A non-2xx or transport error is wrapped.
func ResolveACKClusterConn(
	ctx context.Context,
	client *http.Client,
	regionID, clusterID string,
) (ACKClusterConn, error) {
	if regionID == "" || clusterID == "" {
		return ACKClusterConn{}, fmt.Errorf("ack mint: region and cluster id must both be set (got %q / %q)", regionID, clusterID)
	}
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}

	rawURL := fmt.Sprintf(ackAPIHostFmt, url.PathEscape(regionID)) +
		"/k8s/" + url.PathEscape(clusterID) + "/user_config?PrivateIpAddress=false"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return ACKClusterConn{}, err
	}
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return ACKClusterConn{}, fmt.Errorf("ack DescribeClusterUserKubeconfig %q: %w", clusterID, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ACKClusterConn{}, fmt.Errorf("ack DescribeClusterUserKubeconfig %q: status %d: %s", clusterID, resp.StatusCode, ackErrSnippet(body))
	}

	var uc ackUserConfigResponse
	if err := json.Unmarshal(body, &uc); err != nil {
		return ACKClusterConn{}, fmt.Errorf("ack DescribeClusterUserKubeconfig %q: decode: %w", clusterID, err)
	}
	if strings.TrimSpace(uc.Config) == "" {
		return ACKClusterConn{}, fmt.Errorf("%w: %q (no kubeconfig returned)", ErrACKClusterNotReady, clusterID)
	}

	server, ca := extractACKServerCA(uc.Config)
	if server == "" || ca == "" {
		return ACKClusterConn{}, fmt.Errorf("%w: %q (kubeconfig missing server/CA)", ErrACKClusterNotReady, clusterID)
	}
	if !strings.HasPrefix(server, "https://") {
		server = "https://" + server
	}
	return ACKClusterConn{Endpoint: server, CAData: ca}, nil
}

// extractACKServerCA parses an ACK kubeconfig (raw YAML, or base64-wrapped as some ACK responses return
// it) and returns the API-server URL + base64 CA. Empty strings when the kubeconfig can't be parsed or
// lacks a cluster entry (the caller treats that as not-ready).
func extractACKServerCA(config string) (server, ca string) {
	parse := func(b []byte) (string, string, bool) {
		var kc ackKubeconfigYAML
		if err := yaml.Unmarshal(b, &kc); err != nil || len(kc.Clusters) == 0 {
			return "", "", false
		}
		return strings.TrimSpace(kc.Clusters[0].Cluster.Server),
			strings.TrimSpace(kc.Clusters[0].Cluster.CertificateAuthorityData),
			true
	}
	if s, c, ok := parse([]byte(config)); ok {
		return s, c
	}
	// Some ACK responses base64-wrap the kubeconfig — decode and retry once.
	if decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(config)); err == nil {
		if s, c, ok := parse(decoded); ok {
			return s, c
		}
	}
	return "", ""
}

// ackErrSnippet bounds an ACK error-response body for a log-safe message.
func ackErrSnippet(b []byte) string {
	const max = 256
	s := strings.TrimSpace(string(b))
	if len(s) > max {
		return s[:max] + "…"
	}
	return s
}
