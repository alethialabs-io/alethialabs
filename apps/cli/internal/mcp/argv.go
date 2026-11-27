// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package mcp

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

// Argv turns a tool call's arguments into the command line of the child process, without the
// program name: the command's words, one `--name=value` per flag, then `--` and the positional
// arguments.
//
// Every flag is written in the `--name=value` form, so a value that starts with a dash is a value
// and never another flag. Every positional argument follows `--`, so an argument cannot be read as
// a flag either: `{"args": ["--web-origin=https://elsewhere"]}` reaches the command as an argument
// it refuses, not as a flag it obeys. A property the tool does not declare is refused, which is
// what keeps a hidden flag (hiddenFlags) unreachable.
func (t Tool) Argv(raw json.RawMessage) ([]string, error) {
	args := map[string]json.RawMessage{}
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &args); err != nil {
			return nil, fmt.Errorf("arguments must be a JSON object: %v", err)
		}
	}
	argv := append([]string{}, t.Command...)

	names := make([]string, 0, len(args))
	for name := range args {
		names = append(names, name)
	}
	sort.Strings(names)

	var positional []string
	for _, name := range names {
		value := args[name]
		if name == argsProperty && t.TakesArgs {
			if err := json.Unmarshal(value, &positional); err != nil {
				return nil, fmt.Errorf("%s must be an array of strings", argsProperty)
			}
			continue
		}
		f, ok := t.Flags[name]
		if !ok {
			return nil, fmt.Errorf("unknown argument %q (want one of: %s)", name, strings.Join(t.propertyNames(), ", "))
		}
		values, err := flagValues(flagKind(f.Type), value)
		if err != nil {
			return nil, fmt.Errorf("%s: %v", name, err)
		}
		for _, v := range values {
			argv = append(argv, "--"+name+"="+v)
		}
	}
	if len(positional) > 0 {
		argv = append(argv, "--")
		argv = append(argv, positional...)
	}
	return argv, nil
}

// propertyNames returns the tool's input property names, sorted.
func (t Tool) propertyNames() []string {
	out := make([]string, 0, len(t.Flags)+1)
	for name := range t.Flags {
		out = append(out, name)
	}
	if t.TakesArgs {
		out = append(out, argsProperty)
	}
	sort.Strings(out)
	return out
}

// flagValues returns the command-line spellings of one flag's JSON value: one for a scalar, one per
// item for a list. A JSON null leaves the flag out.
func flagValues(kind valueKind, raw json.RawMessage) ([]string, error) {
	if string(raw) == "null" {
		return nil, nil
	}
	switch kind {
	case kindBool:
		var b bool
		if err := json.Unmarshal(raw, &b); err != nil {
			return nil, fmt.Errorf("want true or false")
		}
		return []string{strconv.FormatBool(b)}, nil
	case kindInt:
		var n float64
		if err := json.Unmarshal(raw, &n); err != nil || n != math.Trunc(n) || math.IsInf(n, 0) {
			return nil, fmt.Errorf("want a whole number")
		}
		return []string{strconv.FormatFloat(n, 'f', -1, 64)}, nil
	case kindNumber:
		var n float64
		if err := json.Unmarshal(raw, &n); err != nil {
			return nil, fmt.Errorf("want a number")
		}
		return []string{strconv.FormatFloat(n, 'f', -1, 64)}, nil
	case kindList:
		var items []string
		if err := json.Unmarshal(raw, &items); err != nil {
			return nil, fmt.Errorf("want an array of strings")
		}
		return items, nil
	case kindString:
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, fmt.Errorf("want a string")
	}
	return []string{s}, nil
}
