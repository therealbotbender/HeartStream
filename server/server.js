const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const express = require('express');
const { spawn } = require('child_process');
const http = require('http');
const axios = require('axios');
const db = require('./database');
const ContentService = require('./api/contentService');
const TMDBService    = require('./api/tmdb');
const streamResolver = require('./services/streamResolver');
const anilist = require('./api/anilist');

const tmdb = new TMDBService();

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
        res.json(await content.getTrendingContent(req.query.timeWindow));
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
            keyword || null, exclude_keyword || null, language || null
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
            keyword || null, exclude_keyword || null, language || null
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

    return res.status(404).json({ success: false, error: 'No stream available for this title.' });
});

// ── MediaFlow internal proxy ──────────────────────────────────────────────────
// Forwards /api/mf/* → internal MediaFlow, keeping MediaFlow off the public
// internet. HLS manifests are rewritten so segment URLs also route through here.

const MEDIAFLOW_INTERNAL = (process.env.MEDIAFLOW_INTERNAL_URL || 'http://mediaflow:8888').replace(/\/$/, '');
const _mfUrl = new URL(MEDIAFLOW_INTERNAL);

app.use('/api/mf', (req, res) => {
    const opts = {
        hostname: _mfUrl.hostname,
        port:     _mfUrl.port || 80,
        path:     req.url,   // everything after /api/mf, including query string
        method:   req.method,
        headers:  {},
    };
    if (req.headers.range) opts.headers['range'] = req.headers.range;

    const proxy = http.request(opts, upstream => {
        const ct = upstream.headers['content-type'] || '';
        const isManifest = ct.includes('mpegurl') || req.url.includes('.m3u8');

        res.status(upstream.statusCode);
        ['content-type', 'content-range', 'accept-ranges', 'cache-control'].forEach(h => {
            if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
        });

        if (req.method === 'HEAD') return res.end();

        const cl = parseInt(upstream.headers['content-length'] || '0');
        const looksLikeManifest = isManifest && (cl === 0 || cl < 512 * 1024);

        if (looksLikeManifest) {
            // Buffer and rewrite internal MediaFlow URLs → /api/mf so all
            // segment requests also route through this proxy.
            // Use Buffer array (not string concat) to avoid max string length crash.
            const chunks = [];
            let size = 0;
            upstream.on('data', chunk => {
                size += chunk.length;
                if (size > 512 * 1024) {
                    // Unexpectedly large — not a real manifest, switch to piping
                    upstream.removeAllListeners('data');
                    upstream.removeAllListeners('end');
                    res.write(Buffer.concat(chunks));
                    upstream.pipe(res);
                    return;
                }
                chunks.push(chunk);
            });
            upstream.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                // Rewrite MediaFlow URLs → /api/mf/ proxy path.
                // Covers both absolute (https://host/proxy/) and relative (/proxy/) forms,
                // since transcode playlists use relative segment paths.
                res.send(body.replace(/(?:https?:\/\/[^/"'\s]+)?\/proxy\//g, '/api/mf/proxy/'));
            });
        } else {
            upstream.pipe(res);
        }
    });

    proxy.on('error', err => {
        console.error('[MF proxy]', err.message);
        if (!res.headersSent) res.status(502).end();
    });

    proxy.end();
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

// ── Playlists ─────────────────────────────────────────────────────────────────

app.get('/api/playlists/:userId', async (req, res) => {
    try { res.json(await db.getUserPlaylists(parseInt(req.params.userId))); }
    catch (err) { res.status(500).json({ error: 'Failed to fetch playlists' }); }
});

app.post('/api/playlists', async (req, res) => {
    const { userId, name, description } = req.body;
    if (!userId || !name) return res.status(400).json({ error: 'userId and name required' });
    try {
        const id = await db.createPlaylist(userId, name, description || null);
        res.status(201).json({ id, name, description: description || null, item_count: 0 });
    } catch (err) { res.status(500).json({ error: 'Failed to create playlist' }); }
});

app.put('/api/playlists/:id', async (req, res) => {
    const { name, description } = req.body;
    try {
        await db.updatePlaylist(parseInt(req.params.id), name, description || null);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to update playlist' }); }
});

app.delete('/api/playlists/:id', async (req, res) => {
    try {
        await db.deletePlaylist(parseInt(req.params.id));
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to delete playlist' }); }
});

app.get('/api/playlists/:id/items', async (req, res) => {
    try {
        const items = await db.getPlaylistItems(parseInt(req.params.id));
        const enriched = await Promise.all(items.map(async item => {
            try {
                const details = await content.getContentDetails(item.content_id, item.content_type);
                return { ...item, title: details?.title || item.content_id, poster: details?.poster || null };
            } catch { return { ...item, title: item.content_id, poster: null }; }
        }));
        res.json(enriched);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch playlist items' }); }
});

app.post('/api/playlists/:id/items', async (req, res) => {
    const { contentId, contentType } = req.body;
    if (!contentId || !contentType) return res.status(400).json({ error: 'contentId and contentType required' });
    try {
        await db.addToPlaylist(parseInt(req.params.id), contentId, contentType);
        res.status(201).json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to add to playlist' }); }
});

app.delete('/api/playlists/:id/items/:contentId', async (req, res) => {
    try {
        await db.removeFromPlaylist(parseInt(req.params.id), decodeURIComponent(req.params.contentId));
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to remove from playlist' }); }
});

// ── Intro times ───────────────────────────────────────────────────────────────

app.get('/api/intro/:contentId', async (req, res) => {
    try {
        const contentId = decodeURIComponent(req.params.contentId);
        const season    = req.query.season  ? parseInt(req.query.season)  : null;
        const episode   = req.query.episode ? parseInt(req.query.episode) : null;
        const tmdbId    = req.query.tmdbId  ? parseInt(req.query.tmdbId)  : null;
        const type      = req.query.type    || 'tv';

        // 1. Persistent cache
        const cached = await db.getCachedIntroData(contentId, season, episode);
        if (cached) return res.json({
            intro_start:  cached.intro_start,
            intro_end:    cached.intro_end,
            ending_start: cached.ending_start ?? null,
            ending_end:   cached.ending_end   ?? null,
            source:       cached.source
        });

        // 2. Community submissions
        const sub = await db.getUserIntroSubmissions(contentId, season, episode);
        if (sub) return res.json({ intro_start: sub.intro_start, intro_end: sub.intro_end, ending_start: null, ending_end: null, source: 'community' });

        // Helper: cache result and send response
        const cacheAndReturn = async (result, source) => {
            if (result.intro_start != null) {
                await db.setCachedIntroData(
                    contentId, season, episode,
                    result.intro_start, result.intro_end,
                    source, 0.9, null, 168,
                    result.ending_start ?? null, result.ending_end ?? null
                ).catch(() => {});
            }
            return res.json({ ...result, source });
        };

        // 3. TheIntroDB — TMDB-native, covers intro/recap/credits/preview (reads are public)
        if (tmdbId && season != null && episode != null) {
            try {
                const headers = process.env.TIDB_TOKEN
                    ? { Authorization: `Bearer ${process.env.TIDB_TOKEN}` }
                    : {};
                const tidbRes = await axios.get(
                    `https://api.theintrodb.org/v2/media?tmdb_id=${tmdbId}&season=${season}&episode=${episode}`,
                    { headers, timeout: 5000 }
                );
                if (tidbRes.status === 200 && tidbRes.data) {
                    const d       = tidbRes.data;
                    // response fields may be objects or single-element arrays
                    const intro   = Array.isArray(d.intro)   ? d.intro[0]   : d.intro;
                    const credits = Array.isArray(d.credits) ? d.credits[0] : d.credits;
                    if (intro?.start_ms != null) {
                        return cacheAndReturn({
                            intro_start:  Math.floor(intro.start_ms   / 1000),
                            intro_end:    Math.floor(intro.end_ms     / 1000),
                            ending_start: credits ? Math.floor(credits.start_ms / 1000) : null,
                            ending_end:   credits ? Math.floor(credits.end_ms   / 1000) : null,
                        }, 'tidb');
                    }
                }
            } catch (e) { /* unavailable — try next */ }
        }

        // 4. IntroDB — no auth, IMDb ID, covers intro + outro
        if (tmdbId && season != null && episode != null) {
            try {
                const extIds = await tmdb.getExternalIds(tmdbId, type);
                const imdbId = extIds?.imdb_id;
                if (imdbId) {
                    const idbRes = await axios.get(
                        `https://api.introdb.app/segments?imdb_id=${imdbId}&season=${season}&episode=${episode}`,
                        { timeout: 5000 }
                    );
                    if (idbRes.status === 200 && idbRes.data?.intro) {
                        const d = idbRes.data;
                        return cacheAndReturn({
                            intro_start:  d.intro.start_sec,
                            intro_end:    d.intro.end_sec,
                            ending_start: d.outro?.start_sec ?? null,
                            ending_end:   d.outro?.end_sec   ?? null,
                        }, 'introdb');
                    }
                }
            } catch (e) { /* unavailable — try next */ }
        }

        // 5. AniSkip — anime only, MAL ID via ARM mapping
        if (tmdbId && episode != null) {
            try {
                const armRes = await axios.get(`https://arm.haglund.dev/api/v2/ids?source=tmdb&id=${tmdbId}`, { timeout: 5000 });
                const malId  = armRes.data?.myanimelist;
                if (malId) {
                    const skipRes = await axios.get(
                        `https://api.aniskip.com/v2/skip-times/${malId}/${episode}?types=op&types=ed`,
                        { timeout: 5000 }
                    );
                    if (skipRes.data?.found) {
                        const op = skipRes.data.results.find(r => r.skipType === 'op');
                        const ed = skipRes.data.results.find(r => r.skipType === 'ed');
                        if (op) {
                            return cacheAndReturn({
                                intro_start:  Math.floor(op.interval.startTime),
                                intro_end:    Math.floor(op.interval.endTime),
                                ending_start: ed ? Math.floor(ed.interval.startTime) : null,
                                ending_end:   ed ? Math.floor(ed.interval.endTime)   : null,
                            }, 'aniskip');
                        }
                    }
                }
            } catch (e) { /* unavailable */ }
        }

        res.json(null);
    } catch (err) {
        console.error('/api/intro GET', err.message);
        res.status(500).json({ error: 'Failed to fetch intro data' });
    }
});

app.post('/api/intro', async (req, res) => {
    try {
        const { userId, contentId, seasonNumber, episodeNumber, introStart, introEnd } = req.body;
        if (!contentId || introStart == null || introEnd == null)
            return res.status(400).json({ error: 'contentId, introStart, introEnd required' });
        if (introEnd <= introStart)
            return res.status(400).json({ error: 'introEnd must be after introStart' });

        await db.submitIntroTimes(userId || null, contentId, seasonNumber || null, episodeNumber || null, introStart, introEnd);
        await db.setCachedIntroData(contentId, seasonNumber || null, episodeNumber || null, introStart, introEnd, 'user_submission', 0.7, null, 168);
        res.json({ success: true });
    } catch (err) {
        console.error('/api/intro POST', err.message);
        res.status(500).json({ error: 'Failed to submit intro times' });
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
