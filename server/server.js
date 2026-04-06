const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const express = require('express');
const { spawn } = require('child_process');
const db = require('./database');
const ContentService = require('./api/contentService');
const streamResolver = require('./services/streamResolver');
const anilist = require('./api/anilist');

const app = express();
const PORT = process.env.PORT || 3000;
const content = new ContentService();

db.initDatabase();

app.use(express.json());
app.use((req, res, next) => {
    if (req.url.startsWith('/api')) process.stdout.write(`${new Date().toISOString().slice(11,19)} ${req.method} ${req.url}\n`);
    next();
});
app.use(express.static(path.join(__dirname, '../web-app-public')));

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Content ──────────────────────────────────────────────────────────────────

app.get('/api/content/trending', async (req, res) => {
    try {
        res.json(await content.getTrendingContent());
    } catch (err) {
        console.error('/api/content/trending', err.message);
        res.status(500).json({ error: 'Failed to fetch trending content' });
    }
});

app.get('/api/content/movies', async (req, res) => {
    try {
        const { page = 1, genre, sort_by = 'popular', keyword, exclude_keyword, language } = req.query;
        res.json(await content.getMovies(
            parseInt(page), genre || null, sort_by,
            false, keyword || null, exclude_keyword || null, language || null
        ));
    } catch (err) {
        console.error('/api/content/movies', err.message);
        res.status(500).json({ error: 'Failed to fetch movies' });
    }
});

app.get('/api/content/tv-shows', async (req, res) => {
    try {
        const { page = 1, genre, sort_by = 'popular', keyword, exclude_keyword, language } = req.query;
        res.json(await content.getTVShows(
            parseInt(page), genre || null, sort_by,
            false, keyword || null, exclude_keyword || null, language || null
        ));
    } catch (err) {
        console.error('/api/content/tv-shows', err.message);
        res.status(500).json({ error: 'Failed to fetch TV shows' });
    }
});

app.get('/api/content/details/:type/:id', async (req, res) => {
    try {
        const data = await content.getContentDetails(req.params.id, req.params.type);
        if (!data) return res.status(404).json({ error: 'Content not found' });
        res.json(data);
    } catch (err) {
        console.error('/api/content/details', err.message);
        res.status(500).json({ error: 'Failed to fetch content details' });
    }
});

app.get('/api/content/episodes/:tvId/:season', async (req, res) => {
    try {
        res.json(await content.getTVEpisodes(req.params.tvId, parseInt(req.params.season)));
    } catch (err) {
        console.error('/api/content/episodes', err.message);
        res.status(500).json({ error: 'Failed to fetch episodes' });
    }
});

app.get('/api/content/search', async (req, res) => {
    try {
        const { q, page = 1 } = req.query;
        if (!q) return res.status(400).json({ error: 'Missing query parameter q' });
        res.json(await content.searchContent(q, parseInt(page)));
    } catch (err) {
        console.error('/api/content/search', err.message);
        res.status(500).json({ error: 'Search failed' });
    }
});

app.get('/api/content/genres', async (req, res) => {
    try {
        res.json(await content.getGenres());
    } catch (err) {
        console.error('/api/content/genres', err.message);
        res.status(500).json({ error: 'Failed to fetch genres' });
    }
});

// ── Anime (AniList) ───────────────────────────────────────────────────────────

app.get('/api/anime/airing', async (req, res) => {
    try { res.json(await anilist.getAiring(parseInt(req.query.page) || 1)); }
    catch (err) { console.error('/api/anime/airing', err.message); res.status(500).json([]); }
});

app.get('/api/anime/season', async (req, res) => {
    try {
        const { season, year } = anilist.getCurrentSeason();
        res.json(await anilist.getSeason(season, year, parseInt(req.query.page) || 1));
    } catch (err) { console.error('/api/anime/season', err.message); res.status(500).json([]); }
});

app.get('/api/anime/top', async (req, res) => {
    try { res.json(await anilist.getTop(parseInt(req.query.page) || 1)); }
    catch (err) { console.error('/api/anime/top', err.message); res.status(500).json([]); }
});

app.get('/api/anime/genre/:genre', async (req, res) => {
    try { res.json(await anilist.getByGenre(req.params.genre, parseInt(req.query.page) || 1)); }
    catch (err) { console.error('/api/anime/genre', err.message); res.status(500).json([]); }
});

app.get('/api/anime/tag/:tag', async (req, res) => {
    try { res.json(await anilist.getByTag(req.params.tag, parseInt(req.query.page) || 1)); }
    catch (err) { console.error('/api/anime/tag', err.message); res.status(500).json([]); }
});

// ── Streams ──────────────────────────────────────────────────────────────────

app.get('/api/stream/:type/:tmdbId/:season?/:episode?', async (req, res) => {
    const { type, tmdbId, season, episode } = req.params;

    if (!['movie', 'tv'].includes(type))
        return res.status(400).json({ error: 'type must be movie or tv' });
    if (type === 'tv' && (!season || !episode))
        return res.status(400).json({ error: 'TV streams require season and episode params' });

    const contentObj = {
        type, tmdbId,
        ...(type === 'tv' && { seasonNumber: parseInt(season), episodeNumber: parseInt(episode) })
    };

    const stream = await streamResolver.resolve(contentObj);
    if (stream) return res.json(stream);

    // AIOStreams had nothing — return iframe fallback URLs
    const fallbackSources = content.generateVideoSources(
        type, tmdbId,
        season  ? parseInt(season)  : null,
        episode ? parseInt(episode) : null
    );
    return res.json({ success: false, fallback: true, sources: fallbackSources });
});

// ── MediaFlow internal proxy ──────────────────────────────────────────────────
// Forwards /api/mf/* → internal MediaFlow, keeping MediaFlow off the public
// internet. HLS manifests are rewritten so segment URLs also route through here.

const MEDIAFLOW_INTERNAL = (process.env.MEDIAFLOW_INTERNAL_URL || 'http://mediaflow:8888').replace(/\/$/, '');

app.use('/api/mf', async (req, res) => {
    const target = MEDIAFLOW_INTERNAL + req.url;
    try {
        const headers = {};
        if (req.headers.range) headers['range'] = req.headers.range;

        const upstream = await fetch(target, { method: req.method, headers,
            signal: AbortSignal.timeout(30000) });

        res.status(upstream.status);
        const ct = upstream.headers.get('content-type') || '';
        res.setHeader('Content-Type', ct);
        ['content-range', 'accept-ranges', 'cache-control'].forEach(h => {
            const v = upstream.headers.get(h);
            if (v) res.setHeader(h, v);
        });

        if (req.method === 'HEAD') return res.end();

        // Rewrite absolute internal MediaFlow URLs → /api/mf/... so all HLS
        // segment requests also come through this proxy.
        if (ct.includes('mpegurl') || req.url.includes('.m3u8')) {
            const body = (await upstream.text()).replaceAll(MEDIAFLOW_INTERNAL, '/api/mf');
            return res.send(body);
        }

        upstream.body.pipe(res);
    } catch (err) {
        console.error('[MF proxy]', err.message);
        if (!res.headersSent) res.status(502).end();
    }
});

// ── FFmpeg remux proxy ────────────────────────────────────────────────────────
// Remuxes any container (MKV, etc.) to fragmented MP4 on-the-fly so the
// browser <video> tag can play it. Video is stream-copied (no re-encode);
// audio is transcoded to AAC only if needed. Near-zero CPU.

app.get('/api/proxy/stream', (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).end();

    let parsed;
    try { parsed = new URL(url); } catch { return res.status(400).end(); }

    // Only proxy trusted sources: Real-Debrid links and internal Jackettio download URLs
    const host = parsed.hostname.toLowerCase();
    const allowed = host === 'jackettio' || host.endsWith('.real-debrid.com') || host.endsWith('.debrid.it');
    if (!allowed) {
        return res.status(403).json({ error: 'URL not allowed' });
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');

    const ff = spawn('ffmpeg', [
        '-loglevel', 'error',
        '-fflags', '+nobuffer+discardcorrupt',
        '-probesize', '32768',       // don't analyse more than 32KB before starting
        '-analyzeduration', '0',     // skip stream analysis — start output immediately
        '-i', url,
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-frag_duration', '500000',  // 500ms fragments — first bytes reach browser faster
        '-f', 'mp4',
        'pipe:1'
    ]);

    ff.stdout.pipe(res);
    ff.stderr.on('data', d => console.error('[FFmpeg]', d.toString().trim()));
    ff.on('error', err => {
        console.error('[FFmpeg] spawn error:', err.message);
        if (!res.headersSent) res.status(500).end();
    });

    req.on('close', () => ff.kill('SIGKILL'));
});

// ── Users ─────────────────────────────────────────────────────────────────────

app.get('/api/users', async (req, res) => {
    try {
        res.json(await db.getUsers());
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

app.post('/api/users', async (req, res) => {
    const { name, avatar, password } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    try {
        const userId = await db.createUser(name, avatar || null, 'default', password || null);
        res.status(201).json(await db.getUserById(userId));
    } catch (err) {
        res.status(500).json({ error: 'Failed to create user' });
    }
});

app.get('/api/users/:id', async (req, res) => {
    try {
        const user = await db.getUserById(parseInt(req.params.id));
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

app.put('/api/users/:id', async (req, res) => {
    try {
        const { name, avatar, theme } = req.body;
        await db.updateUser(parseInt(req.params.id), { name, avatar, theme });
        res.json(await db.getUserById(parseInt(req.params.id)));
    } catch (err) {
        res.status(500).json({ error: 'Failed to update user' });
    }
});

app.delete('/api/users/:id', async (req, res) => {
    try {
        await db.deleteUser(parseInt(req.params.id));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to delete user' });
    }
});

// ── Progress ──────────────────────────────────────────────────────────────────

app.get('/api/progress/:userId', async (req, res) => {
    try {
        res.json(await db.getUserProgress(parseInt(req.params.userId)));
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch progress' });
    }
});

app.get('/api/progress/:userId/:contentId', async (req, res) => {
    try {
        const { userId, contentId } = req.params;
        const { season, episode } = req.query;
        const result = await db.getUserProgress(
            parseInt(userId), contentId,
            season  ? parseInt(season)  : null,
            episode ? parseInt(episode) : null
        );
        res.json(result || {});
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch progress' });
    }
});

app.post('/api/progress', async (req, res) => {
    try {
        const { userId, contentId, contentType, seasonNumber, episodeNumber,
                progressTime, totalTime } = req.body;
        if (!userId || !contentId) return res.status(400).json({ error: 'userId and contentId are required' });
        await db.updateUserProgress(
            userId, contentId, progressTime || 0, contentType,
            totalTime || null, seasonNumber || null, episodeNumber || null
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save progress' });
    }
});

// ── Favorites ─────────────────────────────────────────────────────────────────

app.get('/api/favorites/:userId', async (req, res) => {
    try {
        res.json(await db.getUserFavorites(parseInt(req.params.userId)));
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch favorites' });
    }
});

app.post('/api/favorites', async (req, res) => {
    try {
        const { userId, contentId, contentType } = req.body;
        if (!userId || !contentId) return res.status(400).json({ error: 'userId and contentId are required' });
        await db.addToFavorites(userId, contentId, contentType);
        res.status(201).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to add favorite' });
    }
});

app.delete('/api/favorites/:userId/:contentId', async (req, res) => {
    try {
        await db.removeFromFavorites(parseInt(req.params.userId), req.params.contentId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to remove favorite' });
    }
});

// ── Continue Watching ─────────────────────────────────────────────────────────

app.get('/api/continue-watching/:userId', async (req, res) => {
    try {
        const rows = await db.getContinueWatching(parseInt(req.params.userId));

        // Enrich with TMDB title + poster (dedupe by content_id, batch fetch)
        const seen = new Set();
        const enriched = await Promise.all(
            rows
                .filter(r => { if (seen.has(r.content_id)) return false; seen.add(r.content_id); return true; })
                .map(async row => {
                    try {
                        const details = await content.getContentDetails(row.content_id, row.content_type);
                        return {
                            ...row,
                            title:  details?.title  || row.content_id,
                            poster: details?.poster  || null,
                        };
                    } catch {
                        return { ...row, title: row.content_id, poster: null };
                    }
                })
        );

        res.json(enriched);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch continue watching' });
    }
});

// ── SPA catch-all ─────────────────────────────────────────────────────────────

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../web-app-public/index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`HeartStream V2 running on http://localhost:${PORT}`);
    console.log(`Jackettio endpoint: ${process.env.JACKETTIO_URL || 'http://jackettio:4000'}`);
});
