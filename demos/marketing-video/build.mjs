// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Composes a marketing video from a shotlist + the captured stills + the narration
// clips (narrate.mjs): each segment is a still with an eased Ken Burns zoom/pan,
// a burned-in caption, and its narration; segments are concatenated and the whole
// is timed to the voiceover. Pure ffmpeg — reproducible, re-render when the UI
// changes. Usage: node build.mjs script-3min.json
//
// Expression note: ffmpeg filter args are comma-separated, so we build the Ken
// Burns crop expressions WITHOUT commas (no min()/pow()) — p=t/DUR, smoothstep
// e=3p²−2p³, S=s0+(s1−s0)·e — so no escaping is needed.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const shotlistPath = join(HERE, process.argv[2] ?? "script-3min.json");
const shotlist = JSON.parse(readFileSync(shotlistPath, "utf8"));
const variant = shotlist.variant ?? "video";

const STILLS = process.env.STILLS_DIR ?? join(HERE, "..", "proofs", "marketing-capture", "stills");
const OUT = join(HERE, "out", variant);
const SEGDIR = join(OUT, "segments");
const CAPDIR = join(OUT, "captions");
mkdirSync(SEGDIR, { recursive: true });
mkdirSync(CAPDIR, { recursive: true });

const FONT = process.env.CAPTION_FONT ?? "/System/Library/Fonts/Supplemental/Arial.ttf";
const PAD = Number(process.env.SEGMENT_PAD ?? 0.6); // trailing silence per segment (s)
const FPS = 30;

const durations = JSON.parse(readFileSync(join(OUT, "durations.json"), "utf8"));

/** ffmpeg call, quiet unless it errors. */
function ff(args) {
	execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);
}

/** Ken Burns zoom/pan for a segment via zoompan (per-frame `on`-driven zoom,
 * eased s0→s1, window centred on the focus point; comma-free expressions). */
function kenBurns(dur, kb) {
	const { s0 = 1.0, s1 = 1.12, fx = 0.5, fy = 0.5 } = kb ?? {};
	const n = Math.max(2, Math.round(dur * FPS));
	const p = `(on/${n - 1})`;
	const e = `(3*${p}*${p}-2*${p}*${p}*${p})`; // smoothstep
	const z = `(${s0}+(${s1}-${s0})*${e})`;
	return (
		`scale=3840:2160:force_original_aspect_ratio=increase,crop=3840:2160,` +
		`zoompan=z='${z}':x='iw*${fx}-(iw/zoom)/2':y='ih*${fy}-(ih/zoom)/2':d=1:s=1920x1080:fps=${FPS},setsar=1`
	);
}

const segFiles = [];
for (const seg of shotlist.segments) {
	const still = join(STILLS, `${seg.still}.png`);
	if (!existsSync(still)) {
		console.log(`⚠ missing still ${seg.still}.png — skipping segment ${seg.id}`);
		continue;
	}
	const audio = join(OUT, "audio", `${seg.id}.mp3`);
	const dur = (durations[seg.id] ?? 3) + PAD;
	const capFile = join(CAPDIR, `${seg.id}.txt`);
	writeFileSync(capFile, (seg.caption ?? "").replace(/\n/g, "\n"));

	// Burned-in captions need a freetype-enabled ffmpeg (drawtext). Off by default
	// since the voiceover carries the message; enable with CAPTIONS=1 when available.
	const draw =
		process.env.CAPTIONS === "1" && seg.caption
			? `,drawtext=fontfile=${FONT}:textfile=${capFile}:fontcolor=white:fontsize=46:` +
				`box=1:boxcolor=black@0.60:boxborderw=26:line_spacing=10:` +
				`x=(w-text_w)/2:y=h-190`
			: "";
	const fade = `,fade=t=in:st=0:d=0.35,fade=t=out:st=${(dur - 0.45).toFixed(2)}:d=0.45`;
	const vf = `[0:v]${kenBurns(dur, seg.kb)}${draw}${fade}[v]`;

	const seg_mp4 = join(SEGDIR, `${seg.id}.mp4`);
	const hasAudio = existsSync(audio);
	const args = ["-framerate", String(FPS), "-loop", "1", "-t", dur.toFixed(2), "-i", still];
	if (hasAudio) args.push("-i", audio);
	args.push(
		"-filter_complex", vf,
		"-map", "[v]",
		...(hasAudio ? ["-map", "1:a"] : []),
		"-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-r", String(FPS),
		...(hasAudio ? ["-c:a", "aac", "-b:a", "160k", "-ar", "48000"] : ["-an"]),
		"-t", dur.toFixed(2), seg_mp4,
	);
	ff(args);
	segFiles.push(seg_mp4);
	console.log(`✓ segment ${seg.id} (${dur.toFixed(1)}s)`);
}

if (segFiles.length === 0) throw new Error("no segments rendered — were the stills captured?");

// Concat (identical encode params → stream copy).
const listFile = join(OUT, "concat.txt");
writeFileSync(listFile, segFiles.map((f) => `file '${f}'`).join("\n"));
const finalMp4 = join(OUT, `alethia-${variant}.mp4`);
ff(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", finalMp4]);

/** Best-effort extra asset; never fail the whole build over a missing encoder. */
function tryFf(args, label) {
	try {
		ff(args);
	} catch {
		console.log(`· skipped ${label} (encoder unavailable)`);
	}
}

// Poster (a real product frame) + a short muted ambient loop.
const posterStill = join(STILLS, `${shotlist.poster ?? shotlist.segments.at(-1)?.still}.png`);
if (existsSync(posterStill)) {
	tryFf(["-i", posterStill, "-vf", "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080", "-frames:v", "1", "-q:v", "3", join(OUT, "poster.jpg")], "poster.jpg");
}
const loopStill = join(STILLS, `${shotlist.loop ?? shotlist.segments[0]?.still}.png`);
if (existsSync(loopStill)) {
	tryFf(["-framerate", String(FPS), "-loop", "1", "-t", "4", "-i", loopStill, "-filter_complex", `[0:v]${kenBurns(4, { s0: 1.0, s1: 1.08, fx: 0.5, fy: 0.4 })}[v]`, "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "24", "-pix_fmt", "yuv420p", join(OUT, "hero-loop.mp4")], "hero-loop.mp4");
}

const total = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", finalMp4]).toString().trim();
console.log(`\n✓ ${finalMp4}`);
console.log(`  duration ${Math.floor(total / 60)}m ${Math.round(total % 60)}s · ${segFiles.length} segments`);
