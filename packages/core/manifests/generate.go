// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package manifests generates minimal, opinionated Kubernetes manifests (Deployment +
// Service + optional Ingress) for the project's first-class services (vc.Services — the
// W1 canvas model), so ArgoCD has something to deploy without the customer hand-writing
// YAML. It is the "generate" half of the apps story; the "bring-your-own" half simply
// points ArgoCD at the customer's repo.
//
// The container image is REAL (W2): a service renders with its ResolvedImage — the digest
// URI the BUILD job pushed — or its prebuilt Source.Image. There is deliberately no
// ":latest" fallback anymore (verify/k8s.go IMAGE-001 fails mutable/untagged images); a
// repo-sourced service that has not been built yet is skipped and reported, never
// rendered with a fabricated tag.
//
// Generation is pure + deterministic (a fixed App list → the same YAML) so it is
// golden-testable. Committing the output to the GitOps repo is the caller's job.
package manifests

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"text/template"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// App is one deployable service to render manifests for.
type App struct {
	// DNS-1123 name (also the Deployment/Service name + selector label value).
	Name string
	// Target namespace (defaults to "default" when empty).
	Namespace string
	// Fully-qualified container image — a digest URI (registry/repo@sha256:…) or a
	// pinned tag. REQUIRED: rendering fails on an empty image rather than fabricating
	// a mutable ":latest" (which verify/k8s.go IMAGE-001 rejects).
	Image string
	// Container/Service port. 0 → 8080.
	Port int
	// Replica count. 0 → 2.
	Replicas int
	// Optional external host; when set an Ingress is emitted.
	Host string
	// Optional ServiceAccount name (e.g. a workload-identity KSA).
	ServiceAccount string
	// When set (keyless-DB path, #722), a ServiceAccount object named ServiceAccount is EMITTED with
	// these annotations/labels — the Workload-Identity binding the pod federates through (GCP
	// iam.gke.io/gcp-service-account, Azure azure.workload.identity/*). Empty → no SA object is
	// emitted (ServiceAccount, if set, is assumed to already exist — e.g. a chart-created KSA).
	ServiceAccountAnnotations map[string]string
	ServiceAccountLabels      map[string]string
	// PodLabels are extra labels stamped on the POD TEMPLATE (never on the selector, which must stay
	// stable). Some identity webhooks key on the pod rather than its ServiceAccount — the
	// azure-workload-identity webhook injects AZURE_FEDERATED_TOKEN_FILE only into pods carrying
	// `azure.workload.identity/use`, so a keyless Azure pod whose label sat only on the SA could never
	// mint a token. Empty → not rendered (output byte-identical to a plain app).
	PodLabels map[string]string
	// Plain environment variables (values rendered quoted). Includes W3 binding-derived
	// non-secret facets (a backing resource's endpoint/port, resolved from tofu outputs).
	Env []types.ServiceEnvVar
	// SecretEnv are env vars sourced from a k8s Secret via valueFrom.secretKeyRef — W3
	// binding credential facets, materialized keylessly by an ExternalSecret (#618).
	SecretEnv []AppSecretEnv
	// Sidecars are auxiliary containers co-scheduled in the app's pod. Used by the W3 keyless-DB
	// binding path (#722): a per-cloud auth proxy the workload connects to over 127.0.0.1, so it
	// holds no database password. Empty → not rendered (output byte-identical to a plain app).
	Sidecars []Sidecar
	// Volumes are pod volumes (emptyDir only today) shared between the app's containers — e.g. the
	// Azure Entra-token file the refresher writes and the proxy reads. Empty → not rendered.
	Volumes []Volume
	// ImagePullSecrets are the names of dockerconfigjson Secrets the kubelet uses to pull the app's
	// image from a private, non-native registry (the pluggable registry connectors — dockerhub, ghcr,
	// …). Without this the pull secret those connectors create is orphaned: nothing references it, so
	// a private pull 401s. Empty → not rendered (a public image or the cluster's own-account
	// ECR/GAR/ACR, which authenticates at the node level). Attached to the pod, not the SA, so it is
	// scoped to this app and needs no namespace-default-SA patch.
	ImagePullSecrets []string
	// Compute requests/limits; nil → the opinionated scaffold defaults.
	Resources *types.ServiceResources
	// Readiness/liveness probe; nil → none.
	Probe *types.ServiceProbe
}

// AppSecretEnv is one container env var sourced from a k8s Secret key (valueFrom.secretKeyRef).
// The Secret is materialized by the ExternalSecret lane (#618) under the name BindingSecretName
// derives — this struct is the render-time half of that contract.
type AppSecretEnv struct {
	Env        string // container env var name
	SecretName string // k8s Secret name (see BindingSecretName)
	SecretKey  string // key within the Secret (the binding facet: username|password|connection_string)
}

// Sidecar is an auxiliary container co-scheduled in the app's pod. Used by the W3 keyless-DB binding
// path (#722): a per-cloud auth proxy the workload reaches over 127.0.0.1 so it holds no database
// password. Rendered after the main container, with the same hardened securityContext.
type Sidecar struct {
	Name   string
	Image  string
	Args   []string
	Env    []types.ServiceEnvVar
	Ports  []int // containerPorts to expose (e.g. the local proxy listener)
	Mounts []VolumeMount
	// Compute requests/limits; nil → defaultSidecarResources. An auth proxy is infrastructure the
	// workload does not know it has, so this is a package default rather than a canvas field — but
	// it stays overridable for a caller that knows better.
	Resources *types.ServiceResources
}

// defaultSidecarResources is the compute envelope every auxiliary container gets unless its caller
// overrides it. Sidecars here are auth proxies and token refreshers: near-idle at steady state, with
// work proportional to CONNECTION SETUP rather than request volume, so the requests are small.
//
// RESOURCES-001 requires BOTH a cpu and a memory limit, and the cpu limit is deliberately loose. The
// keyless proxy sits on the hot path of every database connection, and a tight cpu limit does not
// shed load — it becomes CFS throttling, which surfaces as connection latency under exactly the
// burst a pod is least able to explain. Generous-but-present satisfies the control without inventing
// a throughput ceiling nothing has measured. #1511's real-apply is the first thing that could.
func defaultSidecarResources() *types.ServiceResources {
	return &types.ServiceResources{
		Requests: types.ServiceResourceQuantities{CPU: "10m", Memory: "32Mi"},
		Limits:   types.ServiceResourceQuantities{CPU: "200m", Memory: "128Mi"},
	}
}

// VolumeMount mounts a pod Volume into a container at MountPath.
type VolumeMount struct {
	Name      string
	MountPath string
	ReadOnly  bool
}

// Volume is a pod volume. Only emptyDir is supported today — the shared scratch the keyless-DB token
// refresher + proxy sidecars use; it needs no backing store and works with the app container's
// readOnlyRootFilesystem.
type Volume struct {
	Name string
}

// normalize fills defaults + sanitizes the name to DNS-1123. The image deliberately has
// NO default — see App.Image.
func (a App) normalize() App {
	a.Name = dns1123(a.Name)
	if a.Name == "" {
		a.Name = "app"
	}
	if a.Namespace == "" {
		a.Namespace = "default"
	}
	if a.Port == 0 {
		a.Port = 8080
	}
	if a.Replicas == 0 {
		a.Replicas = 2
	}
	if a.Resources == nil {
		a.Resources = &types.ServiceResources{
			Requests: types.ServiceResourceQuantities{CPU: "100m", Memory: "128Mi"},
			Limits:   types.ServiceResourceQuantities{CPU: "500m", Memory: "512Mi"},
		}
	}
	if a.Probe != nil && a.Probe.Port == 0 {
		p := *a.Probe
		p.Port = a.Port
		a.Probe = &p
	}
	// Copy before defaulting: App is taken by value but a slice header is not, so writing through
	// a.Sidecars[i] would mutate the caller's slice (same reason Probe is copied above).
	if len(a.Sidecars) > 0 {
		sidecars := make([]Sidecar, len(a.Sidecars))
		copy(sidecars, a.Sidecars)
		for i := range sidecars {
			if sidecars[i].Resources == nil {
				sidecars[i].Resources = defaultSidecarResources()
			}
		}
		a.Sidecars = sidecars
	}
	return a
}

var tmpl = template.Must(template.New("app").Parse(`
{{- if or .ServiceAccountAnnotations .ServiceAccountLabels -}}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ .ServiceAccount }}
  namespace: {{ .Namespace }}
  {{- if .ServiceAccountLabels }}
  labels:
    {{- range $k, $v := .ServiceAccountLabels }}
    {{ $k }}: {{ printf "%q" $v }}
    {{- end }}
  {{- end }}
  {{- if .ServiceAccountAnnotations }}
  annotations:
    {{- range $k, $v := .ServiceAccountAnnotations }}
    {{ $k }}: {{ printf "%q" $v }}
    {{- end }}
  {{- end }}
---
{{ end -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Name }}
  namespace: {{ .Namespace }}
  labels:
    app.kubernetes.io/name: {{ .Name }}
    app.kubernetes.io/managed-by: alethia
spec:
  replicas: {{ .Replicas }}
  selector:
    matchLabels:
      app.kubernetes.io/name: {{ .Name }}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: {{ .Name }}
        {{- range $k, $v := .PodLabels }}
        {{ $k }}: {{ printf "%q" $v }}
        {{- end }}
    spec:
      {{- if .ServiceAccount }}
      serviceAccountName: {{ .ServiceAccount }}
      {{- end }}
      {{- if .ImagePullSecrets }}
      imagePullSecrets:
        {{- range .ImagePullSecrets }}
        - name: {{ . }}
        {{- end }}
      {{- end }}
      containers:
        - name: {{ .Name }}
          image: {{ printf "%q" .Image }}
          ports:
            - containerPort: {{ .Port }}
          {{- if or .Env .SecretEnv }}
          env:
            {{- range .Env }}
            - name: {{ printf "%q" .Name }}
              value: {{ printf "%q" .Value }}
            {{- end }}
            {{- range .SecretEnv }}
            - name: {{ printf "%q" .Env }}
              valueFrom:
                secretKeyRef:
                  name: {{ .SecretName }}
                  key: {{ .SecretKey }}
            {{- end }}
          {{- end }}
          resources:
            requests:
              cpu: {{ .Resources.Requests.CPU }}
              memory: {{ .Resources.Requests.Memory }}
            limits:
              cpu: {{ .Resources.Limits.CPU }}
              memory: {{ .Resources.Limits.Memory }}
          {{- if .Probe }}
          readinessProbe:
            {{- if eq .Probe.Type "http" }}
            httpGet:
              path: {{ if .Probe.Path }}{{ .Probe.Path }}{{ else }}/{{ end }}
              port: {{ .Probe.Port }}
            {{- else }}
            tcpSocket:
              port: {{ .Probe.Port }}
            {{- end }}
          livenessProbe:
            {{- if eq .Probe.Type "http" }}
            httpGet:
              path: {{ if .Probe.Path }}{{ .Probe.Path }}{{ else }}/{{ end }}
              port: {{ .Probe.Port }}
            {{- else }}
            tcpSocket:
              port: {{ .Probe.Port }}
            {{- end }}
          {{- end }}
          securityContext:
            runAsNonRoot: true
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
        {{- range .Sidecars }}
        - name: {{ .Name }}
          image: {{ printf "%q" .Image }}
          {{- if .Args }}
          args:
            {{- range .Args }}
            - {{ printf "%q" . }}
            {{- end }}
          {{- end }}
          {{- if .Env }}
          env:
            {{- range .Env }}
            - name: {{ printf "%q" .Name }}
              value: {{ printf "%q" .Value }}
            {{- end }}
          {{- end }}
          {{- if .Ports }}
          ports:
            {{- range .Ports }}
            - containerPort: {{ . }}
            {{- end }}
          {{- end }}
          {{- if .Mounts }}
          volumeMounts:
            {{- range .Mounts }}
            - name: {{ .Name }}
              mountPath: {{ .MountPath }}
              {{- if .ReadOnly }}
              readOnly: true
              {{- end }}
            {{- end }}
          {{- end }}
          resources:
            requests:
              cpu: {{ .Resources.Requests.CPU }}
              memory: {{ .Resources.Requests.Memory }}
            limits:
              cpu: {{ .Resources.Limits.CPU }}
              memory: {{ .Resources.Limits.Memory }}
          securityContext:
            runAsNonRoot: true
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
        {{- end }}
      {{- if .Volumes }}
      volumes:
        {{- range .Volumes }}
        - name: {{ .Name }}
          emptyDir: {}
        {{- end }}
      {{- end }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ .Name }}
  namespace: {{ .Namespace }}
  labels:
    app.kubernetes.io/name: {{ .Name }}
spec:
  selector:
    app.kubernetes.io/name: {{ .Name }}
  ports:
    - port: 80
      targetPort: {{ .Port }}
      protocol: TCP
{{- if .Host }}
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ .Name }}
  namespace: {{ .Namespace }}
  labels:
    app.kubernetes.io/name: {{ .Name }}
spec:
  rules:
    - host: {{ printf "%q" .Host }}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{ .Name }}
                port:
                  number: 80
{{- end }}
`))

// imageRefRe is the OCI image-reference charset: registry host (with optional :port), path
// components, and an optional `:tag` or `@sha256:digest`. Deliberately a CHARSET-and-shape check,
// not a full distribution-spec parser — the property that matters here is that every rune it admits
// is inert in a YAML scalar, so no value can append keys to the container map.
//
// A leading rune is required so the empty string and a bare `:tag` are refused; the length cap is
// well above any real digest URI and keeps a pathological value out of a committed manifest.
var imageRefRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$`)

// isValidImageRef reports whether s is a plausible, YAML-inert container image reference.
func isValidImageRef(s string) bool { return imageRefRe.MatchString(s) }

// ingressHostRe is the RFC-1123 DNS subdomain form an Ingress rule host takes, plus the leading
// `*.` wildcard k8s permits. Same reasoning as imageRefRe: no rune here can break a YAML scalar.
var ingressHostRe = regexp.MustCompile(`^(\*\.)?[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`)

// isValidIngressHost reports whether s is a plausible, YAML-inert Ingress host.
func isValidIngressHost(s string) bool { return len(s) <= 253 && ingressHostRe.MatchString(s) }

// RenderApp renders the Deployment (+ Service + optional Ingress) YAML for one app.
// An empty image is an ERROR, not a ":latest" default — a mutable/untagged image fails
// the elench verify gate (IMAGE-001), so fabricating one here would ship a broken app.
func RenderApp(app App) (string, error) {
	a := app.normalize()
	if a.Image == "" {
		return "", fmt.Errorf("render %s: no container image (repo-sourced services must be BUILT first — resolved_image is empty)", a.Name)
	}
	// FAIL CLOSED on values that cannot be what they claim to be. These reach a YAML document the
	// runner commits to the GitOps repo and ArgoCD syncs, and the console validates App.Image with
	// nothing but `z.string().min(1)` — no charset, no length (#2028).
	//
	// The template now quotes them as well, and that alone stops the injection. This is the second
	// layer, and it is the one that gives an operator a comprehensible error instead of a Deployment
	// that fails to sync for reasons nobody can read. It also holds if a future template edit drops
	// a `printf "%q"` — which is exactly how these two lines came to be unquoted while the env
	// values beside them were not.
	if !isValidImageRef(a.Image) {
		return "", fmt.Errorf("render %s: container image %q is not a valid image reference", a.Name, a.Image)
	}
	for _, s := range a.Sidecars {
		if !isValidImageRef(s.Image) {
			return "", fmt.Errorf("render %s: sidecar %s image %q is not a valid image reference", a.Name, s.Name, s.Image)
		}
	}
	if a.Host != "" && !isValidIngressHost(a.Host) {
		return "", fmt.Errorf("render %s: ingress host %q is not a valid hostname", a.Name, a.Host)
	}
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, a); err != nil {
		return "", fmt.Errorf("render %s: %w", a.Name, err)
	}
	return strings.TrimSpace(buf.String()) + "\n", nil
}

// GenerateManifests renders every app to a `<name>.yaml` file map (filename → YAML). Apps are
// rendered in name order, so the SET of filenames a project produces does not depend on the order
// the caller happened to list its services in — without the sort, probing for an unclaimed name
// hands the same apps a different filename set per input order.
//
// What the sort does NOT settle: two apps whose names normalize to the SAME label tie under it and
// keep their relative input order, so which of those two claims the bare `<name>.yaml` and which
// takes the suffix is still input-order dependent. The set of files is stable; the assignment
// within a tie is not. Both manifests are written either way — that is the #2054 fix — but a
// caller that needs a stable file-to-workload mapping across reorderings must give the renderer a
// stable order itself.
//
// Duplicate names are suffixed to keep files unique. Duplicates are not exotic: normalize() puts
// every name through dns1123, which collapses distinct service names onto one label ("api" and
// "API" both become "api"). The suffixed candidate is therefore checked against the filenames
// already claimed instead of being trusted: a bare `-<n>` suffix would otherwise land on the file
// an app genuinely named "<name>-<n>" writes, and the map write would drop one workload's manifest
// silently — WriteManifests would commit the truncated set and the service would never deploy,
// with nothing in the skipped/warning list to say so (#2054).
//
// What that buys is distinct FILES, not distinct Kubernetes objects. Two apps that normalize to
// the same label still render the same metadata.name for their Deployment and Service, so ArgoCD
// applies both files to one object and the loser is dropped at sync time instead of at write time.
// Catching that means rejecting or reporting the collision UPSTREAM of here, where FromServices
// can put it in `skipped` — tracked as #2234, deliberately not done in this function.
func GenerateManifests(apps []App) (map[string]string, error) {
	out := map[string]string{}

	ordered := make([]App, 0, len(apps))
	for _, app := range apps {
		ordered = append(ordered, app.normalize())
	}
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Name < ordered[j].Name })

	for _, a := range ordered {
		yaml, err := RenderApp(a)
		if err != nil {
			return nil, err
		}
		file := a.Name + ".yaml"
		for n := 2; ; n++ {
			if _, claimed := out[file]; !claimed {
				break
			}
			file = fmt.Sprintf("%s-%d.yaml", a.Name, n)
		}
		out[file] = yaml
	}
	return out, nil
}

// Options control how services map to Apps.
type Options struct {
	// Namespace all apps deploy into.
	Namespace string
	// ServiceAccount to bind (e.g. a workload-identity KSA); optional.
	ServiceAccount string
	// Base domain; when set, each app gets an Ingress at "<name>.<domain>".
	Domain string
	// Outputs are the provision's tofu outputs (endpoint values etc.), used to resolve a W3
	// binding's non-secret facets into concrete env values. Nil/empty is fine — a service with
	// no bindings needs none. The per-cloud endpoint output keys are selected by Provider.
	Outputs map[string]string
	// Provider is the cloud the project provisioned on (a types.CloudProvider value) — it selects
	// the per-cloud tofu endpoint output keys a binding's endpoint facet resolves from. Empty → no
	// endpoint resolves (every endpoint facet is reported unresolvable, fail-closed).
	Provider string
	// Databases are the project's database resources — the lookup source for whether a
	// service→database binding uses keyless IAM/AAD auth (db.IamAuth) instead of a password secret
	// (#722). The binding target names the database; matched by Name.
	Databases []types.ProjectDatabaseConfig
	// KeylessDBAuth enables the keyless-DB binding path (dark flag ALETHIA_KEYLESS_DB_AUTH_ENABLED,
	// read by the provisioner). Off → every credential facet keeps the ExternalSecret path unchanged.
	KeylessDBAuth bool
	// RunnerImage is the alethia runner image ref (it carries the `db-token` refresher subcommand
	// the Azure keyless sidecar runs). Empty → Azure keyless fails closed (reported), never a
	// half-wired pod.
	RunnerImage string
	// ImagePullSecrets are dockerconfigjson Secret names attached to every generated app pod so the
	// kubelet can pull from a private, non-native registry connector (dockerhub/ghcr/…). Empty → none
	// (public image or own-account ECR/GAR/AR via node auth). The provisioner derives this from the
	// project's selected pluggable registry (categories.DominantRegistryPullSecret).
	ImagePullSecrets []string
	// SecretStores maps a project secret's NAME → the pluggable SaaS ClusterSecretStore that can read
	// it (the runtime-read lane's secretstore-<slug> + the value property). It is the single source of
	// truth shared by BOTH binding lanes: resolveBindings emits a workload secretKeyRef for a
	// secret-kind binding ONLY when its target secret has a readable store here, and
	// writeBindingExternalSecrets renders the matching ExternalSecret from the SAME entry — so the two
	// never disagree about which secret bindings are satisfiable. A secret whose provider is
	// native/excluded (no read path) is ABSENT here, so its binding is reported unresolved (fail-closed).
	// The provisioner builds it from vc.Secrets + categories.IsSaaSSecretStore. Nil/empty is fine.
	SecretStores map[string]SecretStoreRef
}

// SecretStoreRef is the pluggable secret store that materializes one project secret: the ESO
// ClusterSecretStore name (secretstore-<slug>) and the remoteRef property the value lives under
// ("value" for a Vault-KV-compatible store; "" for Doppler, which is flat). StoreName == "" means no
// readable store (a native/excluded provider) — a secret-kind binding to it stays fail-closed.
type SecretStoreRef struct {
	StoreName     string
	ValueProperty string
}

// endpointOutputKey maps a (provider, backing-kind) to the tofu output holding that resource's
// connection endpoint in Alethia's own per-cloud project templates. "" → no endpoint output for
// that pair, so resolveBindings reports the facet unresolvable + omits it (fail-closed, #710) rather
// than injecting an empty endpoint. The case values are tied to the CloudProvider enum so a rename
// is caught at compile time. The template provisions a SINGLE db/cache per env today, so the
// binding's target NAME doesn't yet disambiguate (a multi-resource infra lane will add that).
//
// Hetzner is intentionally absent: its data services are ArgoCD add-ons (not tofu), so there is no
// endpoint output — bindings to them stay fail-closed until that lane lands.
func endpointOutputKey(provider, kind string) string {
	switch provider {
	case string(types.CloudProviderAws):
		switch kind {
		case "database":
			return "rds_cluster_endpoint"
		case "cache":
			return "redis_primary_endpoint_address"
		}
	case string(types.CloudProviderGcp):
		switch kind {
		case "database":
			return "cloud_sql_ip"
		case "cache":
			return "memorystore_host"
		}
	case string(types.CloudProviderAzure):
		switch kind {
		case "database":
			return "azure_db_fqdn"
		case "cache":
			return "azure_cache_hostname"
		}
	}
	return ""
}

// defaultPort is the conventional port for a backing kind (no port output is emitted today).
//
// A database's port depends on its ENGINE, not just its kind: MySQL is 3306, Postgres 5432. Passing
// the wrong one hands the workload a DATABASE_PORT it cannot connect on — and on the keyless path it
// would also have to match the port the local auth proxy listens on. `engine` is ignored for the
// other kinds; empty means postgres, which is what every pre-MySQL caller assumed.
func defaultPort(kind, engine string) string {
	switch kind {
	case "database":
		port, _ := enginePort(engine)
		return port
	case "cache":
		return "6379"
	case "queue":
		return "5672"
	default:
		return ""
	}
}

// byoEndpointKey returns a BYO-IaC target's declared endpoint output name — the customer module
// output holding the resource's connection endpoint (#687). "" when the target is not BYO-IaC or
// declared no endpoint output, in which case the endpoint facet resolves fail-closed.
func byoEndpointKey(t types.ServiceBindingTarget) string {
	if t.Address == "" || t.OutputKeys == nil {
		return ""
	}
	return t.OutputKeys.Endpoint
}

// byoPortKey returns a BYO-IaC target's declared port output name, or "" (then defaultPort applies,
// as for a first-class target).
func byoPortKey(t types.ServiceBindingTarget) string {
	if t.Address == "" || t.OutputKeys == nil {
		return ""
	}
	return t.OutputKeys.Port
}

// ByoCredentialOutputKey returns a BYO-IaC target's declared master-credentials-secret output name
// — the ExternalSecret RemoteKey source (#687). "" when the target is not BYO-IaC or declared no
// credential-secret output. Shared by the render-bindings credential gate (resolveBindings) and the
// ExternalSecret RemoteKey (provisioner.writeBindingExternalSecrets) so the two lanes never disagree
// about whether a BYO-IaC credential facet is materializable.
func ByoCredentialOutputKey(t types.ServiceBindingTarget) string {
	if t.Address == "" || t.OutputKeys == nil {
		return ""
	}
	return t.OutputKeys.CredentialSecret
}

// byoCredentialSatisfiable reports whether a BYO-IaC target's credential facet can be materialized:
// the module exported a master-secret output that RESOLVES to a value in the deploy outputs, the
// cloud has an ESO ClusterSecretStore, and the facet maps to a property in that secret. It mirrors
// RenderExternalSecret's skip conditions exactly, so resolveBindings only emits a credential
// secretKeyRef when the ExternalSecret lane will actually materialize the Secret it points at.
func byoCredentialSatisfiable(opts Options, t types.ServiceBindingTarget, facet string) bool {
	key := ByoCredentialOutputKey(t)
	if key == "" || opts.Outputs[key] == "" {
		return false
	}
	if StoreNameFor(opts.Provider) == "" {
		return false
	}
	_, ok := facetProperty(opts.Provider, facet)
	return ok
}

// resolveBindings turns a service's W3 bindings into container env: non-secret facets
// (endpoint/port) as plain values resolved from the provision's tofu outputs, credential facets as
// secretKeyRef into the Secret the ExternalSecret lane materializes. It shares IsCredentialFacet +
// BindingSecretName (externalsecret.go) with #618 so the workload reads exactly the Secret #618
// creates — one source of truth, no drift. Pure — a map lookup, no I/O.
//
// Non-secret facets resolve FAIL-CLOSED (mirroring the credential lane's unsatisfiable-facet
// reporting in manifests_gen.go): a facet whose value can't be resolved — an unknown backing kind,
// a provider with no endpoint output for that kind (e.g. Hetzner's add-on data services), or a bound
// BYO-IaC resource whose customer-named outputs the template key map can't reach yet — is REPORTED in
// `unresolved`
// and its env var OMITTED, never injected empty. An empty endpoint would boot the workload pointed
// at nothing (a silent misconfig); an absent required env fails loudly instead.
// bindingResolution is resolveBindings' output: the env a service's bindings inject (plain +
// secretKeyRef), any keyless-DB auth sidecars/volumes to co-schedule, and the fail-closed
// `unresolved` report the caller surfaces (Deploy-tab warnings, #718).
type bindingResolution struct {
	env           []types.ServiceEnvVar
	secretEnv     []AppSecretEnv
	sidecars      []Sidecar
	volumes       []Volume
	saName        string            // keyless Workload-Identity KSA the pod must run as (overrides opts.ServiceAccount)
	saAnnotations map[string]string // rendered onto the emitted KSA (GCP GSA / Azure client-id)
	saLabels      map[string]string
	podLabels     map[string]string // stamped on the pod template (Azure WI webhook keys on the POD)
	unresolved    []string
	keyless       []KeylessBindingDecision
}

// KeylessBindingStatus is what happened to one keyless database binding at render time. Two states,
// both of them a decision: the operator asked for keyless (`iam_auth`) and either got it, or got a
// reasoned refusal. There is deliberately no third "fell back to a password" state — that outcome is
// the defect #1510 removed, and adding a name for it here would make it representable again.
type KeylessBindingStatus string

const (
	// KeylessBindingWired — the auth proxy is in the pod and the workload holds no password.
	KeylessBindingWired KeylessBindingStatus = "wired"
	// KeylessBindingFailedClosed — the cell cannot honor it; the whole binding was omitted, and
	// Reason is the sentence the operator reads.
	KeylessBindingFailedClosed KeylessBindingStatus = "failed_closed"
)

// KeylessBindingDecision is the machine-readable record of one keyless binding's fate, persisted to
// execution_metadata["keyless_bindings"] beside the infra-service decisions.
//
// It exists because keyless previously left NO positive trace: a fail-closed binding produced a
// sentence in the manifest-warnings array and a successful one produced nothing at all. Absence of a
// warning is not evidence of wiring — which is exactly the gap that let a keyless path that had never
// authenticated to a real database look shipped for months (#1500). The T2 keyless scenario (#1511)
// reads this as its earliest assertion, before it polls a cluster for anything.
//
// Every field is a name, a state or product copy. No credential, no token, no endpoint — nothing the
// metadata scrub would need to strip.
type KeylessBindingDecision struct {
	// Service is the workload whose binding this is (dns1123-normalized, as rendered).
	Service string `json:"service"`
	// Target names the bound database — kind is always "database" today, carried so a future keyless
	// target kind does not silently join this list unlabelled.
	TargetKind string `json:"target_kind"`
	TargetName string `json:"target_name"`
	// Engine is the database's engine family ("postgres"/"mysql") — the other half of the cell key,
	// and the field that makes a per-cloud claim checkable per engine.
	Engine string `json:"engine"`
	// Status is wired or failed_closed.
	Status KeylessBindingStatus `json:"status"`
	// CellState is the cloud × engine cell's own state — live, pending or excluded. It is what
	// separates the two very different things a failed_closed record can mean: a refusal on an
	// EXCLUDED cell is a product boundary working (the canvas already disables the toggle there),
	// while a refusal on a LIVE cell is a defect on our side — we say we support that cell and
	// could not deliver it. Without this field the record cannot tell them apart, so neither can
	// the deploy, which is how a fail-closed binding came to sit under a successful deploy (#1790).
	CellState KeylessCellState `json:"cell_state"`
	// Reason carries WHY on both outcomes: on a refusal it is the cell's own product-voice sentence
	// (the same string the canvas shows on the disabled toggle), and on a success it is the mechanism
	// from keylessMechanism — "aws · postgres over RDS IAM, token minted per connection by the
	// db-authproxy sidecar". A wired record that said only "wired" would answer the weaker question:
	// the two mechanisms fail differently, so which one ran is the first thing worth knowing.
	Reason string `json:"reason"`
}

// keylessDecision builds the record for one binding. Both reasons are supplied by the caller from a
// single source each — the refusal from keylessCellSupported's error, the success from
// keylessMechanism — so this constructor never composes prose of its own to drift against them.
func keylessDecision(serviceName, engine string, t types.ServiceBindingTarget, status KeylessBindingStatus, reason string, cellState KeylessCellState) KeylessBindingDecision {
	return KeylessBindingDecision{
		Service:    serviceName,
		TargetKind: string(t.Kind),
		TargetName: t.Name,
		Engine:     engine,
		Status:     status,
		Reason:     reason,
		CellState:  cellState,
	}
}

// cellStateFor answers the table for the decision record. An unknown provider or engine has no
// cell, and naming that "" rather than guessing keeps the record honest: it is the same unknown
// that made keylessCellSupported refuse in the first place, so it must not read as a live cell a
// severity check would then fail the deploy on.
func cellStateFor(provider, engine string) KeylessCellState {
	state, _, err := KeylessCell(provider, engine)
	if err != nil {
		return ""
	}
	return state
}

func resolveBindings(serviceName string, opts Options, bindings []types.ServiceBinding) bindingResolution {
	var r bindingResolution
	proxied := map[string]bool{} // one auth proxy per keyless target (dedup across bindings)
	for _, b := range bindings {
		// A binding uses keyless auth when the flag is on AND the operator marked the bound database
		// `iam_auth`. Whether this cloud × engine cell CAN honor that is a separate question, asked by
		// keylessDBSidecar below — it fails the binding closed with the cell's reason rather than
		// falling back to a password the operator never asked for.
		keyless := opts.KeylessDBAuth && KeylessDBTarget(b.Target, opts.Databases)
		if keyless {
			// The workload connects to a LOCAL auth proxy sidecar. Build it first: if it can't be
			// wired (a missing tofu output — connection name / runner image), the whole binding
			// fails CLOSED (all its facets omitted) rather than rewriting the endpoint to 127.0.0.1
			// with no proxy behind it. Endpoint rewrite is coupled to a proxy actually being there.
			key := string(b.Target.Kind) + "/" + b.Target.Name
			if !proxied[key] {
				engine := dbEngineForTarget(opts, b.Target)
				w, err := keylessDBSidecar(opts, b.Target)
				if err != nil {
					r.unresolved = append(r.unresolved, fmt.Sprintf(
						"keyless binding %s→%s/%s: %v — binding omitted (fail-closed)",
						serviceName, b.Target.Kind, b.Target.Name, err))
					// Recorded on BOTH branches, deliberately. A record written only on failure would
					// make "no bad record" indistinguishable from "nothing was even attempted" — the
					// ambiguity that hid a keyless path which had never authenticated (#1500/#1511).
					r.keyless = append(r.keyless, keylessDecision(
						serviceName, engine, b.Target, KeylessBindingFailedClosed, err.Error(),
						cellStateFor(opts.Provider, engine)))
					continue
				}
				proxied[key] = true
				r.keyless = append(r.keyless, keylessDecision(
					serviceName, engine, b.Target, KeylessBindingWired, keylessMechanism(opts.Provider, engine),
					cellStateFor(opts.Provider, engine)))
				r.sidecars = append(r.sidecars, w.sidecars...)
				r.volumes = append(r.volumes, w.volumes...)
				// The keyless pod runs as the Workload-Identity KSA (all keyless bindings on a service
				// share one identity, so first-writer wins — they're the same GSA/UAMI per project).
				if r.saName == "" {
					r.saName = w.saName
					r.saAnnotations = w.saAnnotations
					r.saLabels = w.saLabels
					r.podLabels = w.podLabels
				}
			}
		}
		for _, inj := range b.Inject {
			if IsCredentialFacet(string(inj.From)) {
				if keyless {
					// Keyless: the workload holds NO password. `username` resolves to the cloud IAM
					// identity; `password`/`connection_string` are intentionally dropped (there is
					// no secret — the proxy authenticates upstream).
					if inj.From == "username" {
						user, uerr := keylessDBUsername(opts.Provider, opts.Outputs)
						if uerr != nil {
							r.unresolved = append(r.unresolved, fmt.Sprintf(
								"keyless binding facet %q (env %s) for %s→%s/%s: %v — env omitted",
								inj.From, inj.Env, serviceName, b.Target.Kind, b.Target.Name, uerr))
							continue
						}
						r.env = append(r.env, types.ServiceEnvVar{Name: inj.Env, Value: user})
					}
					continue
				}
				// A secret-kind binding resolves a PROJECT SECRET from a pluggable SaaS store
				// (Vault/Doppler/generic), not a cloud master secret. Fail-closed + lock-step with
				// writeBindingExternalSecrets: emit the secretKeyRef ONLY when the target secret has a
				// readable store (opts.SecretStores) — a native/excluded provider is absent there, so the
				// workload never references a Secret no ExternalSecret will materialize. The single
				// supported facet is `value`; the materialized Secret key is "value" (RenderSecretBinding-
				// ExternalSecret writes the same), so the two lanes agree on the key.
				if b.Target.Kind == types.ServiceBindingKindSecret {
					if string(inj.From) != "value" {
						r.unresolved = append(r.unresolved, fmt.Sprintf(
							"secret binding facet %q (env %s) for %s→secret/%s: only the `value` facet is supported — env omitted",
							inj.From, inj.Env, serviceName, b.Target.Name))
						continue
					}
					if opts.SecretStores[b.Target.Name].StoreName == "" {
						r.unresolved = append(r.unresolved, fmt.Sprintf(
							"secret binding (env %s) for %s→secret/%s: the project secret has no readable pluggable store (native/excluded provider) — env omitted (fail-closed)",
							inj.Env, serviceName, b.Target.Name))
						continue
					}
					r.secretEnv = append(r.secretEnv, AppSecretEnv{
						Env:        inj.Env,
						SecretName: BindingSecretName(serviceName, b.Target),
						SecretKey:  "value",
					})
					continue
				}
				// BYO-IaC credential facets are fail-closed: emit the secretKeyRef ONLY when the
				// customer module exports a master-credentials secret this cloud's ESO store can
				// materialize for this facet — the SAME predicate RenderExternalSecret uses, so the
				// workload never references a Secret the ExternalSecret lane won't create (mirrors
				// #686). First-class targets keep the existing always-emit path (their platform
				// master secret always exists), so their output is byte-identical.
				if b.Target.Address != "" && !byoCredentialSatisfiable(opts, b.Target, string(inj.From)) {
					r.unresolved = append(r.unresolved, fmt.Sprintf(
						"binding credential facet %q (env %s) for %s→%s/%s: BYO-IaC module exports no usable credential secret — env omitted (fail-closed)",
						inj.From, inj.Env, serviceName, b.Target.Kind, b.Target.Name))
					continue
				}
				r.secretEnv = append(r.secretEnv, AppSecretEnv{
					Env:        inj.Env,
					SecretName: BindingSecretName(serviceName, b.Target),
					SecretKey:  string(inj.From),
				})
				continue
			}
			var value string
			switch string(inj.From) {
			case "endpoint":
				switch {
				case keyless:
					value = "127.0.0.1" // the local auth proxy sidecar
				case b.Target.Address != "":
					// BYO-IaC: the customer module's own output, not the platform template key.
					value = opts.Outputs[byoEndpointKey(b.Target)]
				default:
					value = opts.Outputs[endpointOutputKey(opts.Provider, string(b.Target.Kind))]
				}
			case "port":
				// BYO-IaC may export a port output; otherwise (and for first-class) use the
				// conventional default for the kind — engine-aware for databases, so a MySQL
				// binding gets 3306 rather than silently inheriting Postgres's 5432.
				if k := byoPortKey(b.Target); k != "" {
					value = opts.Outputs[k]
				} else {
					value = defaultPort(string(b.Target.Kind), dbEngineForTarget(opts, b.Target))
				}
			}
			if value == "" {
				r.unresolved = append(r.unresolved, fmt.Sprintf(
					"binding facet %q (env %s) for %s→%s/%s could not be resolved — env omitted",
					inj.From, inj.Env, serviceName, b.Target.Kind, b.Target.Name))
				continue
			}
			r.env = append(r.env, types.ServiceEnvVar{Name: inj.Env, Value: value})
		}
	}
	return r
}

// FromServices builds Apps from the project's FIRST-CLASS services (vc.Services — the W1
// model), replacing the retired scanner-DetectedService path. Image precedence per
// service: ResolvedImage (the digest URI the W2 BUILD pushed) over Source.Image (the
// user's prebuilt image). There is NO ":latest" fallback — the retired scanner path's
// `<name>:latest` default is exactly what verify/k8s.go IMAGE-001 fails.
//
// Not everything renders: a repo-sourced service that has not been built yet has no image,
// and only type=="deployment" has a template today (job/cronjob/statefulset rendering is a
// follow-up lane). Those are returned in `skipped` (name: reason) so the caller REPORTS
// them — a silent drop would read as "deployed" when it wasn't.
//
// `keyless` is the per-binding decision record (#1511) for every database the operator marked
// `iam_auth`, wired or fail-closed. Note what it CANNOT contain: a service skipped above never
// reaches resolveBindings, so its keyless bindings produce no decision — the service's own skip
// reason is the honest record there, and inventing a decision for a workload that does not exist
// would be worse than its absence.
func FromServices(services []types.ProjectServiceConfig, opts Options) (apps []App, skipped []string, keyless []KeylessBindingDecision) {
	apps = make([]App, 0, len(services))
	for _, s := range services {
		name := dns1123(s.Name)
		if s.Type != "" && s.Type != "deployment" {
			skipped = append(skipped, fmt.Sprintf("%s: workload type %q has no manifest template yet", name, s.Type))
			continue
		}
		image := s.ResolvedImage
		if image == "" && s.Source.Kind == "image" {
			image = s.Source.Image
		}
		if image == "" {
			skipped = append(skipped, fmt.Sprintf("%s: repo-sourced service not built yet (resolved_image empty)", name))
			continue
		}
		port := 0
		if len(s.Ports) > 0 {
			port = s.Ports[0].ContainerPort
		}
		host := ""
		if opts.Domain != "" {
			host = name + "." + opts.Domain
		}
		// W3 — resolve the service's bindings into env: endpoint/port as values (from tofu
		// outputs), credentials as secretKeyRef. User-authored env comes first, then binding env.
		// A non-secret facet that can't be resolved is REPORTED (not injected empty) so the caller
		// surfaces it alongside the skipped-service reasons — the app still renders (a missing
		// required env fails loudly at boot; an empty one would silently connect to nothing).
		binds := resolveBindings(s.Name, opts, s.Bindings)
		skipped = append(skipped, binds.unresolved...)
		keyless = append(keyless, binds.keyless...)
		env := append(append(make([]types.ServiceEnvVar, 0, len(s.Env)+len(binds.env)), s.Env...), binds.env...)
		// A keyless binding overrides the ServiceAccount with the Workload-Identity KSA it emits;
		// otherwise the app keeps opts.ServiceAccount (a chart-created KSA, assumed to exist).
		sa := opts.ServiceAccount
		if binds.saName != "" {
			sa = binds.saName
		}
		apps = append(apps, App{
			Name:                      name,
			Namespace:                 opts.Namespace,
			Image:                     image,
			Port:                      port,
			Replicas:                  s.Replicas,
			Host:                      host,
			ServiceAccount:            sa,
			ServiceAccountAnnotations: binds.saAnnotations,
			ServiceAccountLabels:      binds.saLabels,
			PodLabels:                 binds.podLabels,
			Env:                       env,
			SecretEnv:                 binds.secretEnv,
			Sidecars:                  binds.sidecars,
			Volumes:                   binds.volumes,
			ImagePullSecrets:          opts.ImagePullSecrets,
			Resources:                 s.Resources,
			Probe:                     s.Probe,
		})
	}
	return apps, skipped, keyless
}

// WriteManifests renders the apps and writes each "<name>.yaml" into dir (created if
// needed). The caller (the runner's deploy step) then commits dir to the GitOps repo
// ArgoCD syncs. Returns the filenames written.
func WriteManifests(dir string, apps []App) ([]string, error) {
	files, err := GenerateManifests(apps)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir %s: %w", dir, err)
	}
	written := make([]string, 0, len(files))
	for name, yaml := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(yaml), 0o644); err != nil {
			return nil, fmt.Errorf("write %s: %w", name, err)
		}
		written = append(written, name)
	}
	sort.Strings(written)
	return written, nil
}

// dnsLabelMaxLen is the RFC-1123 DNS label length limit kubernetes enforces on resource names and
// on label values. Nothing downstream of here re-checks it: the rendered name becomes the Service
// name and the app.kubernetes.io/name label on the Deployment, its pod template and its selector,
// and console-side validation carries no maximum. So an over-long name used to be committed to the
// GitOps repo and only rejected by the API server, on every sync, long after the deploy reported
// success (#2056).
const dnsLabelMaxLen = 63

// dns1123 lowercases + strips a string to a valid DNS-1123 label (<=63 chars).
func dns1123(s string) string {
	return dns1123Max(s, dnsLabelMaxLen)
}

// dns1123Max is dns1123 bounded to max characters. The cap is applied BEFORE the final hyphen
// trim, so a truncation that lands on a '-' cannot leave a trailing hyphen — itself invalid in a
// DNS-1123 label. A caller that composes a name out of several parts (BindingSecretName,
// BootstrapJobName) still gets the whole composed string bounded, because it passes that string
// through dns1123 as a unit.
//
// Mirrors packages/core/imagebuild.dns1123Max, which is the reference implementation; the copy is
// deliberate so each package owns its scope and neither depends on the other's internals. Change
// both together.
func dns1123Max(s string, max int) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-' || r == '_' || r == '/' || r == ' ' || r == '.':
			b.WriteRune('-')
		}
	}
	out := b.String()
	if max > 0 && len(out) > max {
		out = out[:max]
	}
	return strings.Trim(out, "-")
}
