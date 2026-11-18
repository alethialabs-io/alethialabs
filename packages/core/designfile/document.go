// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package designfile

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// Document is an `alethia.yaml` held as the TEXT a person wrote, so it can be changed without
// rewriting the parts nobody changed.
//
// # Why Render is not enough
//
// Render writes a Manifest from nothing: it has no comments to keep, picks its own quoting and
// indentation, and sorts every free-form mapping. That is right for a file being created. It is
// wrong for a file that already lives in somebody's repository, where a change to one field would
// arrive as a diff of the whole file and the review would be of the formatter rather than of the
// change.
//
// So a Document keeps the source bytes and edits them in place. Update compares the design the file
// holds with the design wanted, and splices only the lines of the entries that differ. Three
// promises follow, and the tests pin each:
//
//   - a design that did not change is written back BYTE FOR BYTE — not "equivalent", identical;
//   - a change touches the lines of the entry that changed and no others, so comments, blank lines,
//     quoting and key order everywhere else survive;
//   - the result is deterministic: the same source and the same design give the same bytes.
//
// # What keeps it honest
//
// Editing text by line is only as good as the guess about where an entry ends, and YAML has shapes
// where that guess is hard (a flow mapping on one line, a folded scalar ending in a line that looks
// like a comment). So Update never trusts the splice: it parses what it produced and requires it to
// mean exactly the design that was asked for. A shape it cannot patch locally is replaced one level
// up; a file it cannot patch at all is written whole, and Result.Whole says so. It never returns
// bytes that mean something else.
type Document struct {
	src       []byte
	lines     []string
	eol       string
	finalEOL  bool
	root      *yaml.Node
	canonical []byte
}

// Result is what Update produced.
type Result struct {
	// Data is the file's new content.
	Data []byte
	// Whole is true when the file could not be patched in place and was written out whole by
	// Render, which drops its comments and formatting. False for every ordinary edit, and always
	// false when nothing changed.
	Whole bool
}

// ParseDocument reads an `alethia.yaml` for editing. It accepts exactly what Parse accepts, and
// additionally refuses a stream of more than one YAML document, because an edit could not say
// which of them it meant.
func ParseDocument(data []byte) (*Document, error) {
	m, err := Parse(data)
	if err != nil {
		return nil, err
	}
	canonical, err := canonicalBytes(m)
	if err != nil {
		return nil, err
	}
	dec := yaml.NewDecoder(bytes.NewReader(data))
	var doc, second yaml.Node
	if err := dec.Decode(&doc); err != nil && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%s: %w", FileName, err)
	}
	if err := dec.Decode(&second); err == nil {
		return nil, fmt.Errorf("%s holds more than one YAML document (line %d starts another) — keep one design per file", FileName, second.Line)
	}
	d := &Document{src: append([]byte(nil), data...), canonical: canonical, eol: "\n"}
	text := string(data)
	if strings.Contains(text, "\r\n") {
		d.eol = "\r\n"
	}
	d.finalEOL = strings.HasSuffix(text, "\n")
	if text != "" {
		d.lines = strings.Split(strings.TrimSuffix(text, "\n"), "\n")
		for i, l := range d.lines {
			d.lines[i] = strings.TrimSuffix(l, "\r")
		}
	}
	if doc.Kind == yaml.DocumentNode && len(doc.Content) == 1 {
		d.root = doc.Content[0]
	}
	return d, nil
}

// Bytes is the source exactly as it was read.
func (d *Document) Bytes() []byte {
	return append([]byte(nil), d.src...)
}

// Manifest is the design the file holds, as a value the caller owns: change it and hand it to
// Update. It is not normalized — a placement the file leaves out is still left out — so writing it
// straight back changes nothing.
func (d *Document) Manifest() (*Manifest, error) {
	return Parse(d.canonical)
}

// Update returns the file changed to hold the design `want`, keeping every line that design does
// not change. See Document for what it promises.
//
// `want` is the WHOLE design the file should hold afterwards, not a patch: an entry `want` leaves
// out is taken out of the file. That is a statement about the file only. What an absent entry means
// for the resource it used to describe is decided by whoever reads the file, and the rule there is
// that it is left running (see Compare and ActionOmitted).
func (d *Document) Update(want *Manifest) (Result, error) {
	if want == nil {
		return Result{}, errors.New("no design to write")
	}
	target, err := canonicalBytes(want)
	if err != nil {
		return Result{}, err
	}
	if bytes.Equal(target, d.canonical) {
		return Result{Data: d.Bytes()}, nil
	}
	if out, ok := d.patch(target); ok {
		return Result{Data: out}, nil
	}
	return Result{Data: target, Whole: true}, nil
}

// canonicalBytes is the one byte form of a design: rendered, read back and rendered again, so that
// two designs meaning the same thing compare equal whatever Go values they were built from (an
// int and a float holding the same number, say).
func canonicalBytes(m *Manifest) ([]byte, error) {
	first, err := Render(m)
	if err != nil {
		return nil, err
	}
	back, err := Parse(first)
	if err != nil {
		return nil, fmt.Errorf("the design does not survive being written: %w", err)
	}
	return Render(back)
}

// patch splices the source so it means `target` (canonical bytes), and reports whether it managed
// to. It fails rather than guesses: a source with no block mapping at its root, a change it cannot
// place, or a result that does not read back as the target all return false.
func (d *Document) patch(target []byte) ([]byte, bool) {
	if d.root == nil || d.root.Kind != yaml.MappingNode {
		return nil, false
	}
	base, ok := rootMapping(d.canonical)
	if !ok {
		return nil, false
	}
	want, ok := rootMapping(target)
	if !ok {
		return nil, false
	}
	p := &patcher{lines: d.lines}
	if !p.mapping(d.root, base, want, len(d.lines)) {
		return nil, false
	}
	out := []byte(strings.Join(p.apply(), d.eol))
	if d.finalEOL || len(d.lines) == 0 {
		out = append(out, d.eol...)
	}
	// The proof. Whatever the splices did, the bytes must read back as the design asked for.
	got, err := Parse(out)
	if err != nil {
		return nil, false
	}
	check, err := canonicalBytes(got)
	if err != nil || !bytes.Equal(check, target) {
		return nil, false
	}
	// And still one document a later edit can open.
	if _, err := ParseDocument(out); err != nil {
		return nil, false
	}
	return out, true
}

// rootMapping parses canonical bytes and returns the document's root mapping.
func rootMapping(data []byte) (*yaml.Node, bool) {
	var doc yaml.Node
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return nil, false
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, false
	}
	return doc.Content[0], true
}

// splice replaces the source lines [start, end) with `with`. A splice whose start equals its end
// is an insertion.
type splice struct {
	start, end int
	with       []string
	seq        int
}

// patcher walks three trees at once — the source as written, the design it holds in canonical
// form, and the design wanted in canonical form — and records the line splices that turn the
// first into the third. The canonical pair says WHAT changed; the source tree says WHERE that is
// in the text.
type patcher struct {
	lines   []string
	splices []splice
}

// add records one splice.
func (p *patcher) add(start, end int, with []string) {
	p.splices = append(p.splices, splice{start: start, end: end, with: with, seq: len(p.splices)})
}

// apply returns the source lines with every recorded splice made, working from the bottom of the
// file up so no splice moves the lines another one names.
func (p *patcher) apply() []string {
	ordered := append([]splice(nil), p.splices...)
	sort.SliceStable(ordered, func(i, j int) bool {
		a, b := ordered[i], ordered[j]
		if a.start != b.start {
			return a.start > b.start
		}
		// At one line, the splice that consumes lines goes first and the insertions after it, so
		// the insertions end up ABOVE it; and of two insertions the later-recorded goes first, so
		// they read in the order they were recorded.
		aInsert, bInsert := a.start == a.end, b.start == b.end
		if aInsert != bInsert {
			return bInsert
		}
		return a.seq > b.seq
	})
	out := append([]string(nil), p.lines...)
	for _, s := range ordered {
		tail := append([]string(nil), out[s.end:]...)
		out = append(append(out[:s.start], s.with...), tail...)
	}
	return out
}

// mapping makes the block mapping `src` mean `want`, given that it means `base` now. `limit` is the
// first source line that is past the mapping. False means it could not be done by splices inside
// the mapping, and the caller must replace the whole of it.
func (p *patcher) mapping(src, base, want *yaml.Node, limit int) bool {
	if src.Kind != yaml.MappingNode || src.Style&yaml.FlowStyle != 0 || len(src.Content) == 0 {
		return false
	}
	if len(want.Content) == 0 || !sameOrder(mappingKeys(base), mappingKeys(want)) {
		return false
	}
	pairs := len(src.Content) / 2
	for i := 0; i < pairs; i++ {
		if !p.ownsItsLine(src.Content[2*i], i == 0) {
			return false
		}
	}
	keyColumn := src.Content[0].Column
	// Whether the source lists its keys in the order the design does. True for every mapping whose
	// order means something (the kinds under `components` are kept in file order), and for a
	// free-form one that happens to be sorted.
	ordered := sameOrder(mappingKeys(src), mappingKeys(want))
	end := func(i int) int { return p.pairEnd(src, i, limit) }
	rawEnd := func(i int) int {
		if i+1 < pairs {
			return src.Content[2*(i+1)].Line - 1
		}
		return limit
	}
	// The pending splices are kept apart until the whole mapping is known to be patchable, so a
	// mapping that fails halfway leaves nothing behind for the caller's replacement to collide with.
	mark := len(p.splices)
	fail := func() bool {
		p.splices = p.splices[:mark]
		return false
	}

	// Entries the design no longer holds.
	for i := 0; i+1 < len(base.Content); i += 2 {
		key := base.Content[i].Value
		if pairIndex(want, key) >= 0 {
			continue
		}
		at := pairIndex(src, key)
		if at < 0 {
			continue
		}
		if at == 0 && p.onADashLine(src.Content[0]) {
			// The first key of a list entry carries the entry's dash; taking it out would orphan
			// the rest. The entry is rewritten instead.
			return fail()
		}
		p.add(p.withHeadComment(src.Content[2*at]), end(at), nil)
	}

	for i := 0; i+1 < len(want.Content); i += 2 {
		wantKey, wantVal := want.Content[i], want.Content[i+1]
		key := wantKey.Value
		at := pairIndex(src, key)
		baseAt := pairIndex(base, key)
		if baseAt >= 0 && at >= 0 {
			baseVal, srcVal := base.Content[baseAt*2+1], src.Content[at*2+1]
			if nodesEqual(baseVal, wantVal) {
				continue
			}
			if p.descend(srcVal, baseVal, wantVal, rawEnd(at)) {
				continue
			}
			p.replacePair(src, at, wantKey, wantVal, end(at))
			continue
		}
		if at >= 0 {
			// Written in the source in a form that holds nothing (`iac:` with no value, say), and
			// now given a value.
			p.replacePair(src, at, wantKey, wantVal, end(at))
			continue
		}
		rendered, ok := renderPair(wantKey, wantVal, nil)
		if !ok {
			return fail()
		}
		indent := strings.Repeat(" ", keyColumn-1)
		if !ordered {
			// The person ordered this mapping their own way, so there is no place in it the
			// design's order points at. The new entry goes last.
			p.add(end(pairs-1), end(pairs-1), prefixed(rendered, indent, indent))
			continue
		}
		// After the nearest entry before it that the source has, so the file keeps the order the
		// design states.
		after := -1
		for j := i - 2; j >= 0 && after < 0; j -= 2 {
			after = pairIndex(src, want.Content[j].Value)
		}
		if after >= 0 {
			p.add(end(after), end(after), prefixed(rendered, indent, indent))
			continue
		}
		if p.onADashLine(src.Content[0]) {
			return fail()
		}
		top := p.withHeadComment(src.Content[0])
		p.add(top, top, prefixed(rendered, indent, indent))
	}
	return true
}

// descend patches a value in place when it is a mapping or a list on both sides, and reports
// whether it did.
func (p *patcher) descend(src, base, want *yaml.Node, limit int) bool {
	if base.Kind != want.Kind {
		return false
	}
	switch want.Kind {
	case yaml.MappingNode:
		return p.mapping(src, base, want, limit)
	case yaml.SequenceNode:
		return p.sequence(src, base, want, limit)
	case yaml.DocumentNode, yaml.ScalarNode, yaml.AliasNode:
		return false
	}
	return false
}

// sequence makes the block list `src` mean `want`, given that it means `base` now. It works only
// for a list of entries that name themselves (`name` for environments and components, `id` for
// add-ons), because that name is the only thing that says which entry in one list is which entry
// in the other. Any other list is replaced whole by the caller.
func (p *patcher) sequence(src, base, want *yaml.Node, limit int) bool {
	if src.Kind != yaml.SequenceNode || src.Style&yaml.FlowStyle != 0 || len(src.Content) == 0 || len(want.Content) == 0 {
		return false
	}
	var srcIDs, baseIDs, wantIDs []string
	identified := false
	for _, key := range []string{"name", "id"} {
		var a, b, c bool
		srcIDs, a = identities(src, key)
		baseIDs, b = identities(base, key)
		wantIDs, c = identities(want, key)
		if a && b && c {
			identified = true
			break
		}
	}
	if !identified || !equalStrings(srcIDs, baseIDs) || !sameOrder(baseIDs, wantIDs) {
		return false
	}
	dashes := make([]int, len(src.Content))
	for i, item := range src.Content {
		dash, ok := p.dashColumn(item)
		if !ok {
			return false
		}
		dashes[i] = dash
	}
	indent := strings.Repeat(" ", dashes[0])
	rawEnd := func(i int) int {
		if i+1 < len(src.Content) {
			return src.Content[i+1].Line - 1
		}
		return limit
	}
	end := func(i int) int { return p.trimEnd(src.Content[i], rawEnd(i)) }
	mark := len(p.splices)
	fail := func() bool {
		p.splices = p.splices[:mark]
		return false
	}

	for i, id := range baseIDs {
		if indexOf(wantIDs, id) >= 0 {
			continue
		}
		p.add(p.commentsAbove(src.Content[i].Line-1, dashes[i]), end(i), nil)
	}
	for i, id := range wantIDs {
		item := want.Content[i]
		at := indexOf(srcIDs, id)
		if at >= 0 {
			if nodesEqual(base.Content[at], item) {
				continue
			}
			if p.mapping(src.Content[at], base.Content[at], item, rawEnd(at)) {
				continue
			}
			rendered, ok := renderItem(item)
			if !ok {
				return fail()
			}
			own := strings.Repeat(" ", dashes[at])
			p.add(src.Content[at].Line-1, end(at), prefixed(rendered, own, own))
			continue
		}
		rendered, ok := renderItem(item)
		if !ok {
			return fail()
		}
		after := -1
		for j := i - 1; j >= 0 && after < 0; j-- {
			after = indexOf(srcIDs, wantIDs[j])
		}
		if after >= 0 {
			p.add(end(after), end(after), prefixed(rendered, indent, indent))
			continue
		}
		top := p.commentsAbove(src.Content[0].Line-1, dashes[0])
		p.add(top, top, prefixed(rendered, indent, indent))
	}
	return true
}

// replacePair rewrites one `key: value` entry of a mapping, keeping whatever stands before the key
// on its line (the indentation, or a list entry's dash) and a trailing comment on a one-line value.
func (p *patcher) replacePair(src *yaml.Node, at int, key, val *yaml.Node, end int) {
	srcKey, srcVal := src.Content[2*at], src.Content[2*at+1]
	var keep *yaml.Node
	if srcVal.Kind == yaml.ScalarNode && srcVal.Line == srcKey.Line && val.Kind == yaml.ScalarNode {
		keep = srcVal
	}
	rendered, ok := renderPair(key, val, keep)
	if !ok {
		// Unreachable for a node that came out of the encoder; if it ever happens the splice is
		// simply not made and the read-back check refuses the result.
		return
	}
	line := p.lines[srcKey.Line-1]
	first := line[:srcKey.Column-1]
	p.add(srcKey.Line-1, end, prefixed(rendered, first, strings.Repeat(" ", len(first))))
}

// pairEnd is the first line past entry `i` of a mapping: where the next entry starts, pulled back
// over the blank lines and comments in between, which belong to what follows rather than to it.
func (p *patcher) pairEnd(src *yaml.Node, i, limit int) int {
	raw := limit
	if 2*(i+1) < len(src.Content) {
		raw = src.Content[2*(i+1)].Line - 1
	}
	return p.trimEnd(src.Content[2*i+1], raw, src.Content[2*i])
}

// trimEnd pulls an end line back over trailing blank lines, comments and document markers, but
// never past the last line the nodes are known to occupy.
func (p *patcher) trimEnd(node *yaml.Node, raw int, also ...*yaml.Node) int {
	floor := lastLine(node)
	for _, n := range also {
		if l := lastLine(n); l > floor {
			floor = l
		}
	}
	if raw > len(p.lines) {
		raw = len(p.lines)
	}
	for raw > floor && skippable(p.lines[raw-1]) {
		raw--
	}
	return raw
}

// withHeadComment is the line an entry starts on, counting the comment lines directly above it at
// its own indentation: a comment sitting on a field describes that field, and goes where it goes.
func (p *patcher) withHeadComment(key *yaml.Node) int {
	return p.commentsAbove(key.Line-1, key.Column-1)
}

// commentsAbove walks up from `line` over the comment lines indented exactly `indent`, and returns
// the topmost of them (or `line` when there is none).
func (p *patcher) commentsAbove(line, indent int) int {
	for line > 0 {
		above := p.lines[line-1]
		trimmed := strings.TrimLeft(above, " ")
		if !strings.HasPrefix(trimmed, "#") || len(above)-len(trimmed) != indent {
			break
		}
		line--
	}
	return line
}

// ownsItsLine reports whether a mapping key is the first thing on its line — after indentation,
// or after a list entry's dash when it is the first key of that entry. Only such an entry can be
// spliced by line.
func (p *patcher) ownsItsLine(key *yaml.Node, first bool) bool {
	if key.Kind != yaml.ScalarNode || key.Line < 1 || key.Line > len(p.lines) {
		return false
	}
	line := p.lines[key.Line-1]
	if key.Column < 1 || key.Column-1 > len(line) {
		return false
	}
	for _, r := range line[:key.Column-1] {
		if r == ' ' || (first && r == '-') {
			continue
		}
		return false
	}
	return true
}

// onADashLine reports whether a key shares its line with a list entry's dash.
func (p *patcher) onADashLine(key *yaml.Node) bool {
	return strings.Contains(p.lines[key.Line-1][:key.Column-1], "-")
}

// dashColumn is the zero-based column of the dash that opens a list entry, when the entry begins
// on the dash's own line with nothing but indentation before the dash.
func (p *patcher) dashColumn(item *yaml.Node) (int, bool) {
	if item.Kind != yaml.MappingNode || item.Style&yaml.FlowStyle != 0 || len(item.Content) == 0 {
		return 0, false
	}
	if item.Line < 1 || item.Line > len(p.lines) {
		return 0, false
	}
	line := p.lines[item.Line-1]
	if item.Column-1 > len(line) {
		return 0, false
	}
	before := line[:item.Column-1]
	dash := strings.Index(before, "-")
	if dash < 0 || strings.TrimLeft(before, " ") != "-"+strings.Repeat(" ", len(before)-dash-1) {
		return 0, false
	}
	return dash, true
}

// skippable reports whether a line carries no YAML content: blank, a comment, or a document marker.
func skippable(line string) bool {
	t := strings.TrimSpace(line)
	return t == "" || strings.HasPrefix(t, "#") || t == "---" || t == "..."
}

// lastLine is the last source line (one-based, so also a zero-based exclusive end) a node is known
// to reach: the deepest line any of its nodes starts on, plus the body of a block scalar, whose
// lines are text and must never be mistaken for comments.
func lastLine(n *yaml.Node) int {
	last := n.Line
	if n.Kind == yaml.ScalarNode && n.Style&(yaml.LiteralStyle|yaml.FoldedStyle) != 0 {
		if body := strings.TrimRight(n.Value, "\n"); body != "" {
			last += strings.Count(body, "\n") + 1
		}
	}
	for _, c := range n.Content {
		if l := lastLine(c); l > last {
			last = l
		}
	}
	return last
}

// renderPair writes one `key: value` entry as lines with no indentation. `keep` is a source value
// whose trailing comment is carried onto the new one.
func renderPair(key, val, keep *yaml.Node) ([]string, bool) {
	v := plainCopy(val)
	if keep != nil && keep.LineComment != "" {
		v.LineComment = keep.LineComment
	}
	return encodeLines(&yaml.Node{Kind: yaml.MappingNode, Content: []*yaml.Node{plainCopy(key), v}})
}

// renderItem writes one list entry as lines with no indentation, the first carrying the dash.
func renderItem(item *yaml.Node) ([]string, bool) {
	return encodeLines(&yaml.Node{Kind: yaml.SequenceNode, Content: []*yaml.Node{plainCopy(item)}})
}

// encodeLines encodes a node the way Render does and splits the result into lines.
func encodeLines(n *yaml.Node) ([]string, bool) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(n); err != nil {
		return nil, false
	}
	if err := enc.Close(); err != nil {
		return nil, false
	}
	return strings.Split(strings.TrimSuffix(buf.String(), "\n"), "\n"), true
}

// plainCopy copies a node and everything under it without positions or comments, so that what is
// encoded is the value alone.
func plainCopy(n *yaml.Node) *yaml.Node {
	out := &yaml.Node{Kind: n.Kind, Style: n.Style, Tag: n.Tag, Value: n.Value}
	for _, c := range n.Content {
		out.Content = append(out.Content, plainCopy(c))
	}
	return out
}

// prefixed puts `first` before the first line and `rest` before every other non-empty one.
func prefixed(lines []string, first, rest string) []string {
	out := make([]string, len(lines))
	for i, l := range lines {
		switch {
		case i == 0:
			out[i] = first + l
		case l == "":
			out[i] = l
		default:
			out[i] = rest + l
		}
	}
	return out
}

// nodesEqual reports whether two canonical nodes are the same value.
func nodesEqual(a, b *yaml.Node) bool {
	if a.Kind != b.Kind || a.Tag != b.Tag || a.Value != b.Value || len(a.Content) != len(b.Content) {
		return false
	}
	for i := range a.Content {
		if !nodesEqual(a.Content[i], b.Content[i]) {
			return false
		}
	}
	return true
}

// mappingKeys are a mapping's keys in order.
func mappingKeys(m *yaml.Node) []string {
	keys := make([]string, 0, len(m.Content)/2)
	for i := 0; i+1 < len(m.Content); i += 2 {
		keys = append(keys, m.Content[i].Value)
	}
	return keys
}

// pairIndex is the position of `key` among a mapping's entries, or -1.
func pairIndex(m *yaml.Node, key string) int {
	if m.Kind != yaml.MappingNode {
		return -1
	}
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return i / 2
		}
	}
	return -1
}

// identities are the values of `key` in each entry of a list of mappings, and whether every entry
// has a distinct, non-empty one.
func identities(seq *yaml.Node, key string) ([]string, bool) {
	if seq.Kind != yaml.SequenceNode {
		return nil, false
	}
	out := make([]string, 0, len(seq.Content))
	seen := map[string]bool{}
	for _, item := range seq.Content {
		at := pairIndex(item, key)
		if at < 0 {
			return nil, false
		}
		val := item.Content[2*at+1]
		if val.Kind != yaml.ScalarNode || val.Value == "" || seen[val.Value] {
			return nil, false
		}
		seen[val.Value] = true
		out = append(out, val.Value)
	}
	return out, true
}

// sameOrder reports whether the names two lists share appear in the same relative order in both.
func sameOrder(a, b []string) bool {
	var shared []string
	for _, s := range a {
		if indexOf(b, s) >= 0 {
			shared = append(shared, s)
		}
	}
	at := 0
	for _, s := range b {
		if indexOf(a, s) < 0 {
			continue
		}
		if at >= len(shared) || shared[at] != s {
			return false
		}
		at++
	}
	return true
}

// equalStrings reports whether two lists hold the same strings in the same order.
func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// indexOf is the position of s in list, or -1.
func indexOf(list []string, s string) int {
	for i, v := range list {
		if v == s {
			return i
		}
	}
	return -1
}
