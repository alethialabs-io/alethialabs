// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// This file renders the ExternalSecret half of a W3 service→backing-infra binding: the keyless
// last hop that materializes a provisioned credential into an in-cluster k8s Secret the workload
// references (management W3, service→backing-infra binding). A binding's NON-secret facets
// (endpoint/port) are templated from tofu outputs by the render-bindings lane; its CREDENTIAL
// facets (username/password/…) resolve here — an ExternalSecret pulls the value from the resource's
// provisioned secret through the per-cloud ESO ClusterSecretStore (IRSA/WIF, no platform-held
// credential) into a k8s Secret whose keys are the FACET names (cloud-independent), which the
// workload's env then reads via secretKeyRef.
//
// Generation is pure + deterministic (golden-testable), like the rest of this package. The caller
// (the provisioner, which holds the tofu outputs) resolves each binding's remote secret name and
// the cloud provider; this file does not read outputs.
package manifests

import (
	"bytes"
	"fmt"
	"sort"
	"strings"
	"text/template"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// credentialFacet is the set of binding `From` facets that resolve to a SECRET value (materialized
// via ExternalSecret) rather than a templated tofu output. connection_string is a credential facet
// but is not derivable from a cloud master-credentials secret today (see facetProperty).
var credentialFacet = map[string]bool{
	"username":          true,
	"password":          true,
	"connection_string": true,
}

// IsCredentialFacet reports whether a binding injection's `From` is a credential (secret) facet —
// i.e. resolved via an ExternalSecret/secretKeyRef, not a templated tofu output. Shared with the
// render-bindings lane so both partition a binding's injections the same way.
func IsCredentialFacet(from string) bool { return credentialFacet[from] }

// CredentialFacetNames returns a binding's distinct credential facets (`From` values), sorted, for
// deterministic rendering. Empty → the binding needs no ExternalSecret (endpoint/port only).
func CredentialFacetNames(b types.ServiceBinding) []string {
	seen := map[string]bool{}
	var out []string
	for _, inj := range b.Inject {
		facet := string(inj.From)
		if credentialFacet[facet] && !seen[facet] {
			seen[facet] = true
			out = append(out, facet)
		}
	}
	sort.Strings(out)
	return out
}

// BindingSecretName is the k8s Secret a binding's credential facets materialize into — the ONE
// shared contract: the render-bindings lane's env secretKeyRef.name (generate.go) and this lane's
// ExternalSecret target both call it, so the workload reads exactly the Secret this creates. Named
// per (service, resource) so each service's Secret is self-contained in its own namespace. This is
// the single declaration for the package (generate_test.go relies on it; tested in
// externalsecret_test.go).
func BindingSecretName(serviceName string, t types.ServiceBindingTarget) string {
	return dns1123(serviceName + "-" + string(t.Kind) + "-" + t.Name)
}

// StoreNameFor maps a cloud provider to its ESO ClusterSecretStore name (defined per-cloud in
// infra/templates/argocd/external-secrets-operator.yaml). "" → no store for that provider (e.g.
// Hetzner): a credential facet there cannot be satisfied and is reported, not silently dropped.
func StoreNameFor(provider string) string {
	switch provider {
	case "aws":
		return "secretstore-aws"
	case "gcp":
		return "secretstore-gcp"
	case "azure":
		return "secretstore-azure"
	case "alibaba":
		return "secretstore-alibaba"
	}
	return ""
}

// facetProperty maps a credential facet to the property key inside the cloud's provisioned
// master-credentials secret. ok=false → that cloud's secret has no such key. The k8s Secret key we
// write is always the FACET name (so secretKeyRef.key is cloud-independent); only the remote
// property differs. AWS RDS-managed secrets carry only username/password; connection_string is not
// a single key in any provider's master secret today, so it is reported unsatisfiable for now.
func facetProperty(provider, facet string) (string, bool) {
	switch facet {
	case "username":
		return "username", true
	case "password":
		return "password", true
	}
	return "", false
}

// ExternalSecretParams is the resolved input the renderer needs for one binding. The caller (the
// provisioner) supplies Provider + RemoteKey (the tofu-provisioned secret name/ARN) from the
// deploy outputs; Facets are the binding's credential facets (see CredentialFacetNames).
type ExternalSecretParams struct {
	ServiceName string
	Namespace   string
	Target      types.ServiceBindingTarget
	Provider    string
	RemoteKey   string
	Facets      []string
}

type esDatum struct{ SecretKey, RemoteKey, Property string }

type esTemplateData struct {
	Name      string
	Namespace string
	StoreName string
	Data      []esDatum
	// Annotations, when set, render onto the ExternalSecret's metadata. Binding-credential secrets
	// (#618) pass none (output byte-identical); the keyless bootstrap Job's ADMIN secret (#722 R5)
	// passes ArgoCD hook annotations so it (and, via ownerRef, the materialized admin Secret) is
	// created just-in-time and deleted after the PreSync phase — no lingering superuser credential.
	Annotations map[string]string
}

// v1beta1 to match the deployed ESO chart (0.9.12) + the ClusterSecretStore definitions in
// infra/templates/argocd/external-secrets-operator.yaml (the v1 API only exists in ESO ≥ 0.10).
var externalSecretTmpl = template.Must(template.New("externalsecret").Parse(`apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: {{ .Name }}
  namespace: {{ .Namespace }}
  labels:
    app.kubernetes.io/name: {{ .Name }}
    app.kubernetes.io/managed-by: alethia
  {{- if .Annotations }}
  annotations:
    {{- range $k, $v := .Annotations }}
    {{ $k }}: {{ printf "%q" $v }}
    {{- end }}
  {{- end }}
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: {{ .StoreName }}
    kind: ClusterSecretStore
  target:
    name: {{ .Name }}
    creationPolicy: Owner
  data:
{{- range .Data }}
    - secretKey: {{ .SecretKey }}
      remoteRef:
        key: {{ .RemoteKey }}
        property: {{ .Property }}
{{- end }}
`))

// RenderExternalSecret renders the ExternalSecret that materializes a binding's credential facets
// into a k8s Secret (named BindingSecretName) via the provider's ClusterSecretStore. It returns
// (yaml, skipped, err): yaml is "" when nothing is materializable, and `skipped` names the reason
// (no store for the provider, no provisioned secret name, or a facet the cloud secret lacks) so the
// caller reports rather than silently drops — mirroring FromServices' skipped-services report.
func RenderExternalSecret(p ExternalSecretParams) (string, []string, error) {
	secretName := BindingSecretName(p.ServiceName, p.Target)

	store := StoreNameFor(p.Provider)
	if store == "" {
		return "", []string{fmt.Sprintf("%s: no ClusterSecretStore for provider %q — credential facets unsatisfiable", secretName, p.Provider)}, nil
	}
	if strings.TrimSpace(p.RemoteKey) == "" {
		return "", []string{fmt.Sprintf("%s: no provisioned secret for %s/%s — credential facets unsatisfiable", secretName, p.Target.Kind, p.Target.Name)}, nil
	}

	var data []esDatum
	var skipped []string
	for _, f := range p.Facets {
		if !credentialFacet[f] {
			continue // ignore non-secret facets defensively (they are the render-bindings lane's job)
		}
		prop, ok := facetProperty(p.Provider, f)
		if !ok {
			skipped = append(skipped, fmt.Sprintf("%s: facet %q is not in the %s master secret", secretName, f, p.Provider))
			continue
		}
		data = append(data, esDatum{SecretKey: f, RemoteKey: p.RemoteKey, Property: prop})
	}
	if len(data) == 0 {
		return "", skipped, nil
	}

	ns := p.Namespace
	if ns == "" {
		ns = "default"
	}
	var buf bytes.Buffer
	if err := externalSecretTmpl.Execute(&buf, esTemplateData{
		Name:      secretName,
		Namespace: ns,
		StoreName: store,
		Data:      data,
	}); err != nil {
		return "", skipped, fmt.Errorf("render external secret %s: %w", secretName, err)
	}
	return strings.TrimSpace(buf.String()) + "\n", skipped, nil
}
