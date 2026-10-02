// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/manifest"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestParseNodeSize pins `--node-size`'s grammar and bounds (#5266): the bounds are the server's,
// so what the terminal accepts is exactly what POST /api/cli/projects and the canvas accept.
func TestParseNodeSize(t *testing.T) {
	ok := map[string]types.NodeSize{
		"4x16":    {VCPU: 4, MemoryGB: 16},
		"2X7.5":   {VCPU: 2, MemoryGB: 7.5},
		" 1x1 ":   {VCPU: 1, MemoryGB: 1},
		"96x768":  {VCPU: 96, MemoryGB: 768},
		"8 x 32 ": {VCPU: 8, MemoryGB: 32},
	}
	for in, want := range ok {
		got, err := parseNodeSize(in)
		if err != nil || got == nil || *got != want {
			t.Errorf("parseNodeSize(%q) = %+v, %v; want %+v", in, got, err, want)
		}
	}
	if got, err := parseNodeSize(""); got != nil || err != nil {
		t.Errorf("an empty --node-size is 'not given', got %+v, %v", got, err)
	}
	for _, bad := range []string{"4", "4x", "x16", "fourx16", "0x16", "97x16", "4x0", "4x769", "4x16x2"} {
		if _, err := parseNodeSize(bad); err == nil {
			t.Errorf("parseNodeSize(%q) accepted a value the server refuses", bad)
		} else if !strings.Contains(err.Error(), "--node-size") {
			t.Errorf("parseNodeSize(%q): the refusal must name the flag, got %v", bad, err)
		}
	}
}

// TestNodeShapeFrom_IsMutuallyExclusive: both flags at once is refused — the resolver prefers the
// machine type, so sending both would silently discard the size.
func TestNodeShapeFrom_IsMutuallyExclusive(t *testing.T) {
	if _, err := nodeShapeFrom("t3.xlarge", "4x16"); err == nil || !strings.Contains(err.Error(), "mutually exclusive") {
		t.Fatalf("both flags must be refused, got %v", err)
	}
	shape, err := nodeShapeFrom(" t3.xlarge ", "")
	if err != nil || shape.InstanceType != "t3.xlarge" || shape.NodeSize != nil {
		t.Errorf("instance type alone = %+v, %v", shape, err)
	}
	shape, err = nodeShapeFrom("", "4x16")
	if err != nil || shape.InstanceType != "" || shape.NodeSize == nil {
		t.Errorf("node size alone = %+v, %v", shape, err)
	}
	if shape, err := nodeShapeFrom("", ""); err != nil || shape != (api.ProjectNodeShape{}) {
		t.Errorf("neither = %+v, %v; want the zero shape, which sends nothing", shape, err)
	}
}

// TestWithNodeShape_OnlyDedicatedEnvironmentsGetACluster: the shape becomes a `cluster` component on
// the environments that provision a cluster, and nowhere else; no shape leaves the file untouched.
func TestWithNodeShape_OnlyDedicatedEnvironmentsGetACluster(t *testing.T) {
	envs := func() []manifest.Environment {
		return []manifest.Environment{
			{Name: "prod", Stage: "production", Placement: "dedicated"},
			{Name: "dev", Stage: "development", Placement: "namespace"},
			{Name: "stage", Stage: "staging", Placement: "dedicated"},
		}
	}

	m := &manifest.Manifest{Environments: envs()}
	withNodeShape(m, api.ProjectNodeShape{InstanceType: "t3.xlarge"})
	for _, e := range m.Environments {
		k, has := e.Components.Kind("cluster")
		if e.Placement != "dedicated" {
			if has {
				t.Errorf("%s (%s) got a cluster component; it owns no cluster", e.Name, e.Placement)
			}
			continue
		}
		want := map[string]any{"instance_types": []any{"t3.xlarge"}}
		if !has || len(k.Entries) != 1 || !reflect.DeepEqual(k.Entries[0].Fields, want) {
			t.Errorf("%s cluster = %+v, want %v", e.Name, k, want)
		}
	}

	m = &manifest.Manifest{Environments: envs()}
	withNodeShape(m, api.ProjectNodeShape{NodeSize: &types.NodeSize{VCPU: 4, MemoryGB: 16}})
	k, _ := m.Environments[0].Components.Kind("cluster")
	if want := map[string]any{"node_size": map[string]any{"vcpu": 4.0, "memory_gb": 16.0}}; len(k.Entries) != 1 || !reflect.DeepEqual(k.Entries[0].Fields, want) {
		t.Errorf("node size cluster = %+v, want %v", k, want)
	}

	m = &manifest.Manifest{Environments: envs()}
	withNodeShape(m, api.ProjectNodeShape{})
	for _, e := range m.Environments {
		if len(e.Components) != 0 {
			t.Errorf("no shape must write no component, %s got %+v", e.Name, e.Components)
		}
	}
}

// TestNodeShape_RoundTripsThroughTheManifest: what `up`/`init` write is what `apply` reads back —
// the file is rendered and parsed, and the cluster component survives with its fields.
func TestNodeShape_RoundTripsThroughTheManifest(t *testing.T) {
	m := manifestFromCreate(api.CreateProjectParams{
		ProjectName: "shop", Region: "eu-west-1",
		Environments: []api.EnvironmentSpec{{Name: "prod", Stage: "production", PlacementMode: "dedicated", IsDefault: true}},
		NodeShape:    api.ProjectNodeShape{NodeSize: &types.NodeSize{VCPU: 4, MemoryGB: 16}},
	}, "acct")
	data, err := manifest.Render(m)
	if err != nil {
		t.Fatal(err)
	}
	back, err := manifest.Parse(data)
	if err != nil {
		t.Fatalf("parse what was rendered: %v\n%s", err, data)
	}
	k, ok := back.Environments[0].Components.Kind("cluster")
	if !ok || len(k.Entries) != 1 {
		t.Fatalf("cluster component lost in the round trip:\n%s", data)
	}
	ns, _ := k.Entries[0].Fields["node_size"].(map[string]any)
	if ns["vcpu"] != 4 || ns["memory_gb"] != 16 {
		t.Errorf("node_size after the round trip = %#v\n%s", k.Entries[0].Fields, data)
	}
}

// TestCreateReplayArgs_CarriesTheNodeShape: the replay line reproduces the project, and the shape
// changes the project — without it the replay would buy the catalog default instead.
func TestCreateReplayArgs_CarriesTheNodeShape(t *testing.T) {
	got := createReplayArgs(api.CreateProjectParams{
		ProjectName: "shop", Region: "eu-west-1",
		NodeShape: api.ProjectNodeShape{NodeSize: &types.NodeSize{VCPU: 2, MemoryGB: 7.5}},
	}, "acct", "")
	if line := strings.Join(got, " "); !strings.HasSuffix(line, "--node-size 2x7.5") {
		t.Errorf("replay = %q, want it to end with --node-size 2x7.5", line)
	}
	got = createReplayArgs(api.CreateProjectParams{
		ProjectName: "shop", NodeShape: api.ProjectNodeShape{InstanceType: "t3.xlarge"},
	}, "acct", "")
	if line := strings.Join(got, " "); !strings.HasSuffix(line, "--instance-type t3.xlarge") {
		t.Errorf("replay = %q, want it to end with --instance-type t3.xlarge", line)
	}
}

// TestUp_NodeShapeFlagsAreAuthoringFlags: against an existing manifest the two flags would do
// nothing, so `up` must refuse them like the other authoring flags rather than drop them silently.
func TestUp_NodeShapeFlagsAreAuthoringFlags(t *testing.T) {
	for _, f := range []string{fieldKeyInstanceType, fieldKeyNodeSize} {
		found := false
		for _, a := range authoringFlags {
			found = found || a == f
		}
		if !found {
			t.Errorf("--%s is not in authoringFlags, so `up` against an existing alethia.yaml would ignore it", f)
		}
	}
}

// TestUp_InstanceTypeReachesTheClusterRow drives the whole `up` path with --instance-type: the file
// it writes carries a cluster component on the dedicated environment, and `apply` sends that
// component to the control plane — so the shape reaches a cluster row through the same request any
// hand-written manifest would make.
func TestUp_InstanceTypeReachesTheClusterRow(t *testing.T) {
	s := &projServer{envs: []map[string]any{
		{"id": "e1", "name": "development", "stage": "development", "placement_mode": "dedicated", "status": "DRAFT", "is_default": true},
	}}
	h := upEnv(t, s)
	dir := chdirTo(t)

	if h.run("up", "--project", "boutique", "--region", "eu-west-1", "--cloud-account", "prod-account",
		"--instance-type", "t3.xlarge", "--yes", "--runner", "primary", "--no-wait", "--no-input") {
		t.Fatal("up exited fatally")
	}
	m, err := manifest.Load(filepath.Join(dir, manifest.FileName))
	if err != nil {
		t.Fatalf("the manifest up wrote does not load: %v", err)
	}
	k, ok := m.Environments[0].Components.Kind("cluster")
	if !ok || len(k.Entries) != 1 {
		t.Fatalf("no cluster component in the written file: %+v", m.Environments[0])
	}
	sent := false
	for _, p := range s.posts {
		if !strings.Contains(p.Path, "/components/cluster") {
			continue
		}
		fields, _ := p.Body["fields"].(map[string]any)
		types, _ := fields["instance_types"].([]any)
		sent = len(types) == 1 && types[0] == "t3.xlarge"
	}
	if !sent {
		t.Errorf("apply did not send the cluster's instance_types: %+v", s.posts)
	}
}

// TestUp_RefusesBothShapesBeforeWritingAnything: the mutual-exclusion refusal comes before the
// manifest exists, so a mistaken command line leaves nothing behind to apply by accident.
func TestUp_RefusesBothShapesBeforeWritingAnything(t *testing.T) {
	h := upEnv(t, &projServer{})
	dir := chdirTo(t)
	if !h.run("up", "--project", "boutique", "--region", "eu-west-1", "--cloud-account", "prod-account",
		"--instance-type", "t3.xlarge", "--node-size", "4x16", "--yes", "--no-input") {
		t.Error("both shapes must be refused")
	}
	if manifest.Exists(filepath.Join(dir, manifest.FileName)) {
		t.Error("a manifest was written for a refused command line")
	}
}

// TestProjectCreate_NodeShapeFlags drives `project create` with each flag and each refusal, and
// reads what reached the wire.
func TestProjectCreate_NodeShapeFlags(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)

	lastCreate := func() map[string]any {
		var body map[string]any
		for _, p := range s.posts {
			if p.Method == "POST" && strings.HasSuffix(p.Path, "/cli/projects") {
				body = p.Body
			}
		}
		return body
	}

	if h.run("project", "create", "api", "--region", "eu-west-1", "--cloud-account", "ci1",
		"--node-size", "4x16", "--no-manifest", "--no-input", "--output", "json") {
		t.Fatal("project create --node-size exited fatally")
	}
	ns, _ := lastCreate()["node_size"].(map[string]any)
	if ns["vcpu"] != 4.0 || ns["memory_gb"] != 16.0 {
		t.Errorf("node_size on the wire = %#v", lastCreate())
	}
	if _, present := lastCreate()["instance_type"]; present {
		t.Errorf("instance_type sent alongside node_size: %#v", lastCreate())
	}

	if h.run("project", "create", "web", "--region", "eu-west-1", "--cloud-account", "ci1",
		"--instance-type", "t3.xlarge", "--no-manifest", "--no-input", "--output", "json") {
		t.Fatal("project create --instance-type exited fatally")
	}
	if got := lastCreate()["instance_type"]; got != "t3.xlarge" {
		t.Errorf("instance_type on the wire = %v", got)
	}

	before := len(s.posts)
	for name, args := range map[string][]string{
		"both":                 {"--instance-type", "t3.xlarge", "--node-size", "4x16", "--cloud-account", "ci1"},
		"type with no account": {"--instance-type", "t3.xlarge"},
		"malformed size":       {"--node-size", "big", "--cloud-account", "ci1"},
	} {
		argv := append([]string{"project", "create", "x", "--region", "eu-west-1", "--no-manifest", "--no-input", "--output", "json"}, args...)
		if !h.run(argv...) {
			t.Errorf("%s: must be refused", name)
		}
	}
	if len(s.posts) != before {
		t.Errorf("a refused node shape reached the control plane: %+v", s.posts[before:])
	}
}
