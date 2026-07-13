// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

type Client struct {
	baseURL    string
	authToken  string
	httpClient *http.Client
}

func NewClient(authToken string) *Client {
	// env > persisted config > hosted default (https://alethialabs.io), so the
	// hosted CLI needs no setup and self-host/dev override it once.
	webOrigin, _ := types.ResolveWebOrigin()
	return &Client{
		baseURL:    fmt.Sprintf("%s/api", webOrigin),
		authToken:  authToken,
		httpClient: &http.Client{},
	}
}

// --- Types ---

type Repository struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	FullName      string `json:"full_name"`
	URL           string `json:"url"`
	Private       bool   `json:"private"`
	DefaultBranch string `json:"default_branch"`
	Provider      string `json:"provider"`
}

type ConfigurationExport struct {
	Content  string `json:"content"`
	Filename string `json:"filename"`
	Format   string `json:"format"`
}

// ProvisionJob mirrors the `jobs` wire contract (see
// apps/console/lib/validations/cli-contract.ts → jobWire). Every column the
// backend returns has a field here; the list endpoint additionally populates
// ProjectName/RunnerName. Nullable columns arrive as JSON null, which Go decodes to
// the zero value, so scalar nullables stay as plain strings.
type ProvisionJob struct {
	ID                string                  `json:"id"`
	UserID            string                  `json:"user_id"`
	OrgID             string                  `json:"org_id"`
	JobType           string                  `json:"job_type"`
	ProjectID         string                  `json:"project_id"`
	CloudIdentityID   string                  `json:"cloud_identity_id"`
	RunnerID          string                  `json:"runner_id"`
	AssignedRunnerID  string                  `json:"assigned_runner_id"`
	PlanJobID         string                  `json:"plan_job_id"`
	ConfigurationHash string                  `json:"configuration_hash"`
	Status            string                  `json:"status"`
	Priority          int                     `json:"priority"`
	Provider          string                  `json:"provider"`
	ErrorMessage      *string                 `json:"error_message"`
	ExecutionMetadata *map[string]interface{} `json:"execution_metadata"`
	ConfigSnapshot    map[string]interface{}  `json:"config_snapshot"`
	ClaimedAt         *time.Time              `json:"claimed_at"`
	StartedAt         *time.Time              `json:"started_at"`
	CompletedAt       *time.Time              `json:"completed_at"`
	CreatedAt         time.Time               `json:"created_at"`
	UpdatedAt         time.Time               `json:"updated_at"`
	// List-only display fields (GET /api/jobs); absent on the single-job GET.
	ProjectName string `json:"project_name,omitempty"`
	RunnerName  string `json:"runner_name,omitempty"`
}

type JobsPage struct {
	Jobs   []ProvisionJob `json:"jobs"`
	Total  int            `json:"total"`
	Limit  int            `json:"limit"`
	Offset int            `json:"offset"`
}

type JobLog struct {
	ID         int       `json:"id"`
	JobID      string    `json:"job_id"`
	LogChunk   string    `json:"log_chunk"`
	StreamType string    `json:"stream_type"`
	CreatedAt  time.Time `json:"created_at"`
}

type Runner struct {
	ID                 string    `json:"id"`
	Name               string    `json:"name"`
	Operator           string    `json:"operator"`            // "managed" | "self"
	Provisioning       string    `json:"provisioning"`        // "deployed" | "registered" | "" (managed)
	SupportedProviders []string  `json:"supported_providers"` // null/empty = any cloud
	Status             string    `json:"status"`
	LastHeartbeat      string    `json:"last_heartbeat"`
	Version            string    `json:"version"`
	IsDefault          bool      `json:"is_default"`
	CreatedAt          time.Time `json:"created_at"`
}

type ClusterSummary struct {
	ID                   string   `json:"id"`
	ClusterName          string   `json:"cluster_name"`
	ClusterVersion       string   `json:"cluster_version"`
	InstanceTypes        []string `json:"instance_types"`
	NodeMinSize          int      `json:"node_min_size"`
	NodeMaxSize          int      `json:"node_max_size"`
	NodeDesiredSize      int      `json:"node_desired_size"`
	Status               string   `json:"status"`
	StatusMessage        string   `json:"status_message"`
	ArgocdURL            string   `json:"argocd_url"`
	EstimatedMonthlyCost *float64 `json:"estimated_monthly_cost"`
	CreatedAt            string   `json:"created_at"`
	UpdatedAt            string   `json:"updated_at"`
	ProjectName          string   `json:"project_name"`
	Environment          string   `json:"environment"`
	Region               string   `json:"region"`
}

type CloudIdentity struct {
	ID        string `json:"id"`
	Provider  string `json:"provider"`
	Label     string `json:"label"`
	CreatedAt string `json:"created_at"`
}

type DeployRunnerResponse struct {
	Runner struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"runner"`
	Job struct {
		ID        string `json:"id"`
		Status    string `json:"status"`
		CreatedAt string `json:"created_at"`
	} `json:"job"`
}

type QueueJobParams struct {
	JobType          string
	ConfigurationID  string
	CloudIdentityID  string
	AssignedRunnerID string
	PlanJobID        string
	ConfigSnapshot   map[string]interface{}
}

// --- Helpers ---

// setAuthHeaders applies the bearer token and, when an active organization is
// selected in the CLI config, the X-Alethia-Org header. Routing every request
// through this keeps org context (the tenancy boundary) uniform across the API.
func (c *Client) setAuthHeaders(req *http.Request) {
	req.Header.Set("Authorization", "Bearer "+c.authToken)
	if org := types.LoadCliConfig().ActiveOrgID; org != "" {
		req.Header.Set("X-Alethia-Org", org)
	}
}

func (c *Client) getProviderToken() string {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	credsPath := filepath.Join(configDir, "alethia", "credentials.json")
	file, err := os.ReadFile(credsPath)
	if err != nil {
		return ""
	}
	var creds types.ExchangeResponse
	if err := json.Unmarshal(file, &creds); err != nil {
		return ""
	}
	return creds.ProviderToken
}

func (c *Client) doGet(endpoint string, result interface{}) error {
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	c.setAuthHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return fmt.Errorf("request failed: status code %d", resp.StatusCode)
		}
		return fmt.Errorf("%s", errorResp.Error)
	}

	return json.NewDecoder(resp.Body).Decode(result)
}

func (c *Client) doPost(endpoint string, payload interface{}, result interface{}) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal request body: %w", err)
	}

	req, err := http.NewRequest("POST", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	c.setAuthHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return fmt.Errorf("request failed: status code %d", resp.StatusCode)
		}
		return fmt.Errorf("%s", errorResp.Error)
	}

	if result != nil {
		return json.NewDecoder(resp.Body).Decode(result)
	}
	return nil
}

func (c *Client) doPut(endpoint string, payload interface{}, result interface{}) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal request body: %w", err)
	}

	req, err := http.NewRequest("PUT", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	c.setAuthHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return fmt.Errorf("request failed: status code %d", resp.StatusCode)
		}
		return fmt.Errorf("%s", errorResp.Error)
	}

	if result != nil {
		return json.NewDecoder(resp.Body).Decode(result)
	}
	return nil
}

func (c *Client) doDelete(endpoint string) error {
	req, err := http.NewRequest("DELETE", endpoint, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	c.setAuthHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return fmt.Errorf("request failed: status code %d", resp.StatusCode)
		}
		return fmt.Errorf("%s", errorResp.Error)
	}
	return nil
}

// --- Repositories ---

func (c *Client) GetRepositories(provider string) ([]Repository, error) {
	endpoint := fmt.Sprintf("%s/cli/repositories/%s", c.baseURL, provider)

	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	c.setAuthHeaders(req)
	if providerToken := c.getProviderToken(); providerToken != "" {
		req.Header.Set("X-Provider-Token", providerToken)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errorResp struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&errorResp); err != nil {
			return nil, fmt.Errorf("failed to get repositories: status code %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("failed to get repositories: %s", errorResp.Error)
	}

	var successResp struct {
		Repositories []Repository `json:"repositories"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&successResp); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return successResp.Repositories, nil
}

// --- Configurations (Projects) ---

func (c *Client) GetConfigurations() ([]types.ConfigurationSummary, error) {
	endpoint := fmt.Sprintf("%s/cli/configurations", c.baseURL)
	var successResp struct {
		Configurations []types.ConfigurationSummary `json:"configurations"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to get configurations: %w", err)
	}
	return successResp.Configurations, nil
}

func (c *Client) GetConfiguration(projectName string) (*types.Configuration, error) {
	var successResp struct {
		Configuration *types.Configuration `json:"configuration"`
	}
	endpoint := fmt.Sprintf("%s/cli/configurations/by-project-name/%s", c.baseURL, projectName)
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to get configuration: %w", err)
	}
	return successResp.Configuration, nil
}

func (c *Client) ExportConfiguration(projectName, format string) (*ConfigurationExport, error) {
	if format == "" {
		format = "legacy-yaml"
	}
	endpoint := fmt.Sprintf(
		"%s/cli/configurations/by-project-name/%s/export?format=%s",
		c.baseURL, url.PathEscape(projectName), url.QueryEscape(format),
	)
	var export ConfigurationExport
	if err := c.doGet(endpoint, &export); err != nil {
		return nil, fmt.Errorf("failed to export configuration: %w", err)
	}
	return &export, nil
}

// --- Jobs ---

func (c *Client) QueueJobWithParams(params QueueJobParams) (*ProvisionJob, error) {
	endpoint := fmt.Sprintf("%s/jobs", c.baseURL)
	payload := map[string]interface{}{
		"job_type": params.JobType,
	}
	if params.ConfigurationID != "" {
		payload["configuration_id"] = params.ConfigurationID
	}
	if params.CloudIdentityID != "" {
		payload["cloud_identity_id"] = params.CloudIdentityID
	}
	if params.AssignedRunnerID != "" {
		payload["assigned_runner_id"] = params.AssignedRunnerID
	}
	if params.PlanJobID != "" {
		payload["plan_job_id"] = params.PlanJobID
	}
	if params.ConfigSnapshot != nil {
		payload["config_snapshot"] = params.ConfigSnapshot
	}

	var successResp struct {
		Job *ProvisionJob `json:"job"`
	}
	if err := c.doPost(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to queue job: %w", err)
	}
	return successResp.Job, nil
}

func (c *Client) GetJobs(status string, limit, offset int) (*JobsPage, error) {
	endpoint := fmt.Sprintf("%s/jobs", c.baseURL)
	params := url.Values{}
	if status != "" {
		params.Set("status", status)
	}
	if limit > 0 {
		params.Set("limit", fmt.Sprintf("%d", limit))
	}
	if offset > 0 {
		params.Set("offset", fmt.Sprintf("%d", offset))
	}
	if len(params) > 0 {
		endpoint = fmt.Sprintf("%s?%s", endpoint, params.Encode())
	}

	var page JobsPage
	if err := c.doGet(endpoint, &page); err != nil {
		return nil, fmt.Errorf("failed to get jobs: %w", err)
	}
	return &page, nil
}

func (c *Client) GetJob(jobID string) (*ProvisionJob, error) {
	endpoint := fmt.Sprintf("%s/cli/jobs/%s", c.baseURL, jobID)
	var job ProvisionJob
	if err := c.doGet(endpoint, &job); err != nil {
		return nil, fmt.Errorf("failed to get job: %w", err)
	}
	return &job, nil
}

func (c *Client) GetJobLogs(jobID string, afterID int) ([]JobLog, error) {
	endpoint := fmt.Sprintf("%s/cli/jobs/%s/logs", c.baseURL, jobID)
	if afterID > 0 {
		endpoint = fmt.Sprintf("%s?after=%d", endpoint, afterID)
	}

	var successResp struct {
		Logs []JobLog `json:"logs"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to get job logs: %w", err)
	}
	return successResp.Logs, nil
}

func (c *Client) CancelJob(jobID string) error {
	endpoint := fmt.Sprintf("%s/cli/jobs/%s/cancel", c.baseURL, jobID)
	return c.doPost(endpoint, nil, nil)
}

// --- Runners ---

func (c *Client) GetRunners() ([]Runner, error) {
	endpoint := fmt.Sprintf("%s/cli/runners", c.baseURL)
	var successResp struct {
		Runners []Runner `json:"runners"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to get runners: %w", err)
	}
	return successResp.Runners, nil
}

func (c *Client) RemoveRunner(runnerID string) error {
	endpoint := fmt.Sprintf("%s/cli/runners/%s", c.baseURL, runnerID)
	if err := c.doDelete(endpoint); err != nil {
		return fmt.Errorf("failed to remove runner: %w", err)
	}
	return nil
}

func (c *Client) DeployRunner(name, cloudIdentityID, region, assignedRunnerID string) (*DeployRunnerResponse, error) {
	endpoint := fmt.Sprintf("%s/cli/runners/deploy", c.baseURL)
	payload := map[string]string{
		"name":              name,
		"cloud_identity_id": cloudIdentityID,
		"region":            region,
	}
	if assignedRunnerID != "" {
		payload["assigned_runner_id"] = assignedRunnerID
	}

	var resp DeployRunnerResponse
	if err := c.doPost(endpoint, payload, &resp); err != nil {
		return nil, fmt.Errorf("failed to deploy runner: %w", err)
	}
	return &resp, nil
}

// --- Clusters (Project Clusters) ---

func (c *Client) GetClusters() ([]ClusterSummary, error) {
	endpoint := fmt.Sprintf("%s/cli/clusters", c.baseURL)
	var successResp struct {
		Clusters []ClusterSummary `json:"clusters"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to get clusters: %w", err)
	}
	return successResp.Clusters, nil
}

// --- Legacy (used by core/utils) ---

type LogEntry struct {
	Message string `json:"message"`
	Level   string `json:"level"`
	Step    string `json:"step,omitempty"`
}

func (c *Client) SendLog(deploymentID string, log LogEntry) error {
	endpoint := fmt.Sprintf("%s/deployments/%s/logs", c.baseURL, deploymentID)
	return c.doPost(endpoint, log, nil)
}

type BootstrapJob struct {
	ID           string    `json:"id"`
	Status       string    `json:"status"`
	ErrorMessage *string   `json:"error_message,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
}

func (c *Client) CreateBootstrapJob() (*BootstrapJob, error) {
	endpoint := fmt.Sprintf("%s/cli/bootstrap-jobs", c.baseURL)
	payload := map[string]string{}
	var successResp struct {
		Job *BootstrapJob `json:"job"`
	}
	if err := c.doPost(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to create bootstrap job: %w", err)
	}
	return successResp.Job, nil
}

func (c *Client) UpdateBootstrapJobStatus(jobID, status, errorMessage string) error {
	endpoint := fmt.Sprintf("%s/cli/bootstrap-jobs/%s", c.baseURL, jobID)
	payload := map[string]string{"status": status}
	if errorMessage != "" {
		payload["error_message"] = errorMessage
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequest("PUT", endpoint, bytes.NewBuffer(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	c.setAuthHeaders(req)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("failed to update bootstrap job: status %d", resp.StatusCode)
	}
	return nil
}

type ClusterRegistrationResponse struct {
	ClusterID  string `json:"cluster_id"`
	AgentToken string `json:"agent_token"`
}

func (c *Client) RegisterCluster(name, vpcID, vpcCidr, region string) (*ClusterRegistrationResponse, error) {
	endpoint := fmt.Sprintf("%s/cli/clusters", c.baseURL)
	payload := map[string]string{
		"name": name, "vpc_id": vpcID, "vpc_cidr": vpcCidr,
		"region": region,
	}
	var resp ClusterRegistrationResponse
	if err := c.doPost(endpoint, payload, &resp); err != nil {
		return nil, fmt.Errorf("failed to register cluster: %w", err)
	}
	return &resp, nil
}

func (c *Client) UnregisterCluster(id, name string) error {
	endpoint := fmt.Sprintf("%s/cli/clusters", c.baseURL)
	req, err := http.NewRequest("DELETE", endpoint, nil)
	if err != nil {
		return err
	}
	q := req.URL.Query()
	if id != "" {
		q.Add("id", id)
	}
	if name != "" {
		q.Add("name", name)
	}
	req.URL.RawQuery = q.Encode()
	c.setAuthHeaders(req)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("failed to unregister cluster: status %d", resp.StatusCode)
	}
	return nil
}

func (c *Client) SendBootstrapLog(jobID string, logChunk string, streamType string) error {
	endpoint := fmt.Sprintf("%s/cli/bootstrap-jobs/%s/logs", c.baseURL, jobID)
	payload := map[string]string{
		"log_chunk":   logChunk,
		"stream_type": streamType,
	}
	return c.doPost(endpoint, payload, nil)
}

// --- Cloud Identities ---

func (c *Client) GetCloudIdentities() ([]CloudIdentity, error) {
	endpoint := fmt.Sprintf("%s/cli/cloud-identities", c.baseURL)
	var successResp struct {
		CloudIdentities []CloudIdentity `json:"cloud_identities"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to get cloud identities: %w", err)
	}
	return successResp.CloudIdentities, nil
}

// --- Cloud Provider Connections ---

type InitIdentityResponse struct {
	IdentityID string `json:"identity_id"`
	ExternalID string `json:"external_id"`
}

// ConnectIdentityResponse is the SYNCHRONOUS result of submitting credentials — the
// server runs the health probe inline and returns the verdict directly (there is no
// CONNECTION_TEST job anymore). Mirrors connectIdentityWire in cli-contract.ts.
type ConnectIdentityResponse struct {
	IdentityID         string   `json:"identity_id"`
	Verified           bool     `json:"verified"`
	Status             string   `json:"status"` // connected | degraded | disconnected
	Error              string   `json:"error"`
	MissingPermissions []string `json:"missing_permissions"`
}

type ProviderStatus struct {
	Connected  bool   `json:"connected"`
	IdentityID string `json:"identityId"`
	// AWS
	AccountID  string `json:"accountId"`
	RoleArn    string `json:"roleArn"`
	ExternalID string `json:"externalId"`
	// GCP
	ProjectID           string `json:"projectId"`
	ServiceAccountEmail string `json:"serviceAccountEmail"`
	// Azure
	TenantID       string `json:"tenantId"`
	ClientID       string `json:"clientId"`
	SubscriptionID string `json:"subscriptionId"`
}

// InitProviderIdentity gets or creates the pending identity for a provider.
// For AWS, the response includes the external_id to embed in the trust policy.
func (c *Client) InitProviderIdentity(provider string) (*InitIdentityResponse, error) {
	endpoint := fmt.Sprintf("%s/cli/providers/%s/init", c.baseURL, provider)
	var resp InitIdentityResponse
	if err := c.doPost(endpoint, map[string]interface{}{}, &resp); err != nil {
		return nil, fmt.Errorf("failed to initialize %s connection: %w", provider, err)
	}
	return &resp, nil
}

// ConnectProviderIdentity submits the captured credentials; the server verifies the
// identity INLINE (a synchronous health probe) and returns the verdict directly — no
// job to poll. The credentials map shape is provider-specific:
//   - aws:   {"role_arn": "..."}
//   - gcp:   {"wif_config": {...}}
//   - azure: {"tenant_id": "...", "client_id": "...", "subscription_id": "..."}
func (c *Client) ConnectProviderIdentity(provider, identityID string, credentials map[string]interface{}) (*ConnectIdentityResponse, error) {
	endpoint := fmt.Sprintf("%s/cli/providers/%s/connect", c.baseURL, provider)
	payload := map[string]interface{}{
		"identity_id": identityID,
		"credentials": credentials,
	}
	var resp ConnectIdentityResponse
	if err := c.doPost(endpoint, payload, &resp); err != nil {
		return nil, fmt.Errorf("failed to submit %s credentials: %w", provider, err)
	}
	return &resp, nil
}

// DisconnectProviderIdentity resets a provider identity to its pending state.
func (c *Client) DisconnectProviderIdentity(provider, identityID string) error {
	endpoint := fmt.Sprintf("%s/cli/providers/%s/disconnect", c.baseURL, provider)
	payload := map[string]interface{}{"identity_id": identityID}
	if err := c.doPost(endpoint, payload, nil); err != nil {
		return fmt.Errorf("failed to disconnect %s: %w", provider, err)
	}
	return nil
}

// GetProviderStatus returns the verified connection status for a provider.
func (c *Client) GetProviderStatus(provider string) (*ProviderStatus, error) {
	endpoint := fmt.Sprintf("%s/cli/providers/%s/status", c.baseURL, provider)
	var resp ProviderStatus
	if err := c.doGet(endpoint, &resp); err != nil {
		return nil, fmt.Errorf("failed to get %s status: %w", provider, err)
	}
	return &resp, nil
}

// --- Identity & Organizations ---
//
// These mirror the wire contract in apps/console/lib/validations/cli-contract.ts
// (whoamiWire, orgWire, memberWire, teamWire). The active org is selected with
// `alethia org switch`, persisted in the CLI config, and sent as X-Alethia-Org.

// OrgSummary is an organization the caller belongs to, with the caller's role and
// the org's billing plan. `IsActive` marks the org the CLI is currently scoped to.
type OrgSummary struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Slug     string `json:"slug"`
	Role     string `json:"role"`
	Plan     string `json:"plan"`
	IsActive bool   `json:"is_active"`
}

// WhoAmI is the resolved CLI identity: the authenticated user, the active org
// context, and the org's default runner (if any).
type WhoAmI struct {
	User struct {
		ID    string `json:"id"`
		Email string `json:"email"`
		Name  string `json:"name"`
	} `json:"user"`
	ActiveOrg     *OrgSummary `json:"active_org"`
	DefaultRunner *struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"default_runner"`
}

// Member is a member of an organization.
type Member struct {
	ID     string `json:"id"`
	UserID string `json:"user_id"`
	Email  string `json:"email"`
	Name   string `json:"name"`
	Role   string `json:"role"`
	Status string `json:"status"`
}

// Invitation is a pending invitation created by InviteMember.
type Invitation struct {
	ID     string `json:"id"`
	Email  string `json:"email"`
	Role   string `json:"role"`
	Status string `json:"status"`
}

// Team is an organization team.
type Team struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	MemberCount int    `json:"member_count"`
}

// Whoami resolves the authenticated user and active org context.
func (c *Client) Whoami() (*WhoAmI, error) {
	endpoint := fmt.Sprintf("%s/cli/whoami", c.baseURL)
	var resp WhoAmI
	if err := c.doGet(endpoint, &resp); err != nil {
		return nil, fmt.Errorf("failed to resolve identity: %w", err)
	}
	return &resp, nil
}

// ListOrgs returns the organizations the caller belongs to.
func (c *Client) ListOrgs() ([]OrgSummary, error) {
	endpoint := fmt.Sprintf("%s/cli/orgs", c.baseURL)
	var successResp struct {
		Orgs []OrgSummary `json:"orgs"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to list organizations: %w", err)
	}
	return successResp.Orgs, nil
}

// ListMembers returns the members of an organization.
func (c *Client) ListMembers(orgID string) ([]Member, error) {
	endpoint := fmt.Sprintf("%s/cli/orgs/%s/members", c.baseURL, url.PathEscape(orgID))
	var successResp struct {
		Members []Member `json:"members"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to list members: %w", err)
	}
	return successResp.Members, nil
}

// InviteMember invites an email to the organization with the given role.
func (c *Client) InviteMember(orgID, email, role string) (*Invitation, error) {
	endpoint := fmt.Sprintf("%s/cli/orgs/%s/members", c.baseURL, url.PathEscape(orgID))
	payload := map[string]string{"email": email, "role": role}
	var successResp struct {
		Invitation *Invitation `json:"invitation"`
	}
	if err := c.doPost(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to invite member: %w", err)
	}
	return successResp.Invitation, nil
}

// RemoveMember removes a member from the organization.
func (c *Client) RemoveMember(orgID, memberID string) error {
	endpoint := fmt.Sprintf("%s/cli/orgs/%s/members/%s", c.baseURL, url.PathEscape(orgID), url.PathEscape(memberID))
	if err := c.doDelete(endpoint); err != nil {
		return fmt.Errorf("failed to remove member: %w", err)
	}
	return nil
}

// ListTeams returns the teams of an organization.
func (c *Client) ListTeams(orgID string) ([]Team, error) {
	endpoint := fmt.Sprintf("%s/cli/orgs/%s/teams", c.baseURL, url.PathEscape(orgID))
	var successResp struct {
		Teams []Team `json:"teams"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to list teams: %w", err)
	}
	return successResp.Teams, nil
}

// CreateTeam creates a team in the organization.
func (c *Client) CreateTeam(orgID, name string) (*Team, error) {
	endpoint := fmt.Sprintf("%s/cli/orgs/%s/teams", c.baseURL, url.PathEscape(orgID))
	payload := map[string]string{"name": name}
	var successResp struct {
		Team *Team `json:"team"`
	}
	if err := c.doPost(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to create team: %w", err)
	}
	return successResp.Team, nil
}

// DeleteTeam deletes a team from the organization.
func (c *Client) DeleteTeam(orgID, teamID string) error {
	endpoint := fmt.Sprintf("%s/cli/orgs/%s/teams/%s", c.baseURL, url.PathEscape(orgID), url.PathEscape(teamID))
	if err := c.doDelete(endpoint); err != nil {
		return fmt.Errorf("failed to delete team: %w", err)
	}
	return nil
}

// --- Notifications: Channels, Alert rules, Activity ---
//
// These mirror the wire contract in apps/console/lib/validations/cli-contract.ts
// (channelWire, alertRuleWire, activityWire). Channel secrets (webhook/Slack URLs,
// PagerDuty routing keys) are AES-encrypted server-side and never returned — only
// HasSecret / Recipients surface. All are scoped to the active org.

// Channel is a notification delivery destination (webhook, email, Slack, …). The
// encrypted secret envelope is never on the wire; HasSecret reports its presence.
type Channel struct {
	ID             string   `json:"id"`
	Type           string   `json:"type"`
	Name           string   `json:"name"`
	Enabled        bool     `json:"enabled"`
	IsVerified     bool     `json:"is_verified"`
	Recipients     []string `json:"recipients"`
	HasSecret      bool     `json:"has_secret"`
	LastVerifiedAt string   `json:"last_verified_at"`
	CreatedAt      string   `json:"created_at"`
}

// AlertRule binds a set of event-key patterns to notification channels.
type AlertRule struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Description     string   `json:"description"`
	EventPatterns   []string `json:"event_patterns"`
	Severity        string   `json:"severity"`
	ThrottleSeconds int      `json:"throttle_seconds"`
	Enabled         bool     `json:"enabled"`
	ChannelIDs      []string `json:"channel_ids"`
	CreatedAt       string   `json:"created_at"`
}

// ActivityEntry is one row of the PDP-written delivery/activity log.
type ActivityEntry struct {
	ID           string `json:"id"`
	ActorID      string `json:"actor_id"`
	ActorName    string `json:"actor_name"`
	ActorEmail   string `json:"actor_email"`
	Action       string `json:"action"`
	ResourceType string `json:"resource_type"`
	ResourceID   string `json:"resource_id"`
	Decision     bool   `json:"decision"`
	Reason       string `json:"reason"`
	Ts           string `json:"ts"`
}

// ListChannels returns the active org's notification channels.
func (c *Client) ListChannels() ([]Channel, error) {
	endpoint := fmt.Sprintf("%s/cli/channels", c.baseURL)
	var successResp struct {
		Channels []Channel `json:"channels"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to list channels: %w", err)
	}
	return successResp.Channels, nil
}

// CreateChannel creates a notification channel. `config` carries the email
// recipients and/or the transport destination (url / signing_secret / routing_key).
func (c *Client) CreateChannel(name, channelType string, config map[string]interface{}) (*Channel, error) {
	endpoint := fmt.Sprintf("%s/cli/channels", c.baseURL)
	payload := map[string]interface{}{"name": name, "type": channelType, "config": config}
	var successResp struct {
		Channel *Channel `json:"channel"`
	}
	if err := c.doPost(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to create channel: %w", err)
	}
	return successResp.Channel, nil
}

// DeleteChannel deletes a notification channel.
func (c *Client) DeleteChannel(channelID string) error {
	endpoint := fmt.Sprintf("%s/cli/channels/%s", c.baseURL, url.PathEscape(channelID))
	if err := c.doDelete(endpoint); err != nil {
		return fmt.Errorf("failed to delete channel: %w", err)
	}
	return nil
}

// VerifyChannel sends a synthetic test event through the channel and returns the
// (now verified) channel.
func (c *Client) VerifyChannel(channelID string) (*Channel, error) {
	endpoint := fmt.Sprintf("%s/cli/channels/%s/verify", c.baseURL, url.PathEscape(channelID))
	var successResp struct {
		Channel *Channel `json:"channel"`
	}
	if err := c.doPost(endpoint, map[string]interface{}{}, &successResp); err != nil {
		return nil, fmt.Errorf("failed to verify channel: %w", err)
	}
	return successResp.Channel, nil
}

// ListAlertRules returns the active org's alert rules with their bound channel ids.
func (c *Client) ListAlertRules() ([]AlertRule, error) {
	endpoint := fmt.Sprintf("%s/cli/alerts", c.baseURL)
	var successResp struct {
		AlertRules []AlertRule `json:"alert_rules"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to list alert rules: %w", err)
	}
	return successResp.AlertRules, nil
}

// CreateAlertRule creates an alert rule binding event patterns to channels.
func (c *Client) CreateAlertRule(name string, eventPatterns, channelIDs []string, severity string) (*AlertRule, error) {
	endpoint := fmt.Sprintf("%s/cli/alerts", c.baseURL)
	payload := map[string]interface{}{
		"name":           name,
		"event_patterns": eventPatterns,
		"channel_ids":    channelIDs,
		"severity":       severity,
	}
	var successResp struct {
		AlertRule *AlertRule `json:"alert_rule"`
	}
	if err := c.doPost(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to create alert rule: %w", err)
	}
	return successResp.AlertRule, nil
}

// DeleteAlertRule deletes an alert rule.
func (c *Client) DeleteAlertRule(ruleID string) error {
	endpoint := fmt.Sprintf("%s/cli/alerts/%s", c.baseURL, url.PathEscape(ruleID))
	if err := c.doDelete(endpoint); err != nil {
		return fmt.Errorf("failed to delete alert rule: %w", err)
	}
	return nil
}

// ListActivity returns the active org's delivery/activity log, newest first.
// A limit <= 0 lets the server apply its default page size.
func (c *Client) ListActivity(limit int) ([]ActivityEntry, error) {
	endpoint := fmt.Sprintf("%s/cli/activity", c.baseURL)
	if limit > 0 {
		endpoint = fmt.Sprintf("%s?limit=%d", endpoint, limit)
	}
	var successResp struct {
		Activity []ActivityEntry `json:"activity"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to list activity: %w", err)
	}
	return successResp.Activity, nil
}

// --- RBAC: Roles, Grants, SSO ---
//
// These mirror the wire contract in apps/console/lib/validations/cli-contract.ts
// (roleWire, grantWire, ssoProviderWire). Roles are the four built-in templates plus
// the org's custom roles; grants bind a principal (user/team) to a role OR a single
// permission at a resource scope, allow or deny; SSO providers are read-only (registered
// via Better Auth's sso plugin). All are scoped to the active org and PDP-gated.

// Role is a permission bundle: a built-in template (IsBuiltin) or a custom org role.
// PermissionKeys are its `resource:action` keys (every key for the owner template).
type Role struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	IsBuiltin      bool     `json:"is_builtin"`
	PermissionKeys []string `json:"permission_keys"`
}

// Grant binds a principal to a role XOR a single permission at a resource scope, as an
// allow or explicit deny. Role is the bound role's name (empty for a permission grant);
// PermissionKey is the bound permission (empty for a role grant); ResourceID empty =
// org-wide.
type Grant struct {
	ID            string `json:"id"`
	PrincipalType string `json:"principal_type"`
	PrincipalID   string `json:"principal_id"`
	Effect        string `json:"effect"`
	Role          string `json:"role"`
	PermissionKey string `json:"permission_key"`
	ResourceType  string `json:"resource_type"`
	ResourceID    string `json:"resource_id"`
}

// SsoProvider is a configured SSO identity provider (read-only). Secrets/config JSON
// are never on the wire; Enabled reports whether its domain is verified.
type SsoProvider struct {
	ID           string `json:"id"`
	ProviderType string `json:"provider_type"`
	Domain       string `json:"domain"`
	Issuer       string `json:"issuer"`
	Enabled      bool   `json:"enabled"`
}

// AddGrantParams is the payload for AddGrant. Provide exactly one of RoleID or
// PermissionKey; leave ResourceID empty for an org-wide grant.
type AddGrantParams struct {
	PrincipalType string
	PrincipalID   string
	Effect        string
	RoleID        string
	PermissionKey string
	ResourceType  string
	ResourceID    string
}

// ListRoles returns the active org's roles: the built-in templates plus custom roles.
func (c *Client) ListRoles() ([]Role, error) {
	endpoint := fmt.Sprintf("%s/cli/roles", c.baseURL)
	var successResp struct {
		Roles []Role `json:"roles"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to list roles: %w", err)
	}
	return successResp.Roles, nil
}

// CreateRole creates a custom role with the given permission keys.
func (c *Client) CreateRole(name string, permissionKeys []string) (*Role, error) {
	endpoint := fmt.Sprintf("%s/cli/roles", c.baseURL)
	if permissionKeys == nil {
		permissionKeys = []string{}
	}
	payload := map[string]interface{}{"name": name, "permission_keys": permissionKeys}
	var successResp struct {
		Role *Role `json:"role"`
	}
	if err := c.doPost(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to create role: %w", err)
	}
	return successResp.Role, nil
}

// DeleteRole deletes a custom role.
func (c *Client) DeleteRole(roleID string) error {
	endpoint := fmt.Sprintf("%s/cli/roles/%s", c.baseURL, url.PathEscape(roleID))
	if err := c.doDelete(endpoint); err != nil {
		return fmt.Errorf("failed to delete role: %w", err)
	}
	return nil
}

// ClassificationValue is one allowed value on a dimension.
type ClassificationValue struct {
	ID    string `json:"id"`
	Value string `json:"value"`
	Label string `json:"label"`
}

// ClassificationDimension is a classification axis with its values and resource-kind scope.
type ClassificationDimension struct {
	ID          string                `json:"id"`
	Key         string                `json:"key"`
	Label       string                `json:"label"`
	Description string                `json:"description"`
	Multi       bool                  `json:"multi"`
	AppliesTo   []string              `json:"applies_to"`
	Values      []ClassificationValue `json:"values"`
}

// ClassificationAssignment is a value assigned to a resource.
type ClassificationAssignment struct {
	DimensionKey   string `json:"dimension_key"`
	DimensionLabel string `json:"dimension_label"`
	Value          string `json:"value"`
	ValueLabel     string `json:"value_label"`
}

// ListClassificationDimensions returns the org's classification taxonomy.
func (c *Client) ListClassificationDimensions() ([]ClassificationDimension, error) {
	endpoint := fmt.Sprintf("%s/cli/classification/dimensions", c.baseURL)
	var resp struct {
		Dimensions []ClassificationDimension `json:"dimensions"`
	}
	if err := c.doGet(endpoint, &resp); err != nil {
		return nil, fmt.Errorf("failed to list classification dimensions: %w", err)
	}
	return resp.Dimensions, nil
}

// GetResourceClassifications returns the values assigned to a resource.
func (c *Client) GetResourceClassifications(kind, id string) ([]ClassificationAssignment, error) {
	endpoint := fmt.Sprintf("%s/cli/classification/assignments?kind=%s&id=%s",
		c.baseURL, url.QueryEscape(kind), url.QueryEscape(id))
	var resp struct {
		Assignments []ClassificationAssignment `json:"assignments"`
	}
	if err := c.doGet(endpoint, &resp); err != nil {
		return nil, fmt.Errorf("failed to get classifications: %w", err)
	}
	return resp.Assignments, nil
}

// AssignClassification pins a value (by dimension key + value slug) to a resource and returns
// the resource's updated assignments.
func (c *Client) AssignClassification(kind, id, dimensionKey, valueSlug string) ([]ClassificationAssignment, error) {
	endpoint := fmt.Sprintf("%s/cli/classification/assignments", c.baseURL)
	payload := map[string]interface{}{
		"kind":          kind,
		"id":            id,
		"dimension_key": dimensionKey,
		"value_slug":    valueSlug,
	}
	var resp struct {
		Assignments []ClassificationAssignment `json:"assignments"`
	}
	if err := c.doPost(endpoint, payload, &resp); err != nil {
		return nil, fmt.Errorf("failed to assign classification: %w", err)
	}
	return resp.Assignments, nil
}

// UnassignClassification clears a value (by slug) from a resource.
func (c *Client) UnassignClassification(kind, id, valueSlug string) error {
	endpoint := fmt.Sprintf("%s/cli/classification/assignments?kind=%s&id=%s&value_slug=%s",
		c.baseURL, url.QueryEscape(kind), url.QueryEscape(id), url.QueryEscape(valueSlug))
	if err := c.doDelete(endpoint); err != nil {
		return fmt.Errorf("failed to unassign classification: %w", err)
	}
	return nil
}

// ListGrants returns the active org's access grants.
func (c *Client) ListGrants() ([]Grant, error) {
	endpoint := fmt.Sprintf("%s/cli/grants", c.baseURL)
	var successResp struct {
		Grants []Grant `json:"grants"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to list grants: %w", err)
	}
	return successResp.Grants, nil
}

// AddGrant assigns an access grant. Empty optional fields are omitted from the payload
// so the server applies its defaults (effect=allow, resource_type=org).
func (c *Client) AddGrant(params AddGrantParams) (*Grant, error) {
	endpoint := fmt.Sprintf("%s/cli/grants", c.baseURL)
	payload := map[string]interface{}{
		"principal_type": params.PrincipalType,
		"principal_id":   params.PrincipalID,
	}
	if params.Effect != "" {
		payload["effect"] = params.Effect
	}
	if params.RoleID != "" {
		payload["role_id"] = params.RoleID
	}
	if params.PermissionKey != "" {
		payload["permission_key"] = params.PermissionKey
	}
	if params.ResourceType != "" {
		payload["resource_type"] = params.ResourceType
	}
	if params.ResourceID != "" {
		payload["resource_id"] = params.ResourceID
	}
	var successResp struct {
		Grant *Grant `json:"grant"`
	}
	if err := c.doPost(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to add grant: %w", err)
	}
	return successResp.Grant, nil
}

// RemoveGrant revokes an access grant.
func (c *Client) RemoveGrant(grantID string) error {
	endpoint := fmt.Sprintf("%s/cli/grants/%s", c.baseURL, url.PathEscape(grantID))
	if err := c.doDelete(endpoint); err != nil {
		return fmt.Errorf("failed to remove grant: %w", err)
	}
	return nil
}

// ListSsoProviders returns the active org's configured SSO identity providers.
func (c *Client) ListSsoProviders() ([]SsoProvider, error) {
	endpoint := fmt.Sprintf("%s/cli/sso", c.baseURL)
	var successResp struct {
		SsoProviders []SsoProvider `json:"sso_providers"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to list SSO providers: %w", err)
	}
	return successResp.SsoProviders, nil
}

// GetSsoProvider returns a single SSO identity provider by id.
func (c *Client) GetSsoProvider(id string) (*SsoProvider, error) {
	endpoint := fmt.Sprintf("%s/cli/sso/%s", c.baseURL, url.PathEscape(id))
	var successResp struct {
		SsoProvider *SsoProvider `json:"sso_provider"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to get SSO provider: %w", err)
	}
	return successResp.SsoProvider, nil
}

// --- Billing, Usage & Managed fleet ---
//
// These mirror the wire contract in apps/console/lib/validations/cli-contract.ts
// (billingWire, usageWire, fleetPoolWire). Billing + usage are read-only org-scoped
// roll-ups (no Stripe customer ids / amounts on the wire). Fleet pools are GLOBAL
// platform-operator config (no org_id): readable by owner/admin/viewer and editable by
// owner/admin (the `fleet` PDP resource), and only on self-managed deployments — hosted
// tenants get an empty list and an edit is refused.

// Billing is the active org's billing state. Seats is nil on flat tiers / no subscription;
// the timestamp fields are empty strings when absent.
type Billing struct {
	Plan                 string `json:"plan"`
	Status               string `json:"status"`
	Seats                *int   `json:"seats"`
	StripeSubscriptionID string `json:"stripe_subscription_id"`
	TrialEndsAt          string `json:"trial_ends_at"`
	CurrentPeriodEnd     string `json:"current_period_end"`
}

// Usage is the active org's current usage counters.
type Usage struct {
	SeatsUsed        int `json:"seats_used"`
	SeatsCap         int `json:"seats_cap"`
	RunnerMinutes    int `json:"runner_minutes"`
	Projects         int `json:"projects"`
	AICreditsUsed    int `json:"ai_credits_used"`
	AICreditsGranted int `json:"ai_credits_granted"`
}

// FleetPool is one managed warm pool (one per provider). Channel/Version are empty when
// unset (a pinned version and a release channel are mutually exclusive).
type FleetPool struct {
	Provider       string   `json:"provider"`
	WarmMin        int      `json:"warm_min"`
	Max            int      `json:"max"`
	SlotsPerRunner int      `json:"slots_per_runner"`
	Locations      []string `json:"locations"`
	Surge          int      `json:"surge"`
	Buffer         int      `json:"buffer"`
	Channel        string   `json:"channel"`
	Version        string   `json:"version"`
	Enabled        bool     `json:"enabled"`
}

// FleetPoolUpdate is the payload for SetFleetPool. Only set fields are sent (the rest keep
// their stored value); Enabled is a pointer so "leave unchanged" is distinct from "disable".
type FleetPoolUpdate struct {
	WarmMin        *int
	Max            *int
	SlotsPerRunner *int
	Enabled        *bool
	Channel        *string
	Version        *string
}

// GetBilling returns the active org's billing state.
func (c *Client) GetBilling() (*Billing, error) {
	endpoint := fmt.Sprintf("%s/cli/billing", c.baseURL)
	var successResp struct {
		Billing *Billing `json:"billing"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to get billing: %w", err)
	}
	return successResp.Billing, nil
}

// GetUsage returns the active org's current usage counters.
func (c *Client) GetUsage() (*Usage, error) {
	endpoint := fmt.Sprintf("%s/cli/usage", c.baseURL)
	var successResp struct {
		Usage *Usage `json:"usage"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to get usage: %w", err)
	}
	return successResp.Usage, nil
}

// ListFleetPools returns the managed fleet's warm pools (empty on hosted deployments).
func (c *Client) ListFleetPools() ([]FleetPool, error) {
	endpoint := fmt.Sprintf("%s/cli/fleet", c.baseURL)
	var successResp struct {
		Pools []FleetPool `json:"pools"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to list fleet pools: %w", err)
	}
	return successResp.Pools, nil
}

// SetFleetPool updates the warm pool for a provider. Only the non-nil fields of the update
// are sent, so unspecified config keeps its stored value.
func (c *Client) SetFleetPool(provider string, update FleetPoolUpdate) (*FleetPool, error) {
	endpoint := fmt.Sprintf("%s/cli/fleet/%s", c.baseURL, url.PathEscape(provider))
	payload := map[string]interface{}{}
	if update.WarmMin != nil {
		payload["warm_min"] = *update.WarmMin
	}
	if update.Max != nil {
		payload["max"] = *update.Max
	}
	if update.SlotsPerRunner != nil {
		payload["slots_per_runner"] = *update.SlotsPerRunner
	}
	if update.Enabled != nil {
		payload["enabled"] = *update.Enabled
	}
	if update.Channel != nil {
		payload["channel"] = *update.Channel
	}
	if update.Version != nil {
		payload["version"] = *update.Version
	}
	var successResp struct {
		Pool *FleetPool `json:"pool"`
	}
	if err := c.doPut(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to update fleet pool: %w", err)
	}
	return successResp.Pool, nil
}

// --- Project authoring: projects, environments, components ---
//
// These mirror the wire contract in apps/console/lib/validations/cli-contract.ts
// (projectWire, environmentWire, componentWire). They ADD write (authoring) verbs on
// top of the read-only configurations endpoints: create a project, manage its
// environments, and CRUD its component resources. The project is addressed by id OR
// name; everything is scoped to the active org and PDP-gated. Components share ONE
// struct across all kinds — the kind-specific fields live in the open Config map.

// Project is a project as returned by project authoring (create). CloudIdentityID is nil
// when the project has no cloud account linked; EstimatedMonthlyCost is nil until costed.
type Project struct {
	ID                   string    `json:"id"`
	ProjectName          string    `json:"project_name"`
	Slug                 string    `json:"slug"`
	Region               string    `json:"region"`
	IacVersion           string    `json:"iac_version"`
	CloudIdentityID      *string   `json:"cloud_identity_id"`
	CloudProvider        string    `json:"cloud_provider"`
	EnvironmentStage     string    `json:"environment_stage"`
	Status               string    `json:"status"`
	EstimatedMonthlyCost *float64  `json:"estimated_monthly_cost"`
	CreatedAt            time.Time `json:"created_at"`
	UpdatedAt            time.Time `json:"updated_at"`
}

// Environment is one of a project's deployment targets. Region is nil when it inherits
// the project's region; IsDefault marks the project's anchor environment.
type Environment struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Stage     string  `json:"stage"`
	Status    string  `json:"status"`
	IsDefault bool    `json:"is_default"`
	Region    *string `json:"region"`
}

// Component is one project component, uniform across every kind. Config holds the
// kind-specific columns (shapes vary by kind), so a single struct decodes them all.
// CloudIdentityID is nil when the component inherits the project's primary identity.
type Component struct {
	ID              string                 `json:"id"`
	Kind            string                 `json:"kind"`
	Name            string                 `json:"name"`
	Status          string                 `json:"status"`
	CloudIdentityID *string                `json:"cloud_identity_id"`
	Config          map[string]interface{} `json:"config"`
}

// CreateProjectParams is the payload for CreateProject. CloudIdentityID/Stage are
// optional (the server defaults the stage to "development" and leaves the project
// unlinked when no identity is given).
type CreateProjectParams struct {
	ProjectName     string
	Region          string
	CloudIdentityID string
	Stage           string
	IacVersion      string
}

// CreateProject creates a new project and returns it.
func (c *Client) CreateProject(params CreateProjectParams) (*Project, error) {
	endpoint := fmt.Sprintf("%s/cli/projects", c.baseURL)
	payload := map[string]interface{}{
		"project_name": params.ProjectName,
		"region":       params.Region,
	}
	if params.CloudIdentityID != "" {
		payload["cloud_identity_id"] = params.CloudIdentityID
	}
	if params.Stage != "" {
		payload["stage"] = params.Stage
	}
	if params.IacVersion != "" {
		payload["iac_version"] = params.IacVersion
	}
	var successResp struct {
		Project *Project `json:"project"`
	}
	if err := c.doPost(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to create project: %w", err)
	}
	return successResp.Project, nil
}

// ListEnvironments returns a project's environments (default first).
func (c *Client) ListEnvironments(project string) ([]Environment, error) {
	endpoint := fmt.Sprintf("%s/cli/projects/%s/environments", c.baseURL, url.PathEscape(project))
	var successResp struct {
		Environments []Environment `json:"environments"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to list environments: %w", err)
	}
	return successResp.Environments, nil
}

// AddEnvironment adds an environment to a project. An empty region inherits the project's.
func (c *Client) AddEnvironment(project, name, stage, region string) (*Environment, error) {
	endpoint := fmt.Sprintf("%s/cli/projects/%s/environments", c.baseURL, url.PathEscape(project))
	payload := map[string]interface{}{"name": name}
	if stage != "" {
		payload["stage"] = stage
	}
	if region != "" {
		payload["region"] = region
	}
	var successResp struct {
		Environment *Environment `json:"environment"`
	}
	if err := c.doPost(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to add environment: %w", err)
	}
	return successResp.Environment, nil
}

// ListComponents returns a project's components. An empty kind/env lists all of them;
// otherwise the listing is filtered server-side.
func (c *Client) ListComponents(project, kind, env string) ([]Component, error) {
	endpoint := fmt.Sprintf("%s/cli/projects/%s/components", c.baseURL, url.PathEscape(project))
	params := url.Values{}
	if kind != "" {
		params.Set("kind", kind)
	}
	if env != "" {
		params.Set("env", env)
	}
	if len(params) > 0 {
		endpoint = fmt.Sprintf("%s?%s", endpoint, params.Encode())
	}
	var successResp struct {
		Components []Component `json:"components"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to list components: %w", err)
	}
	return successResp.Components, nil
}

// AddComponent creates a component of `kind` on a project. `name` is ignored for singleton
// kinds; `fields` are validated server-side against the kind's drizzle-zod insert schema.
func (c *Client) AddComponent(project, kind, name string, fields map[string]interface{}) (*Component, error) {
	endpoint := fmt.Sprintf("%s/cli/projects/%s/components/%s", c.baseURL, url.PathEscape(project), url.PathEscape(kind))
	if fields == nil {
		fields = map[string]interface{}{}
	}
	payload := map[string]interface{}{"fields": fields}
	if name != "" {
		payload["name"] = name
	}
	var successResp struct {
		Component *Component `json:"component"`
	}
	if err := c.doPost(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to add component: %w", err)
	}
	return successResp.Component, nil
}

// RemoveComponent deletes a component of `kind` from a project. `name` is ignored for
// singleton kinds (which have at most one row per project).
func (c *Client) RemoveComponent(project, kind, name string) error {
	endpoint := fmt.Sprintf("%s/cli/projects/%s/components/%s", c.baseURL, url.PathEscape(project), url.PathEscape(kind))
	if name != "" {
		endpoint = fmt.Sprintf("%s/%s", endpoint, url.PathEscape(name))
	}
	if err := c.doDelete(endpoint); err != nil {
		return fmt.Errorf("failed to remove component: %w", err)
	}
	return nil
}

// --- Break-glass (privileged incident recovery) ---
//
// These hit the audited /api/breakglass/* endpoints behind the ALETHIA_BREAKGLASS_ENABLED +
// BREAKGLASS_OPERATORS gate, using the SAME bearer token as the rest of the CLI. The endpoints are
// cross-tenant and RLS-bypassing, so they do NOT go through the /api/cli namespace — the operator
// allowlist (not org membership) is the wall.

// BreakglassActionInput is the small, explicit per-action input the backend records + validates.
type BreakglassActionInput struct {
	ExpectedFrom   []string `json:"expectedFrom,omitempty"`
	To             string   `json:"to,omitempty"`
	StateKey       string   `json:"stateKey,omitempty"`
	FleetReason    string   `json:"fleetReason,omitempty"`
	ProjectID      string   `json:"projectId,omitempty"`
	EnvironmentID  string   `json:"environmentId,omitempty"`
	SurgeryNote    string   `json:"surgeryNote,omitempty"`
	SuppressEmails *bool    `json:"suppressEmails,omitempty"`
}

// BreakglassSession is a newly-opened time-boxed operator session.
type BreakglassSession struct {
	SessionID string `json:"sessionId"`
	ExpiresAt string `json:"expiresAt"`
	Operator  string `json:"operator"`
}

// BreakglassApproval is a minted two-person approval token.
type BreakglassApproval struct {
	ApprovalID string `json:"approvalId"`
	Action     string `json:"action"`
	ResourceID string `json:"resourceId"`
	ExpiresAt  string `json:"expiresAt"`
	Approver   string `json:"approver"`
	Note       string `json:"note"`
}

// BreakglassResult is the outcome of an executed break-glass action.
type BreakglassResult struct {
	OK     bool            `json:"ok"`
	Detail string          `json:"detail"`
	Data   json.RawMessage `json:"data"`
}

// BreakglassExecuteParams is the body for POST /api/breakglass/execute.
type BreakglassExecuteParams struct {
	SessionID  string                 `json:"sessionId"`
	Action     string                 `json:"action"`
	ResourceID string                 `json:"resourceId,omitempty"`
	Confirm    string                 `json:"confirm,omitempty"`
	Reason     string                 `json:"reason"`
	ApprovalID string                 `json:"approvalId,omitempty"`
	Input      *BreakglassActionInput `json:"input,omitempty"`
}

// OpenBreakglassSession opens a time-boxed break-glass session.
func (c *Client) OpenBreakglassSession(reason string) (*BreakglassSession, error) {
	endpoint := fmt.Sprintf("%s/breakglass/session", c.baseURL)
	var out BreakglassSession
	if err := c.doPost(endpoint, map[string]string{"reason": reason}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// MintBreakglassApproval mints a two-person approval token (called by the SECOND operator).
func (c *Client) MintBreakglassApproval(action, resourceID, reason string, input *BreakglassActionInput) (*BreakglassApproval, error) {
	endpoint := fmt.Sprintf("%s/breakglass/approval", c.baseURL)
	payload := map[string]interface{}{"action": action, "resourceId": resourceID, "reason": reason}
	if input != nil {
		payload["input"] = input
	}
	var out BreakglassApproval
	if err := c.doPost(endpoint, payload, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ExecuteBreakglass runs one audited break-glass action.
func (c *Client) ExecuteBreakglass(params BreakglassExecuteParams) (*BreakglassResult, error) {
	endpoint := fmt.Sprintf("%s/breakglass/execute", c.baseURL)
	var out BreakglassResult
	if err := c.doPost(endpoint, params, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
