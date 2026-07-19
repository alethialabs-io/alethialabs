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
    spec:
      {{- if .ServiceAccount }}
      serviceAccountName: {{ .ServiceAccount }}
      {{- end }}
      containers:
        - name: {{ .Name }}
          image: {{ .Image }}
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
          image: {{ .Image }}
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
    - host: {{ .Host }}
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

// RenderApp renders the Deployment (+ Service + optional Ingress) YAML for one app.
// An empty image is an ERROR, not a ":latest" default — a mutable/untagged image fails
// the elench verify gate (IMAGE-001), so fabricating one here would ship a broken app.
func RenderApp(app App) (string, error) {
	a := app.normalize()
	if a.Image == "" {
		return "", fmt.Errorf("render %s: no container image (repo-sourced services must be BUILT first — resolved_image is empty)", a.Name)
	}
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, a); err != nil {
		return "", fmt.Errorf("render %s: %w", a.Name, err)
	}
	return strings.TrimSpace(buf.String()) + "\n", nil
}

// GenerateManifests renders every app to a `<name>.yaml` file map (filename → YAML),
// deterministically ordered by name. Duplicate names are suffixed to keep files unique.
func GenerateManifests(apps []App) (map[string]string, error) {
	out := map[string]string{}
	seen := map[string]int{}
	names := make([]string, 0, len(apps))
	for _, app := range apps {
		a := app.normalize()
		names = append(names, a.Name)
	}
	sort.Strings(names)

	for _, app := range apps {
		a := app.normalize()
		yaml, err := RenderApp(a)
		if err != nil {
			return nil, err
		}
		file := a.Name + ".yaml"
		if seen[a.Name] > 0 {
			file = fmt.Sprintf("%s-%d.yaml", a.Name, seen[a.Name]+1)
		}
		seen[a.Name]++
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
func defaultPort(kind string) string {
	switch kind {
	case "database":
		return "5432"
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
	unresolved    []string
}

func resolveBindings(serviceName string, opts Options, bindings []types.ServiceBinding) bindingResolution {
	var r bindingResolution
	proxied := map[string]bool{} // one auth proxy per keyless target (dedup across bindings)
	for _, b := range bindings {
		// A binding uses keyless auth when the flag is on AND the bound database has IAM/AAD auth on
		// a provider that supports it (gcp/azure). Otherwise the existing password/ExternalSecret
		// path is used, unchanged.
		keyless := opts.KeylessDBAuth && KeylessDBTarget(opts.Provider, b.Target, opts.Databases)
		if keyless {
			// The workload connects to a LOCAL auth proxy sidecar. Build it first: if it can't be
			// wired (a missing tofu output — connection name / runner image), the whole binding
			// fails CLOSED (all its facets omitted) rather than rewriting the endpoint to 127.0.0.1
			// with no proxy behind it. Endpoint rewrite is coupled to a proxy actually being there.
			key := string(b.Target.Kind) + "/" + b.Target.Name
			if !proxied[key] {
				w, err := keylessDBSidecar(opts, b.Target)
				if err != nil {
					r.unresolved = append(r.unresolved, fmt.Sprintf(
						"keyless binding %s→%s/%s: %v — binding omitted (fail-closed)",
						serviceName, b.Target.Kind, b.Target.Name, err))
					continue
				}
				proxied[key] = true
				r.sidecars = append(r.sidecars, w.sidecars...)
				r.volumes = append(r.volumes, w.volumes...)
				// The keyless pod runs as the Workload-Identity KSA (all keyless bindings on a service
				// share one identity, so first-writer wins — they're the same GSA/UAMI per project).
				if r.saName == "" {
					r.saName = w.saName
					r.saAnnotations = w.saAnnotations
					r.saLabels = w.saLabels
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
				// conventional default for the kind.
				if k := byoPortKey(b.Target); k != "" {
					value = opts.Outputs[k]
				} else {
					value = defaultPort(string(b.Target.Kind))
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
func FromServices(services []types.ProjectServiceConfig, opts Options) (apps []App, skipped []string) {
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
			Env:                       env,
			SecretEnv:                 binds.secretEnv,
			Sidecars:                  binds.sidecars,
			Volumes:                   binds.volumes,
			Resources:                 s.Resources,
			Probe:                     s.Probe,
		})
	}
	return apps, skipped
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

// dns1123 lowercases + strips a string to a valid DNS-1123 label.
func dns1123(s string) string {
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
	return strings.Trim(b.String(), "-")
}
