// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"fmt"
	"io"
	"strings"
	"text/template"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// CertManagerIssuerName is the ClusterIssuer an Ingress references to get a certificate.
// It is deliberately `letsencrypt-prod` — the name deploy/helm/alethia/values.yaml and the
// self-hosting docs already tell operators to use — so the issuer this platform add-on creates
// is the one the rest of the product already points at, rather than a second convention.
const CertManagerIssuerName = "letsencrypt-prod"

// certManagerIssuerMaxWait bounds the wait for cert-manager's CRDs + webhook, which ArgoCD
// installs ASYNCHRONOUSLY after ApplyApplications returns. Same shape and the same reasoning as
// externalSecretsStoreMaxWait: on a fresh cluster the CRD register → webhook pod Ready sequence
// routinely runs past ten minutes on real EKS (#1208), and the caller treats a timeout as
// NON-fatal, so this is an upper bound on patience rather than a deadline anything depends on.
var certManagerIssuerMaxWait = 15 * time.Minute

// certManagerIssuerTemplate renders the ACME DNS01 ClusterIssuer for the cloud in facts.
//
// DNS01, NOT HTTP01, on every cloud. HTTP01 needs an ingress that is already reachable from the
// public internet, and AWS is the only cloud in this repo with an ingress controller today
// (argocd.ingressControllers) — an HTTP01 issuer would therefore be un-solvable on three of the
// four clouds it renders for. DNS01 needs only the zone, which each of these clouds provisions,
// and it is also the only challenge type that can issue a wildcard.
//
// NO STATIC CREDENTIAL ANYWHERE IN HERE. Each solver authenticates as the identity external-dns
// ALREADY holds on that cloud, which the IaC additionally binds to `cert-manager:cert-manager`
// (the IRSA namespace_service_accounts entry / the GCP workload-identity member / the Azure
// federated-identity credential). cert-manager writes and deletes one TXT record per challenge —
// precisely the permission external-dns already has and no more — so reusing the identity costs
// nothing in privilege and removes a second one to keep in step.
//
// The `{{ if }}` arms mirror certManagerDNS01Solvers exactly; CertManagerSolver() has already
// guaranteed the facts each arm reads are non-empty, so no arm can render a half-empty solver.
const certManagerIssuerTemplate = `
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: {{ .IssuerName }}
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    {{- /* No contact email is emitted. ACME registration without one is valid, and the
           alternative is worse: the only address available here belongs to the Alethia operator,
           not to the project owner, so expiry warnings would go to someone who cannot act on
           them. Wiring the project owner's address is a follow-up, not a guess to make here. */}}
    privateKeySecretRef:
      name: {{ .IssuerName }}-account-key
    solvers:
      - dns01:
          {{- if eq .Solver "route53" }}
          route53:
            region: {{ .Facts.Region }}
            {{- /* Scoping the solver to the project's own zone. Omitted when the snapshot
                   carries no zone id, in which case cert-manager discovers the zone by name
                   via the ListHostedZonesByName permission the external-dns policy grants. */}}
            {{- if .Facts.DNSZoneID }}
            hostedZoneID: {{ .Facts.DNSZoneID }}
            {{- end }}
          {{- else if eq .Solver "clouddns" }}
          cloudDNS:
            project: {{ .Facts.GCPProjectID }}
            {{- /* hostedZoneName is MANDATORY here, not an optimisation: the external-dns GSA's
                   dns.admin grant is ZONE-scoped, so it carries no project-level
                   dns.managedZones.list and cert-manager cannot FIND the zone it is allowed to
                   write to. CertManagerSolver() fails closed when this output is absent. */}}
            hostedZoneName: {{ .Facts.GCPDNSZoneName }}
          {{- else if eq .Solver "azuredns" }}
          azureDNS:
            subscriptionID: {{ .Facts.AzureSubscriptionID }}
            resourceGroupName: {{ .Facts.AzureResourceGroup }}
            hostedZoneName: {{ .Facts.DomainName }}
            tenantID: {{ .Facts.AzureTenantID }}
            environment: AzurePublicCloud
            managedIdentity:
              clientID: {{ .Facts.AzureExternalDNSClient }}
          {{- end }}
        {{- /* Bound to the project's own domain so this issuer can never be used to attempt a
               challenge for a zone the deploy does not own. */}}
        selector:
          dnsZones:
            - {{ .Facts.DomainName }}
`

var certManagerIssuerTmpl = template.Must(template.New("cert-manager-issuer").Parse(certManagerIssuerTemplate))

// certManagerIssuerData is the render dot: the facts plus the two values already derived from
// them, so the template never re-asks a question CertManagerSolver() has answered.
type certManagerIssuerData struct {
	Facts      *InfraFacts
	Solver     string
	IssuerName string
}

// certManagerIssuerManifest renders the ClusterIssuer for these facts, or "" when cert-manager
// does not ship on this deploy at all. It reads CertManagerEnabled — the SAME predicate the
// Application template gates on — so the issuer and the controller can never disagree about
// whether cert-manager is present.
func certManagerIssuerManifest(facts *InfraFacts) (string, error) {
	if !facts.CertManagerEnabled() {
		return "", nil
	}
	var buf bytes.Buffer
	data := certManagerIssuerData{
		Facts:      facts,
		Solver:     facts.CertManagerSolver(),
		IssuerName: CertManagerIssuerName,
	}
	if err := certManagerIssuerTmpl.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("render cert-manager ClusterIssuer: %w", err)
	}
	return strings.TrimSpace(buf.String()), nil
}

// EnsureCertManagerIssuer applies the ACME DNS01 ClusterIssuer AFTER ApplyApplications has applied
// the cert-manager Application, mirroring EnsureExternalSecretsStore for the same reason: the
// ClusterIssuer is a custom resource whose CRD and validating webhook that Application installs,
// so on a fresh cluster it races the controller in two stages ("no matches for kind", then the
// webhook having no ready endpoints). Applying it on its own, server-side, retrying ONLY the
// transient operator-not-ready markers, is what stops it deadlocking the way the ClusterSecretStore
// did in #1208 — a CR mixed into the client-side apply file could poison that file so the operator
// never installed and the retry could never converge.
//
// No-op when cert-manager does not ship for this deploy. A timeout is returned as an error the
// caller treats as NON-fatal: the issuer is idempotent and reconciles on the next deploy, so a slow
// webhook on a fresh cluster must not fail an otherwise-healthy cluster.
func EnsureCertManagerIssuer(facts *InfraFacts, stdout, stderr io.Writer) error {
	manifest, err := certManagerIssuerManifest(facts)
	if err != nil {
		return err
	}
	if manifest == "" {
		return nil
	}
	fmt.Fprintf(stdout, "Ensuring cert-manager ClusterIssuer %q (waiting for the controller's CRD + webhook)...\n", CertManagerIssuerName)
	deadline := time.Now().Add(certManagerIssuerMaxWait)
	for attempt := 1; ; attempt++ {
		var captured bytes.Buffer
		applyErr := applyManifestServerSide(manifest, stdout, io.MultiWriter(stderr, &captured))
		if applyErr == nil {
			fmt.Fprintln(stdout, "cert-manager ClusterIssuer applied.")
			return nil
		}
		if !isOperatorNotReady(captured.String()) || time.Now().After(deadline) {
			if time.Now().After(deadline) {
				// Dump the controller's pods so a recurrence is diagnosable from logs alone —
				// a slow install and a crash-looping webhook look identical from the apply error.
				_ = utils.ExecuteCommand("kubectl get pods -n cert-manager -o wide", ".", nil, stderr, stderr)
			}
			return fmt.Errorf("apply cert-manager ClusterIssuer: %w", applyErr)
		}
		fmt.Fprintf(stdout, "  cert-manager (CRD/webhook) isn't ready yet (attempt %d) — "+
			"waiting 15s for ArgoCD to finish installing it...\n", attempt)
		time.Sleep(15 * time.Second)
	}
}
