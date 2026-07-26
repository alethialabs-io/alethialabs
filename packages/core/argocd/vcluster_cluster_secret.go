// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

// vcluster ArgoCD registration (#960 lane, blocked-by the provisioner seam #1239). After the seam
// helm-installs a vcluster with `exportKubeConfig`, the loft chart writes a SCOPED service-account-token
// kubeconfig into a Secret in the host `argocd` namespace (spec.KubeconfigSecret). That is a plain
// kubeconfig Secret — NOT an ArgoCD cluster registration. This file reads it and writes OUR OWN ArgoCD
// `cluster` Secret (labelled `argocd.argoproj.io/secret-type: cluster`) named for the vcluster, so an
// Application/ApplicationSet whose `destination.name = <VClusterName>` resolves to it (the contract in
// applicationset_preview.go / preview_guardrails.go). Pure OSS — we do NOT use the vcluster auto-ArgoCD
// phone-home connector; Alethia owns the register/deregister lifecycle.
//
// Security posture: the kubeconfig carries a bearer token (SA-token mode, short-TTL, scoped ClusterRole).
// It is read from an in-cluster Secret and re-written into another in-cluster Secret in the SAME argocd
// namespace over the already-minted keyless host KUBECONFIG — it NEVER lands in a git-committed manifest
// and is NEVER logged (we log names only). Every identifier is fail-closed-validated before it reaches a
// kubectl command. The cluster Secret carries a prune label but deliberately NO ArgoCD tracking metadata:
// no Application owns it, so nothing syncs it away, and DeregisterVClusterClusterSecret /
// PruneVClusterClusterSecrets GC it on teardown (a leaked cluster Secret would keep a dead vcluster
// registered — the orphan-reclaim hazard the seam header calls out).
//
// Call-site wiring (register after provision, deregister on teardown) is the sibling placement-path lane
// (#1231, deploy_vcluster.go); this file provides the capability + its unit tests only.

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
	"gopkg.in/yaml.v3"
)

// vclusterClusterSecretLabelKey marks an Alethia-written ArgoCD cluster Secret for a vcluster, so
// PruneVClusterClusterSecrets can GC one whose vcluster is gone.
const vclusterClusterSecretLabelKey = "alethia.io/vcluster-cluster"

// vclusterRegisterAttempts / vclusterRegisterDelay bound the wait for the exported kubeconfig Secret: the
// chart writes it asynchronously after the control-plane rolls out, so it (or its token) may briefly lag a
// WaitReady. Kept small — the caller has already waited for readiness.
const (
	vclusterRegisterAttempts = 6
	vclusterRegisterDelay    = 5 * time.Second
)

// kubeconfigDoc is the minimal kubeconfig shape we read out of the vcluster-exported Secret: the first
// cluster's server + CA data and the first user's bearer token. Parsing the full `config` kubeconfig (vs
// trusting discrete Secret keys) keeps this robust across vcluster chart versions.
type kubeconfigDoc struct {
	Clusters []struct {
		Cluster struct {
			Server                   string `yaml:"server"`
			CertificateAuthorityData string `yaml:"certificate-authority-data"`
		} `yaml:"cluster"`
	} `yaml:"clusters"`
	Users []struct {
		User struct {
			Token string `yaml:"token"`
		} `yaml:"user"`
	} `yaml:"users"`
}

// parseKubeconfigForCluster pulls the server URL, base64 CA data, and bearer token out of a
// vcluster-exported kubeconfig (SA-token mode). Fail-closed: errors if any of the three is absent, so a
// half-written Secret never yields a broken cluster registration. certificate-authority-data is already
// base64 PEM — exactly ArgoCD's tlsClientConfig.caData — so it is returned verbatim.
func parseKubeconfigForCluster(kubeconfigYAML []byte) (server, caData, token string, err error) {
	var doc kubeconfigDoc
	if err = yaml.Unmarshal(kubeconfigYAML, &doc); err != nil {
		return "", "", "", fmt.Errorf("parse vcluster kubeconfig: %w", err)
	}
	if len(doc.Clusters) == 0 {
		return "", "", "", fmt.Errorf("vcluster kubeconfig has no clusters")
	}
	if len(doc.Users) == 0 {
		return "", "", "", fmt.Errorf("vcluster kubeconfig has no users")
	}
	server = doc.Clusters[0].Cluster.Server
	caData = doc.Clusters[0].Cluster.CertificateAuthorityData
	token = doc.Users[0].User.Token
	if server == "" {
		return "", "", "", fmt.Errorf("vcluster kubeconfig has no cluster server")
	}
	if token == "" {
		return "", "", "", fmt.Errorf("vcluster kubeconfig has no user token")
	}
	if caData == "" {
		return "", "", "", fmt.Errorf("vcluster kubeconfig has no certificate-authority-data")
	}
	return server, caData, token, nil
}

// vclusterClusterConfigJSON renders the ArgoCD cluster Secret `config` value: the bearer token + the CA
// data (tlsClientConfig, no client cert — SA-token auth). Marshalled via encoding/json so the token/CA are
// correctly escaped. caData is already base64 (from certificate-authority-data), which is what ArgoCD wants.
func vclusterClusterConfigJSON(caData, token string) (string, error) {
	cfg := struct {
		BearerToken     string `json:"bearerToken"`
		TLSClientConfig struct {
			CAData string `json:"caData"`
		} `json:"tlsClientConfig"`
	}{BearerToken: token}
	cfg.TLSClientConfig.CAData = caData
	b, err := json.Marshal(cfg)
	if err != nil {
		return "", fmt.Errorf("marshal vcluster cluster config: %w", err)
	}
	return string(b), nil
}

// vclusterClusterSecretManifest renders the ArgoCD `cluster` Secret. `name` (metadata + the `name` data
// key) equals the vcluster name so an env's `destination.name = <VClusterName>` resolves against it.
// server/config are base64'd into `data` and NEVER logged. Mirrors helmRepoCredManifest.
func vclusterClusterSecretManifest(name, server, configJSON string) string {
	b64 := func(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
	return fmt.Sprintf(`apiVersion: v1
kind: Secret
metadata:
  name: %s
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: cluster
    %s: "true"
type: Opaque
data:
  name: %s
  server: %s
  config: %s
`, name, vclusterClusterSecretLabelKey, b64(name), b64(server), b64(configJSON))
}

// readExportedKubeconfig reads the vcluster-exported kubeconfig Secret and returns its decoded `config`
// (the full kubeconfig). Both identifiers are already validated by the caller before interpolation.
func readExportedKubeconfig(secretName, namespace string) ([]byte, error) {
	raw, err := utils.ExecuteCommandWithOutput(
		fmt.Sprintf("kubectl get secret %s -n %s -o json", secretName, namespace),
		".",
		nil,
	)
	if err != nil {
		return nil, fmt.Errorf("read exported kubeconfig Secret %s/%s: %w", namespace, secretName, err)
	}
	var secret struct {
		Data map[string]string `json:"data"`
	}
	if err := json.Unmarshal([]byte(raw), &secret); err != nil {
		return nil, fmt.Errorf("parse exported kubeconfig Secret %s/%s: %w", namespace, secretName, err)
	}
	encoded, ok := secret.Data["config"]
	if !ok || encoded == "" {
		return nil, fmt.Errorf("exported kubeconfig Secret %s/%s has no config key yet", namespace, secretName)
	}
	kubeconfig, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("decode exported kubeconfig Secret %s/%s: %w", namespace, secretName, err)
	}
	return kubeconfig, nil
}

// EnsureVClusterClusterSecret reads the vcluster-exported kubeconfig Secret (kubeconfigSecretName in
// kubeconfigNamespace) and registers the vcluster with the host ArgoCD as a cluster Secret named
// clusterName. Idempotent — re-applying refreshes a rotated token every deploy. Bounded-retries the read
// because the chart writes the exported Secret asynchronously. Fail-closed on odd identifiers (they
// interpolate into kubectl); the token/CA are never logged.
func EnsureVClusterClusterSecret(clusterName, kubeconfigSecretName, kubeconfigNamespace string, stdout, stderr io.Writer) error {
	if !k8sNameRe.MatchString(clusterName) {
		return fmt.Errorf("refusing to register vcluster with invalid cluster name %q", clusterName)
	}
	if !k8sNameRe.MatchString(kubeconfigSecretName) || !k8sNameRe.MatchString(kubeconfigNamespace) {
		return fmt.Errorf("refusing to read exported kubeconfig from invalid Secret ref %q/%q", kubeconfigNamespace, kubeconfigSecretName)
	}

	var lastErr error
	for attempt := 1; attempt <= vclusterRegisterAttempts; attempt++ {
		kubeconfig, err := readExportedKubeconfig(kubeconfigSecretName, kubeconfigNamespace)
		if err != nil {
			lastErr = err
		} else {
			server, caData, token, perr := parseKubeconfigForCluster(kubeconfig)
			if perr != nil {
				lastErr = perr
			} else {
				configJSON, cerr := vclusterClusterConfigJSON(caData, token)
				if cerr != nil {
					return cerr // a marshal failure won't fix itself on retry
				}
				fmt.Fprintf(stdout, "Registering vcluster %s with ArgoCD (server %s)...\n", clusterName, server)
				return ApplyManifest(vclusterClusterSecretManifest(clusterName, server, configJSON), stdout, stderr)
			}
		}
		if attempt < vclusterRegisterAttempts {
			fmt.Fprintf(stderr, "Waiting for vcluster %s exported kubeconfig (attempt %d/%d): %v\n",
				clusterName, attempt, vclusterRegisterAttempts, lastErr)
			time.Sleep(vclusterRegisterDelay)
		}
	}
	return fmt.Errorf("register vcluster %s: exported kubeconfig not ready after %d attempts: %w",
		clusterName, vclusterRegisterAttempts, lastErr)
}

// DeregisterVClusterClusterSecret deletes the ArgoCD cluster Secret for a torn-down vcluster. Best-effort
// + idempotent (--ignore-not-found). Fail-closed on an odd name.
func DeregisterVClusterClusterSecret(clusterName string, stdout, stderr io.Writer) error {
	if !k8sNameRe.MatchString(clusterName) {
		return fmt.Errorf("refusing to deregister vcluster with invalid cluster name %q", clusterName)
	}
	fmt.Fprintf(stdout, "Deregistering vcluster %s from ArgoCD...\n", clusterName)
	cmd := fmt.Sprintf("kubectl delete secret %s -n argocd --ignore-not-found=true", clusterName)
	return utils.ExecuteCommand(cmd, ".", nil, stdout, stderr)
}

// PruneVClusterClusterSecrets deletes Alethia-written ArgoCD cluster Secrets in the argocd namespace whose
// vcluster is no longer desired (mirrors PruneHelmRepoCredentials). Best-effort + idempotent — runs even
// with an empty desired set so a removed vcluster's registration is cleaned up.
func PruneVClusterClusterSecrets(desiredNames []string, stdout, stderr io.Writer) {
	desired := make(map[string]struct{}, len(desiredNames))
	for _, n := range desiredNames {
		desired[n] = struct{}{}
	}
	raw, err := utils.ExecuteCommandWithOutput(
		fmt.Sprintf("kubectl get secrets -n argocd -l %s -o json", vclusterClusterSecretLabelKey),
		".",
		nil,
	)
	if err != nil {
		fmt.Fprintf(stderr, "Warning: could not list vcluster cluster Secrets to prune: %v\n", err)
		return
	}
	var list struct {
		Items []struct {
			Metadata struct {
				Name      string `json:"name"`
				Namespace string `json:"namespace"`
			} `json:"metadata"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		fmt.Fprintf(stderr, "Warning: could not parse vcluster cluster Secret list to prune: %v\n", err)
		return
	}
	for _, item := range list.Items {
		if _, keep := desired[item.Metadata.Name]; keep {
			continue
		}
		// The name/namespace interpolate into a kubectl command; fail closed on anything the API server
		// wouldn't already constrain to a DNS label.
		if !k8sNameRe.MatchString(item.Metadata.Name) || !k8sNameRe.MatchString(item.Metadata.Namespace) {
			fmt.Fprintf(stderr, "Warning: skipping prune of oddly-named vcluster cluster Secret %q/%q\n", item.Metadata.Namespace, item.Metadata.Name)
			continue
		}
		fmt.Fprintf(stdout, "Pruning stale vcluster cluster Secret: %s/%s\n", item.Metadata.Namespace, item.Metadata.Name)
		cmd := fmt.Sprintf("kubectl delete secret -n %s %s --ignore-not-found=true",
			item.Metadata.Namespace, item.Metadata.Name)
		if delErr := utils.ExecuteCommand(cmd, ".", nil, stdout, stderr); delErr != nil {
			fmt.Fprintf(stderr, "Warning: failed to prune vcluster cluster Secret %s/%s: %v\n",
				item.Metadata.Namespace, item.Metadata.Name, delErr)
		}
	}
}
