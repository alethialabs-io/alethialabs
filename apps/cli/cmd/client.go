// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// apiClient is the subset of *api.Client used by the command logic. Commands
// depend on this interface (not the concrete client) so their run* functions can
// be unit-tested against an in-memory fake without a live control plane.
type apiClient interface {
	Whoami() (*api.WhoAmI, error)
	ListOrgs() ([]api.OrgSummary, error)
	ListMembers(orgID string) ([]api.Member, error)
	InviteMember(orgID, email, role string) (*api.Invitation, error)
	RemoveMember(orgID, memberID string) error
	ListTeams(orgID string) ([]api.Team, error)
	CreateTeam(orgID, name string) (*api.Team, error)
	DeleteTeam(orgID, teamID string) error
	GetRunners() ([]api.Runner, error)
	GetClusters() ([]api.ClusterSummary, error)
	GetConfigurations() ([]types.ConfigurationSummary, error)
	ExportConfiguration(projectName, format string) (*api.ConfigurationExport, error)
	GetRepositories(provider string) ([]api.Repository, error)
	GetProviderStatus(provider string) (*api.ProviderStatus, error)
	VerifyProviderIdentity(provider, identityID string) (*api.ConnectIdentityResponse, error)
	GetJobs(status string, limit, offset int) (*api.JobsPage, error)
	GetJob(jobID string) (*api.ProvisionJob, error)
	ListChannels() ([]api.Channel, error)
	CreateChannel(name, channelType string, config map[string]interface{}) (*api.Channel, error)
	DeleteChannel(channelID string) error
	VerifyChannel(channelID string) (*api.Channel, error)
	ListAlertRules() ([]api.AlertRule, error)
	CreateAlertRule(name string, eventPatterns, channelIDs []string, severity string) (*api.AlertRule, error)
	DeleteAlertRule(ruleID string) error
	ListActivity(limit int) ([]api.ActivityEntry, error)
	ListRoles() ([]api.Role, error)
	CreateRole(name string, permissionKeys []string) (*api.Role, error)
	DeleteRole(roleID string) error
	ListClassificationDimensions() ([]api.ClassificationDimension, error)
	GetResourceClassifications(kind, id string) ([]api.ClassificationAssignment, error)
	AssignClassification(kind, id, dimensionKey, valueSlug string) ([]api.ClassificationAssignment, error)
	UnassignClassification(kind, id, valueSlug string) error
	ListGrants() ([]api.Grant, error)
	AddGrant(params api.AddGrantParams) (*api.Grant, error)
	RemoveGrant(grantID string) error
	ListSsoProviders() ([]api.SsoProvider, error)
	GetSsoProvider(id string) (*api.SsoProvider, error)
	GetBilling() (*api.Billing, error)
	GetUsage() (*api.Usage, error)
	ListFleetPools() ([]api.FleetPool, error)
	SetFleetPool(provider string, update api.FleetPoolUpdate) (*api.FleetPool, error)
	CreateProject(params api.CreateProjectParams) (*api.Project, error)
	ListEnvironments(project string) ([]api.Environment, error)
	AddEnvironment(project, name, stage, region string) (*api.Environment, error)
	ListComponents(project, kind, env string) ([]api.Component, error)
	AddComponent(project, kind, name string, fields map[string]interface{}) (*api.Component, error)
	RemoveComponent(project, kind, name string) error
	GetProjectDrift(project, env string) (*api.DriftPosture, error)
	GetEnvironmentCost(project, env string) (*api.EnvironmentCost, error)
	GetProjectProtection(project string) ([]api.ProtectionRule, error)
	GetProjectProbes(project string) ([]api.ProbeState, error)
	GetProjectAddons(project, env string) (*api.ProjectAddons, error)
	GetProjectByoCharts(project, env string) (*api.ProjectByoCharts, error)
	GetProjectIacSource(project, env string) (*api.IacSource, error)
}

// Ensure the concrete client satisfies the interface at compile time.
var _ apiClient = (*api.Client)(nil)
