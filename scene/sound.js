// SPDX-FileCopyrightText: 2025 Teleport XR Ltd <contact@teleportxr.io>
//
// SPDX-License-Identifier: MIT
//
// Server-side audio streaming for scene "sound" components.
//
// Sound components are kept server-side: their PCM is mixed and pushed into
// an @roamhq/wrtc RTCAudioSource as 10 ms / 48 kHz / mono / int16 frames,
// which libwebrtc encodes to Opus on the outbound audio media track.
'use strict';
const fs = require('fs');

// Required output format for RTCAudioSource.onData.
const SAMPLE_RATE = 48000;
const CHANNEL_COUNT = 1;
const FRAME_MS = 10;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 480

// Parse a minimal RIFF/WAVE file. Returns { samples: Int16Array, sampleRate, channelCount }
// or throws on any unsupported variant (we only accept mono / 16-bit / 48 kHz).
function parseWav(buffer) {
	if (buffer.length < 44) throw new Error('WAV: file too short');
	if (buffer.toString('ascii', 0, 4) !== 'RIFF') throw new Error('WAV: missing RIFF header');
	if (buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('WAV: missing WAVE marker');
	let pos = 12;
	let fmt = null;
	let dataOffset = -1;
	let dataSize = 0;
	while (pos + 8 <= buffer.length) {
		const id = buffer.toString('ascii', pos, pos + 4);
		const size = buffer.readUInt32LE(pos + 4);
		const next = pos + 8 + size + (size & 1); // chunks are word-aligned
		if (id === 'fmt ') {
			fmt = {
				audioFormat: buffer.readUInt16LE(pos + 8),
				channels: buffer.readUInt16LE(pos + 10),
				sampleRate: buffer.readUInt32LE(pos + 12),
				bitsPerSample: buffer.readUInt16LE(pos + 22)
			};
		} else if (id === 'data') {
			dataOffset = pos + 8;
			dataSize = size;
			break;
		}
		pos = next;
	}
	if (!fmt) throw new Error('WAV: no fmt chunk');
	if (dataOffset < 0) throw new Error('WAV: no data chunk');
	if (fmt.audioFormat !== 1) throw new Error('WAV: only PCM (audioFormat=1) is supported, got '+fmt.audioFormat);
	if (fmt.channels !== CHANNEL_COUNT) throw new Error('WAV: only mono is supported, got channels='+fmt.channels);
	if (fmt.sampleRate !== SAMPLE_RATE) throw new Error('WAV: only '+SAMPLE_RATE+' Hz is supported, got '+fmt.sampleRate);
	if (fmt.bitsPerSample !== 16) throw new Error('WAV: only 16-bit PCM is supported, got bitsPerSample='+fmt.bitsPerSample);
	const numSamples = Math.floor(dataSize / 2);
	const samples = new Int16Array(numSamples);
	for (let i = 0; i < numSamples; i++) {
		samples[i] = buffer.readInt16LE(dataOffset + i * 2);
	}
	return { samples, sampleRate: fmt.sampleRate, channelCount: fmt.channels };
}

// One looping mono int16 PCM source. pull() writes FRAME_SAMPLES samples into
// the supplied Int32 accumulator (caller mixes; we just add).
class WavSource {
	constructor(filePath) {
		const buf = fs.readFileSync(filePath);
		const wav = parseWav(buf);
		this.samples = wav.samples;
		this.position = 0;
		this.filePath = filePath;
	}
	pull(accumulator) {
		const len = this.samples.length;
		if (len === 0) return;
		let pos = this.position;
		for (let i = 0; i < FRAME_SAMPLES; i++) {
			accumulator[i] += this.samples[pos];
			pos++;
			if (pos >= len) pos = 0;
		}
		this.position = pos;
	}
}

// SceneAudioStreamer mixes all active sources at 48 kHz mono int16 and
// pushes one 10 ms frame per tick into the supplied RTCAudioSource.
class SceneAudioStreamer {
	constructor(audioSource) {
		this.audioSource = audioSource;
		this.sources = []; // [{ url, source }]
		this.mixBuffer = new Int32Array(FRAME_SAMPLES);
		this.outputBuffer = new Int16Array(FRAME_SAMPLES);
		this.frame = {
			samples: this.outputBuffer,
			sampleRate: SAMPLE_RATE,
			bitsPerSample: 16,
			channelCount: CHANNEL_COUNT,
			numberOfFrames: FRAME_SAMPLES
		};
	}
	addSource(url, source) {
		this.sources.push({ url, source });
	}
	clear() {
		this.sources = [];
	}
	tick() {
		const mix = this.mixBuffer;
		mix.fill(0);
		for (const s of this.sources) {
			s.source.pull(mix);
		}
		// Clip to int16 range.
		const out = this.outputBuffer;
		for (let i = 0; i < FRAME_SAMPLES; i++) {
			let v = mix[i];
			if (v > 32767) v = 32767;
			else if (v < -32768) v = -32768;
			out[i] = v;
		}
		try {
			this.audioSource.onData(this.frame);
		} catch (e) {
			console.error('SceneAudioStreamer: onData failed: '+e.message);
		}
	}
}

module.exports = {
	SAMPLE_RATE,
	CHANNEL_COUNT,
	FRAME_MS,
	FRAME_SAMPLES,
	parseWav,
	WavSource,
	SceneAudioStreamer
};
