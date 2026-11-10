// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The runner/console contract for a NEW snapshot key (#6445): the console serves `addons[].byo` only
// to a runner that advertises types.RunnerCapabilityAddonByoMarker, and strips it for any other. The
// two fixtures are the before/after of that strip; apps/console/tests/lib/runners/
// snapshot-capabilities.test.ts asserts the console's strip turns the first into the second.

// snapshotFixture reads one of the shared fixtures as the generic map a claim response decodes into.
func snapshotFixture(t *testing.T, name string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "core", "types", "testdata", "snapshot-capabilities", name))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// oldRunnerAddOn is types.AddOnInstall as a runner built before #6445 has it: every field but Byo.
// Built by reflection so it follows every other field of the real struct.
func oldRunnerAddOn(t *testing.T) reflect.Type {
	t.Helper()
	real := reflect.TypeOf(types.AddOnInstall{})
	var fields []reflect.StructField
	found := false
	for i := 0; i < real.NumField(); i++ {
		f := real.Field(i)
		if f.Name == "Byo" {
			found = true
			continue
		}
		fields = append(fields, f)
	}
	if !found {
		t.Fatal("types.AddOnInstall has no Byo field — this contract test no longer describes anything")
	}
	return reflect.StructOf(fields)
}

// decodeAsOldRunner strict-decodes snapshot's addons the way an old runner's
// assertNoUnknownSnapshotKeys does (DisallowUnknownFields, reaching addons[]).
func decodeAsOldRunner(t *testing.T, snapshot map[string]any) error {
	t.Helper()
	data, err := json.Marshal(map[string]any{"addons": snapshot["addons"]})
	if err != nil {
		t.Fatal(err)
	}
	top := reflect.StructOf([]reflect.StructField{{
		Name: "AddOns", Type: reflect.SliceOf(oldRunnerAddOn(t)), Tag: `json:"addons"`,
	}})
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	return dec.Decode(reflect.New(top).Interface())
}

// TestSnapshotContract_AnOldRunnerDecodesTheSnapshotServedToIt: the snapshot the console serves a
// runner WITHOUT the capability decodes under an old runner's strict decode; the one with the marker
// would not — which is exactly why it is gated.
func TestSnapshotContract_AnOldRunnerDecodesTheSnapshotServedToIt(t *testing.T) {
	if err := decodeAsOldRunner(t, snapshotFixture(t, "without-byo-marker.json")); err != nil {
		t.Fatalf("an old runner must decode the snapshot served to it: %v", err)
	}
	err := decodeAsOldRunner(t, snapshotFixture(t, "with-byo-marker.json"))
	if err == nil || !strings.Contains(err.Error(), `unknown field "byo"`) {
		t.Fatalf("an old runner must refuse the marker (the reason it is gated), got %v", err)
	}
}

// TestSnapshotContract_ThisRunnerDecodesBothShapes: this build reads the marker, and reads a snapshot
// without it (an old console, or a snapshot stored before the marker) as no BYO marker — a git source
// is still BYO, an OCI one is not.
func TestSnapshotContract_ThisRunnerDecodesBothShapes(t *testing.T) {
	with, err := snapshotToProjectConfig(snapshotFixture(t, "with-byo-marker.json"))
	if err != nil {
		t.Fatalf("with the marker: %v", err)
	}
	without, err := snapshotToProjectConfig(snapshotFixture(t, "without-byo-marker.json"))
	if err != nil {
		t.Fatalf("without the marker: %v", err)
	}
	byo := func(vc *types.ProjectConfig) []bool {
		out := make([]bool, len(vc.AddOns))
		for i, a := range vc.AddOns {
			out[i] = a.IsByo()
		}
		return out
	}
	if got := byo(with); !reflect.DeepEqual(got, []bool{true, true, false}) {
		t.Errorf("IsByo with the marker = %v, want [true true false]", got)
	}
	if got := byo(without); !reflect.DeepEqual(got, []bool{false, true, false}) {
		t.Errorf("IsByo without the marker = %v, want [false true false]", got)
	}
}

// TestRunnerHeaders_AdvertiseTheSnapshotCapabilities: every runner request — the claim included —
// names the capabilities, so the console's gate sees this build as one that reads the marker.
func TestRunnerHeaders_AdvertiseTheSnapshotCapabilities(t *testing.T) {
	var got string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get(types.RunnerCapabilitiesHeader)
		_, _ = w.Write([]byte(`{"job":null}`))
	}))
	defer server.Close()
	if _, err := NewRunnerAPIClient(server.URL, "r1", "tok").ClaimJob(); err != nil {
		t.Fatalf("ClaimJob: %v", err)
	}
	if want := "addon-byo-marker,preview-namespace-prefix,placement-host-namespaces"; got != want {
		t.Errorf("%s = %q, want %q (the console matches these exact names)", types.RunnerCapabilitiesHeader, got, want)
	}
}

// oldRunnerProjectConfig is types.ProjectConfig as a runner built before #6494 has it: every field but
// PreviewNamespacePrefix. Built by reflection so it follows every other field of the real struct.
func oldRunnerProjectConfig(t *testing.T) reflect.Type {
	t.Helper()
	real := reflect.TypeOf(types.ProjectConfig{})
	var fields []reflect.StructField
	found := false
	for i := 0; i < real.NumField(); i++ {
		f := real.Field(i)
		if f.Name == "PreviewNamespacePrefix" {
			found = true
			continue
		}
		fields = append(fields, f)
	}
	if !found {
		t.Fatal("types.ProjectConfig has no PreviewNamespacePrefix field — this contract test no longer describes anything")
	}
	return reflect.StructOf(fields)
}

// decodeTopLevelAsOldRunner strict-decodes snapshot's top level the way a runner built before #6494
// does (assertNoUnknownSnapshotKeys: DisallowUnknownFields into types.ProjectConfig).
func decodeTopLevelAsOldRunner(t *testing.T, snapshot map[string]any) error {
	t.Helper()
	data, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	return dec.Decode(reflect.New(oldRunnerProjectConfig(t)).Interface())
}

// TestSnapshotContract_AnOldRunnerDecodesTheSnapshotWithoutThePreviewPrefix (#6494): the snapshot the
// console serves a runner without types.RunnerCapabilityPreviewNamespacePrefix decodes under an old
// runner's strict decode; the one carrying the key would fail every job — which is why it is gated.
func TestSnapshotContract_AnOldRunnerDecodesTheSnapshotWithoutThePreviewPrefix(t *testing.T) {
	if err := decodeTopLevelAsOldRunner(t, snapshotFixture(t, "without-preview-namespace-prefix.json")); err != nil {
		t.Fatalf("an old runner must decode the snapshot served to it: %v", err)
	}
	err := decodeTopLevelAsOldRunner(t, snapshotFixture(t, "with-preview-namespace-prefix.json"))
	if err == nil || !strings.Contains(err.Error(), `unknown field "preview_namespace_prefix"`) {
		t.Fatalf("an old runner must refuse the key (the reason it is gated), got %v", err)
	}
}

// TestSnapshotContract_ThisRunnerReadsThePreviewPrefix: this build decodes both shapes, and reads the
// prefix when it is served.
func TestSnapshotContract_ThisRunnerReadsThePreviewPrefix(t *testing.T) {
	with, err := snapshotToProjectConfig(snapshotFixture(t, "with-preview-namespace-prefix.json"))
	if err != nil {
		t.Fatalf("with the prefix: %v", err)
	}
	without, err := snapshotToProjectConfig(snapshotFixture(t, "without-preview-namespace-prefix.json"))
	if err != nil {
		t.Fatalf("without the prefix: %v", err)
	}
	if with.PreviewNamespacePrefix != "pr" || without.PreviewNamespacePrefix != "" {
		t.Errorf("PreviewNamespacePrefix with=%q without=%q, want \"pr\" and \"\"", with.PreviewNamespacePrefix, without.PreviewNamespacePrefix)
	}
}

// projectConfigWithout is types.ProjectConfig as a runner built before the field named `field` was
// added: every other field of the real struct, built by reflection so it follows them.
func projectConfigWithout(t *testing.T, field string) reflect.Type {
	t.Helper()
	real := reflect.TypeOf(types.ProjectConfig{})
	var fields []reflect.StructField
	found := false
	for i := 0; i < real.NumField(); i++ {
		f := real.Field(i)
		if f.Name == field {
			found = true
			continue
		}
		fields = append(fields, f)
	}
	if !found {
		t.Fatalf("types.ProjectConfig has no %s field — this contract test no longer describes anything", field)
	}
	return reflect.StructOf(fields)
}

// TestSnapshotContract_AnOldRunnerDecodesTheSnapshotWithoutTheHostNamespaces (#6551): the snapshot the
// console serves a runner without types.RunnerCapabilityPlacementHostNamespaces decodes under that
// runner's strict decode; the one carrying the key would fail every job — which is why it is gated.
func TestSnapshotContract_AnOldRunnerDecodesTheSnapshotWithoutTheHostNamespaces(t *testing.T) {
	decode := func(name string) error {
		data, err := json.Marshal(snapshotFixture(t, name))
		if err != nil {
			t.Fatal(err)
		}
		dec := json.NewDecoder(bytes.NewReader(data))
		dec.DisallowUnknownFields()
		return dec.Decode(reflect.New(projectConfigWithout(t, "PlacementHostNamespaces")).Interface())
	}
	if err := decode("without-placement-host-namespaces.json"); err != nil {
		t.Fatalf("an old runner must decode the snapshot served to it: %v", err)
	}
	if err := decode("with-placement-host-namespaces.json"); err == nil || !strings.Contains(err.Error(), `unknown field "placement_host_namespaces"`) {
		t.Fatalf("an old runner must refuse the key (the reason it is gated), got %v", err)
	}
}

// TestSnapshotContract_ThisRunnerTellsAbsentHostNamespacesFromNone: this build decodes both shapes, and
// keeps "not sent" (nil — the provisioner refuses the deploy) apart from "sent" (a list, maybe empty).
func TestSnapshotContract_ThisRunnerTellsAbsentHostNamespacesFromNone(t *testing.T) {
	with, err := snapshotToProjectConfig(snapshotFixture(t, "with-placement-host-namespaces.json"))
	if err != nil {
		t.Fatalf("with the key: %v", err)
	}
	without, err := snapshotToProjectConfig(snapshotFixture(t, "without-placement-host-namespaces.json"))
	if err != nil {
		t.Fatalf("without the key: %v", err)
	}
	if with.PlacementHostNamespaces == nil || !reflect.DeepEqual(*with.PlacementHostNamespaces, []string{"payments"}) {
		t.Errorf("PlacementHostNamespaces with the key = %v, want [payments]", with.PlacementHostNamespaces)
	}
	if without.PlacementHostNamespaces != nil {
		t.Errorf("PlacementHostNamespaces without the key = %v, want nil (not sent is not the same as none)", *without.PlacementHostNamespaces)
	}
	empty := snapshotFixture(t, "without-placement-host-namespaces.json")
	empty["placement_host_namespaces"] = []any{}
	none, err := snapshotToProjectConfig(empty)
	if err != nil {
		t.Fatalf("with an empty list: %v", err)
	}
	if none.PlacementHostNamespaces == nil || len(*none.PlacementHostNamespaces) != 0 {
		t.Errorf("an empty list must decode as an empty, NON-nil list, got %v", none.PlacementHostNamespaces)
	}
}
