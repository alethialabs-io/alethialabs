// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func TestFromServices_ResolvedImageWins(t *testing.T) {
	// A built repo-sourced service renders with its ResolvedImage digest URI — the W2
	// contract — and the options land on the app.
	apps, skipped := FromServices([]types.ProjectServiceConfig{
		{
			Name:          "api",
			Type:          "deployment",
			Source:        types.ProjectServiceSource{Kind: "repo", RepoURL: "https://github.com/acme/api"},
			ResolvedImage: "123.dkr.ecr.eu-west-1.amazonaws.com/proj-api@sha256:abc123",
			Ports:         []types.ServicePort{{ContainerPort: 9000}},
			Replicas:      3,
		},
	}, Options{Namespace: "demo", Domain: "example.com", ServiceAccount: "wi-sa"})
	if len(skipped) != 0 {
		t.Fatalf("nothing should be skipped, got %v", skipped)
	}
	if len(apps) != 1 {
		t.Fatalf("expected 1 app, got %d", len(apps))
	}
	a := apps[0]
	if a.Image != "123.dkr.ecr.eu-west-1.amazonaws.com/proj-api@sha256:abc123" {
		t.Errorf("image = %q, want the resolved digest URI", a.Image)
	}
	if a.Port != 9000 || a.Replicas != 3 {
		t.Errorf("service config not applied: %+v", a)
	}
	if a.Host != "api.example.com" || a.Namespace != "demo" || a.ServiceAccount != "wi-sa" {
		t.Errorf("app opts not applied: %+v", a)
	}
}

func TestFromServices_PrebuiltImageAndSkips(t *testing.T) {
	apps, skipped := FromServices([]types.ProjectServiceConfig{
		// Prebuilt image → renders with Source.Image.
		{Name: "worker", Type: "deployment", Source: types.ProjectServiceSource{Kind: "image", Image: "ghcr.io/acme/worker:1.2.3"}},
		// Repo-sourced but never BUILT → skipped, never a fabricated ":latest".
		{Name: "unbuilt", Type: "deployment", Source: types.ProjectServiceSource{Kind: "repo", RepoURL: "https://github.com/acme/x"}},
		// Workload type without a template yet → skipped + reported.
		{Name: "nightly", Type: "cronjob", Source: types.ProjectServiceSource{Kind: "image", Image: "ghcr.io/acme/n:1"}},
	}, Options{})
	if len(apps) != 1 || apps[0].Image != "ghcr.io/acme/worker:1.2.3" {
		t.Fatalf("expected only the prebuilt worker to render, got %+v", apps)
	}
	if len(skipped) != 2 {
		t.Fatalf("expected 2 skips (unbuilt + cronjob), got %v", skipped)
	}
	for _, s := range skipped {
		if !strings.Contains(s, "unbuilt") && !strings.Contains(s, "nightly") {
			t.Errorf("skip reason should name the service: %q", s)
		}
	}
}

func TestRenderApp_EnvResourcesProbe(t *testing.T) {
	y, err := RenderApp(App{
		Name:  "api",
		Image: "r/api@sha256:def",
		Port:  8080,
		Env:   []types.ServiceEnvVar{{Name: "LOG_LEVEL", Value: "info"}},
		Resources: &types.ServiceResources{
			Requests: types.ServiceResourceQuantities{CPU: "250m", Memory: "256Mi"},
			Limits:   types.ServiceResourceQuantities{CPU: "1", Memory: "1Gi"},
		},
		Probe: &types.ServiceProbe{Type: "http", Path: "/healthz", Port: 8080},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`name: "LOG_LEVEL"`,
		`value: "info"`,
		"cpu: 250m",
		"memory: 1Gi",
		"readinessProbe:",
		"livenessProbe:",
		"path: /healthz",
	} {
		if !strings.Contains(y, want) {
			t.Errorf("manifest missing %q:\n%s", want, y)
		}
	}
}

func TestRenderApp_TCPProbe(t *testing.T) {
	y, err := RenderApp(App{
		Name:  "q",
		Image: "r/q@sha256:aaa",
		Probe: &types.ServiceProbe{Type: "tcp", Port: 9000},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(y, "tcpSocket:") || !strings.Contains(y, "port: 9000") {
		t.Errorf("tcp probe not rendered:\n%s", y)
	}
	if strings.Contains(y, "httpGet:") {
		t.Errorf("tcp probe must not render httpGet:\n%s", y)
	}
}

func TestWriteManifests(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "gen")
	written, err := WriteManifests(dir, []App{{Name: "api", Image: "r/api:1"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(written) != 1 || written[0] != "api.yaml" {
		t.Fatalf("written = %v", written)
	}
	b, err := os.ReadFile(filepath.Join(dir, "api.yaml"))
	if err != nil || !strings.Contains(string(b), "kind: Deployment") {
		t.Errorf("api.yaml not written correctly: %v", err)
	}
}

func TestRenderApp_DeploymentAndService(t *testing.T) {
	y, err := RenderApp(App{
		Name:           "api",
		Namespace:      "demo",
		Image:          "reg.example.com/api:v1",
		Port:           8080,
		Replicas:       3,
		ServiceAccount: "api-sa",
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"kind: Deployment",
		"kind: Service",
		"name: api",
		"namespace: demo",
		"image: reg.example.com/api:v1",
		"containerPort: 8080",
		"replicas: 3",
		"serviceAccountName: api-sa",
		"runAsNonRoot: true",
		"readOnlyRootFilesystem: true",
	} {
		if !strings.Contains(y, want) {
			t.Errorf("manifest missing %q:\n%s", want, y)
		}
	}
	// No Host → no Ingress.
	if strings.Contains(y, "kind: Ingress") {
		t.Errorf("Ingress should not render without a Host")
	}
}

func TestRenderApp_ImagePullSecrets(t *testing.T) {
	// With a private-registry pull secret, the pod spec must reference it so the kubelet
	// authenticates the image pull (otherwise the secret the registry connector creates is orphaned).
	y, err := RenderApp(App{
		Name:             "api",
		Image:            "ghcr.io/acme/api@sha256:abc",
		ImagePullSecrets: []string{"ghcr-pull"},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"imagePullSecrets:", "- name: ghcr-pull"} {
		if !strings.Contains(y, want) {
			t.Errorf("manifest missing %q:\n%s", want, y)
		}
	}

	// Without it (the common case: public image / own-account ECR-GAR-AR node auth), NO
	// imagePullSecrets block renders — output stays identical to a plain app.
	plain, err := RenderApp(App{Name: "api", Image: "ghcr.io/acme/api@sha256:abc"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(plain, "imagePullSecrets") {
		t.Errorf("imagePullSecrets must not render when none are set:\n%s", plain)
	}
}

func TestRenderApp_IngressWhenHost(t *testing.T) {
	y, err := RenderApp(App{Name: "web", Image: "r/web:1", Host: "web.example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(y, "kind: Ingress") || !strings.Contains(y, "host: web.example.com") {
		t.Errorf("Ingress should render with the host:\n%s", y)
	}
}

func TestRenderApp_Defaults(t *testing.T) {
	y, err := RenderApp(App{Name: "svc", Image: "r/svc:1.0.0"})
	if err != nil {
		t.Fatal(err)
	}
	// Defaults: 2 replicas, port 8080, namespace default, scaffold resources.
	for _, want := range []string{"replicas: 2", "containerPort: 8080", "namespace: default", "cpu: 100m", "memory: 512Mi"} {
		if !strings.Contains(y, want) {
			t.Errorf("default missing %q:\n%s", want, y)
		}
	}
}

func TestRenderApp_EmptyImageIsAnError(t *testing.T) {
	// The ":latest" fallback is RETIRED: an empty image must fail loudly (verify's
	// IMAGE-001 rejects mutable/untagged images, so fabricating one ships a broken app).
	if _, err := RenderApp(App{Name: "svc"}); err == nil {
		t.Fatal("RenderApp with no image must error, not default to :latest")
	}
}

func TestGenerateManifests_FilePerApp(t *testing.T) {
	files, err := GenerateManifests([]App{
		{Name: "API", Image: "r/api:1"}, // uppercase → dns1123
		{Name: "web", Image: "r/web:1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := files["api.yaml"]; !ok {
		t.Errorf("expected api.yaml (name lowercased), got %v", keys(files))
	}
	if _, ok := files["web.yaml"]; !ok {
		t.Errorf("expected web.yaml, got %v", keys(files))
	}
}

func TestGenerateManifests_DuplicateNamesUnique(t *testing.T) {
	files, err := GenerateManifests([]App{
		{Name: "app", Image: "r/a:1"}, {Name: "app", Image: "r/b:1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 {
		t.Errorf("duplicate names should produce 2 files, got %d: %v", len(files), keys(files))
	}
	if _, ok := files["app-2.yaml"]; !ok {
		t.Errorf("second duplicate should be app-2.yaml, got %v", keys(files))
	}
}

func TestDNS1123(t *testing.T) {
	cases := map[string]string{
		"apps/My_Service": "apps-my-service",
		"  Web App  ":     "web-app",
		"---x---":         "x",
	}
	for in, want := range cases {
		if got := dns1123(in); got != want {
			t.Errorf("dns1123(%q) = %q, want %q", in, got, want)
		}
	}
}

func keys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// TestFromServices_ResolvesBindings locks the W3 injection contract (#617): a service's bindings
// become container env — non-secret facets (endpoint/port) as plain VALUES resolved from the
// provision's tofu outputs, credential facets as secretKeyRef into the ExternalSecret-materialized
// Secret. User-authored env is preserved and ordered first.
func TestFromServices_ResolvesBindings(t *testing.T) {
	apps, skipped := FromServices([]types.ProjectServiceConfig{
		{
			Name:   "api",
			Type:   "deployment",
			Source: types.ProjectServiceSource{Kind: "image", Image: "ghcr.io/acme/api:1"},
			Env:    []types.ServiceEnvVar{{Name: "LOG_LEVEL", Value: "info"}},
			Bindings: []types.ServiceBinding{{
				Target: types.ServiceBindingTarget{Kind: "database", Name: "orders-db"},
				Inject: []types.ServiceBindingInjection{
					{Env: "DATABASE_HOST", From: "endpoint"},
					{Env: "DATABASE_PORT", From: "port"},
					{Env: "DATABASE_USER", From: "username"},
					{Env: "DATABASE_PASSWORD", From: "password"},
				},
			}},
		},
	}, Options{Provider: "aws", Outputs: map[string]string{"rds_cluster_endpoint": "orders.abc.rds.amazonaws.com"}})
	if len(skipped) != 0 {
		t.Fatalf("nothing should skip, got %v", skipped)
	}
	a := apps[0]

	// User env first, then binding VALUE facets (endpoint resolved from outputs, port defaulted).
	wantEnv := []types.ServiceEnvVar{
		{Name: "LOG_LEVEL", Value: "info"},
		{Name: "DATABASE_HOST", Value: "orders.abc.rds.amazonaws.com"},
		{Name: "DATABASE_PORT", Value: "5432"},
	}
	if len(a.Env) != len(wantEnv) {
		t.Fatalf("env = %+v, want %+v", a.Env, wantEnv)
	}
	for i, e := range wantEnv {
		if a.Env[i] != e {
			t.Errorf("env[%d] = %+v, want %+v", i, a.Env[i], e)
		}
	}

	// Credential facets → secretKeyRef into the Secret the ExternalSecret lane materializes, named
	// by the SHARED BindingSecretName (externalsecret.go) so the workload reads exactly that Secret.
	// (BindingSecretName itself is tested in externalsecret_test.go — the single source of truth.)
	secretName := BindingSecretName("api", types.ServiceBindingTarget{Kind: "database", Name: "orders-db"})
	wantSecret := []AppSecretEnv{
		{Env: "DATABASE_USER", SecretName: secretName, SecretKey: "username"},
		{Env: "DATABASE_PASSWORD", SecretName: secretName, SecretKey: "password"},
	}
	if len(a.SecretEnv) != len(wantSecret) {
		t.Fatalf("secretEnv = %+v, want %+v", a.SecretEnv, wantSecret)
	}
	for i, s := range wantSecret {
		if a.SecretEnv[i] != s {
			t.Errorf("secretEnv[%d] = %+v, want %+v", i, a.SecretEnv[i], s)
		}
	}
}

// TestFromServices_ResolvesBindings_PerCloud locks the per-cloud endpoint output-key map (#711): a
// service's endpoint facet resolves from the RIGHT tofu output for the provision's cloud — Cloud SQL
// / Memorystore on GCP, the DB FQDN / Cache hostname on Azure — not only the AWS keys. Ports stay on
// the standard managed-service defaults (5432 / 6379) across clouds.
func TestFromServices_ResolvesBindings_PerCloud(t *testing.T) {
	cases := []struct {
		provider     string
		dbEndpointK  string
		cacheEndK    string
		wantDBHost   string
		wantCacheHst string
	}{
		{"gcp", "cloud_sql_ip", "memorystore_host", "10.20.0.3", "10.20.0.4"},
		{"azure", "azure_db_fqdn", "azure_cache_hostname", "db.postgres.database.azure.com", "cache.redis.cache.windows.net"},
	}
	for _, tc := range cases {
		t.Run(tc.provider, func(t *testing.T) {
			apps, skipped := FromServices([]types.ProjectServiceConfig{{
				Name:   "api",
				Type:   "deployment",
				Source: types.ProjectServiceSource{Kind: "image", Image: "ghcr.io/acme/api:1"},
				Bindings: []types.ServiceBinding{
					{
						Target: types.ServiceBindingTarget{Kind: "database", Name: "main"},
						Inject: []types.ServiceBindingInjection{
							{Env: "DB_HOST", From: "endpoint"},
							{Env: "DB_PORT", From: "port"},
						},
					},
					{
						Target: types.ServiceBindingTarget{Kind: "cache", Name: "sessions"},
						Inject: []types.ServiceBindingInjection{{Env: "CACHE_HOST", From: "endpoint"}},
					},
				},
			}}, Options{Provider: tc.provider, Outputs: map[string]string{
				tc.dbEndpointK: tc.wantDBHost,
				tc.cacheEndK:   tc.wantCacheHst,
			}})
			if len(skipped) != 0 {
				t.Fatalf("%s: nothing should skip, got %v", tc.provider, skipped)
			}
			wantEnv := []types.ServiceEnvVar{
				{Name: "DB_HOST", Value: tc.wantDBHost},
				{Name: "DB_PORT", Value: "5432"},
				{Name: "CACHE_HOST", Value: tc.wantCacheHst},
			}
			if len(apps[0].Env) != len(wantEnv) {
				t.Fatalf("%s: env = %+v, want %+v", tc.provider, apps[0].Env, wantEnv)
			}
			for i, e := range wantEnv {
				if apps[0].Env[i] != e {
					t.Errorf("%s: env[%d] = %+v, want %+v", tc.provider, i, apps[0].Env[i], e)
				}
			}
		})
	}
}

// TestFromServices_UnresolvableBindingFailsClosed locks the fail-closed rule (#687): a non-secret
// facet whose value can't be resolved — here a `cache` endpoint on an AWS provision that emitted no
// such tofu output (or a bound BYO-IaC resource the template key map can't reach) — is REPORTED and
// its env var OMITTED, never injected empty. An empty endpoint would boot the app pointed at
// nothing; an absent required env fails loudly instead. The port facet (a kind default, not an
// output lookup) still resolves, and the app still renders.
func TestFromServices_UnresolvableBindingFailsClosed(t *testing.T) {
	apps, skipped := FromServices([]types.ProjectServiceConfig{
		{
			Name:   "api",
			Type:   "deployment",
			Source: types.ProjectServiceSource{Kind: "image", Image: "ghcr.io/acme/api:1"},
			Env:    []types.ServiceEnvVar{{Name: "LOG_LEVEL", Value: "info"}},
			Bindings: []types.ServiceBinding{{
				Target: types.ServiceBindingTarget{Kind: "cache", Name: "sessions"},
				Inject: []types.ServiceBindingInjection{
					{Env: "REDIS_HOST", From: "endpoint"}, // no output emitted → unresolved, omitted
					{Env: "REDIS_PORT", From: "port"},     // kind default → resolves
				},
			}},
		},
	}, Options{Provider: "aws", Outputs: map[string]string{}}) // AWS, but no cache endpoint output emitted

	if len(apps) != 1 {
		t.Fatalf("app must still render, got %d apps", len(apps))
	}
	// The unresolvable endpoint must be reported, naming the facet + service.
	if len(skipped) != 1 {
		t.Fatalf("expected 1 unresolved-binding report, got %v", skipped)
	}
	for _, want := range []string{"endpoint", "REDIS_HOST", "api", "cache/sessions"} {
		if !strings.Contains(skipped[0], want) {
			t.Errorf("report %q missing %q", skipped[0], want)
		}
	}
	// The empty endpoint env must NOT be injected; the resolvable port must be.
	for _, e := range apps[0].Env {
		if e.Name == "REDIS_HOST" {
			t.Errorf("unresolvable endpoint must be omitted, not injected: %+v", e)
		}
	}
	wantEnv := []types.ServiceEnvVar{
		{Name: "LOG_LEVEL", Value: "info"},
		{Name: "REDIS_PORT", Value: "6379"},
	}
	if len(apps[0].Env) != len(wantEnv) {
		t.Fatalf("env = %+v, want %+v", apps[0].Env, wantEnv)
	}
	for i, e := range wantEnv {
		if apps[0].Env[i] != e {
			t.Errorf("env[%d] = %+v, want %+v", i, apps[0].Env[i], e)
		}
	}
}

// byoDBTarget is a bound BYO-IaC database target with its customer-module output mapping (#687).
func byoDBTarget() types.ServiceBindingTarget {
	return types.ServiceBindingTarget{
		Kind:    "database",
		Name:    "primary",
		Address: "module.db.aws_db_instance.main",
		OutputKeys: &types.ServiceBindingOutputKeys{
			Endpoint:         "db_endpoint",
			CredentialSecret: "db_master_secret",
		},
	}
}

// TestFromServices_ResolvesBYOIaCBinding locks #687: a binding to a BYO-IaC target resolves its
// endpoint from the CUSTOMER module's declared output (not the platform template key), and a
// credential facet becomes a secretKeyRef when the module exported a master-secret output the ESO
// store can read — mirroring the first-class contract but keyed off the target's OutputKeys.
func TestFromServices_ResolvesBYOIaCBinding(t *testing.T) {
	apps, skipped := FromServices([]types.ProjectServiceConfig{{
		Name:   "api",
		Type:   "deployment",
		Source: types.ProjectServiceSource{Kind: "image", Image: "ghcr.io/acme/api:1"},
		Bindings: []types.ServiceBinding{{
			Target: byoDBTarget(),
			Inject: []types.ServiceBindingInjection{
				{Env: "DATABASE_HOST", From: "endpoint"},
				{Env: "DATABASE_PORT", From: "port"},
				{Env: "DATABASE_USER", From: "username"},
			},
		}},
	}}, Options{Provider: "aws", Outputs: map[string]string{
		// Customer-named outputs — NOT rds_cluster_endpoint / rds_master_credentials_secret_name.
		"db_endpoint":      "prod-db.internal:5432",
		"db_master_secret": "arn:aws:secretsmanager:...:acme/db",
	}})
	if len(skipped) != 0 {
		t.Fatalf("nothing should skip, got %v", skipped)
	}
	a := apps[0]
	wantEnv := []types.ServiceEnvVar{
		{Name: "DATABASE_HOST", Value: "prod-db.internal:5432"}, // from the CUSTOMER output
		{Name: "DATABASE_PORT", Value: "5432"},                  // kind default (no port output)
	}
	if len(a.Env) != len(wantEnv) {
		t.Fatalf("env = %+v, want %+v", a.Env, wantEnv)
	}
	for i, e := range wantEnv {
		if a.Env[i] != e {
			t.Errorf("env[%d] = %+v, want %+v", i, a.Env[i], e)
		}
	}
	// The credential facet is satisfiable (module exported db_master_secret, aws has an ESO store) →
	// secretKeyRef into the SHARED BindingSecretName.
	wantSecret := AppSecretEnv{
		Env:        "DATABASE_USER",
		SecretName: BindingSecretName("api", byoDBTarget()),
		SecretKey:  "username",
	}
	if len(a.SecretEnv) != 1 || a.SecretEnv[0] != wantSecret {
		t.Fatalf("secretEnv = %+v, want [%+v]", a.SecretEnv, wantSecret)
	}
}

// TestFromServices_BYOIaCEndpointUnsatisfiable locks the #687 fail-closed rule for a BYO-IaC target
// whose declared endpoint output is absent from the deploy outputs: the endpoint env is REPORTED and
// OMITTED (never injected empty), exactly like the first-class unresolvable case.
func TestFromServices_BYOIaCEndpointUnsatisfiable(t *testing.T) {
	tgt := byoDBTarget()
	_, skipped := FromServices([]types.ProjectServiceConfig{{
		Name:   "api",
		Type:   "deployment",
		Source: types.ProjectServiceSource{Kind: "image", Image: "ghcr.io/acme/api:1"},
		Bindings: []types.ServiceBinding{{
			Target: tgt,
			Inject: []types.ServiceBindingInjection{{Env: "DATABASE_HOST", From: "endpoint"}},
		}},
	}}, Options{Provider: "aws", Outputs: map[string]string{}}) // db_endpoint not emitted
	if len(skipped) != 1 {
		t.Fatalf("expected 1 unresolved report, got %v", skipped)
	}
	for _, want := range []string{"endpoint", "DATABASE_HOST", "database/primary"} {
		if !strings.Contains(skipped[0], want) {
			t.Errorf("report %q missing %q", skipped[0], want)
		}
	}
}

// TestFromServices_BYOIaCCredentialUnsatisfiable locks the #687 fail-closed credential rule: when a
// BYO-IaC module exported NO master-credentials secret output, a credential facet must NOT emit a
// secretKeyRef (that would point the workload at a Secret the ExternalSecret lane will never
// materialize) — it is reported and omitted instead.
func TestFromServices_BYOIaCCredentialUnsatisfiable(t *testing.T) {
	tgt := types.ServiceBindingTarget{
		Kind:    "database",
		Name:    "primary",
		Address: "module.db.aws_db_instance.main",
		// Endpoint declared, but NO CredentialSecret output — the module keeps no cloud secret.
		OutputKeys: &types.ServiceBindingOutputKeys{Endpoint: "db_endpoint"},
	}
	apps, skipped := FromServices([]types.ProjectServiceConfig{{
		Name:   "api",
		Type:   "deployment",
		Source: types.ProjectServiceSource{Kind: "image", Image: "ghcr.io/acme/api:1"},
		Bindings: []types.ServiceBinding{{
			Target: tgt,
			Inject: []types.ServiceBindingInjection{
				{Env: "DATABASE_HOST", From: "endpoint"},
				{Env: "DATABASE_PASSWORD", From: "password"},
			},
		}},
	}}, Options{Provider: "aws", Outputs: map[string]string{"db_endpoint": "prod-db.internal"}})
	// Endpoint resolves; the credential is reported unsatisfiable and emits NO secretKeyRef.
	if len(apps[0].SecretEnv) != 0 {
		t.Errorf("no secretKeyRef must be emitted for an unsatisfiable BYO-IaC credential, got %+v", apps[0].SecretEnv)
	}
	foundCred := false
	for _, s := range skipped {
		if strings.Contains(s, "credential") && strings.Contains(s, "DATABASE_PASSWORD") {
			foundCred = true
		}
	}
	if !foundCred {
		t.Errorf("expected a fail-closed credential report naming DATABASE_PASSWORD, got %v", skipped)
	}
}

// TestRenderApp_SecretEnv renders a workload whose only env is a binding credential — the env block
// must still emit with a valueFrom.secretKeyRef (not be skipped for want of plain env).
func TestRenderApp_SecretEnv(t *testing.T) {
	y, err := RenderApp(App{
		Name:  "api",
		Image: "ghcr.io/acme/api:1",
		SecretEnv: []AppSecretEnv{
			{Env: "DATABASE_PASSWORD", SecretName: "alethia-bind-database-orders-db", SecretKey: "password"},
		},
	})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	for _, want := range []string{
		"valueFrom:",
		"secretKeyRef:",
		"name: alethia-bind-database-orders-db",
		"key: password",
		`- name: "DATABASE_PASSWORD"`,
	} {
		if !strings.Contains(y, want) {
			t.Errorf("rendered manifest missing %q:\n%s", want, y)
		}
	}
	if strings.Contains(y, ":latest") {
		t.Errorf("must never render :latest:\n%s", y)
	}
}
