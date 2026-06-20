// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package types

import "time"

type ConfigurationSummary struct {
	ID                   string    `json:"id"`
	ProjectName          string    `json:"project_name"`
	ZoneID               *string   `json:"zone_id"`
	EnvironmentStage     string    `json:"environment_stage"`
	Status               string    `json:"status"`
	Region               string    `json:"region"`
	CloudProvider        string    `json:"cloud_provider"`
	EstimatedMonthlyCost *float64  `json:"estimated_monthly_cost"`
	CreatedAt            time.Time `json:"created_at"`
	UpdatedAt            time.Time `json:"updated_at"`
}

type Configuration struct {
	CloudAccountID          string    `json:"cloud_account_id"`
	Region                  string    `json:"region"`
	ContainerPlatform       string    `json:"container_platform"`
	ProvisionNetwork        *bool     `json:"provision_network"`
	CreatedAt               time.Time `json:"created_at"`
	DbMaxCapacity           *float64  `json:"db_max_capacity"`
	DbMinCapacity           *float64  `json:"db_min_capacity"`
	Description             *string   `json:"description"`
	DnsDomainName           *string   `json:"dns_domain_name"`
	DnsZoneID               *string   `json:"dns_zone_id"`
	DownloadCount           *int      `json:"download_count"`
	ClusterAdmins           *string   `json:"cluster_admins"`
	DnsEnabled              *bool     `json:"dns_enabled"`
	EnableGitopsDestination *bool     `json:"enable_gitops_destination"`
	HasCache                *bool     `json:"has_cache"`
	EnvironmentRepository   *string   `json:"environment_repository"`
	EnvironmentStage        string    `json:"environment_stage"`
	FullConfig              *string   `json:"full_config"`
	GitopsAppTemplate       *string   `json:"gitops_app_template"`
	GitopsAppToken          *string   `json:"gitops_app_token"`
	GitopsArgocdToken       *string   `json:"gitops_argocd_token"`
	GitopsDestinationsRepo  *string   `json:"gitops_destinations_repo"`
	GitopsRepository        *string   `json:"gitops_repository"`

	ID               string  `json:"id"`
	LastDownloadedAt *string `json:"last_downloaded_at"`
	// Name                    string    `json:"name"`
	ProjectName            string    `json:"project_name"`
	ZoneID                 *string   `json:"zone_id"`
	RedisAllowedCidrBlocks *string   `json:"redis_allowed_cidr_blocks"`
	SesQueuesTopics        *string   `json:"ses_queues_topics"`
	Status                 *string   `json:"status"`
	IacVersion             string    `json:"iac_version"`
	UiPositionX            *float64  `json:"ui_position_x"`
	UiPositionY            *float64  `json:"ui_position_y"`
	UpdatedAt              time.Time `json:"updated_at"`
	UserID                 string    `json:"user_id"`
	CIDRBlock              *string   `json:"cidr_block"`
}

type DeployJob struct {
	ID              string     `json:"id"`
	ClusterID       string     `json:"cluster_id"`
	ConfigurationID string     `json:"configuration_id"`
	Status          string     `json:"status"`
	CreatedAt       time.Time  `json:"created_at"`
	StartedAt       *time.Time `json:"started_at,omitempty"`
	CompletedAt     *time.Time `json:"completed_at,omitempty"`
	ErrorMessage    *string    `json:"error_message,omitempty"`
}
