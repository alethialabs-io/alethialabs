// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"fmt"
	"strings"
)

// The GKE platform ingress: what the runner has to render so an Ingress on GKE actually exists and
// actually carries the project's Cloud Armor policy.
//
// There is NO controller to install. GKE's Ingress controller runs in the Google-managed control
// plane, gated on the cluster's HTTP(S) Load Balancing add-on, which modules/gke enables
// unconditionally — so unlike AWS (whose aws-load-balancer-controller.yaml is a real ArgoCD
// Application) this file adds no template and nothing new to bake into the runner image. What the
// platform must render is two small objects:
//
//   - a BackendConfig, the ONLY way a Cloud Armor policy binds to a Kubernetes workload: Cloud Armor
//     attaches to a GCLB BACKEND SERVICE, and `spec.securityPolicy.name` is what tells GKE which
//     policy to put on the backend service it creates for a Service;
//   - the argo-cd chart values that turn on the `gce` Ingress, put the Google-managed certificate on
//     it, and point the ArgoCD server Service at the BackendConfig above.
//
// The values are a FILE, not a pile of `--set` flags like the AWS path. The backend-config
// annotation's value is the JSON document `{"default":"argocd-server"}`, and helm's `--set` parser
// reads a value that starts with `{` and ends with `}` as a LIST literal — so the annotation cannot
// be expressed as a `--set` at all without relying on escaping behaviour that differs across helm
// versions. YAML has no such ambiguity, and it lets the Service be created ALREADY annotated:
// annotating it after the install would leave a window in which the load balancer is provisioned
// with no security policy on it, which is the exact gap this lane exists to close.

// GKEBackendConfigName is the name of both the BackendConfig and the key the ArgoCD server Service's
// `cloud.google.com/backend-config` annotation points at. One constant because the two MUST agree:
// a Service pointing at a BackendConfig that does not exist makes the GKE ingress controller refuse
// to program the backend service, which wedges the ingress rather than silently dropping the WAF.
const GKEBackendConfigName = "argocd-server"

// GKEBackendConfigManifest renders the BackendConfig that binds a Cloud Armor security policy to the
// GCLB backend service GKE creates for the ArgoCD server Service.
//
// Fail-closed on an empty policy name: a BackendConfig whose `spec.securityPolicy.name` is "" is not
// "no WAF", it is a resource the ingress controller rejects — the GCP shape of the empty
// `wafv2-acl-arn` annotation that wedges an ALB. The caller must skip the object entirely when the
// project's WAF switch is off, and the error here is what stops it doing otherwise by accident.
func GKEBackendConfigManifest(namespace, securityPolicy string) (string, error) {
	if strings.TrimSpace(namespace) == "" {
		return "", fmt.Errorf("refusing to render a BackendConfig with no namespace")
	}
	if strings.TrimSpace(securityPolicy) == "" {
		return "", fmt.Errorf("refusing to render a BackendConfig with an empty securityPolicy name — the GKE ingress controller rejects it and the ingress never programs; skip the object instead")
	}
	return fmt.Sprintf(`apiVersion: cloud.google.com/v1
kind: BackendConfig
metadata:
  name: %s
  namespace: %s
spec:
  securityPolicy:
    name: %s
`, GKEBackendConfigName, namespace, securityPolicy), nil
}

// GKEArgoServerValues renders the argo-cd chart values that expose the ArgoCD server through a GKE
// Ingress, optionally armored by a Cloud Armor policy.
//
//   - host is the DNS name the Ingress serves (argocd.<domain>).
//   - preSharedCert is the GLOBAL Google-managed SSL certificate NAME. REQUIRED — it is the whole
//     gate: `ingress.gcp.kubernetes.io/pre-shared-cert` is the only way to put TLS on a GKE Ingress
//     without standing up a second cert-manager stack, and an Ingress without it would serve the
//     ArgoCD API over plain HTTP on the public internet.
//   - backendConfig is GKEBackendConfigName when a Cloud Armor policy was rendered, and "" when the
//     project's WAF switch is off. Empty emits NO `cloud.google.com/backend-config` annotation at
//     all — an annotation naming a BackendConfig that does not exist stalls the ingress.
//
// `server.insecure` mirrors the AWS path: the load balancer terminates TLS, so argocd-server must
// stop trying to as well or the health checks fail against its self-signed certificate.
func GKEArgoServerValues(host, preSharedCert, backendConfig string) (string, error) {
	if strings.TrimSpace(host) == "" {
		return "", fmt.Errorf("refusing to render GKE ArgoCD ingress values with no host")
	}
	if strings.TrimSpace(preSharedCert) == "" {
		return "", fmt.Errorf("refusing to render a GKE ArgoCD Ingress with no pre-shared certificate — it would serve the ArgoCD API over plain HTTP")
	}
	var b strings.Builder
	fmt.Fprintf(&b, `configs:
  params:
    server.insecure: "true"
server:
  ingress:
    enabled: true
    ingressClassName: gce
    hostname: %s
    annotations:
      ingress.gcp.kubernetes.io/pre-shared-cert: %q
      kubernetes.io/ingress.allow-http: "false"
  service:
    type: ClusterIP
    annotations:
`, host, preSharedCert)
	// Container-native load balancing. Stated explicitly rather than left to GKE's default for a
	// ClusterIP Service behind an Ingress: the default is version- and cluster-shape-dependent
	// (VPC-native only), and the instance-group fallback would put the backend service on the node
	// pool instead of the pods — where a Cloud Armor policy still applies, but health checks and
	// client IPs behave differently enough that the difference should not be implicit.
	b.WriteString("      cloud.google.com/neg: '{\"ingress\": true}'\n")
	if strings.TrimSpace(backendConfig) != "" {
		fmt.Fprintf(&b, "      cloud.google.com/backend-config: '{\"default\":%q}'\n", backendConfig)
	}
	return b.String(), nil
}
