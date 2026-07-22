// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"encoding/base64"
	"fmt"
	"sort"
	"strings"
	"text/template"
)

// The cross-account KEYLESS registry pull refresher (PR B). Unlike the #722 db-token sidecar (which
// lives in the app pod and hands a token file to a co-located proxy), a container-registry pull secret
// must exist BEFORE an app pod schedules — so the refresher is a STANDALONE Deployment. It runs the
// runner image's `registry-token` loop under a dedicated Workload-Identity KSA (federated by the B4
// tofu pull role to the customer's target account), mints a short-lived pull token, and PATCHES the
// pre-seeded <slug>-pull Secret. This renders the whole unit — KSA + placeholder Secret + a
// least-privilege Role/RoleBinding (get+patch on ONLY that Secret) + the Deployment — as one manifest
// the GitOps repo commits and ArgoCD syncs, exactly like the keyless-DB bootstrap Job.

// registryPullKSAName is the refresher's ServiceAccount — the coupling constant with the B4 tofu pull
// role (which federates default:alethia-registry-pull to the cross-account identity).
const registryPullKSAName = "alethia-registry-pull"

// RegistryRefresher describes the standalone refresher to render. It is built by the provisioner from
// the keyless registry target + the tofu pull-identity output; the manifests package stays free of the
// categories/tofu detail (primitives only).
type RegistryRefresher struct {
	Provider      string // "aws" | "gcp" | "azure" — selects the registry-token minter
	Namespace     string // the app namespace (default) — where the Secret + refresher live
	SecretName    string // "<slug>-pull" — the imagePullSecret app pods reference (#1007)
	RegistryHost  string // dockerconfig auths key
	Region        string // AWS
	TargetRoleArn string // AWS: the cross-account role the refresher assumes (empty for gcp/azure)
	RunnerImage   string // the image carrying the `registry-token` subcommand

	// SAAnnotations / SALabels wire the KSA to the cloud Workload Identity (per-cloud): AWS IRSA
	// role-arn annotation, GKE WI gcp-service-account annotation, or Azure WI client-id annotation +
	// use label. PodLabels carries Azure's azure.workload.identity/use on the pod. All computed by the
	// provisioner from the B4 tofu output.
	SAAnnotations map[string]string
	SALabels      map[string]string
	PodLabels     map[string]string
}

// emptyDockerConfig is the placeholder .dockerconfigjson the Secret ships with until the refresher's
// first mint patches in the real auth (an app pod referencing it before then simply can't pull yet).
var emptyDockerConfig = base64.StdEncoding.EncodeToString([]byte(`{"auths":{}}`))

// registryTokenArgs builds the `registry-token` container args for the refresher (provider-specific).
func (r RegistryRefresher) registryTokenArgs() []string {
	args := []string{
		"registry-token",
		"--provider", r.Provider,
		"--secret", r.SecretName,
		"--namespace", r.Namespace,
		"--registry-host", r.RegistryHost,
	}
	if r.Provider == "aws" {
		args = append(args, "--region", r.Region, "--target-role-arn", r.TargetRoleArn)
	}
	return args
}

// RenderRegistryRefresher renders the KSA + placeholder Secret + Role/RoleBinding + Deployment as one
// multi-document manifest. Returns an error on a missing required field (fail-closed — never a
// half-wired refresher). Off-path callers render nothing (see the provisioner gate).
func RenderRegistryRefresher(r RegistryRefresher) (string, error) {
	if r.Provider == "" || r.SecretName == "" || r.RegistryHost == "" || r.RunnerImage == "" {
		return "", fmt.Errorf("registry refresher: provider, secret, registry-host and runner image are required")
	}
	if r.Namespace == "" {
		r.Namespace = keylessKSANamespace
	}
	if r.Provider == "aws" && r.TargetRoleArn == "" {
		return "", fmt.Errorf("registry refresher (aws): target role ARN is required")
	}
	var b strings.Builder
	if err := registryRefresherTmpl.Execute(&b, registryRefresherView{
		R:             r,
		KSAName:       registryPullKSAName,
		EmptyDocker:   emptyDockerConfig,
		Args:          r.registryTokenArgs(),
		SAAnnotations: sortedKV(r.SAAnnotations),
		SALabels:      sortedKV(r.SALabels),
		PodLabels:     sortedKV(r.PodLabels),
	}); err != nil {
		return "", fmt.Errorf("render registry refresher: %w", err)
	}
	return b.String(), nil
}

type kv struct{ K, V string }

func sortedKV(m map[string]string) []kv {
	out := make([]kv, 0, len(m))
	for k, v := range m {
		out = append(out, kv{k, v})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].K < out[j].K })
	return out
}

type registryRefresherView struct {
	R             RegistryRefresher
	KSAName       string
	EmptyDocker   string
	Args          []string
	SAAnnotations []kv
	SALabels      []kv
	PodLabels     []kv
}

// registryRefresherTmpl renders the standalone refresher. The Role is name-scoped to the one Secret
// (resourceNames) and grants only get+patch — the tightest RBAC that lets the refresher keep the pull
// secret fresh, and nothing else.
var registryRefresherTmpl = template.Must(template.New("registryRefresher").Parse(`apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ .KSAName }}
  namespace: {{ .R.Namespace }}
  labels:
    app.kubernetes.io/managed-by: alethia
    alethia.io/registry-pull-refresher: "true"
{{- range .SALabels }}
    {{ .K }}: "{{ .V }}"
{{- end }}
{{- if .SAAnnotations }}
  annotations:
{{- range .SAAnnotations }}
    {{ .K }}: "{{ .V }}"
{{- end }}
{{- end }}
---
apiVersion: v1
kind: Secret
metadata:
  name: {{ .R.SecretName }}
  namespace: {{ .R.Namespace }}
  labels:
    app.kubernetes.io/managed-by: alethia
    alethia.io/registry-pull: "true"
type: kubernetes.io/dockerconfigjson
data:
  .dockerconfigjson: {{ .EmptyDocker }}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: {{ .KSAName }}
  namespace: {{ .R.Namespace }}
  labels:
    app.kubernetes.io/managed-by: alethia
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["{{ .R.SecretName }}"]
    verbs: ["get", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: {{ .KSAName }}
  namespace: {{ .R.Namespace }}
  labels:
    app.kubernetes.io/managed-by: alethia
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: {{ .KSAName }}
subjects:
  - kind: ServiceAccount
    name: {{ .KSAName }}
    namespace: {{ .R.Namespace }}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .KSAName }}
  namespace: {{ .R.Namespace }}
  labels:
    app.kubernetes.io/managed-by: alethia
    app.kubernetes.io/name: {{ .KSAName }}
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: {{ .KSAName }}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: {{ .KSAName }}
{{- range .PodLabels }}
        {{ .K }}: "{{ .V }}"
{{- end }}
    spec:
      serviceAccountName: {{ .KSAName }}
      containers:
        - name: registry-token
          image: {{ .R.RunnerImage }}
          args:
{{- range .Args }}
            - {{ . }}
{{- end }}
          resources:
            requests:
              cpu: 10m
              memory: 32Mi
            limits:
              memory: 64Mi
`))
