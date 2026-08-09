// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package aws

import (
	"testing"

	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

// TestSubnetInfos_NilFieldsDoNotPanic is #2036's repro, kept.
//
// Every field on an EC2 API type is a pointer, and AWS omits what it has nothing to say about.
// MapPublicIpOnLaunch was nil-guarded while SubnetId/CidrBlock/AvailabilityZone/VpcId were
// dereferenced raw — so one nil field panicked the runner instead of degrading one row.
func TestSubnetInfos_NilFieldsDoNotPanic(t *testing.T) {
	id := "subnet-1"
	got := subnetInfos([]ec2types.Subnet{
		{},              // everything nil — the panic
		{SubnetId: &id}, // one populated field, the rest nil
	})

	if len(got) != 2 {
		t.Fatalf("got %d subnets, want 2 — a nil field must degrade the row, not drop it", len(got))
	}
	if got[0] != (SubnetInfo{}) {
		t.Errorf("an all-nil subnet should read as zero values, got %+v", got[0])
	}
	if got[1].ID != id {
		t.Errorf("populated field lost: got %q, want %q", got[1].ID, id)
	}
	if got[1].CIDR != "" || got[1].AvailabilityZone != "" || got[1].VpcID != "" {
		t.Errorf("nil siblings should read empty, got %+v", got[1])
	}
}

// TestVPCInfos_NilFieldsDoNotPanic covers the sibling, which carried MORE unguarded derefs than the
// reported one: a tag's Key and Value are pointers too, so a single nil-keyed tag panicked the loop
// before any VPC was returned.
func TestVPCInfos_NilFieldsDoNotPanic(t *testing.T) {
	vpcID := "vpc-1"
	nameKey, nameVal := "Name", "prod"
	got := vpcInfos([]ec2types.Vpc{
		{}, // everything nil
		{
			VpcId: &vpcID,
			Tags: []ec2types.Tag{
				{},                               // nil Key AND nil Value — the panic
				{Key: &nameKey, Value: &nameVal}, // the tag we actually want, AFTER it
			},
		},
	})

	if len(got) != 2 {
		t.Fatalf("got %d VPCs, want 2", len(got))
	}
	if got[0] != (VPCInfo{}) {
		t.Errorf("an all-nil VPC should read as zero values, got %+v", got[0])
	}
	// The ordering is the point: a nil-keyed tag must be skipped, not stop the scan.
	if got[1].Name != "prod" {
		t.Errorf("Name tag = %q, want %q — a nil-keyed tag earlier in the list must not stop the scan", got[1].Name, "prod")
	}
	if got[1].ID != vpcID {
		t.Errorf("VpcId lost: got %q, want %q", got[1].ID, vpcID)
	}
}

// TestRegionNames_NilFieldsDoNotPanic covers the third instance of the same shape, one function up
// from the reported one. Fixed in the same pass because it is the identical deref.
func TestRegionNames_NilFieldsDoNotPanic(t *testing.T) {
	name := "eu-central-1"
	got := regionNames([]ec2types.Region{{}, {RegionName: &name}})

	if len(got) != 2 {
		t.Fatalf("got %d regions, want 2", len(got))
	}
	if got[0] != "" {
		t.Errorf("a nil RegionName should read empty, got %q", got[0])
	}
	if got[1] != name {
		t.Errorf("populated RegionName lost: got %q, want %q", got[1], name)
	}
}

// TestMappersOnEmptyInput: no rows in, nil slice out — the shape the callers already return on an
// empty response, so this stays byte-compatible with what they did before.
func TestMappersOnEmptyInput(t *testing.T) {
	if got := subnetInfos(nil); got != nil {
		t.Errorf("subnetInfos(nil) = %v, want nil", got)
	}
	if got := vpcInfos(nil); got != nil {
		t.Errorf("vpcInfos(nil) = %v, want nil", got)
	}
	if got := regionNames(nil); got != nil {
		t.Errorf("regionNames(nil) = %v, want nil", got)
	}
}
