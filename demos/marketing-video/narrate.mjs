// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Generates narration audio for a marketing-video shotlist, one clip per segment,
// via ElevenLabs TTS (falls back to macOS `say` when no key is set — a timing
// scratch track a human replaces later). Writes out/audio/<id>.mp3 and records
// each clip's duration (via ffprobe) into out/durations.json so the compositor
// can time the Ken Burns moves to the voiceover.
//
// Usage: ELEVENLABS_API_KEY=… node narrate.mjs script-3min.json
// The key is read from the env ONLY — never hard-coded, never committed.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Load the gitignored local secrets file (ELEVENLABS_API_KEY) if present.
const envLocal = join(HERE, ".env.local");
if (existsSync(envLocal)) {
	for (const line of readFileSync(envLocal, "utf8").split("\n")) {
		const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
		if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
	}
}

const shotlistPath = join(HERE, process.argv[2] ?? "script-3min.json");
const shotlist = JSON.parse(readFileSync(shotlistPath, "utf8"));
const variant = shotlist.variant ?? "video";
const OUT = join(HERE, "out", variant);
const AUDIO = join(OUT, "audio");
mkdirSync(AUDIO, { recursive: true });

const KEY = process.env.ELEVENLABS_API_KEY;
const VOICE = process.env.ELEVENLABS_VOICE_ID ?? "JBFqnCBsd6RMkjVDRZzb"; // "George" — warm, clear narrator
const MODEL = process.env.ELEVENLABS_MODEL ?? "eleven_multilingual_v2";

/** ElevenLabs TTS → mp3 bytes, with backoff on transient rate limits. */
async function elevenlabs(text, attempt = 0) {
	const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}`, {
		method: "POST",
		headers: { "xi-api-key": KEY, "content-type": "application/json", accept: "audio/mpeg" },
		body: JSON.stringify({
			text,
			model_id: MODEL,
			voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0.1, use_speaker_boost: true },
		}),
	});
	if (res.status === 429 && attempt < 6) {
		const wait = 4000 * (attempt + 1);
		console.log(`  · rate-limited, retrying in ${wait / 1000}s…`);
		await new Promise((r) => setTimeout(r, wait));
		return elevenlabs(text, attempt + 1);
	}
	if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
	return Buffer.from(await res.arrayBuffer());
}

/** macOS `say` fallback → mp3 (scratch track). */
function sayFallback(text, mp3Path) {
	const aiff = mp3Path.replace(/\.mp3$/, ".aiff");
	execFileSync("say", ["-v", "Daniel", "-o", aiff, text]);
	execFileSync("ffmpeg", ["-y", "-i", aiff, "-b:a", "160k", mp3Path], { stdio: "ignore" });
}

/** Seconds of an audio file via ffprobe. */
function durationOf(file) {
	const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
	return parseFloat(out.toString().trim());
}

const durations = {};
for (const seg of shotlist.segments) {
	const mp3 = join(AUDIO, `${seg.id}.mp3`);
	if (existsSync(mp3) && process.env.FORCE !== "1") {
		durations[seg.id] = durationOf(mp3);
		console.log(`· ${seg.id} (cached) ${durations[seg.id].toFixed(2)}s`);
		continue;
	}
	if (KEY) {
		const bytes = await elevenlabs(seg.narration);
		writeFileSync(mp3, bytes);
	} else {
		console.log("  (no ELEVENLABS_API_KEY — using macOS `say` scratch track)");
		sayFallback(seg.narration, mp3);
	}
	durations[seg.id] = durationOf(mp3);
	console.log(`✓ ${seg.id} ${durations[seg.id].toFixed(2)}s`);
}
writeFileSync(join(OUT, "durations.json"), JSON.stringify(durations, null, 2));
console.log(`\nWrote ${Object.keys(durations).length} narration clips → ${AUDIO}`);
console.log(`Total narration: ${Object.values(durations).reduce((a, b) => a + b, 0).toFixed(1)}s`);
