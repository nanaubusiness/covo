import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSettings } from './config.js';

// Text → speech with the Mac's own voices (say + ffmpeg → MP3), so voice mode sounds the same on
// every device instead of depending on the phone's built-in voice.
const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 120_000 }, (e) => (e ? reject(e) : resolve())));
const FFMPEG = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find((p) => fs.existsSync(p));
export const speakAvailable = () => process.platform === 'darwin' && !!FFMPEG;

export function plainForSpeech(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'the link')
    .replace(/^[\s>*-]+/gm, '')
    .replace(/[*_`#|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function speak(text) {
  const clean = plainForSpeech(text).slice(0, 4000);
  if (!clean) throw Object.assign(new Error('Nothing to say'), { status: 400 });
  const v = getSettings().voice || {};
  const arabic = /[؀-ۿ]/.test(clean);
  const voice = arabic ? v.arabicVoice || 'Majed' : v.englishVoice || 'Samantha';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'covo-say-'));
  try {
    const txt = path.join(dir, 'in.txt'), aiff = path.join(dir, 'out.aiff'), mp3 = path.join(dir, 'out.mp3');
    fs.writeFileSync(txt, clean);
    await run('say', ['-v', voice, '-r', String(v.rate || 190), '-f', txt, '-o', aiff]);
    await run(FFMPEG, ['-nostdin', '-loglevel', 'error', '-y', '-i', aiff, '-ac', '1', '-b:a', '64k', mp3]);
    return fs.readFileSync(mp3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
