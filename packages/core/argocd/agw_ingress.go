// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"fmt"
	"strings"
)

// AGWIngressClassName is the IngressClass AGIC watches. AGIC reconciles every Ingress carrying it
// onto the ONE Application Gateway it was configured with — there is no per-Ingress provisioning
// the way the AWS ALB controller does it.
const AGWIngressClassName = "azure-application-gateway"

// ArgoCDTLSSecretName is the Secret cert-manager writes the issued certificate into and AGIC lifts
// onto the gateway listener.
//
// ⚠️ This name is the CHART'S, not ours. argo-cd 8.6.4 documents `server.ingress.tls` as: "TLS
// certificate will be retrieved from a TLS secret `argocd-server-tls`" — there is no values key to
// override it (the chart has `tls` as a bool and no `tlsSecret`). So this constant RECORDS the
// chart's choice for the Go side to reason about; it does not set it. If the chart ever renames it,
// setting this alone would change nothing and the listener would quietly keep serving the gateway's
// default certificate — which is why the values renderer below asserts the bool and never the name.
const ArgoCDTLSSecretName = "argocd-server-tls"

// AGWArgoServerValues renders the argo-cd Helm values for the ArgoCD server Ingress on Azure.
//
// Mirrors GKEArgoServerValues in shape and differs in exactly one way that matters: the certificate
// does not exist yet when this is written. On AWS and GCP the ingress is gated on a certificate the
// TEMPLATE already created, so the annotation names something real at install time. Here
// cert-manager issues asynchronously — `EnsureCertManagerIssuer` applies the ClusterIssuer AFTER
// the Applications are applied, and the ACME DNS01 challenge completes some seconds later still.
//
// So this asks for a certificate rather than pointing at one: the `cert-manager.io/cluster-issuer`
// annotation plus a `spec.tls` entry make cert-manager mint a Certificate, write it to
// ArgoCDTLSSecretName, and AGIC picks the Secret up and puts it on the gateway listener. Until that
// completes the listener serves the gateway's default certificate, which is why
// `appgw.ssl-certificate` is NOT also set — two sources for one listener is how you get a
// certificate that flaps.
//
//   - host is the ArgoCD hostname (argocd.<domain>). external-dns creates the record for it from
//     this Ingress, using the same identity cert-manager solves the challenge with.
//   - issuer is the ClusterIssuer name (CertManagerIssuerName). Empty is refused: an Ingress with a
//     `spec.tls` and no issuer never gets a Secret, so the listener would serve the wrong
//     certificate forever with nothing reporting it.
//
// `server.insecure` mirrors both other clouds: the gateway terminates TLS, so argocd-server must
// stop trying to as well or its health checks fail against its own self-signed certificate.
//
// NOTE there is no WAF annotation here, unlike AWS's `wafv2-acl-arn`. On Azure the WAF policy is
// bound by the TEMPLATE (`firewall_policy_id` on the gateway), so it already applies to every
// listener this Ingress creates — see wafAttachments["azure"] in decisions.go.
func AGWArgoServerValues(host, issuer string) (string, error) {
	if strings.TrimSpace(host) == "" {
		return "", fmt.Errorf("refusing to render the Application Gateway ArgoCD ingress with no host")
	}
	if strings.TrimSpace(issuer) == "" {
		return "", fmt.Errorf("refusing to render an Application Gateway ArgoCD Ingress with no cert-manager issuer — the TLS secret would never be created and the listener would serve the gateway's default certificate")
	}
	var b strings.Builder
	// `tls: true` is the whole TLS contract with this chart. It renders `spec.tls` for `hostname`
	// with secretName argocd-server-tls, which is what makes cert-manager mint a Certificate (the
	// annotation names the issuer) and what AGIC then reads. Verified against argo-cd 8.6.4's own
	// values.yaml rather than assumed — an invented key like `tlsSecret` is accepted silently by
	// helm and renders no TLS block at all.
	fmt.Fprintf(&b, `configs:
  params:
    server.insecure: "true"
server:
  ingress:
    enabled: true
    ingressClassName: %s
    hostname: %s
    tls: true
    annotations:
      cert-manager.io/cluster-issuer: %q
      appgw.ingress.kubernetes.io/ssl-redirect: "true"
`, AGWIngressClassName, host, issuer)
	return b.String(), nil
}
