const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '32kb' }));
const PORT = process.env.PORT || 3000;

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
  return { id, url: `https://www.youtube.com/watch?v=${id}` };
}

// YouTube oEmbed is used only for public video metadata. It does not expose
// downloadable media streams or bypass YouTube's download/access controls.
app.get('/api/info', async (req, res) => {
  try {
    const video = normalizeYouTubeUrl(req.query.url);
    const endpoint = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(video.url)}`;
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) {
      return res.status(200).json({
        ok: true, id: video.id, title: 'YouTube video', thumbnail: '', duration: 0,
        heights: [], downloadAvailable: false,
        message: 'Video details are unavailable. YouTube does not provide a supported direct download for this link.'
      });
    }
    const info = await response.json();
    return res.json({
      ok: true, id: video.id, title: info.title || 'YouTube video',
      author: info.author_name || '', thumbnail: info.thumbnail_url || '', duration: 0,
      heights: [], downloadAvailable: false,
      message: 'YouTube does not provide a supported direct download for this video. Use YouTube’s official Download feature where available, or a creator-provided download link.'
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: String(error.message || error).slice(0, 500) });
  }
});

// Deliberately do not proxy or extract YouTube media streams. The Android
// Download Manager downloads authorized direct media URLs supplied by users.
app.get('/api/download', (_req, res) => {
  res.status(403).json({
    ok: false,
    error: 'YouTube direct downloading is unavailable. Use the official YouTube Download feature where available, or provide an authorized direct media-file link.'
  });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Social Hub Server running on ${PORT}`));
