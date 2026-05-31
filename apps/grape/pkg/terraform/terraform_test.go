package terraform

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/types"
)

func TestOverrideTfvarsWritesTypedJSONFromRawConfig(t *testing.T) {
	t.Parallel()

	rawConfig := `{"project_name":"demo","region":"eu-west-1","environment":"dev","aws_account_id":"123456789012","provision_vpc":true,"rds_scaling_config":{"min_capacity":0.5},"redis_allowed_cidr_blocks":["10.0.0.0/16"]}`
	config := &types.Configuration{
		ProjectName:      "demo",
		AwsRegion:        "eu-west-1",
		EnvironmentStage: "dev",
		AwsAccountID:     "123456789012",
		TerraformVersion: "1.11.4",
		FullConfig:       &rawConfig,
	}

	tfvarsPath, err := OverrideTfvars(t.TempDir(), config)
	if err != nil {
		t.Fatalf("OverrideTfvars returned error: %v", err)
	}
	if !strings.HasSuffix(tfvarsPath, "terraform.tfvars.json") {
		t.Fatalf("expected tfvars path to end with terraform.tfvars.json, got %q", tfvarsPath)
	}

	tfvarsData, err := os.ReadFile(tfvarsPath)
	if err != nil {
		t.Fatalf("failed to read tfvars file: %v", err)
	}
	var tfvars map[string]interface{}
	if err := json.Unmarshal(tfvarsData, &tfvars); err != nil {
		t.Fatalf("tfvars file is not valid JSON: %v", err)
	}
	if tfvars["provision_vpc"] != true {
		t.Fatalf("expected provision_vpc bool to be true, got %#v", tfvars["provision_vpc"])
	}
	if _, ok := tfvars["rds_scaling_config"].(map[string]interface{}); !ok {
		t.Fatalf("expected nested rds_scaling_config, got %#v", tfvars["rds_scaling_config"])
	}
}

func TestGenerateBackendConfig(t *testing.T) {
	t.Parallel()

	config := &types.Configuration{
		ProjectName:      "myproject",
		EnvironmentStage: "dev",
		AwsRegion:        "eu-west-1",
	}

	bc := GenerateBackendConfig(config)
	if bc["bucket"] != "myproject-dev-eu-west-1-idp-state" {
		t.Fatalf("unexpected bucket: %s", bc["bucket"])
	}
	if bc["key"] != "myproject-dev-eu-west-1-terraform.tfstate" {
		t.Fatalf("unexpected key: %s", bc["key"])
	}
	if bc["region"] != "eu-west-1" {
		t.Fatalf("unexpected region: %s", bc["region"])
	}
}
