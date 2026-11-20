const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '32kb' }));
const PORT = process.env.PORT || 3000;
const YTDLP = process.env.YTDLP_PATH || 'python3';
const MAX_RUNTIME_MS = 10 * 60 * 1000;
const active = new Set();

app.get('/', (_req, res) => res.json({ app: 'Social Hub Server', status: 'online' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

function normalizeYouTubeUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('Invalid video URL');
  let u;
  try { u = new URL(raw.trim()); } catch { throw new Error('Please enter a valid YouTube URL'); }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) {
    throw new Error('Only YouTube video links are supported');
  }
  if (u.protocol !== 'https:') throw new Error('Use a secure https YouTube link');
  let id = '';
  if (host === 'youtu.be') id = u.pathname.split('/').filter(Boolean)[0] || '';
  else if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
  else if (/^\/(shorts|embed|live)\//.test(u.pathname)) id = u.pathname.split('/')[2] || '';
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('Could not find a valid YouTube video ID');
  return `https://www.youtube.com/watch?v=${id}`;
}
function runYtDlp(args, timeout = MAX_RUNTIME_MS) {
  return new Promise((resolve, reject) => {
    const commandArgs = YTDLP === 'python3' ? ['-m', 'yt_dlp', ...args] : args;
    const child = spawn(YTDLP, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    active.add(child);
    let stdout = '', stderr = '', settled = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', d => { stdout += d.toString(); if (stdout.length > 8 * 1024 * 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024); });
    child.on('error', e => { if (!settled) { settled = true; clearTimeout(timer); active.delete(child); reject(e); } });
    child.on('close', code => {
      if (settled) return; settled = true; clearTimeout(timer); active.delete(child);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.includes('not found') ? 'Downloader is not installed on the server' : (stderr.trim().slice(-1200) || `yt-dlp exited with code ${code}`)));
    });
  });
}
function safeError(err) {
  const s = String(err && err.message || err);
  if (/private video|members-only|sign in|age-restricted|unavailable|not available/i.test(s)) return 'This video is unavailable to the server (private, age/region restricted, or sign-in required).';
  if (/ffmpeg/i.test(s)) return 'The server media converter (FFmpeg) is not installed.';
  if (/not found/i.test(s)) return 'The server downloader is not installed yet.';
  return s.slice(0, 700);
}

app.get('/api/info', async (req, res) => {
  try {
    const url = normalizeYouTubeUrl(req.query.url);
    const { stdout } = await runYtDlp(['--dump-single-json', '--skip-download', '--no-warnings', '--no-playlist', url], 90000);
    const info = JSON.parse(stdout);
    const heights = [...new Set((info.formats || []).filter(f => f.vcodec && f.vcodec !== 'none' && Number(f.height) > 0).map(f => Number(f.height)))].sort((a,b) => b-a);
    if (!heights.length) throw new Error('No downloadable video formats were found for this video');
    res.json({ ok: true, id: info.id, title: info.title || 'YouTube video', thumbnail: info.thumbnail || '', duration: info.duration || 0, heights });
  } catch (e) { res.status(400).json({ ok: false, error: safeError(e) }); }
});

app.get('/api/download', async (req, res) => {
  let file = null;
  try {
    const url = normalizeYouTubeUrl(req.query.url);
    const height = Number(req.query.height);
    const audioOnly = req.query.audio === '1';
    if (!audioOnly && (!Number.isInteger(height) || height < 144 || height > 4320)) throw new Error('Choose a valid video resolution');
    if (active.size >= 2) return res.status(429).json({ ok: false, error: 'The server is busy. Try again in a moment.' });
    const id = crypto.randomBytes(8).toString('hex');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socialhub-'));
    file = path.join(dir, id + (audioOnly ? '.mp3' : '.mp4'));
    const format = audioOnly ? 'bestaudio/best' : `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`;
    const args = ['--no-playlist', '--no-warnings', '--no-part', '-f', format, '-o', file];
    if (audioOnly) args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    else args.push('--merge-output-format', 'mp4');
    args.push(url);
    await runYtDlp(args);
    if (!fs.existsSync(file)) throw new Error('The server did not create the output file');
    const stat = fs.statSync(file);
    if (stat.size > 500 * 1024 * 1024) throw new Error('This file exceeds the 500 MB server download limit');
    const base = (audioOnly ? 'socialhub-audio-' : `socialhub-${height}p-`) + id + (audioOnly ? '.mp3' : '.mp4');
    res.setHeader('Content-Type', audioOnly ? 'audio/mpeg' : 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="${base}"`);
    const stream = fs.createReadStream(file);
    stream.pipe(res);
    stream.on('close', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  } catch (e) {
    if (!res.headersSent) res.status(400).json({ ok: false, error: safeError(e) });
    if (file) { try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch {} }
  }
});

process.on('SIGTERM', () => { for (const p of active) p.kill('SIGTERM'); process.exit(0); });
app.listen(PORT, '0.0.0.0', () => console.log(`Social Hub Server running on ${PORT}`));
