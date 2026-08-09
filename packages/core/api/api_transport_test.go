// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newDeadClient returns a client pointed at a control plane that is not listening,
// so every request fails at the transport layer.
func newDeadClient(t *testing.T) *Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := server.URL
	server.Close()
	t.Setenv("ALETHIA_WEB_ORIGIN", url)
	return NewClient("test-token")
}

// isolateConfigDir points os.UserConfigDir at a temp directory so the CLI config and
// credentials seen by the client are the test's, not the developer's.
func isolateConfigDir(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	dir, err := os.UserConfigDir()
	if err != nil {
		t.Fatalf("UserConfigDir: %v", err)
	}
	alethia := filepath.Join(dir, "alethia")
	if err := os.MkdirAll(alethia, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	return alethia
}

// --- Error bodies the client cannot parse ---

func TestVerbs_NonJSONErrorBodyKeepsStatusCode(t *testing.T) {
	tests := []struct {
		name   string
		method string
		call   func(*Client) error
	}{
		{
			name: "GET", method: "GET",
			call: func(c *Client) error { _, err := c.GetRunners(); return err },
		},
		{
			name: "POST", method: "POST",
			call: func(c *Client) error { _, err := c.CreateBootstrapJob(); return err },
		},
		{
			name: "PUT", method: "PUT",
			call: func(c *Client) error { _, err := c.SetFleetPool("aws", FleetPoolUpdate{}); return err },
		},
		{
			name: "DELETE", method: "DELETE",
			call: func(c *Client) error { return c.DeleteRole("r1") },
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != tt.method {
					t.Errorf("expected %s, got %s", tt.method, r.Method)
				}
				w.WriteHeader(http.StatusBadGateway)
				w.Write([]byte("<html>upstream is down</html>"))
			}))

			err := tt.call(client)
			if err == nil {
				t.Fatal("expected an error for a 502 response")
			}
			if !strings.Contains(err.Error(), "502") {
				t.Errorf("expected the status code in %q", err.Error())
			}
		})
	}
}

func TestVerbs_JSONErrorBodySurfacesServerMessage(t *testing.T) {
	tests := []struct {
		name string
		call func(*Client) error
	}{
		{name: "GET", call: func(c *Client) error { _, err := c.GetRunners(); return err }},
		{name: "POST", call: func(c *Client) error { _, err := c.CreateBootstrapJob(); return err }},
		{name: "PUT", call: func(c *Client) error { _, err := c.SetFleetPool("aws", FleetPoolUpdate{}); return err }},
		{name: "DELETE", call: func(c *Client) error { return c.DeleteRole("r1") }},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusForbidden)
				json.NewEncoder(w).Encode(map[string]string{"error": "seat limit reached"})
			}))

			err := tt.call(client)
			if err == nil {
				t.Fatal("expected an error for a 403 response")
			}
			if !strings.Contains(err.Error(), "seat limit reached") {
				t.Errorf("expected the server message in %q", err.Error())
			}
		})
	}
}

func TestVerbs_TransportFailure(t *testing.T) {
	tests := []struct {
		name string
		call func(*Client) error
	}{
		{name: "GET", call: func(c *Client) error { _, err := c.GetRunners(); return err }},
		{name: "POST", call: func(c *Client) error { _, err := c.CreateBootstrapJob(); return err }},
		{name: "PUT", call: func(c *Client) error { _, err := c.SetFleetPool("aws", FleetPoolUpdate{}); return err }},
		{name: "DELETE", call: func(c *Client) error { return c.DeleteRole("r1") }},
		{name: "repositories", call: func(c *Client) error { _, err := c.GetRepositories("github"); return err }},
		{name: "bootstrap status", call: func(c *Client) error { return c.UpdateBootstrapJobStatus("bj-1", "FAILED", "boom") }},
		{name: "unregister cluster", call: func(c *Client) error { return c.UnregisterCluster("cl-1", "") }},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := newDeadClient(t)
			if err := tt.call(client); err == nil {
				t.Fatal("expected an error when the control plane is unreachable")
			}
		})
	}
}

// --- Repositories: the provider-token header and the decode paths ---

func TestGetRepositories_ProviderTokenHeader(t *testing.T) {
	tests := []struct {
		name        string
		credentials string
		writeFile   bool
		wantHeader  string
	}{
		{name: "no credentials file", writeFile: false, wantHeader: ""},
		{name: "malformed credentials", writeFile: true, credentials: "{not json", wantHeader: ""},
		{name: "credentials without a provider token", writeFile: true, credentials: `{"access_token":"a"}`, wantHeader: ""},
		{name: "provider token present", writeFile: true, credentials: `{"provider_token":"ptok"}`, wantHeader: "ptok"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := isolateConfigDir(t)
			if tt.writeFile {
				if err := os.WriteFile(filepath.Join(dir, "credentials.json"), []byte(tt.credentials), 0o600); err != nil {
					t.Fatalf("write credentials: %v", err)
				}
			}

			var seen string
			client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				assertAuth(t, r)
				if r.URL.Path != "/api/cli/repositories/github" {
					t.Errorf("unexpected path: %s", r.URL.Path)
				}
				seen = r.Header.Get("X-Provider-Token")
				json.NewEncoder(w).Encode(map[string]any{
					"repositories": []map[string]any{
						{"id": "1", "name": "web", "full_name": "acme/web", "provider": "github"},
					},
				})
			}))

			repos, err := client.GetRepositories("github")
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(repos) != 1 || repos[0].FullName != "acme/web" {
				t.Errorf("unexpected repositories: %+v", repos)
			}
			if seen != tt.wantHeader {
				t.Errorf("expected X-Provider-Token %q, got %q", tt.wantHeader, seen)
			}
		})
	}
}

func TestGetRepositories_ErrorBodies(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		body       string
		wantIn     string
	}{
		{name: "json error", statusCode: http.StatusUnauthorized, body: `{"error":"token expired"}`, wantIn: "token expired"},
		{name: "non-json error", statusCode: http.StatusBadGateway, body: "<html>nope</html>", wantIn: "502"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			isolateConfigDir(t)
			client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tt.statusCode)
				w.Write([]byte(tt.body))
			}))

			_, err := client.GetRepositories("github")
			if err == nil {
				t.Fatal("expected an error")
			}
			if !strings.Contains(err.Error(), tt.wantIn) {
				t.Errorf("expected %q in %q", tt.wantIn, err.Error())
			}
		})
	}
}

func TestGetRepositories_MalformedSuccessBody(t *testing.T) {
	isolateConfigDir(t)
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("not json at all"))
	}))

	if _, err := client.GetRepositories("github"); err == nil {
		t.Fatal("expected a decode error for a malformed 200 body")
	}
}

// --- Org header ---

func TestSetAuthHeaders_ActiveOrg(t *testing.T) {
	tests := []struct {
		name      string
		config    string
		writeFile bool
		wantOrg   string
	}{
		{name: "no config", writeFile: false, wantOrg: ""},
		{name: "config without an active org", writeFile: true, config: `{}`, wantOrg: ""},
		{name: "active org selected", writeFile: true, config: `{"active_org_id":"org-7"}`, wantOrg: "org-7"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := isolateConfigDir(t)
			if tt.writeFile {
				if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(tt.config), 0o600); err != nil {
					t.Fatalf("write config: %v", err)
				}
			}

			var seen string
			client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				seen = r.Header.Get("X-Alethia-Org")
				json.NewEncoder(w).Encode(map[string]any{"runners": []any{}})
			}))

			if _, err := client.GetRunners(); err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if seen != tt.wantOrg {
				t.Errorf("expected X-Alethia-Org %q, got %q", tt.wantOrg, seen)
			}
		})
	}
}
