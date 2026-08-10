// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// newRefusingClient returns a client pointed at a control plane that answers every
// request with a 500 and a JSON error body, so each wrapper's failure branch runs.
func newRefusingClient(t *testing.T) *Client {
	t.Helper()
	isolateConfigDir(t)
	return newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": "control plane exploded"})
	}))
}

// newUnbuildableClient returns a client whose base URL carries an ASCII control
// character, so http.NewRequest refuses to build the request at all.
func newUnbuildableClient(t *testing.T) *Client {
	t.Helper()
	isolateConfigDir(t)
	t.Setenv("ALETHIA_WEB_ORIGIN", "http://control\x7fplane.invalid")
	return NewClient("test-token")
}

// TestWrappers_SurfaceTheirOwnContextOnFailure drives every read/write wrapper
// against a refusing control plane and asserts each one wraps the transport error
// with its own operation name (so the CLI's message names what failed).
func TestWrappers_SurfaceTheirOwnContextOnFailure(t *testing.T) {
	tests := []struct {
		name string
		want string
		call func(*Client) error
	}{
		{"GetConfiguration", "failed to get configuration", func(c *Client) error {
			_, err := c.GetConfiguration("my-app")
			return err
		}},
		{"ExportConfiguration", "failed to export configuration", func(c *Client) error {
			_, err := c.ExportConfiguration("my-app", "")
			return err
		}},
		{"QueueJobWithParams", "failed to queue job", func(c *Client) error {
			_, err := c.QueueJobWithParams(QueueJobParams{JobType: "PLAN"})
			return err
		}},
		{"GetJobs", "failed to get jobs", func(c *Client) error {
			_, err := c.GetJobs("QUEUED", 10, 5)
			return err
		}},
		{"GetJobLogs", "failed to get job logs", func(c *Client) error {
			_, err := c.GetJobLogs("j1", 3)
			return err
		}},
		{"DeployRunner", "failed to deploy runner", func(c *Client) error {
			_, err := c.DeployRunner("r", "ci-1", "eu-central-1", "")
			return err
		}},
		{"GetClusters", "failed to get clusters", func(c *Client) error {
			_, err := c.GetClusters()
			return err
		}},
		{"GetCloudIdentities", "failed to get cloud identities", func(c *Client) error {
			_, err := c.GetCloudIdentities()
			return err
		}},
		{"InitProviderIdentity", "failed to initialize gcp connection", func(c *Client) error {
			_, err := c.InitProviderIdentity("gcp")
			return err
		}},
		{"DisconnectProviderIdentity", "failed to disconnect azure", func(c *Client) error {
			return c.DisconnectProviderIdentity("azure", "id-1")
		}},
		{"GetProviderStatus", "failed to get aws status", func(c *Client) error {
			_, err := c.GetProviderStatus("aws")
			return err
		}},
		{"ListOrgs", "failed to list organizations", func(c *Client) error {
			_, err := c.ListOrgs()
			return err
		}},
		{"ListMembers", "failed to list members", func(c *Client) error {
			_, err := c.ListMembers("org-1")
			return err
		}},
		{"InviteMember", "failed to invite member", func(c *Client) error {
			_, err := c.InviteMember("org-1", "a@b.c", "member")
			return err
		}},
		{"RemoveMember", "failed to remove member", func(c *Client) error {
			return c.RemoveMember("org-1", "m-1")
		}},
		{"ListTeams", "failed to list teams", func(c *Client) error {
			_, err := c.ListTeams("org-1")
			return err
		}},
		{"CreateTeam", "failed to create team", func(c *Client) error {
			_, err := c.CreateTeam("org-1", "platform")
			return err
		}},
		{"DeleteTeam", "failed to delete team", func(c *Client) error {
			return c.DeleteTeam("org-1", "t-1")
		}},
		{"ListChannels", "failed to list channels", func(c *Client) error {
			_, err := c.ListChannels()
			return err
		}},
		{"CreateChannel", "failed to create channel", func(c *Client) error {
			_, err := c.CreateChannel("ops", "webhook", map[string]interface{}{"url": "https://x"})
			return err
		}},
		{"DeleteChannel", "failed to delete channel", func(c *Client) error {
			return c.DeleteChannel("ch-1")
		}},
		{"VerifyChannel", "failed to verify channel", func(c *Client) error {
			_, err := c.VerifyChannel("ch-1")
			return err
		}},
		{"ListAlertRules", "failed to list alert rules", func(c *Client) error {
			_, err := c.ListAlertRules()
			return err
		}},
		{"CreateAlertRule", "failed to create alert rule", func(c *Client) error {
			_, err := c.CreateAlertRule("r", []string{"job.*"}, []string{"ch-1"}, "warning")
			return err
		}},
		{"DeleteAlertRule", "failed to delete alert rule", func(c *Client) error {
			return c.DeleteAlertRule("ar-1")
		}},
		{"ListActivity", "failed to list activity", func(c *Client) error {
			_, err := c.ListActivity(25)
			return err
		}},
		{"ListRoles", "failed to list roles", func(c *Client) error {
			_, err := c.ListRoles()
			return err
		}},
		{"CreateRole", "failed to create role", func(c *Client) error {
			_, err := c.CreateRole("auditor", nil)
			return err
		}},
		{"GetResourceClassifications", "failed to get classifications", func(c *Client) error {
			_, err := c.GetResourceClassifications("project", "p-1")
			return err
		}},
		{"ListGrants", "failed to list grants", func(c *Client) error {
			_, err := c.ListGrants()
			return err
		}},
		{"AddGrant", "failed to add grant", func(c *Client) error {
			_, err := c.AddGrant(AddGrantParams{PrincipalType: "user", PrincipalID: "u-1"})
			return err
		}},
		{"RemoveGrant", "failed to remove grant", func(c *Client) error {
			return c.RemoveGrant("g-1")
		}},
		{"ListSsoProviders", "failed to list SSO providers", func(c *Client) error {
			_, err := c.ListSsoProviders()
			return err
		}},
		{"GetUsage", "failed to get usage", func(c *Client) error {
			_, err := c.GetUsage()
			return err
		}},
		{"ListFleetPools", "failed to list fleet pools", func(c *Client) error {
			_, err := c.ListFleetPools()
			return err
		}},
		{"ListEnvironments", "failed to list environments", func(c *Client) error {
			_, err := c.ListEnvironments("p-1")
			return err
		}},
		{"AddEnvironment", "failed to add environment", func(c *Client) error {
			_, err := c.AddEnvironment(AddEnvironmentParams{Project: "p-1", Name: "staging"})
			return err
		}},
		{"ListComponents", "failed to list components", func(c *Client) error {
			_, err := c.ListComponents("p-1", "", "")
			return err
		}},
		{"AddComponent", "failed to add component", func(c *Client) error {
			_, err := c.AddComponent("p-1", "database", "", "", nil)
			return err
		}},
		{"RemoveComponent", "failed to remove component", func(c *Client) error {
			return c.RemoveComponent("p-1", "database", "", "")
		}},
		{"GetProjectDrift", "failed to get drift", func(c *Client) error {
			_, err := c.GetProjectDrift("p-1", "")
			return err
		}},
		{"GetEnvironmentCost", "failed to get cost", func(c *Client) error {
			_, err := c.GetEnvironmentCost("p-1", "")
			return err
		}},
		{"GetProjectProtection", "failed to get protection rules", func(c *Client) error {
			_, err := c.GetProjectProtection("p-1")
			return err
		}},
		{"GetProjectProbes", "failed to get probes", func(c *Client) error {
			_, err := c.GetProjectProbes("p-1")
			return err
		}},
		{"GetProjectAddons", "failed to get add-ons", func(c *Client) error {
			_, err := c.GetProjectAddons("p-1", "")
			return err
		}},
		{"GetProjectByoCharts", "failed to get BYO charts", func(c *Client) error {
			_, err := c.GetProjectByoCharts("p-1", "")
			return err
		}},
		{"GetProjectIacSource", "failed to get IaC source", func(c *Client) error {
			_, err := c.GetProjectIacSource("p-1", "")
			return err
		}},
		{"GetProjectPromotions", "failed to get promotions", func(c *Client) error {
			_, err := c.GetProjectPromotions("p-1", "")
			return err
		}},
		{"GetPromotion", "failed to get promotion", func(c *Client) error {
			_, err := c.GetPromotion("p-1", "pr-1")
			return err
		}},
		{"GetProjectStagedChanges", "failed to get staged changes", func(c *Client) error {
			_, err := c.GetProjectStagedChanges("p-1", "")
			return err
		}},
		{"GetCloudInventory", "failed to get cloud inventory", func(c *Client) error {
			_, err := c.GetCloudInventory("ci-1")
			return err
		}},
		{"GetOrgSettings", "failed to get org settings", func(c *Client) error {
			_, err := c.GetOrgSettings()
			return err
		}},
		{"ListAgents", "failed to list agents", func(c *Client) error {
			_, err := c.ListAgents()
			return err
		}},
		{"GetAgent", "failed to get agent", func(c *Client) error {
			_, err := c.GetAgent("a-1")
			return err
		}},
		{"MintBreakglassApproval", "control plane exploded", func(c *Client) error {
			_, err := c.MintBreakglassApproval("job.cancel", "j-1", "INC-1", nil)
			return err
		}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := newRefusingClient(t)
			err := tt.call(client)
			if err == nil {
				t.Fatal("expected an error for a 500 response")
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("expected %q in %q", tt.want, err.Error())
			}
		})
	}
}

// TestVerbs_UnbuildableRequestURL covers the "failed to create request" branch of
// every verb: an origin carrying a control character cannot be parsed into a URL.
func TestVerbs_UnbuildableRequestURL(t *testing.T) {
	tests := []struct {
		name string
		call func(*Client) error
	}{
		{"GET", func(c *Client) error { _, err := c.GetRunners(); return err }},
		{"POST", func(c *Client) error { _, err := c.CreateBootstrapJob(); return err }},
		{"PUT", func(c *Client) error { _, err := c.SetFleetPool("aws", FleetPoolUpdate{}); return err }},
		{"DELETE", func(c *Client) error { return c.DeleteRole("r-1") }},
		{"repositories", func(c *Client) error { _, err := c.GetRepositories("github"); return err }},
		{"bootstrap status", func(c *Client) error { return c.UpdateBootstrapJobStatus("bj-1", "FAILED", "boom") }},
		{"unregister cluster", func(c *Client) error { return c.UnregisterCluster("cl-1", "prod-cluster") }},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := newUnbuildableClient(t)
			err := tt.call(client)
			if err == nil {
				t.Fatal("expected an error when the request URL cannot be built")
			}
		})
	}
}

// TestGetProviderToken_NoUserConfigDir covers the branch where the OS cannot resolve
// a user config directory: the request goes out with no provider-token header.
func TestGetProviderToken_NoUserConfigDir(t *testing.T) {
	t.Setenv("HOME", "")
	t.Setenv("XDG_CONFIG_HOME", "")

	var seen string
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get("X-Provider-Token")
		json.NewEncoder(w).Encode(map[string]any{"repositories": []any{}})
	}))

	if _, err := client.GetRepositories("github"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if seen != "" {
		t.Errorf("expected no provider-token header, got %q", seen)
	}
}
