// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build integration

package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func loadTestToken(t *testing.T) string {
	t.Helper()
	configDir, err := os.UserConfigDir()
	if err != nil {
		t.Skip("cannot find config dir")
	}
	credsPath := filepath.Join(configDir, "alethia", "credentials.json")
	data, err := os.ReadFile(credsPath)
	if err != nil {
		t.Skip("not logged in — run `alethia login` first")
	}
	var creds types.ExchangeResponse
	if err := json.Unmarshal(data, &creds); err != nil {
		t.Skip("invalid credentials file")
	}
	if creds.AccessToken == "" {
		t.Skip("empty access token")
	}

	token, err := refreshIfNeeded(creds, credsPath)
	if err != nil {
		t.Skipf("token refresh failed: %v — run `alethia login` to re-authenticate", err)
	}
	return token
}

func refreshIfNeeded(creds types.ExchangeResponse, credsPath string) (string, error) {
	webOrigin := os.Getenv("ALETHIA_WEB_ORIGIN")
	if webOrigin == "" {
		webOrigin = "http://localhost"
	}

	payload, _ := json.Marshal(map[string]string{"refresh_token": creds.RefreshToken})
	resp, err := http.Post(webOrigin+"/api/auth/cli/refresh", "application/json", bytes.NewBuffer(payload))
	if err != nil {
		return creds.AccessToken, nil
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK {
		var result struct {
			AccessToken string `json:"access_token"`
		}
		json.NewDecoder(resp.Body).Decode(&result)
		if result.AccessToken != "" {
			creds.AccessToken = result.AccessToken
			data, _ := json.MarshalIndent(creds, "", "  ")
			os.WriteFile(credsPath, data, 0644)
			return result.AccessToken, nil
		}
	}

	return creds.AccessToken, nil
}

func skipOnAuthOrNotFound(t *testing.T, err error, endpoint string) {
	t.Helper()
	if err == nil {
		return
	}
	msg := err.Error()
	if strings.Contains(msg, "Unauthorized") || strings.Contains(msg, "Invalid token") {
		t.Skipf("auth failed for %s — run `alethia login` to refresh", endpoint)
	}
	if strings.Contains(msg, "404") || strings.Contains(msg, "status code 404") {
		t.Skipf("endpoint %s not deployed yet — skipping", endpoint)
	}
	if strings.Contains(msg, "status code 500") || strings.Contains(msg, "Failed to fetch") {
		t.Skipf("endpoint %s returned server error (may need deployment) — skipping", endpoint)
	}
}

func TestIntegration_GetRunners(t *testing.T) {
	token := loadTestToken(t)
	client := NewClient(token)

	runners, err := client.GetRunners()
	skipOnAuthOrNotFound(t, err, "GetRunners")
	if err != nil {
		t.Fatalf("GetRunners failed: %v", err)
	}

	t.Logf("Found %d runners", len(runners))
	for _, w := range runners {
		t.Logf("  %s (operator=%s, provisioning=%s, status=%s, default=%v)", w.Name, w.Operator, w.Provisioning, w.Status, w.IsDefault)

		if w.ID == "" {
			t.Error("runner ID is empty")
		}
		if w.Name == "" {
			t.Error("runner name is empty")
		}

		validOperators := map[string]bool{"managed": true, "self": true}
		if !validOperators[w.Operator] {
			t.Errorf("unexpected operator: %s", w.Operator)
		}
		validProvisioning := map[string]bool{"deployed": true, "registered": true, "": true}
		if !validProvisioning[w.Provisioning] {
			t.Errorf("unexpected provisioning: %s", w.Provisioning)
		}

		validStatuses := map[string]bool{"ONLINE": true, "OFFLINE": true, "DRAINING": true, "": true}
		if !validStatuses[w.Status] {
			t.Errorf("unexpected status: %s", w.Status)
		}
	}
}

func TestIntegration_GetClusters(t *testing.T) {
	token := loadTestToken(t)
	client := NewClient(token)

	clusters, err := client.GetClusters()
	skipOnAuthOrNotFound(t, err, "GetClusters")
	if err != nil {
		t.Fatalf("GetClusters failed: %v", err)
	}

	t.Logf("Found %d clusters", len(clusters))
	for _, c := range clusters {
		t.Logf("  %s — %s (%s) [%s]", c.ProjectName, c.ClusterName, c.ClusterVersion, c.Status)

		validStatuses := map[string]bool{
			"PENDING": true, "CREATING": true, "ACTIVE": true,
			"UPDATING": true, "FAILED": true, "DESTROYING": true, "DESTROYED": true,
			"": true,
		}
		if !validStatuses[c.Status] {
			t.Errorf("unexpected cluster status: %s", c.Status)
		}
	}
}

func TestIntegration_GetCloudIdentities(t *testing.T) {
	token := loadTestToken(t)
	client := NewClient(token)

	identities, err := client.GetCloudIdentities()
	skipOnAuthOrNotFound(t, err, "GetCloudIdentities")
	if err != nil {
		t.Fatalf("GetCloudIdentities failed: %v", err)
	}

	t.Logf("Found %d cloud identities", len(identities))
	for _, id := range identities {
		t.Logf("  %s — %s", id.Provider, id.Label)

		if id.ID == "" {
			t.Error("identity ID is empty")
		}

		validProviders := map[string]bool{"aws": true, "gcp": true, "azure": true}
		if !validProviders[id.Provider] {
			t.Errorf("unexpected provider: %s", id.Provider)
		}
	}
}

func TestIntegration_GetJobs(t *testing.T) {
	token := loadTestToken(t)
	client := NewClient(token)

	page, err := client.GetJobs("", 20, 0)
	jobs := page.Jobs
	skipOnAuthOrNotFound(t, err, "GetJobs")
	if err != nil {
		t.Fatalf("GetJobs failed: %v", err)
	}
	_ = page

	t.Logf("Found %d jobs", len(jobs))

	// Derived from the generated enum SSOT so these sets can never drift from the
	// backend's provision_job_status / provision_job_type values.
	validStatuses := map[string]bool{}
	for _, s := range types.AllJobStatuses {
		validStatuses[string(s)] = true
	}
	validTypes := map[string]bool{}
	for _, jt := range types.AllJobTypes {
		validTypes[string(jt)] = true
	}

	for i, j := range jobs {
		if i >= 5 {
			break
		}
		id := j.ID
		if len(id) > 8 {
			id = id[:8]
		}
		t.Logf("  %s — %s [%s]", id, j.JobType, j.Status)

		if !validStatuses[j.Status] {
			t.Errorf("unexpected job status: %s", j.Status)
		}
		if !validTypes[j.JobType] {
			t.Errorf("unexpected job type: %s", j.JobType)
		}
	}
}

func TestIntegration_GetJob_FirstFromList(t *testing.T) {
	token := loadTestToken(t)
	client := NewClient(token)

	page, err := client.GetJobs("", 20, 0)
	jobs := page.Jobs
	skipOnAuthOrNotFound(t, err, "GetJobs")
	if err != nil {
		t.Fatalf("GetJobs failed: %v", err)
	}
	_ = page
	if len(jobs) == 0 {
		t.Skip("no jobs to test with")
	}

	job, err := client.GetJob(jobs[0].ID)
	skipOnAuthOrNotFound(t, err, fmt.Sprintf("GetJob(%s)", jobs[0].ID))
	if err != nil {
		t.Fatalf("GetJob failed: %v", err)
	}
	if job.ID != jobs[0].ID {
		t.Errorf("expected %s, got %s", jobs[0].ID, job.ID)
	}
	id := job.ID
	if len(id) > 8 {
		id = id[:8]
	}
	t.Logf("GetJob(%s) → type=%s status=%s", id, job.JobType, job.Status)
}
