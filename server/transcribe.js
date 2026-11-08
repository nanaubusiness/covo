import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSettings } from './config.js';

// Voice → text with Whisper running on this computer (whisper.cpp + ffmpeg). Much more accurate
// than the browser's speech recognition, works in any language, and the audio never leaves your Mac.
const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, timeout: 180_000, ...opts }, (e, stdout, stderr) => (e ? reject(Object.assign(e, { stderr })) : resolve(stdout)));
});
const BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
const which = (name) => BIN_DIRS.map((d) => path.join(d, name)).find((p) => fs.existsSync(p));
const MODELS = ['ggml-large-v3-turbo-q5_0.bin', 'ggml-large-v3-turbo.bin', 'ggml-large-v3.bin', 'ggml-medium.bin', 'ggml-small.bin', 'ggml-base.en.bin'];
function modelPath() {
  const s = getSettings().voice || {};
  if (s.whisperModel && fs.existsSync(s.whisperModel)) return s.whisperModel;
  const dir = path.join(os.homedir(), '.cache', 'whisper');
  return MODELS.map((m) => path.join(dir, m)).find((p) => fs.existsSync(p)) || null;
}

export function transcribeAvailable() {
  return !!(which('whisper-cli') && which('ffmpeg') && modelPath());
}

export async function transcribe(buf, { language } = {}) {
  const whisper = which('whisper-cli'), ffmpeg = which('ffmpeg'), model = modelPath();
  if (!whisper || !ffmpeg || !model) throw Object.assign(new Error('Whisper is not installed on this computer'), { status: 501 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'covo-voice-'));
  try {
    const src = path.join(dir, 'in'), wav = path.join(dir, 'in.wav');
    fs.writeFileSync(src, buf);
    await run(ffmpeg, ['-nostdin', '-loglevel', 'error', '-y', '-i', src, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    const s = getSettings();
    // Names Whisper should spell right (it uses this as context, not as text to output).
    const vocab = [s.agent?.name || 'Duet', 'Lessicon', 'TikTok', 'YouTube Shorts', 'Instagram', 'Threads', 'Claude', s.profile?.name].filter(Boolean).join(', ');
    const lang = language || (s.profile?.language === 'ar' ? 'ar' : 'auto');
    const out = await run(whisper, ['-m', model, '-f', wav, '-l', lang, '-nt', '-np', '-t', String(Math.max(4, os.cpus().length - 2)), '--prompt', `${vocab}.`]);
    return out.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
