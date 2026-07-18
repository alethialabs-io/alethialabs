// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// This file renders the LEAST-PRIVILEGE bootstrap Job for a keyless service→database binding (#722 R5).
// The keyless app logs in with its own cloud identity, but that identity must map to a Postgres ROLE
// with working privileges — SQL the cloud API can't perform. So alongside the app manifests we emit a
// one-shot ArgoCD PreSync Job that, connected as the database ADMIN, runs `alethia db-bootstrap` to
// create/scope the app's role, then exits (hook-delete-policy: HookSucceeded). Because it is a PreSync
// hook it completes before the app syncs, so the app's very first connection already has its grants.
//
// The Job is why the app never needs admin: it is the alternative to registering the app identity as a
// superuser / Entra administrator. Its OWN admin credential is sourced per cloud, keyless where the
// cloud allows it:
//
//   - AWS   — the RDS master credentials, materialized EPHEMERALLY into the Job's namespace by an
//     ExternalSecret (ESO fetches via its IRSA identity; no static platform key). Direct
//     in-VPC connection to the cluster endpoint.
//   - GCP   — the Cloud SQL BUILT_IN default user (a cloudsqlsuperuser), materialized the same way via
//     ESO from its Secret Manager secret. Direct private-IP connection. (Fully-keyless admin
//     would need roles/cloudsql.admin on an in-cluster identity — broader than an ephemeral
//     password, so this is the least-privilege choice for GCP.)
//   - Azure — a DEDICATED admin managed identity (NOT the app): the Job runs as its federated Workload
//     Identity and an `alethia db-token` init container mints the admin Entra token. No
//     password anywhere; the app identity holds zero admin rights.
//
// Everything here is pure + deterministic (golden-testable); the caller supplies the tofu outputs and
// fails the whole Job closed (reporting it) when a required admin output is missing.
package manifests

import (
	"bytes"
	"fmt"
	"strings"
	"text/template"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

const (
	// keylessBootstrapKSAName is the ServiceAccount the bootstrap Job runs as. On Azure it is federated
	// (the template's db_admin UAMI) so the Job mints the dedicated ADMIN Entra token; the Azure
	// template's federated-identity subject MUST be
	// system:serviceaccount:<keylessKSANamespace>:<keylessBootstrapKSAName>.
	keylessBootstrapKSAName = "alethia-db-bootstrap"

	// postgresClientImage runs psql to apply the generated SQL. Alpine-based, so it has /bin/sh (Azure
	// reads the admin token from a file into PGPASSWORD) and a pinned client version.
	postgresClientImage = "postgres:16-alpine"

	bootstrapSQLDir    = "/sql"
	bootstrapSQLFile   = "/sql/init.sql"
	bootstrapTokenDir  = "/db-admin-token"
	bootstrapTokenFile = "/db-admin-token/token"
)

// bootstrapEnv is one Job container env var — a plain value, or a secretKeyRef when SecretName is set.
type bootstrapEnv struct {
	Name       string
	Value      string
	SecretName string
	SecretKey  string
}

// bootstrapContainer is one init/main container of the Job. Command overrides the image entrypoint
// (used for the psql step + the shell wrapper Azure needs); Args passes subcommands to the runner
// image's entrypoint (db-bootstrap / db-token).
type bootstrapContainer struct {
	Name    string
	Image   string
	Command []string
	Args    []string
	Env     []bootstrapEnv
	Mounts  []VolumeMount
}

// bootstrapJobSpec is the fully-resolved shape the Job template renders — one per keyless database.
type bootstrapJobSpec struct {
	Name           string
	Namespace      string
	ServiceAccount string // "" → the namespace default SA (AWS/GCP need no cloud identity for the Job)
	EmitSA         bool   // emit a ServiceAccount object (Azure Workload Identity)
	SAAnnotations  map[string]string
	SALabels       map[string]string
	PodLabels      map[string]string // extra pod-template labels (Azure WI use=true — the webhook trigger)
	InitContainers []bootstrapContainer
	Main           bootstrapContainer
	Volumes        []Volume
}

// BootstrapJobResult is the rendered artifacts for one keyless database's bootstrap.
type BootstrapJobResult struct {
	// Name is the Job object name (and the stem the caller derives output filenames from).
	Name string
	// JobYAML is the batch/v1 Job (a PreSync hook). Always set on success.
	JobYAML string
	// AdminSecretYAML is the ExternalSecret materializing the Job's admin credentials (AWS/GCP). Empty
	// for Azure (keyless admin token) — the caller writes it only when non-empty.
	AdminSecretYAML string
}

// bootstrapJobName is the Job (and its admin Secret's stem) name for a keyless database target — one
// per (kind, name) so multiple keyless DBs don't collide. dns1123 to be a valid object name.
func bootstrapJobName(t types.ServiceBindingTarget) string {
	return dns1123("bootstrap-" + string(t.Kind) + "-" + t.Name)
}

// RenderBootstrapJob renders the least-priv bootstrap Job (+ its admin ExternalSecret on AWS/GCP) for
// one keyless database target. It reads the per-cloud admin-connection outputs from opts.Outputs and
// fails CLOSED — returning an error the caller reports — when a required output is missing, so we
// never emit a Job that can't connect (which would wedge ArgoCD on a failing PreSync hook). Only
// called for a target KeylessDBTarget already accepted; provider is one of aws|gcp|azure.
func RenderBootstrapJob(opts Options, t types.ServiceBindingTarget) (BootstrapJobResult, error) {
	if opts.RunnerImage == "" {
		return BootstrapJobResult{}, fmt.Errorf("no runner image for the keyless bootstrap Job (db-bootstrap/db-token)")
	}
	ns := opts.Namespace
	if ns == "" {
		ns = keylessKSANamespace
	}
	name := bootstrapJobName(t)

	var spec bootstrapJobSpec
	var adminSecret string
	var err error
	switch opts.Provider {
	case string(types.CloudProviderAws):
		spec, adminSecret, err = awsBootstrapSpec(opts, t, name, ns)
	case string(types.CloudProviderGcp):
		spec, adminSecret, err = gcpBootstrapSpec(opts, t, name, ns)
	case string(types.CloudProviderAzure):
		spec, err = azureBootstrapSpec(opts, t, name, ns)
	default:
		return BootstrapJobResult{}, fmt.Errorf("keyless bootstrap is not supported for provider %q", opts.Provider)
	}
	if err != nil {
		return BootstrapJobResult{}, err
	}
	job, err := renderBootstrapJobYAML(spec)
	if err != nil {
		return BootstrapJobResult{}, err
	}
	return BootstrapJobResult{Name: name, JobYAML: job, AdminSecretYAML: adminSecret}, nil
}

// sqlVolume + its mount are shared by every cloud: the init container writes /sql/init.sql, the psql
// container reads it.
func sqlVolume() Volume     { return Volume{Name: "sql"} }
func sqlMount() VolumeMount { return VolumeMount{Name: "sql", MountPath: bootstrapSQLDir} }
func sqlMountRO() VolumeMount {
	return VolumeMount{Name: "sql", MountPath: bootstrapSQLDir, ReadOnly: true}
}
func tokenVolume() Volume     { return Volume{Name: "admin-token"} }
func tokenMount() VolumeMount { return VolumeMount{Name: "admin-token", MountPath: bootstrapTokenDir} }
func tokenMountRO() VolumeMount {
	return VolumeMount{Name: "admin-token", MountPath: bootstrapTokenDir, ReadOnly: true}
}

// renderSQLInit is the init container common to all clouds: run the runner image's db-bootstrap with
// the provider's args, writing the SQL to the shared volume (the runner image has no shell for `>`).
func renderSQLInit(opts Options, extraArgs []string, dbName string) bootstrapContainer {
	args := append([]string{"db-bootstrap", "--provider", opts.Provider, "--db", dbName}, extraArgs...)
	args = append(args, "--out", bootstrapSQLFile)
	return bootstrapContainer{
		Name:   "render-sql",
		Image:  opts.RunnerImage,
		Args:   args,
		Mounts: []VolumeMount{sqlMount()},
	}
}

// awsBootstrapSpec: connect as the RDS master (ExternalSecret-materialized) over the in-VPC endpoint.
func awsBootstrapSpec(opts Options, t types.ServiceBindingTarget, name, ns string) (bootstrapJobSpec, string, error) {
	host := opts.Outputs[endpointOutputKey(string(types.CloudProviderAws), "database")]
	if host == "" {
		return bootstrapJobSpec{}, "", fmt.Errorf("no rds_cluster_endpoint output for the keyless bootstrap Job")
	}
	dbName := opts.Outputs["rds_database_name"]
	if dbName == "" {
		return bootstrapJobSpec{}, "", fmt.Errorf("no rds_database_name output for the keyless bootstrap Job")
	}
	remoteKey := opts.Outputs["rds_master_credentials_secret_name"]
	if remoteKey == "" {
		return bootstrapJobSpec{}, "", fmt.Errorf("no rds_master_credentials_secret_name output for the bootstrap Job admin credentials")
	}
	adminSecretName := name + "-admin"
	esYAML, err := renderAdminExternalSecret(adminSecretName, ns, string(types.CloudProviderAws), remoteKey)
	if err != nil {
		return bootstrapJobSpec{}, "", err
	}
	spec := bootstrapJobSpec{
		Name:      name,
		Namespace: ns,
		InitContainers: []bootstrapContainer{
			renderSQLInit(opts, nil, dbName), // AWS grants the fixed alethia_app role — no extra args
		},
		Main:    psqlContainer(host, dbName, "", adminSecretName, false),
		Volumes: []Volume{sqlVolume()},
	}
	return spec, esYAML, nil
}

// gcpBootstrapSpec: connect as the BUILT_IN default user (cloudsqlsuperuser, ExternalSecret-materialized)
// over the instance private IP; grant the app's tofu-created CLOUD_IAM_SERVICE_ACCOUNT user.
func gcpBootstrapSpec(opts Options, t types.ServiceBindingTarget, name, ns string) (bootstrapJobSpec, string, error) {
	host := opts.Outputs[endpointOutputKey(string(types.CloudProviderGcp), "database")]
	if host == "" {
		return bootstrapJobSpec{}, "", fmt.Errorf("no cloud_sql_ip output for the keyless bootstrap Job")
	}
	dbName := opts.Outputs["cloud_sql_database"]
	if dbName == "" {
		return bootstrapJobSpec{}, "", fmt.Errorf("no cloud_sql_database output for the keyless bootstrap Job")
	}
	appUser := opts.Outputs["cloud_sql_iam_user"]
	if appUser == "" {
		return bootstrapJobSpec{}, "", fmt.Errorf("no cloud_sql_iam_user output — the app login to grant is unknown")
	}
	remoteKey := opts.Outputs["cloud_sql_credentials_secret"]
	if remoteKey == "" {
		return bootstrapJobSpec{}, "", fmt.Errorf("no cloud_sql_credentials_secret output for the bootstrap Job admin credentials")
	}
	adminSecretName := name + "-admin"
	esYAML, err := renderAdminExternalSecret(adminSecretName, ns, string(types.CloudProviderGcp), remoteKey)
	if err != nil {
		return bootstrapJobSpec{}, "", err
	}
	spec := bootstrapJobSpec{
		Name:      name,
		Namespace: ns,
		InitContainers: []bootstrapContainer{
			renderSQLInit(opts, []string{"--app-user", appUser}, dbName),
		},
		Main:    psqlContainer(host, dbName, "", adminSecretName, false),
		Volumes: []Volume{sqlVolume()},
	}
	return spec, esYAML, nil
}

// azureBootstrapSpec: run as the DEDICATED db-admin Workload Identity, mint its Entra admin token, and
// psql with the token as the password. No admin password/secret exists.
func azureBootstrapSpec(opts Options, t types.ServiceBindingTarget, name, ns string) (bootstrapJobSpec, error) {
	host := opts.Outputs[endpointOutputKey(string(types.CloudProviderAzure), "database")]
	if host == "" {
		return bootstrapJobSpec{}, fmt.Errorf("no azure_db_fqdn output for the keyless bootstrap Job")
	}
	dbName := opts.Outputs["azure_db_name"]
	if dbName == "" {
		return bootstrapJobSpec{}, fmt.Errorf("no azure_db_name output for the keyless bootstrap Job")
	}
	adminUser := opts.Outputs["azure_db_admin_user"]
	if adminUser == "" {
		return bootstrapJobSpec{}, fmt.Errorf("no azure_db_admin_user output — the dedicated DB admin login is unknown")
	}
	adminClientID := opts.Outputs["azure_db_admin_client_id"]
	if adminClientID == "" {
		return bootstrapJobSpec{}, fmt.Errorf("no azure_db_admin_client_id output for the bootstrap Job Workload Identity")
	}
	appOID := opts.Outputs["azure_db_app_oid"]
	if appOID == "" {
		return bootstrapJobSpec{}, fmt.Errorf("no azure_db_app_oid output — cannot bind the app's Entra login")
	}
	// Init 1: mint the admin Entra token (once) via the Job's federated Workload Identity.
	mintToken := bootstrapContainer{
		Name:   "mint-admin-token",
		Image:  opts.RunnerImage,
		Args:   []string{"db-token", "--provider", "azure", "--once", "--out", bootstrapTokenFile},
		Mounts: []VolumeMount{tokenMount()},
	}
	spec := bootstrapJobSpec{
		Name:           name,
		Namespace:      ns,
		ServiceAccount: keylessBootstrapKSAName,
		EmitSA:         true,
		SALabels:       map[string]string{"azure.workload.identity/use": "true"},
		// The SA federates the DEDICATED admin identity, so it is ephemeral like the admin secret on the
		// other clouds: a PreSync hook one wave before the Job, deleted after the phase — a pod can't
		// impersonate the admin-capable KSA between deploys.
		SAAnnotations: map[string]string{
			"azure.workload.identity/client-id":     adminClientID,
			"argocd.argoproj.io/hook":               "PreSync",
			"argocd.argoproj.io/hook-delete-policy": "HookSucceeded",
			"argocd.argoproj.io/sync-wave":          "-1",
		},
		// The azure-workload-identity webhook injects the federated token when the POD carries this
		// label, so it must be on the pod template (not only the SA).
		PodLabels: map[string]string{"azure.workload.identity/use": "true"},
		InitContainers: []bootstrapContainer{
			mintToken,
			renderSQLInit(opts, []string{"--app-oid", appOID}, dbName),
		},
		Main:    psqlContainer(host, dbName, adminUser, "", true),
		Volumes: []Volume{sqlVolume(), tokenVolume()},
	}
	return spec, nil
}

// psqlContainer builds the apply-sql container. AWS/GCP read PGUSER + PGPASSWORD from the admin
// ExternalSecret (adminSecretName); Azure passes a plain PGUSER and reads the token file into
// PGPASSWORD via a tiny shell wrapper (fromToken=true). SSL is always required.
func psqlContainer(host, dbName, plainUser, adminSecretName string, fromToken bool) bootstrapContainer {
	env := []bootstrapEnv{
		{Name: "PGHOST", Value: host},
		{Name: "PGPORT", Value: "5432"},
		{Name: "PGDATABASE", Value: dbName},
		{Name: "PGSSLMODE", Value: "require"},
		{Name: "PGCONNECT_TIMEOUT", Value: "30"},
	}
	c := bootstrapContainer{
		Name:   "apply-sql",
		Image:  postgresClientImage,
		Mounts: []VolumeMount{sqlMountRO()},
	}
	if fromToken {
		// Azure: username is a plain value; the password is the minted Entra token on the shared file.
		env = append(env, bootstrapEnv{Name: "PGUSER", Value: plainUser})
		c.Command = []string{"/bin/sh", "-c",
			`PGPASSWORD="$(cat ` + bootstrapTokenFile + `)" psql -v ON_ERROR_STOP=1 -f ` + bootstrapSQLFile}
		c.Mounts = append(c.Mounts, tokenMountRO())
	} else {
		// AWS/GCP: both username and password come from the admin ExternalSecret.
		env = append(env,
			bootstrapEnv{Name: "PGUSER", SecretName: adminSecretName, SecretKey: "username"},
			bootstrapEnv{Name: "PGPASSWORD", SecretName: adminSecretName, SecretKey: "password"},
		)
		c.Command = []string{"psql", "-v", "ON_ERROR_STOP=1", "-f", bootstrapSQLFile}
	}
	c.Env = env
	return c
}

// renderAdminExternalSecret materializes the Job's admin credentials (username + password) from the
// cloud's provisioned admin secret into a k8s Secret (adminSecretName) via the provider's
// ClusterSecretStore — the same ESO path #618 uses for binding credentials, reused here for the
// one-shot admin login. Fails closed when the provider has no store.
func renderAdminExternalSecret(adminSecretName, namespace, provider, remoteKey string) (string, error) {
	store := StoreNameFor(provider)
	if store == "" {
		return "", fmt.Errorf("no ClusterSecretStore for provider %q — the bootstrap Job admin credentials are unsatisfiable", provider)
	}
	ns := namespace
	if ns == "" {
		ns = keylessKSANamespace
	}
	data := []esDatum{
		{SecretKey: "username", RemoteKey: remoteKey, Property: "username"},
		{SecretKey: "password", RemoteKey: remoteKey, Property: "password"},
	}
	var buf bytes.Buffer
	if err := externalSecretTmpl.Execute(&buf, esTemplateData{
		Name:      adminSecretName,
		Namespace: ns,
		StoreName: store,
		Data:      data,
		// Ephemeral, just-in-time admin credential: a PreSync hook one wave BEFORE the Job (so ESO has
		// materialized the Secret — ArgoCD waits on the ExternalSecret's health), deleted after the
		// PreSync phase. creationPolicy Owner sets an ownerRef, so deleting this ExternalSecret
		// garbage-collects the admin Secret too — no standing superuser credential in the app namespace.
		Annotations: map[string]string{
			"argocd.argoproj.io/hook":               "PreSync",
			"argocd.argoproj.io/hook-delete-policy": "HookSucceeded",
			"argocd.argoproj.io/sync-wave":          "-1",
		},
	}); err != nil {
		return "", fmt.Errorf("render bootstrap admin ExternalSecret %s: %w", adminSecretName, err)
	}
	return strings.TrimSpace(buf.String()) + "\n", nil
}

var bootstrapJobTmpl = template.Must(template.New("bootstrapjob").Parse(`
{{- if .EmitSA -}}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ .ServiceAccount }}
  namespace: {{ .Namespace }}
  {{- if .SALabels }}
  labels:
    {{- range $k, $v := .SALabels }}
    {{ $k }}: {{ printf "%q" $v }}
    {{- end }}
  {{- end }}
  {{- if .SAAnnotations }}
  annotations:
    {{- range $k, $v := .SAAnnotations }}
    {{ $k }}: {{ printf "%q" $v }}
    {{- end }}
  {{- end }}
---
{{ end -}}
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ .Name }}
  namespace: {{ .Namespace }}
  labels:
    app.kubernetes.io/name: {{ .Name }}
    app.kubernetes.io/managed-by: alethia
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded
    argocd.argoproj.io/sync-wave: "0"
spec:
  backoffLimit: 2
  template:
    metadata:
      labels:
        app.kubernetes.io/name: {{ .Name }}
        {{- range $k, $v := .PodLabels }}
        {{ $k }}: {{ printf "%q" $v }}
        {{- end }}
    spec:
      restartPolicy: Never
      {{- if .ServiceAccount }}
      serviceAccountName: {{ .ServiceAccount }}
      {{- end }}
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      initContainers:
        {{- range .InitContainers }}
        - name: {{ .Name }}
          image: {{ .Image }}
          {{- if .Command }}
          command:
            {{- range .Command }}
            - {{ printf "%q" . }}
            {{- end }}
          {{- end }}
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
              {{- if .SecretName }}
              valueFrom:
                secretKeyRef:
                  name: {{ .SecretName }}
                  key: {{ .SecretKey }}
              {{- else }}
              value: {{ printf "%q" .Value }}
              {{- end }}
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
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
        {{- end }}
      containers:
        - name: {{ .Main.Name }}
          image: {{ .Main.Image }}
          {{- if .Main.Command }}
          command:
            {{- range .Main.Command }}
            - {{ printf "%q" . }}
            {{- end }}
          {{- end }}
          {{- if .Main.Args }}
          args:
            {{- range .Main.Args }}
            - {{ printf "%q" . }}
            {{- end }}
          {{- end }}
          {{- if .Main.Env }}
          env:
            {{- range .Main.Env }}
            - name: {{ printf "%q" .Name }}
              {{- if .SecretName }}
              valueFrom:
                secretKeyRef:
                  name: {{ .SecretName }}
                  key: {{ .SecretKey }}
              {{- else }}
              value: {{ printf "%q" .Value }}
              {{- end }}
            {{- end }}
          {{- end }}
          {{- if .Main.Mounts }}
          volumeMounts:
            {{- range .Main.Mounts }}
            - name: {{ .Name }}
              mountPath: {{ .MountPath }}
              {{- if .ReadOnly }}
              readOnly: true
              {{- end }}
            {{- end }}
          {{- end }}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
      {{- if .Volumes }}
      volumes:
        {{- range .Volumes }}
        - name: {{ .Name }}
          emptyDir: {}
        {{- end }}
      {{- end }}
`))

// renderBootstrapJobYAML executes the Job template for a resolved spec.
func renderBootstrapJobYAML(spec bootstrapJobSpec) (string, error) {
	var buf bytes.Buffer
	if err := bootstrapJobTmpl.Execute(&buf, spec); err != nil {
		return "", fmt.Errorf("render bootstrap job %s: %w", spec.Name, err)
	}
	return strings.TrimSpace(buf.String()) + "\n", nil
}
