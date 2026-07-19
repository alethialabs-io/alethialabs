// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

func TestRunCloudInventory(t *testing.T) {
	cidr := "10.0.0.0/16"
	subCidr := "10.0.1.0/24"
	name := "main"
	c := &fakeClient{cloudInv: &api.CloudInventory{
		Networks: []api.CloudNetwork{{NativeID: "vpc-1", Name: &name, Region: strptr("eu-west-1"), Provider: "aws", CidrBlock: &cidr, IsDefault: true}},
		Subnets:  []api.CloudSubnet{{NativeID: "subnet-1", Region: strptr("eu-west-1"), AvailabilityZone: strptr("eu-west-1a"), CidrBlock: &subCidr, IsPublic: true}},
		Regions:  []string{"eu-west-1", "us-east-1"},
	}}
	var buf bytes.Buffer
	if err := runCloudInventory(c, &buf, "table", "id-1"); err != nil {
		t.Fatalf("runCloudInventory: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"vpc-1", "10.0.0.0/16", "subnet-1", "eu-west-1a", "Regions:", "us-east-1"} {
		if !strings.Contains(out, want) {
			t.Errorf("table output missing %q:\n%s", want, out)
		}
	}
}

func TestRunCloudInventoryJSON(t *testing.T) {
	c := &fakeClient{cloudInv: &api.CloudInventory{Networks: []api.CloudNetwork{{NativeID: "vpc-1", Provider: "aws"}}, Regions: []string{}}}
	var buf bytes.Buffer
	if err := runCloudInventory(c, &buf, "json", "id-1"); err != nil {
		t.Fatalf("runCloudInventory json: %v", err)
	}
	if !strings.Contains(buf.String(), `"native_id": "vpc-1"`) {
		t.Errorf("json output unexpected:\n%s", buf.String())
	}
}

func TestRunCloudInventoryEmpty(t *testing.T) {
	c := &fakeClient{cloudInv: &api.CloudInventory{}}
	var buf bytes.Buffer
	if err := runCloudInventory(c, &buf, "table", "id-1"); err != nil {
		t.Fatalf("runCloudInventory empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No cloud inventory discovered") {
		t.Errorf("expected empty notice, got: %q", buf.String())
	}
}

func TestRunCloudInventoryError(t *testing.T) {
	c := &fakeClient{err: errors.New("boom")}
	if err := runCloudInventory(c, &bytes.Buffer{}, "table", "id-1"); err == nil {
		t.Error("expected error to propagate")
	}
}
