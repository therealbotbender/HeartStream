/**
 * Jackettio Provider
 *
 * Self-hosted Node.js addon that queries Jackett torrent indexers
 * and converts cached results via Real-Debrid into direct HTTPS stream URLs.
 *
 * GitHub: https://github.com/arvida42/jackettio
 *
 * Environment vars:
 *   JACKETTIO_URL        — base URL of your Jackettio instance (default: http://jackettio:4000)
 *   REALDEBRID_API_KEY   — your Real-Debrid API key
 *   JACKETTIO_INDEXERS   — comma-separated indexer IDs (default: thepiratebay,yts,eztv,therarbg)
 *   JACKETTIO_QUALITIES  — comma-separated quality values in px (default: 720,1080,2160)
 */

const BASE_URL          = (process.env.JACKETTIO_URL          || 'http://jackettio:4000').replace(/\/$/, '');
const RD_KEY            = process.env.REALDEBRID_API_KEY      || '';
const MEDIAFLOW_URL     = process.env.MEDIAFLOW_PUBLIC_URL    || '';
const MEDIAFLOW_PASSWORD = process.env.MEDIAFLOW_API_PASSWORD || 'heartstream';

const INDEXERS  = (process.env.JACKETTIO_INDEXERS  || 'thepiratebay,yts,eztv,therarbg').split(',');
const QUALITIES = (process.env.JACKETTIO_QUALITIES || '720,1080,2160').split(',').map(Number);

// Comma-separated name/hash fragments to permanently exclude from results.
// Useful when an indexer has a torrent mislabeled under the wrong IMDB ID.
// e.g. JACKETTIO_BLACKLIST=Star.Wars.Maul.Shadow.Lord,b6318f2df1c3310f31ce519a7feed1dd26ebbde6
const BLACKLIST = (process.env.JACKETTIO_BLACKLIST || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// Quality preference for ranking (lower index = preferred)
const QUALITY_RANK = [2160, 1080, 720, 480, 360];

// In-memory stream cache — avoids re-searching Jackettio for the same content
// within a short window (RD cached links stay valid for hours).
const streamCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cacheKey(content) {
    return `${content.imdbId}:${content.type}:${content.seasonNumber || ''}:${content.episodeNumber || ''}`;
}

function getCached(content) {
    const entry = streamCache.get(cacheKey(content));
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) { streamCache.delete(cacheKey(content)); return null; }
    return entry.value;
}

function setCached(content, value) {
    streamCache.set(cacheKey(content), { value, ts: Date.now() });
}

// Build the base64 config blob once at startup — Jackettio reads it from the URL path
function buildConfig() {
    return Buffer.from(JSON.stringify({
        debridId:               'realdebrid',
        debridApiKey:           RD_KEY,
        indexers:               INDEXERS,
        qualities:              QUALITIES,
        maxTorrents:            5,
        sortCached:             [['quality', true], ['size', true]],
        sortUncached:           [['seeders', true]],
        hideUncached:           false,
        priotizePackTorrents:   2,
        forceCacheNextEpisode:  true,
        indexerTimeoutSec:      8,
        metaLanguage:           '',
        enableMediaFlow:        !!MEDIAFLOW_URL,
        mediaflowProxyUrl:      MEDIAFLOW_URL,
        mediaflowApiPassword:   MEDIAFLOW_PASSWORD,
        mediaflowPublicIp:      '',
    })).toString('base64');
}

const CONFIG = buildConfig();

// MP4-likely sources (browser-native, no transcode needed)
const MP4_HINTS = ['yts', 'webrip', 'web-dl', 'webdl', 'web.dl', 'amzn', 'nf', 'hulu', '.mp4'];

function isMp4Likely(stream) {
    const text = ((stream.name || '') + ' ' + (stream.url || '')).toLowerCase();
    return MP4_HINTS.some(h => text.includes(h));
}

function rankStream(stream) {
    const name = (stream.name || stream.description || '').toLowerCase();
    let qualityScore = QUALITY_RANK.length;
    for (let i = 0; i < QUALITY_RANK.length; i++) {
        if (name.includes(`${QUALITY_RANK[i]}p`)) { qualityScore = i; break; }
    }
    // MP4-likely releases get a bonus — prefer them over same-quality MKV
    const formatBonus = isMp4Likely(stream) ? 0 : 0.5;
    return qualityScore + formatBonus;
}

class JackettioProvider {
    async getStream(content) {
        if (!RD_KEY) throw new Error('REALDEBRID_API_KEY is not set');

        const { imdbId, type } = content;
        if (!imdbId) throw new Error('imdbId is required — convert TMDB ID first');

        const cached = getCached(content);
        if (cached) { console.log('[Jackettio] cache hit'); return cached; }

        const stremioType = type === 'movie' ? 'movie' : 'series';
        const idSegment   = type === 'movie'
            ? imdbId
            : `${imdbId}:${content.seasonNumber || 1}:${content.episodeNumber || 1}`;

        const url = `${BASE_URL}/${CONFIG}/stream/${stremioType}/${idSegment}.json`;
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`Jackettio responded ${res.status}`);

        const { streams = [] } = await res.json();

        // Jackettio builds its download URLs from the incoming request host, which
        // may resolve to the wrong scheme/port inside Docker. Normalize them to the
        // correct internal address so our proxy (and FFmpeg) can reach them.
        const fixUrl = u => u ? u.replace(/^https?:\/\/jackettio(:\d+)?\//i, `${BASE_URL}/`) : u;

        const direct = streams
            .filter(s => s.url?.startsWith('http'))
            .map(s => ({ ...s, url: fixUrl(s.url) }))
            .filter(s => {
                if (!BLACKLIST.length) return true;
                const haystack = ((s.name || '') + ' ' + (s.url || '')).toLowerCase();
                const blocked = BLACKLIST.find(b => haystack.includes(b));
                if (blocked) console.log(`[Jackettio] blacklisted stream: ${s.name} (matched "${blocked}")`);
                return !blocked;
            });

        if (!direct.length) return null;

        direct.sort((a, b) => rankStream(a) - rankStream(b));
        const best = direct[0];

        const result = {
            success:    true,
            url:        best.url,
            mimeType:   best.url.endsWith('.m3u8') ? 'hls' : 'mp4',
            name:       best.name || best.description || 'Direct Stream',
            provider:   'jackettio',
            allStreams:  direct.map(s => ({ url: s.url, name: s.name || s.description || '' }))
        };
        setCached(content, result);
        return result;
    }
}

module.exports = JackettioProvider;
