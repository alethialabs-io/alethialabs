// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"encoding/base64"
	"fmt"
	"strings"
	"text/template"
)

// The cross-account KEYLESS OCI Helm chart-repo credential refresher (#1185) — the helm_registry
// analogue of the image registry refresher (registry_keyless.go). ECR issues a ~12h token, so a static
// ArgoCD repo-cred Secret would silently expire; instead a STANDALONE in-cluster Deployment runs the
// runner image's `helm-repo-token` loop under a dedicated Workload-Identity KSA (federated by the tofu
// helm-repo-pull role to the customer's ECR account, or the cluster's own identity for ECR Public),
// mints a short-lived ECR token, and PATCHES the pre-seeded repo-helm-<hash> Secret's username/password.
// Everything lives in the argocd namespace (where ArgoCD reads repo credentials). A project may connect
// several ECR chart repos, so the KSA is shared and each repo gets its own placeholder Secret + a
// least-privilege name-scoped Role/RoleBinding (get+patch on ONLY that Secret) + Deployment. ECR is an
// AWS-only service, so the KSA is always IRSA-annotated (no per-cloud branch).

// helmRepoPullKSAName is the refresher's ServiceAccount — the coupling constant with the tofu
// helm-repo-pull role (which federates argocd:alethia-helm-repo-pull to the ECR pull identity).
const helmRepoPullKSAName = "alethia-helm-repo-pull"

// helmRepoRefresherNamespace is where ArgoCD reads repo credentials + where the refresher runs.
const helmRepoRefresherNamespace = "argocd"

// helmRepoRefresherLabelKey marks a refresher's Deployment/Role/RoleBinding so PruneHelmRepoRefreshers
// can GC the unit once its connector is deselected (parallels helmRepoCredLabelKey on the Secret).
const helmRepoRefresherLabelKey = "alethia.io/helm-repo-refresher"

// helmRepoCredCloneLabelKey marks the placeholder repo-cred Secret. It MUST match argocd's
// helmRepoCredLabelKey so the existing PruneHelmRepoCredentials GCs a deselected keyless placeholder.
const helmRepoCredCloneLabelKey = "alethia.io/helm-repo-cred"

// HelmRepoRefresher describes one keyless OCI Helm chart-repo refresher (one connected ECR repo). Built
// by the provisioner from a KeylessHelmRepoTarget + the tofu pull-identity output.
type HelmRepoRefresher struct {
	SecretName    string // repo-helm-<hash> — the ArgoCD repo-cred Secret this refresher keeps fresh
	RepoURL       string // oci://<host> — pre-seeded into the placeholder Secret's immutable url field
	Region        string // private ECR region (empty for public)
	TargetRoleArn string // private ECR: the cross-account role the refresher assumes (empty for public)
	Public        bool   // ECR Public — mint under the cluster's own identity, no target role
}

// helmRepoTokenArgs builds the `helm-repo-token` container args for one refresher (public vs private).
func (r HelmRepoRefresher) helmRepoTokenArgs() []string {
	args := []string{
		"helm-repo-token",
		"--secret", r.SecretName,
		"--namespace", helmRepoRefresherNamespace,
	}
	if r.Public {
		args = append(args, "--public")
	} else {
		args = append(args, "--region", r.Region, "--target-role-arn", r.TargetRoleArn)
	}
	return args
}

// DeploymentName is the per-repo Deployment/Role/RoleBinding name (the KSA is shared + separate). The
// provisioner uses it as the desired-name for PruneHelmRepoRefreshers.
func (r HelmRepoRefresher) DeploymentName() string { return r.SecretName + "-refresher" }

// b64 is the Secret-data encoder shared by the template.
func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

// RenderHelmRepoRefreshers renders the shared KSA (once, IRSA-annotated to irsaRoleArn) + per-repo
// placeholder repo-cred Secret (the SAME shape EnsureHelmRepoCredential seeds, so ArgoCD recognises it
// and PruneHelmRepoCredentials GCs it) + a name-scoped Role/RoleBinding + Deployment, all in the argocd
// namespace. Returns an error on a missing required field (fail-closed — never a half-wired refresher).
// An empty target list renders nothing.
func RenderHelmRepoRefreshers(refreshers []HelmRepoRefresher, irsaRoleArn, runnerImage string) (string, error) {
	if len(refreshers) == 0 {
		return "", nil
	}
	if irsaRoleArn == "" || runnerImage == "" {
		return "", fmt.Errorf("helm repo refresher: IRSA role ARN and runner image are required")
	}
	items := make([]helmRepoItemView, 0, len(refreshers))
	for _, r := range refreshers {
		if r.SecretName == "" || r.RepoURL == "" {
			return "", fmt.Errorf("helm repo refresher: secret name and repo URL are required")
		}
		if !r.Public && (r.Region == "" || r.TargetRoleArn == "") {
			return "", fmt.Errorf("helm repo refresher (private ECR %s): region and target role ARN are required", r.SecretName)
		}
		items = append(items, helmRepoItemView{
			SecretName:     r.SecretName,
			B64URL:         b64(r.RepoURL),
			DeploymentName: r.DeploymentName(),
			Args:           r.helmRepoTokenArgs(),
		})
	}
	var b strings.Builder
	if err := helmRepoRefresherTmpl.Execute(&b, helmRepoRefresherView{
		KSAName:      helmRepoPullKSAName,
		Namespace:    helmRepoRefresherNamespace,
		CredLabelKey: helmRepoCredCloneLabelKey,
		RefLabelKey:  helmRepoRefresherLabelKey,
		IRSARoleArn:  irsaRoleArn,
		RunnerImage:  runnerImage,
		B64Helm:      b64("helm"),
		B64User:      b64("AWS"),
		B64Empty:     b64(""),
		B64OCI:       b64("true"),
		Items:        items,
	}); err != nil {
		return "", fmt.Errorf("render helm repo refresher: %w", err)
	}
	return b.String(), nil
}

type helmRepoItemView struct {
	SecretName     string
	B64URL         string
	DeploymentName string
	Args           []string
}

type helmRepoRefresherView struct {
	KSAName      string
	Namespace    string
	CredLabelKey string
	RefLabelKey  string
	IRSARoleArn  string
	RunnerImage  string
	B64Helm      string
	B64User      string
	B64Empty     string
	B64OCI       string
	Items        []helmRepoItemView
}

// helmRepoRefresherTmpl renders the shared KSA once, then per-repo Secret/Role/RoleBinding/Deployment.
// The placeholder Secret matches argocd.helmRepoCredManifest exactly (an OCI repo-creds credential with
// username=AWS, empty password) so ArgoCD authenticates OCI chart pulls by URL prefix and the existing
// PruneHelmRepoCredentials GCs it. The Role is name-scoped to the one Secret (resourceNames) with only
// get+patch — the tightest RBAC that lets the refresher keep the credential fresh, and nothing else.
var helmRepoRefresherTmpl = template.Must(template.New("helmRepoRefresher").Parse(`apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ .KSAName }}
  namespace: {{ .Namespace }}
  labels:
    app.kubernetes.io/managed-by: alethia
  annotations:
    eks.amazonaws.com/role-arn: "{{ .IRSARoleArn }}"
{{- range .Items }}
---
apiVersion: v1
kind: Secret
metadata:
  name: {{ .SecretName }}
  namespace: {{ $.Namespace }}
  labels:
    argocd.argoproj.io/secret-type: repo-creds
    {{ $.CredLabelKey }}: "true"
type: Opaque
data:
  type: {{ $.B64Helm }}
  url: {{ .B64URL }}
  username: {{ $.B64User }}
  password: {{ $.B64Empty }}
  enableOCI: {{ $.B64OCI }}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: {{ .DeploymentName }}
  namespace: {{ $.Namespace }}
  labels:
    app.kubernetes.io/managed-by: alethia
    {{ $.RefLabelKey }}: "true"
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["{{ .SecretName }}"]
    verbs: ["get", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: {{ .DeploymentName }}
  namespace: {{ $.Namespace }}
  labels:
    app.kubernetes.io/managed-by: alethia
    {{ $.RefLabelKey }}: "true"
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: {{ .DeploymentName }}
subjects:
  - kind: ServiceAccount
    name: {{ $.KSAName }}
    namespace: {{ $.Namespace }}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .DeploymentName }}
  namespace: {{ $.Namespace }}
  labels:
    app.kubernetes.io/managed-by: alethia
    app.kubernetes.io/name: {{ .DeploymentName }}
    {{ $.RefLabelKey }}: "true"
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: {{ .DeploymentName }}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: {{ .DeploymentName }}
    spec:
      serviceAccountName: {{ $.KSAName }}
      containers:
        - name: helm-repo-token
          image: {{ $.RunnerImage }}
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
{{- end }}
`))
