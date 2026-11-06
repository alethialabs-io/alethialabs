// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"gopkg.in/yaml.v3"
)

// byoUsersTestUsers are two declared users with their own store secrets.
var byoUsersTestUsers = []ByoDBUsersUser{
	{User: "alethia_byo_bbbbbbbbbbbb", RemoteKey: "store/alethia-byo-db-bbbbbbbbbbbb"},
	{User: "alethia_byo_aaaaaaaaaaaa", RemoteKey: "store/alethia-byo-db-aaaaaaaaaaaa"},
}

// byoUsersTestOutputs are each cloud's admin-connection outputs.
var byoUsersTestOutputs = map[string]map[string]string{
	"aws": {"rds_cluster_endpoint": "db.internal", "rds_database_name": "app", "rds_master_credentials_secret_name": "acme/rds/master"},
	"gcp": {"cloud_sql_ip": "10.0.0.5", "cloud_sql_database": "app", "cloud_sql_credentials_secret": "acme-sql-admin"},
	"azure": {"azure_db_fqdn": "db.postgres.database.azure.com", "azure_db_name": "app",
		"azure_db_admin_user": "acme-dbadmin", "azure_db_admin_client_id": "11111111-2222-3333-4444-555555555555"},
}

// byoUsersTestAdminKey is the administrative output each cloud's run must reference only from its
// admin credential object ("" on Azure, which has no admin password).
var byoUsersTestAdminKey = map[string]string{"aws": "acme/rds/master", "gcp": "acme-sql-admin", "azure": ""}

// renderByoUsersFor renders a run for provider with the test users.
func renderByoUsersFor(t *testing.T, provider string, skipRevoke bool) ByoDBUsersJob {
	t.Helper()
	job, err := RenderByoDBUsersJob(ByoDBUsersJobParams{
		Provider: provider, RunnerImage: "ghcr.io/alethia/runner:1", Environment: "env-1",
		Users: byoUsersTestUsers, SkipRevoke: skipRevoke, RunID: "r1",
		Outputs: byoUsersTestOutputs[provider], NamespaceLabels: map[string]string{"alethia.io/secret-store-access": "runner"},
	})
	if err != nil {
		t.Fatalf("%s: render: %v", provider, err)
	}
	return job
}

// byoUsersDoc decodes one rendered document.
func byoUsersDoc(t *testing.T, doc string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := yaml.Unmarshal([]byte(doc), &m); err != nil {
		t.Fatalf("parse: %v\n%s", err, doc)
	}
	return m
}

// dig walks a decoded document by keys.
func dig(m any, keys ...string) any {
	for _, k := range keys {
		mm, ok := m.(map[string]any)
		if !ok {
			return nil
		}
		m = mm[k]
	}
	return m
}

// assertByoUsersLabels checks a document carries both run labels, as strings.
func assertByoUsersLabels(t *testing.T, what string, labels any) {
	t.Helper()
	l, _ := labels.(map[string]any)
	if v, ok := l[ByoDBUsersLabel].(string); !ok || v != "true" {
		t.Errorf("%s: %s = %#v, want the string \"true\"", what, ByoDBUsersLabel, l[ByoDBUsersLabel])
	}
	if v, ok := l[ByoDBUsersOwnerLabel].(string); !ok || v != "env-1" {
		t.Errorf("%s: %s = %#v, want \"env-1\"", what, ByoDBUsersOwnerLabel, l[ByoDBUsersOwnerLabel])
	}
}

// TestByoDBUsersJob_RendersPerCloud pins, for each cloud, what the ADR requires of a run: the
// namespace, the labels on every object, one Secret per user with that user's password alone, each
// read through its own secretKeyRef by the render container only, the admin credential as the
// bootstrap Job sources it, and the db-bootstrap invocation.
func TestByoDBUsersJob_RendersPerCloud(t *testing.T) {
	for _, provider := range []string{"aws", "gcp", "azure"} {
		t.Run(provider, func(t *testing.T) {
			job := renderByoUsersFor(t, provider, false)

			ns := byoUsersDoc(t, job.NamespaceYAML)
			if dig(ns, "kind") != "Namespace" || dig(ns, "metadata", "name") != "alethia-byo-db-users" {
				t.Errorf("namespace document: %v", ns)
			}
			if dig(ns, "metadata", "labels", "alethia.io/secret-store-access") != "runner" || dig(ns, "metadata", "labels", ByoDBUsersLabel) != "true" {
				t.Errorf("namespace labels: %v", dig(ns, "metadata", "labels"))
			}

			// One credential object per user, plus the admin object.
			if len(job.Credentials) != len(byoUsersTestUsers)+1 {
				t.Fatalf("%d credential objects, want %d", len(job.Credentials), len(byoUsersTestUsers)+1)
			}
			userSecrets := map[string]string{} // secret name → remote key
			for _, c := range job.Credentials {
				d := byoUsersDoc(t, c.YAML)
				if dig(d, "metadata", "namespace") != "alethia-byo-db-users" || dig(d, "metadata", "name") != c.Name {
					t.Errorf("%s %s: metadata %v", c.Resource, c.Name, dig(d, "metadata"))
				}
				assertByoUsersLabels(t, c.Name, dig(d, "metadata", "labels"))
				if dig(d, "kind") != "ExternalSecret" {
					continue
				}
				assertByoUsersLabels(t, c.Name+" (its Secret)", dig(d, "spec", "target", "template", "metadata", "labels"))
				if dig(d, "spec", "target", "creationPolicy") != "Owner" {
					t.Errorf("%s: the Secret is not owned by its ExternalSecret, so a Foreground delete would not remove it", c.Name)
				}
				data, _ := dig(d, "spec", "data").([]any)
				if strings.HasSuffix(c.Name, "-admin") {
					if key := byoUsersTestAdminKey[provider]; key == "" || len(data) != 2 || dig(data[0], "remoteRef", "key") != key {
						t.Errorf("%s: admin ExternalSecret data %v", c.Name, data)
					}
					continue
				}
				if len(data) != 1 || dig(data[0], "secretKey") != "password" {
					t.Fatalf("%s: a user's Secret must hold exactly that user's password, got %v", c.Name, data)
				}
				key, _ := dig(data[0], "remoteRef", "key").(string)
				if key == byoUsersTestAdminKey[provider] && key != "" {
					t.Errorf("%s reads the administrative secret", c.Name)
				}
				userSecrets[c.Name] = key
			}
			if len(userSecrets) != len(byoUsersTestUsers) {
				t.Fatalf("%d user Secrets, want one per user: %v", len(userSecrets), userSecrets)
			}
			seenKeys := map[string]bool{}
			for _, k := range userSecrets {
				if seenKeys[k] {
					t.Errorf("two user Secrets read one store key %s", k)
				}
				seenKeys[k] = true
			}

			j := byoUsersDoc(t, job.JobYAML)
			if dig(j, "metadata", "namespace") != "alethia-byo-db-users" || dig(j, "metadata", "name") != job.JobName {
				t.Errorf("Job metadata %v", dig(j, "metadata"))
			}
			assertByoUsersLabels(t, "Job", dig(j, "metadata", "labels"))
			assertByoUsersLabels(t, "Job pod", dig(j, "spec", "template", "metadata", "labels"))
			if dig(j, "spec", "activeDeadlineSeconds") != bootstrapJobDeadlineSeconds || dig(j, "spec", "ttlSecondsAfterFinished") != bootstrapJobTTLSeconds {
				t.Errorf("deadline/TTL %v/%v, want the bootstrap Job's", dig(j, "spec", "activeDeadlineSeconds"), dig(j, "spec", "ttlSecondsAfterFinished"))
			}
			pod := dig(j, "spec", "template", "spec")
			inits, _ := dig(pod, "initContainers").([]any)
			var render map[string]any
			for _, c := range inits {
				if dig(c, "name") == "render-sql" {
					render, _ = c.(map[string]any)
				}
			}
			if render == nil {
				t.Fatalf("no render-sql init container")
			}
			// One env var per user, each from that user's own Secret, key password.
			refs := map[string]string{}
			envs, _ := render["env"].([]any)
			for _, e := range envs {
				name, _ := dig(e, "name").(string)
				secret, _ := dig(e, "valueFrom", "secretKeyRef", "name").(string)
				if dig(e, "valueFrom", "secretKeyRef", "key") != "password" {
					t.Errorf("%s does not read a password key", name)
				}
				refs[name] = secret
			}
			for _, u := range byoUsersTestUsers {
				want := byoDBUsersUserSecretName("env-1", u.User)
				if refs[ByoDBUsersPasswordEnv(u.User)] != want {
					t.Errorf("%s reads %q, want its own Secret %q", ByoDBUsersPasswordEnv(u.User), refs[ByoDBUsersPasswordEnv(u.User)], want)
				}
			}
			if len(refs) != len(byoUsersTestUsers) {
				t.Errorf("render-sql has %d env vars, want one per user: %v", len(refs), refs)
			}
			args := strings.Join(toStrings(render["args"]), " ")
			for _, want := range []string{"db-bootstrap --byo-users", "--provider " + provider, "--env-id env-1", "--db app",
				"--users=alethia_byo_aaaaaaaaaaaa,alethia_byo_bbbbbbbbbbbb", "--result-path /dev/termination-log", "--out /sql/init.sql"} {
				if !strings.Contains(args, want) {
					t.Errorf("render-sql args %q lack %q", args, want)
				}
			}
			if strings.Contains(args, "--skip-revoke") {
				t.Errorf("--skip-revoke rendered for a complete declared set: %q", args)
			}

			mains, _ := dig(pod, "containers").([]any)
			if len(mains) != 1 || dig(mains[0], "name") != ByoDBUsersMainContainer {
				t.Fatalf("containers %v", mains)
			}
			main := mains[0]
			if dig(main, "terminationMessagePath") != "/dev/termination-log" {
				t.Errorf("terminationMessagePath %v", dig(main, "terminationMessagePath"))
			}
			cmd := strings.Join(toStrings(dig(main, "command")), " ")
			if !strings.Contains(cmd, "psql -X -v ON_ERROR_STOP=1 -f /sql/init.sql") || strings.Contains(cmd, "single-transaction") {
				t.Errorf("apply command %q", cmd)
			}
			mainEnv, _ := dig(main, "env").([]any)
			for _, e := range mainEnv {
				if secret, _ := dig(e, "valueFrom", "secretKeyRef", "name").(string); secret != "" && secret != byoDBUsersAdminName("env-1") {
					t.Errorf("the apply container reads %s; only render-sql may read a user's password", secret)
				}
			}
			if provider == "azure" {
				if dig(pod, "serviceAccountName") != byoDBUsersAdminName("env-1") {
					t.Errorf("Azure pod runs as %v", dig(pod, "serviceAccountName"))
				}
				sa := byoUsersDoc(t, job.Credentials[0].YAML)
				if dig(sa, "kind") != "ServiceAccount" || dig(sa, "metadata", "annotations", "azure.workload.identity/client-id") != byoUsersTestOutputs["azure"]["azure_db_admin_client_id"] {
					t.Errorf("Azure admin ServiceAccount %v", sa)
				}
			} else if dig(pod, "serviceAccountName") != nil {
				t.Errorf("%s pod names a ServiceAccount", provider)
			}
		})
	}
}

// toStrings converts a decoded YAML list to strings.
func toStrings(v any) []string {
	l, _ := v.([]any)
	out := make([]string, 0, len(l))
	for _, x := range l {
		s, _ := x.(string)
		out = append(out, s)
	}
	return out
}

// TestByoDBUsersJob_EmptySetAndSkipRevoke: an empty declared set is still an explicit `--users=`
// (db-bootstrap refuses a missing flag) and renders no user Secret; --skip-revoke is rendered only
// when asked.
func TestByoDBUsersJob_EmptySetAndSkipRevoke(t *testing.T) {
	job, err := RenderByoDBUsersJob(ByoDBUsersJobParams{Provider: "aws", RunnerImage: "img", Environment: "env-1", RunID: "r1",
		Outputs: byoUsersTestOutputs["aws"]})
	if err != nil {
		t.Fatal(err)
	}
	if len(job.Credentials) != 1 {
		t.Errorf("%d credential objects for an empty set, want the admin one only", len(job.Credentials))
	}
	if !regexp.MustCompile(`- --users=\n`).MatchString(job.JobYAML) {
		t.Errorf("no explicit empty --users= argument:\n%s", job.JobYAML)
	}
	skip := renderByoUsersFor(t, "aws", true)
	if !strings.Contains(skip.JobYAML, "- --skip-revoke\n") {
		t.Errorf("--skip-revoke not rendered:\n%s", skip.JobYAML)
	}
}

// TestByoDBUsersJob_FailsClosed: a run that could not connect, or would hand db-bootstrap a name it
// refuses, is not rendered.
func TestByoDBUsersJob_FailsClosed(t *testing.T) {
	base := func() ByoDBUsersJobParams {
		return ByoDBUsersJobParams{Provider: "aws", RunnerImage: "img", Environment: "env-1", RunID: "r1",
			Users: []ByoDBUsersUser{byoUsersTestUsers[0]}, Outputs: map[string]string{}}
	}
	for name, mut := range map[string]func(*ByoDBUsersJobParams){
		"no runner image":  func(p *ByoDBUsersJobParams) { p.RunnerImage = "" },
		"no environment":   func(p *ByoDBUsersJobParams) { p.Environment = "" },
		"bad run id":       func(p *ByoDBUsersJobParams) { p.RunID = "R 1" },
		"unknown provider": func(p *ByoDBUsersJobParams) { p.Provider = "hetzner" },
		"not a per-binding user": func(p *ByoDBUsersJobParams) {
			p.Users = []ByoDBUsersUser{{User: "alethia_app", RemoteKey: "k"}}
		},
		"user twice": func(p *ByoDBUsersJobParams) { p.Users = append(p.Users, p.Users[0]) },
		"no remote key": func(p *ByoDBUsersJobParams) {
			p.Users = []ByoDBUsersUser{{User: "alethia_byo_aaaaaaaaaaaa", RemoteKey: " "}}
		},
		"multi-line remote key": func(p *ByoDBUsersJobParams) {
			p.Users = []ByoDBUsersUser{{User: "alethia_byo_aaaaaaaaaaaa", RemoteKey: "a\nb"}}
		},
	} {
		t.Run(name, func(t *testing.T) {
			p := base()
			p.Outputs = byoUsersTestOutputs["aws"]
			mut(&p)
			if _, err := RenderByoDBUsersJob(p); err == nil {
				t.Errorf("rendered")
			}
		})
	}
	for provider, outputs := range byoUsersTestOutputs {
		for key := range outputs {
			t.Run(provider+" without "+key, func(t *testing.T) {
				p := base()
				p.Provider = provider
				p.Outputs = map[string]string{}
				for k, v := range outputs {
					if k != key {
						p.Outputs[k] = v
					}
				}
				if _, err := RenderByoDBUsersJob(p); err == nil || !strings.Contains(err.Error(), key) {
					t.Errorf("err = %v, want one naming %s", err, key)
				}
			})
		}
	}
}

// TestByoDBUsersJob_SecurityContextMatchesTheBootstrapJob holds the run's pod and container security
// context to the bootstrap Job's, which the ADR says it shares.
func TestByoDBUsersJob_SecurityContextMatchesTheBootstrapJob(t *testing.T) {
	boot, err := RenderBootstrapJob(Options{Provider: "aws", RunnerImage: "img", Outputs: map[string]string{
		"rds_cluster_endpoint": "db", "rds_database_name": "app", "rds_master_credentials_secret_name": "m"}},
		types.ServiceBindingTarget{Kind: types.ServiceBindingKindDatabase, Name: "primary"})
	if err != nil {
		t.Fatal(err)
	}
	bootPod := dig(byoUsersDoc(t, boot.JobYAML), "spec", "template", "spec")
	pod := dig(byoUsersDoc(t, renderByoUsersFor(t, "aws", false).JobYAML), "spec", "template", "spec")
	if !reflect.DeepEqual(dig(pod, "securityContext"), dig(bootPod, "securityContext")) {
		t.Errorf("pod securityContext %v, the bootstrap Job's %v", dig(pod, "securityContext"), dig(bootPod, "securityContext"))
	}
	bootC := dig(bootPod, "containers").([]any)[0]
	for _, c := range append(dig(pod, "initContainers").([]any), dig(pod, "containers").([]any)...) {
		if !reflect.DeepEqual(dig(c, "securityContext"), dig(bootC, "securityContext")) || !reflect.DeepEqual(dig(c, "resources"), dig(bootC, "resources")) {
			t.Errorf("container %v: securityContext/resources differ from the bootstrap Job's", dig(c, "name"))
		}
	}
}

// TestByoDBUsersJob_ContractWithTheRunner pins the spellings this renderer shares with
// `alethia db-bootstrap --byo-users` (apps/runner, a separate module this package cannot import):
// the password variable prefix and the default result path.
func TestByoDBUsersJob_ContractWithTheRunner(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "..", "apps", "runner", "internal", "agent", "db_bootstrap_byo.go"))
	if err != nil {
		t.Fatalf("read the runner source: %v", err)
	}
	if want := `const byoPasswordEnvPrefix = "` + ByoDBUsersPasswordEnv(ByoDBUserPrefix) + `"`; !strings.Contains(string(src), want) {
		t.Errorf("the runner's password variable prefix is not %q", want)
	}
	if !strings.Contains(string(src), `fs.String("result-path", "`+ByoDBUsersResultPath+`"`) {
		t.Errorf("the runner's default --result-path is not %s", ByoDBUsersResultPath)
	}
}

// TestByoDBUsersJob_RefusesACloudWithNoAdminConnection: Alibaba has a ClusterSecretStore but no admin
// connection this Job knows (the bootstrap Job has none there either), so a run is refused rather
// than rendered against outputs it would not read.
func TestByoDBUsersJob_RefusesACloudWithNoAdminConnection(t *testing.T) {
	if StoreNameFor("alibaba") == "" {
		t.Fatal("fixture: alibaba is expected to have a store, so the refusal below is the admin connection's")
	}
	_, err := RenderByoDBUsersJob(ByoDBUsersJobParams{Provider: "alibaba", RunnerImage: "img", Environment: "env-1", RunID: "r1",
		Outputs: map[string]string{"rds_cluster_endpoint": "db", "rds_database_name": "app", "rds_master_credentials_secret_name": "m"}})
	if err == nil || !strings.Contains(err.Error(), `not supported for provider "alibaba"`) {
		t.Fatalf("err = %v", err)
	}
}

// TestByoDBUsersJob_MarshalDefectPanics: a document holding a value YAML cannot encode is a defect in
// the renderer, and fails loudly instead of rendering a partial manifest — which is why
// marshalByoDBUsersDoc has no error to return.
func TestByoDBUsersJob_MarshalDefectPanics(t *testing.T) {
	defer func() {
		if r := recover(); r == nil || !strings.Contains(fmt.Sprint(r), "cannot marshal") {
			t.Fatalf("recovered %v, want yaml's panic on an unencodable value", r)
		}
	}()
	marshalByoDBUsersDoc(map[string]any{"bad": make(chan int)})
}
