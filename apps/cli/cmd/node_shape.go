// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/manifest"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The node-shape override (#5266): `--instance-type` and `--node-size` on `project create`, `up`
// and `init`. The catalog is the single source of truth for the DEFAULT node — the templates'
// own defaults are pinned equal to it — and these two flags are the explicit way past it.
//
// They are mutually exclusive, as a cluster's `instance_types` and `node_size` are (#5267): the
// resolver (packages/core/cloud/resolve.go, ResolveInstanceTypes) prefers the machine type, so a
// row carrying both would provision the machine type and silently ignore the size.

// Field keys and flag names, shared by the three specs so they cannot drift apart.
const (
	fieldKeyInstanceType = "instance-type"
	fieldKeyNodeSize     = "node-size"
)

// The node-size bounds. They are the canvas inspector's ("vCPU per node" 1–96, "Memory per node"
// 1–768 GB) and the server's (nodeSizeWire in apps/console/lib/validations/cli-contract.ts), so
// the terminal refuses here exactly what the server would refuse there.
const (
	nodeSizeMinVCPU, nodeSizeMaxVCPU     = 1, 96
	nodeSizeMinMemory, nodeSizeMaxMemory = 1, 768
)

// Descriptions shared by the three specs. Plain text, no angle brackets: the same string is the
// `--help` line and a cell of an MDX docs table, where `<vCPU>` would parse as a JSX tag.
const (
	instanceTypeDescription = "Machine type for the cluster nodes, e.g. t3.xlarge (needs a cloud account; not with --node-size)"
	nodeSizeDescription     = "Node size as vCPUxGiB, e.g. 4x16, mapped to the nearest machine type (not with --instance-type)"
)

// parseNodeSize reads `--node-size`: `<vCPU>x<GiB>`, e.g. `4x16` or `2x7.5`. An empty string is
// "not given" and returns nil. Anything else that does not parse, or lies outside the bounds, is an
// error naming the flag — never a silently dropped value.
func parseNodeSize(s string) (*types.NodeSize, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, nil
	}
	vcpuText, memText, ok := strings.Cut(strings.ToLower(s), "x")
	if !ok {
		return nil, fmt.Errorf("--node-size %q: want vCPUxGiB, e.g. 4x16", s)
	}
	vcpu, errV := strconv.ParseFloat(strings.TrimSpace(vcpuText), 64)
	mem, errM := strconv.ParseFloat(strings.TrimSpace(memText), 64)
	if errV != nil || errM != nil {
		return nil, fmt.Errorf("--node-size %q: want vCPUxGiB, e.g. 4x16", s)
	}
	if vcpu < nodeSizeMinVCPU || vcpu > nodeSizeMaxVCPU {
		return nil, fmt.Errorf("--node-size %q: vCPU must be %d–%d", s, nodeSizeMinVCPU, nodeSizeMaxVCPU)
	}
	if mem < nodeSizeMinMemory || mem > nodeSizeMaxMemory {
		return nil, fmt.Errorf("--node-size %q: memory must be %d–%d GiB", s, nodeSizeMinMemory, nodeSizeMaxMemory)
	}
	return &types.NodeSize{VCPU: vcpu, MemoryGB: mem}, nil
}

// nodeShapeFrom turns the two flag values into the wire shape, refusing both at once.
func nodeShapeFrom(instanceType, nodeSize string) (api.ProjectNodeShape, error) {
	instanceType = strings.TrimSpace(instanceType)
	size, err := parseNodeSize(nodeSize)
	if err != nil {
		return api.ProjectNodeShape{}, err
	}
	if instanceType != "" && size != nil {
		return api.ProjectNodeShape{}, fmt.Errorf("--instance-type and --node-size are mutually exclusive: pass one")
	}
	return api.ProjectNodeShape{InstanceType: instanceType, NodeSize: size}, nil
}

// formatNodeSize renders a size back into the flag's own spelling, for a replay line.
func formatNodeSize(ns *types.NodeSize) string {
	return strconv.FormatFloat(ns.VCPU, 'f', -1, 64) + "x" + strconv.FormatFloat(ns.MemoryGB, 'f', -1, 64)
}

// nodeShapeArgs renders the shape as the flags that reproduce it, for a replay line.
func nodeShapeArgs(shape api.ProjectNodeShape) []string {
	switch {
	case shape.InstanceType != "":
		return []string{"--" + fieldKeyInstanceType, shape.InstanceType}
	case shape.NodeSize != nil:
		return []string{"--" + fieldKeyNodeSize, formatNodeSize(shape.NodeSize)}
	}
	return nil
}

// clusterFieldsFor is the shape as the fields of a manifest `cluster` component — the keys the
// server's cluster kind accepts (`instance_types`, `node_size`). Nil when no shape was given.
func clusterFieldsFor(shape api.ProjectNodeShape) map[string]any {
	switch {
	case shape.InstanceType != "":
		return map[string]any{"instance_types": []any{shape.InstanceType}}
	case shape.NodeSize != nil:
		return map[string]any{"node_size": map[string]any{
			"vcpu": shape.NodeSize.VCPU, "memory_gb": shape.NodeSize.MemoryGB,
		}}
	}
	return nil
}

// withNodeShape writes the shape into a manifest as a `cluster` component on every `dedicated`
// environment — the only placement that provisions a cluster. A `namespace`/`vcluster` environment
// owns no cluster: it runs on the cluster of the Fabric it is placed on, which a dedicated one sizes.
//
// It is how `up` and `init` carry the shape: they author alethia.yaml and `apply` creates from it,
// so the file is the one place the shape can live, and a person reading the file sees it.
// No shape leaves the manifest untouched: no cluster component, and the template default (which
// equals the catalog default) applies.
func withNodeShape(m *manifest.Manifest, shape api.ProjectNodeShape) {
	fields := clusterFieldsFor(shape)
	if fields == nil {
		return
	}
	for i := range m.Environments {
		env := &m.Environments[i]
		if env.Placement != string(placementDedicated) {
			continue
		}
		env.Components = append(env.Components, manifest.KindEntries{
			Kind:    "cluster",
			Entries: []manifest.Component{{Fields: fields}},
		})
	}
}
