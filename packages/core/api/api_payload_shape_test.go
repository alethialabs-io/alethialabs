// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

// capture records the one request a client made, so a test can assert on the URL
// the client built and the body it sent.
type capture struct {
	path  string
	query string
	body  map[string]interface{}
}

// newCapturingClient returns a client whose control plane records the request and
// answers with the supplied JSON body.
func newCapturingClient(t *testing.T, got *capture, respond string) *Client {
	t.Helper()
	isolateConfigDir(t)
	return newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.path = r.URL.Path
		got.query = r.URL.RawQuery
		raw, _ := io.ReadAll(r.Body)
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &got.body)
		}
		w.Write([]byte(respond))
	}))
}

// TestQueueJobWithParams_SendsEveryOptionalField asserts each optional field is put
// on the wire only when set, under the snake_case key the control plane expects.
func TestQueueJobWithParams_SendsEveryOptionalField(t *testing.T) {
	var got capture
	client := newCapturingClient(t, &got, `{"job":{"id":"j-1","status":"QUEUED"}}`)

	job, err := client.QueueJobWithParams(QueueJobParams{
		JobType:          "DEPLOY",
		ConfigurationID:  "p-1",
		CloudIdentityID:  "ci-1",
		AssignedRunnerID: "rn-1",
		PlanJobID:        "j-0",
		EnvironmentID:    "env-1",
		ConfigSnapshot:   map[string]interface{}{"region": "eu-central-1"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if job == nil || job.ID != "j-1" {
		t.Fatalf("unexpected job: %+v", job)
	}
	if got.path != "/api/jobs" {
		t.Errorf("unexpected path: %s", got.path)
	}

	want := map[string]string{
		"job_type":           "DEPLOY",
		"configuration_id":   "p-1",
		"cloud_identity_id":  "ci-1",
		"assigned_runner_id": "rn-1",
		"plan_job_id":        "j-0",
		"environment_id":     "env-1",
	}
	for key, value := range want {
		if got.body[key] != value {
			t.Errorf("expected %s=%q, got %v", key, value, got.body[key])
		}
	}
	snapshot, ok := got.body["config_snapshot"].(map[string]interface{})
	if !ok || snapshot["region"] != "eu-central-1" {
		t.Errorf("expected the config snapshot on the wire, got %v", got.body["config_snapshot"])
	}
}

// TestQueueJobWithParams_OmitsUnsetFields asserts an unset optional field is absent
// rather than sent empty, so the server applies its own default.
func TestQueueJobWithParams_OmitsUnsetFields(t *testing.T) {
	var got capture
	client := newCapturingClient(t, &got, `{"job":{"id":"j-1"}}`)

	if _, err := client.QueueJobWithParams(QueueJobParams{JobType: "PLAN"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, key := range []string{
		"configuration_id", "cloud_identity_id", "assigned_runner_id",
		"plan_job_id", "environment_id", "config_snapshot",
	} {
		if _, present := got.body[key]; present {
			t.Errorf("expected %s to be omitted, got %v", key, got.body[key])
		}
	}
}

// TestAddGrant_OptionalFieldsAreOmittedOrSent covers both halves of every optional
// grant field: present when set, absent when empty.
func TestAddGrant_OptionalFieldsAreOmittedOrSent(t *testing.T) {
	tests := []struct {
		name    string
		params  AddGrantParams
		want    map[string]string
		omitted []string
	}{
		{
			name: "role grant, org-wide",
			params: AddGrantParams{
				PrincipalType: "user", PrincipalID: "u-1",
			},
			want:    map[string]string{"principal_type": "user", "principal_id": "u-1"},
			omitted: []string{"effect", "role_id", "permission_key", "resource_type", "resource_id"},
		},
		{
			name: "explicit deny on a scoped permission",
			params: AddGrantParams{
				PrincipalType: "team", PrincipalID: "t-1", Effect: "deny",
				PermissionKey: "project:delete", ResourceType: "project", ResourceID: "p-1",
			},
			want: map[string]string{
				"principal_type": "team", "principal_id": "t-1", "effect": "deny",
				"permission_key": "project:delete", "resource_type": "project", "resource_id": "p-1",
			},
			omitted: []string{"role_id"},
		},
		{
			name: "role binding",
			params: AddGrantParams{
				PrincipalType: "user", PrincipalID: "u-2", Effect: "allow", RoleID: "r-1",
			},
			want:    map[string]string{"role_id": "r-1", "effect": "allow"},
			omitted: []string{"permission_key", "resource_type", "resource_id"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got capture
			client := newCapturingClient(t, &got, `{"grant":{"id":"g-1"}}`)

			grant, err := client.AddGrant(tt.params)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if grant == nil || grant.ID != "g-1" {
				t.Fatalf("unexpected grant: %+v", grant)
			}
			for key, value := range tt.want {
				if got.body[key] != value {
					t.Errorf("expected %s=%q, got %v", key, value, got.body[key])
				}
			}
			for _, key := range tt.omitted {
				if _, present := got.body[key]; present {
					t.Errorf("expected %s to be omitted, got %v", key, got.body[key])
				}
			}
		})
	}
}

// TestSetFleetPool_SendsOnlyTheSetFields asserts a nil update field is left off the
// wire so the stored pool config survives an update of its neighbours.
func TestSetFleetPool_SendsOnlyTheSetFields(t *testing.T) {
	warmMin, maxRunners, slots := 2, 9, 3
	enabled := true
	channel, version := "stable", "1.4.0"

	tests := []struct {
		name    string
		update  FleetPoolUpdate
		want    []string
		omitted []string
	}{
		{
			name:    "every field",
			update:  FleetPoolUpdate{WarmMin: &warmMin, Max: &maxRunners, SlotsPerRunner: &slots, Enabled: &enabled, Channel: &channel, Version: &version},
			want:    []string{"warm_min", "max", "slots_per_runner", "enabled", "channel", "version"},
			omitted: nil,
		},
		{
			name:    "capacity only",
			update:  FleetPoolUpdate{WarmMin: &warmMin, Max: &maxRunners},
			want:    []string{"warm_min", "max"},
			omitted: []string{"slots_per_runner", "enabled", "channel", "version"},
		},
		{
			name:    "nothing set",
			update:  FleetPoolUpdate{},
			want:    nil,
			omitted: []string{"warm_min", "max", "slots_per_runner", "enabled", "channel", "version"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got capture
			client := newCapturingClient(t, &got, `{"pool":{"provider":"aws","warm_min":2}}`)

			pool, err := client.SetFleetPool("aws", tt.update)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if pool == nil || pool.Provider != "aws" {
				t.Fatalf("unexpected pool: %+v", pool)
			}
			if got.path != "/api/cli/fleet/aws" {
				t.Errorf("unexpected path: %s", got.path)
			}
			for _, key := range tt.want {
				if _, present := got.body[key]; !present {
					t.Errorf("expected %s on the wire", key)
				}
			}
			for _, key := range tt.omitted {
				if _, present := got.body[key]; present {
					t.Errorf("expected %s to be omitted, got %v", key, got.body[key])
				}
			}
		})
	}
}

// TestCreateProject_OptionalFields asserts the optional authoring fields reach the
// wire only when the caller supplied them.
func TestCreateProject_OptionalFields(t *testing.T) {
	var got capture
	client := newCapturingClient(t, &got, `{"project":{"id":"p-1","project_name":"web"}}`)

	project, err := client.CreateProject(CreateProjectParams{
		ProjectName:     "web",
		Region:          "eu-central-1",
		CloudIdentityID: "ci-1",
		Stage:           "production",
		IacVersion:      "1.9.0",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if project == nil || project.ID != "p-1" {
		t.Fatalf("unexpected project: %+v", project)
	}
	want := map[string]string{
		"project_name":      "web",
		"region":            "eu-central-1",
		"cloud_identity_id": "ci-1",
		"stage":             "production",
		"iac_version":       "1.9.0",
	}
	for key, value := range want {
		if got.body[key] != value {
			t.Errorf("expected %s=%q, got %v", key, value, got.body[key])
		}
	}
}

// TestAddEnvironment_InheritsWhenUnset asserts an empty stage/region is omitted so
// the environment inherits the project's, and sent verbatim when given.
func TestAddEnvironment_InheritsWhenUnset(t *testing.T) {
	tests := []struct {
		name    string
		stage   string
		region  string
		omitted []string
	}{
		{name: "inherit both", omitted: []string{"stage", "region"}},
		{name: "explicit region", stage: "production", region: "us-east-1"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got capture
			client := newCapturingClient(t, &got, `{"environment":{"id":"e-1","name":"staging"}}`)

			env, err := client.AddEnvironment("web", "staging", tt.stage, tt.region)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if env == nil || env.Name != "staging" {
				t.Fatalf("unexpected environment: %+v", env)
			}
			if got.body["name"] != "staging" {
				t.Errorf("expected the environment name on the wire, got %v", got.body["name"])
			}
			for _, key := range tt.omitted {
				if _, present := got.body[key]; present {
					t.Errorf("expected %s to be omitted, got %v", key, got.body[key])
				}
			}
			if tt.region != "" && got.body["region"] != tt.region {
				t.Errorf("expected region=%q, got %v", tt.region, got.body["region"])
			}
		})
	}
}

// TestAddComponent_NilFieldsBecomeAnEmptyObject asserts a nil field map is sent as
// {} rather than JSON null, which the server's insert schema would reject.
func TestAddComponent_NilFieldsBecomeAnEmptyObject(t *testing.T) {
	var got capture
	client := newCapturingClient(t, &got, `{"component":{"id":"c-1","kind":"database"}}`)

	component, err := client.AddComponent("web", "database", "", "", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if component == nil || component.Kind != "database" {
		t.Fatalf("unexpected component: %+v", component)
	}
	fields, ok := got.body["fields"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected fields to be an object, got %v", got.body["fields"])
	}
	if len(fields) != 0 {
		t.Errorf("expected an empty fields object, got %v", fields)
	}
	if _, present := got.body["name"]; present {
		t.Errorf("expected the name to be omitted for a singleton kind, got %v", got.body["name"])
	}
}

// TestCreateRole_NilPermissionKeysBecomeAnEmptyArray asserts a nil key slice is sent
// as [] rather than JSON null.
func TestCreateRole_NilPermissionKeysBecomeAnEmptyArray(t *testing.T) {
	var got capture
	client := newCapturingClient(t, &got, `{"role":{"id":"r-1","name":"auditor"}}`)

	role, err := client.CreateRole("auditor", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if role == nil || role.Name != "auditor" {
		t.Fatalf("unexpected role: %+v", role)
	}
	keys, ok := got.body["permission_keys"].([]interface{})
	if !ok {
		t.Fatalf("expected permission_keys to be an array, got %v", got.body["permission_keys"])
	}
	if len(keys) != 0 {
		t.Errorf("expected an empty permission_keys array, got %v", keys)
	}
}

// TestEnvScopedReads_PassTheEnvSelector covers the `?env=` branch of every
// environment-scoped project read, and asserts the selector is query-escaped.
func TestEnvScopedReads_PassTheEnvSelector(t *testing.T) {
	tests := []struct {
		name     string
		wantPath string
		respond  string
		call     func(*Client, string) error
	}{
		{
			name: "drift", wantPath: "/api/cli/projects/web/drift", respond: `{"evaluated":true,"in_sync":true}`,
			call: func(c *Client, env string) error { _, err := c.GetProjectDrift("web", env); return err },
		},
		{
			name: "cost", wantPath: "/api/cli/projects/web/cost", respond: `{"priced":false}`,
			call: func(c *Client, env string) error { _, err := c.GetEnvironmentCost("web", env); return err },
		},
		{
			name: "addons", wantPath: "/api/cli/projects/web/addons", respond: `{"environment":"prod eu","addons":[]}`,
			call: func(c *Client, env string) error { _, err := c.GetProjectAddons("web", env); return err },
		},
		{
			name: "byo charts", wantPath: "/api/cli/projects/web/byo-charts", respond: `{"environment":"prod eu","charts":[]}`,
			call: func(c *Client, env string) error { _, err := c.GetProjectByoCharts("web", env); return err },
		},
		{
			name: "byo iac", wantPath: "/api/cli/projects/web/byo-iac", respond: `{"source":null}`,
			call: func(c *Client, env string) error { _, err := c.GetProjectIacSource("web", env); return err },
		},
		{
			name: "promotions", wantPath: "/api/cli/projects/web/promotions", respond: `{"promotions":[]}`,
			call: func(c *Client, env string) error { _, err := c.GetProjectPromotions("web", env); return err },
		},
		{
			name: "staged", wantPath: "/api/cli/projects/web/staged", respond: `{"environment":"prod eu","changes":[]}`,
			call: func(c *Client, env string) error { _, err := c.GetProjectStagedChanges("web", env); return err },
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got capture
			client := newCapturingClient(t, &got, tt.respond)

			if err := tt.call(client, "prod eu"); err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.path != tt.wantPath {
				t.Errorf("expected path %s, got %s", tt.wantPath, got.path)
			}
			if got.query != "env=prod+eu" {
				t.Errorf("expected an escaped env selector, got %q", got.query)
			}
		})
	}
}

// TestEnvScopedReads_OmitTheSelectorWhenEmpty asserts an empty env leaves the query
// string off entirely, so the server resolves the default environment.
func TestEnvScopedReads_OmitTheSelectorWhenEmpty(t *testing.T) {
	var got capture
	client := newCapturingClient(t, &got, `{"evaluated":false,"in_sync":false}`)

	posture, err := client.GetProjectDrift("web", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if posture.Evaluated {
		t.Error("expected an unevaluated drift posture")
	}
	if got.query != "" {
		t.Errorf("expected no query string, got %q", got.query)
	}
}

// TestListComponents_FiltersAreQueryEncoded covers the kind/env filter branches of
// the component listing.
func TestListComponents_FiltersAreQueryEncoded(t *testing.T) {
	tests := []struct {
		name      string
		kind      string
		env       string
		wantQuery string
	}{
		{name: "no filters", wantQuery: ""},
		{name: "kind only", kind: "database", wantQuery: "kind=database"},
		{name: "env only", env: "prod eu", wantQuery: "env=prod+eu"},
		{name: "both", kind: "database", env: "staging", wantQuery: "env=staging&kind=database"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got capture
			client := newCapturingClient(t, &got, `{"components":[]}`)

			if _, err := client.ListComponents("web", tt.kind, tt.env); err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.query != tt.wantQuery {
				t.Errorf("expected query %q, got %q", tt.wantQuery, got.query)
			}
		})
	}
}

// TestGetJobs_PaginationQuery covers the status/limit/offset branches of the job
// listing, including the "leave it to the server" defaults.
func TestGetJobs_PaginationQuery(t *testing.T) {
	tests := []struct {
		name      string
		status    string
		limit     int
		offset    int
		wantQuery string
	}{
		{name: "no filters", wantQuery: ""},
		{name: "status only", status: "QUEUED", wantQuery: "status=QUEUED"},
		{name: "limit only", limit: 50, wantQuery: "limit=50"},
		{name: "limit and offset", limit: 50, offset: 100, wantQuery: "limit=50&offset=100"},
		{name: "everything", status: "FAILED", limit: 10, offset: 20, wantQuery: "limit=10&offset=20&status=FAILED"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got capture
			client := newCapturingClient(t, &got, `{"jobs":[],"total":0,"limit":20,"offset":0}`)

			page, err := client.GetJobs(tt.status, tt.limit, tt.offset)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if page.Limit != 20 {
				t.Errorf("expected the server's page size, got %d", page.Limit)
			}
			if got.query != tt.wantQuery {
				t.Errorf("expected query %q, got %q", tt.wantQuery, got.query)
			}
		})
	}
}

// TestListActivity_LimitQuery covers the optional activity page-size branch.
func TestListActivity_LimitQuery(t *testing.T) {
	tests := []struct {
		name      string
		limit     int
		wantQuery string
	}{
		{name: "server default", limit: 0, wantQuery: ""},
		{name: "negative is a server default", limit: -5, wantQuery: ""},
		{name: "explicit", limit: 42, wantQuery: "limit=42"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got capture
			client := newCapturingClient(t, &got, `{"activity":[]}`)

			if _, err := client.ListActivity(tt.limit); err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.query != tt.wantQuery {
				t.Errorf("expected query %q, got %q", tt.wantQuery, got.query)
			}
		})
	}
}
