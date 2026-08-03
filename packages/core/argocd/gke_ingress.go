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
//   - the argo-cd chart values that turn on the `gce` Ingress, ask cert-manager for its TLS
//     certificate, and point the ArgoCD server Service at the BackendConfig above.
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

// GKEArgoServerTLSSecret is the Secret the GKE Ingress reads its certificate + key out of, and the
// one cert-manager's ingress-shim writes: naming it in `spec.tls[].secretName` is the ENTIRE
// instruction — the shim derives a Certificate from the Ingress (the issuer annotation, the hosts,
// this name), so nothing else has to be rendered for the certificate to exist.
//
// The value matches what the argo-cd chart's own `server.ingress.tls: true` would pick, but this
// package emits it through `extraTls` and therefore OWNS it: a chart bump cannot move the name out
// from under the constant, and the values file states the whole TLS block instead of half of it.
//
// The GCE ingress controller turns a TLS secret into a SELF-MANAGED SslCertificate on the load
// balancer. That is the mechanism this replaces `pre-shared-cert` with, and the reason a
// Google-managed certificate is no longer needed on this path at all.
const GKEArgoServerTLSSecret = "argocd-server-tls"

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
//   - certIssuer is the cert-manager ClusterIssuer that issues this Ingress's certificate
//     (CertManagerIssuerName). REQUIRED, and it is the whole gate, exactly as the Google-managed
//     certificate name used to be: without it nothing writes GKEArgoServerTLSSecret, so the caller
//     must not render this Ingress at all. See the ORDERING note below for what the empty-secret
//     window actually does, and why it is fail-closed rather than plaintext.
//   - backendConfig is GKEBackendConfigName when a Cloud Armor policy was rendered, and "" when the
//     project's WAF switch is off. Empty emits NO `cloud.google.com/backend-config` annotation at
//     all — an annotation naming a BackendConfig that does not exist stalls the ingress.
//
// TLS COMES FROM cert-manager, NOT FROM A GOOGLE-MANAGED CERTIFICATE (#1858). It used to be
// `ingress.gcp.kubernetes.io/pre-shared-cert`, naming a `google_compute_managed_ssl_certificate`
// the template built. Google validates such a certificate by resolving EVERY name on it to the load
// balancer it is attached to, so one unresolvable SAN holds the whole thing in FAILED_NOT_VISIBLE
// forever; changing the SAN set REPLACES the certificate (hence create_before_destroy plus a digest
// in its name, which surfaced a 63-char overflow); and it can never issue a wildcard. cert-manager
// has none of those three properties, and it is what every other cloud's managed_certificate switch
// already means (#1851) — one mechanism instead of a per-cloud special case.
//
// ORDERING — the Ingress is created BEFORE cert-manager exists, and that is safe:
//
//	installArgoCD runs before ApplyApplications, so at the moment these values are written there is
//	no cert-manager controller, no ingress-shim, no Certificate and no GKEArgoServerTLSSecret. The
//	GCE ingress controller therefore cannot build an HTTPS frontend yet, and
//	`kubernetes.io/ingress.allow-http: "false"` — kept from the pre-shared-cert shape precisely for
//	this — forbids it building a plaintext one either. The load balancer serves NOTHING in that
//	window rather than serving the ArgoCD API in the clear, which is the guarantee the old hard
//	error existed to protect. It is level-triggered: once cert-manager installs, the shim issues
//	over ACME DNS01 (no ingress reachability required, so the window cannot deadlock on itself) and
//	the controller programs the frontend on the next sync.
//
// `server.insecure` mirrors the AWS path: the load balancer terminates TLS, so argocd-server must
// stop trying to as well or the health checks fail against its self-signed certificate.
func GKEArgoServerValues(host, certIssuer, backendConfig string) (string, error) {
	if strings.TrimSpace(host) == "" {
		return "", fmt.Errorf("refusing to render GKE ArgoCD ingress values with no host")
	}
	if strings.TrimSpace(certIssuer) == "" {
		return "", fmt.Errorf("refusing to render a GKE ArgoCD Ingress with no cert-manager issuer — nothing would ever write the %s secret, so the Ingress would serve nothing at all (or, without allow-http=false, the ArgoCD API over plain HTTP)", GKEArgoServerTLSSecret)
	}
	var b strings.Builder
	// `extraTls` rather than the chart's `tls: true` shorthand: both render the same `spec.tls`
	// entry, but this one names the secret in OUR source, so GKEArgoServerTLSSecret stays the single
	// place it is written and a chart bump cannot silently rename it.
	fmt.Fprintf(&b, `configs:
  params:
    server.insecure: "true"
server:
  ingress:
    enabled: true
    ingressClassName: gce
    hostname: %s
    annotations:
      cert-manager.io/cluster-issuer: %q
      kubernetes.io/ingress.allow-http: "false"
    extraTls:
      - hosts:
          - %s
        secretName: %s
  service:
    type: ClusterIP
    annotations:
`, host, certIssuer, host, GKEArgoServerTLSSecret)
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
