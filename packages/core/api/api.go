// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
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
	webOrigin := os.Getenv("ALETHIA_WEB_ORIGIN")
	if webOrigin == "" {
		fmt.Fprintln(os.Stderr, "Error: ALETHIA_WEB_ORIGIN is required (set it to your Alethia control-plane URL).")
		os.Exit(1)
	}
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
// SpecName/RunnerName. Nullable columns arrive as JSON null, which Go decodes to
// the zero value, so scalar nullables stay as plain strings.
type ProvisionJob struct {
	ID                string                  `json:"id"`
	UserID            string                  `json:"user_id"`
	OrgID             string                  `json:"org_id"`
	JobType           string                  `json:"job_type"`
	ZoneID            string                  `json:"zone_id"`
	SpecID            string                  `json:"spec_id"`
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
	SpecName   string `json:"spec_name,omitempty"`
	RunnerName string `json:"runner_name,omitempty"`
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

type SpecCluster struct {
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
	SpecProjectName      string   `json:"spec_project_name"`
	SpecEnvironment      string   `json:"spec_environment"`
	SpecRegion           string   `json:"spec_region"`
}

type CloudIdentity struct {
	ID        string `json:"id"`
	Provider  string `json:"provider"`
	Label     string `json:"label"`
	CreatedAt string `json:"created_at"`
}

// ZoneSpec is a spec as nested under a zone (GET /api/cli/zones).
type ZoneSpec struct {
	ID               string `json:"id"`
	ProjectName      string `json:"project_name"`
	EnvironmentStage string `json:"environment_stage"`
	Status           string `json:"status"`
	Region           string `json:"region"`
}

// ZoneWithSpecs mirrors the zoneWire contract — a zone plus its nested specs.
type ZoneWithSpecs struct {
	ID          string     `json:"id"`
	UserID      string     `json:"user_id"`
	Name        string     `json:"name"`
	Description *string    `json:"description"`
	CreatedAt   string     `json:"created_at"`
	UpdatedAt   string     `json:"updated_at"`
	Specs       []ZoneSpec `json:"specs"`
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
	ZoneID           string
	ConfigurationID  string
	CloudIdentityID  string
	AssignedRunnerID string
	PlanJobID        string
	ConfigSnapshot   map[string]interface{}
}

// --- Helpers ---

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
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

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
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

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
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))

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
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))
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

// --- Configurations (Specs) ---

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
		"zone_id":  params.ZoneID,
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

func (c *Client) GetJobs(status, zoneID string, limit, offset int) (*JobsPage, error) {
	endpoint := fmt.Sprintf("%s/jobs", c.baseURL)
	params := url.Values{}
	if status != "" {
		params.Set("status", status)
	}
	if zoneID != "" {
		params.Set("zone_id", zoneID)
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

// --- Clusters (Spec Clusters) ---

func (c *Client) GetSpecClusters() ([]SpecCluster, error) {
	endpoint := fmt.Sprintf("%s/cli/clusters", c.baseURL)
	var successResp struct {
		Clusters []SpecCluster `json:"clusters"`
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
	ZoneID       string    `json:"zone_id"`
	Status       string    `json:"status"`
	ErrorMessage *string   `json:"error_message,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
}

func (c *Client) CreateBootstrapJob(zoneID string) (*BootstrapJob, error) {
	endpoint := fmt.Sprintf("%s/cli/bootstrap-jobs", c.baseURL)
	payload := map[string]string{"zone_id": zoneID}
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
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))
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

func (c *Client) RegisterCluster(name, vpcID, vpcCidr, region, zoneID string) (*ClusterRegistrationResponse, error) {
	endpoint := fmt.Sprintf("%s/cli/clusters", c.baseURL)
	payload := map[string]string{
		"name": name, "vpc_id": vpcID, "vpc_cidr": vpcCidr,
		"region": region, "zone_id": zoneID,
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
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.authToken))
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

// --- Zones ---

func (c *Client) GetZones() ([]ZoneWithSpecs, error) {
	endpoint := fmt.Sprintf("%s/cli/zones", c.baseURL)
	var successResp struct {
		Zones []ZoneWithSpecs `json:"zones"`
	}
	if err := c.doGet(endpoint, &successResp); err != nil {
		return nil, fmt.Errorf("failed to get zones: %w", err)
	}
	return successResp.Zones, nil
}

func (c *Client) CreateZone(name, description string) (*types.Zone, error) {
	endpoint := fmt.Sprintf("%s/cli/zones", c.baseURL)
	payload := map[string]string{"name": name}
	if description != "" {
		payload["description"] = description
	}
	var successResp struct {
		Zone *types.Zone `json:"zone"`
	}
	if err := c.doPost(endpoint, payload, &successResp); err != nil {
		return nil, fmt.Errorf("failed to create zone: %w", err)
	}
	return successResp.Zone, nil
}

func (c *Client) DeleteZone(id string) error {
	endpoint := fmt.Sprintf("%s/cli/zones/%s", c.baseURL, id)
	if err := c.doDelete(endpoint); err != nil {
		return fmt.Errorf("failed to delete zone: %w", err)
	}
	return nil
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

type ConnectIdentityResponse struct {
	JobID      string `json:"job_id"`
	IdentityID string `json:"identity_id"`
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

// ConnectProviderIdentity submits the captured credentials and queues a
// CONNECTION_TEST job. The credentials map shape is provider-specific:
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

// VerifyProviderIdentity marks an identity verified after its connection test
// job has succeeded.
func (c *Client) VerifyProviderIdentity(provider, identityID, jobID string) error {
	endpoint := fmt.Sprintf("%s/cli/providers/%s/verify", c.baseURL, provider)
	payload := map[string]interface{}{
		"identity_id": identityID,
		"job_id":      jobID,
	}
	if err := c.doPost(endpoint, payload, nil); err != nil {
		return fmt.Errorf("failed to verify %s identity: %w", provider, err)
	}
	return nil
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
