// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

func sampleDims() []api.ClassificationDimension {
	return []api.ClassificationDimension{
		{
			ID: "d1", Key: "environment", Label: "Environment", Multi: false,
			AppliesTo: []string{"project_environment"},
			Values:    []api.ClassificationValue{{ID: "v1", Value: "prod", Label: "Production"}},
		},
		{
			ID: "d2", Key: "team", Label: "Team", Multi: true, AppliesTo: nil,
			Values: []api.ClassificationValue{{ID: "v2", Value: "platform", Label: "Platform"}},
		},
	}
}

func sampleAssigns() []api.ClassificationAssignment {
	return []api.ClassificationAssignment{
		{DimensionKey: "environment", DimensionLabel: "Environment", Value: "prod", ValueLabel: "Production"},
	}
}

func TestRunClassificationDimensions(t *testing.T) {
	var buf bytes.Buffer
	if err := runClassificationDimensions(&fakeClient{classDims: sampleDims()}, &buf, "table"); err != nil {
		t.Fatalf("runClassificationDimensions: %v", err)
	}
	for _, want := range []string{"environment", "Team", "multi", "single", "all resources", "project_environment"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("dimensions missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRunClassificationDimensionsEmpty(t *testing.T) {
	var buf bytes.Buffer
	if err := runClassificationDimensions(&fakeClient{}, &buf, "table"); err != nil {
		t.Fatalf("empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No classification dimensions") {
		t.Errorf("expected empty message, got: %s", buf.String())
	}
}

func TestRunClassificationDimensionsError(t *testing.T) {
	var buf bytes.Buffer
	if err := runClassificationDimensions(&fakeClient{err: errBoom}, &buf, "table"); err == nil {
		t.Fatal("expected error")
	}
}

func TestRunClassificationShow(t *testing.T) {
	var buf bytes.Buffer
	if err := runClassificationShow(&fakeClient{classAssigns: sampleAssigns()}, &buf, "table", "project_environment", "env1"); err != nil {
		t.Fatalf("show: %v", err)
	}
	if !strings.Contains(buf.String(), "Production") {
		t.Errorf("show missing value:\n%s", buf.String())
	}
}

func TestRunClassificationShowEmpty(t *testing.T) {
	var buf bytes.Buffer
	if err := runClassificationShow(&fakeClient{}, &buf, "table", "member", "m1"); err != nil {
		t.Fatalf("show empty: %v", err)
	}
	if !strings.Contains(buf.String(), "Not classified") {
		t.Errorf("expected not-classified message:\n%s", buf.String())
	}
}

func TestRunClassificationShowError(t *testing.T) {
	var buf bytes.Buffer
	if err := runClassificationShow(&fakeClient{err: errBoom}, &buf, "table", "k", "i"); err == nil {
		t.Fatal("expected error")
	}
}

func TestRunClassificationAssign(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{classAssigns: sampleAssigns()}
	if err := runClassificationAssign(f, &buf, "project_environment", "env1", "environment", "prod"); err != nil {
		t.Fatalf("assign: %v", err)
	}
	if f.assignedKind != "project_environment" || f.assignedID != "env1" ||
		f.assignedDim != "environment" || f.assignedValue != "prod" {
		t.Errorf("assign not recorded: %+v", f)
	}
	if !strings.Contains(buf.String(), "Assigned") {
		t.Errorf("assign missing confirmation:\n%s", buf.String())
	}
}

func TestRunClassificationAssignError(t *testing.T) {
	var buf bytes.Buffer
	if err := runClassificationAssign(&fakeClient{err: errBoom}, &buf, "k", "i", "d", "v"); err == nil {
		t.Fatal("expected error")
	}
}

func TestRunClassificationUnassign(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{}
	if err := runClassificationUnassign(f, &buf, "project_environment", "env1", "prod"); err != nil {
		t.Fatalf("unassign: %v", err)
	}
	if f.unassignedKind != "project_environment" || f.unassignedID != "env1" || f.unassignedValue != "prod" {
		t.Errorf("unassign not recorded: %+v", f)
	}
	if !strings.Contains(buf.String(), "Cleared") {
		t.Errorf("unassign missing confirmation:\n%s", buf.String())
	}
}

func TestRunClassificationUnassignError(t *testing.T) {
	var buf bytes.Buffer
	if err := runClassificationUnassign(&fakeClient{err: errBoom}, &buf, "k", "i", "v"); err == nil {
		t.Fatal("expected error")
	}
}
