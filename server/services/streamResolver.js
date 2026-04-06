/**
 * StreamResolver
 *
 * Resolves a direct HTTPS stream URL for a given piece of content.
 *
 * Flow:
 *  1. Convert TMDB ID → IMDb ID (cached in TMDBService)
 *  2. Call Jackettio → Real-Debrid → direct HTTPS URL
 *  3. Return StreamResult or null (caller falls back to iframe)
 *
 * StreamResult: { success, url, mimeType, name, provider, allStreams[] }
 */

const JackettioProvider = require('./providers/jackettio');
const TMDBService = require('../api/tmdb');

const jackettio = new JackettioProvider();
const tmdb      = new TMDBService();

const RD_KEY = process.env.REALDEBRID_API_KEY || '';

// Extensions the browser <video> tag can play natively
const NATIVE_EXTS = ['.mp4', '.webm', '.mov', '.m3u8'];

function isNativePlayable(url) {
    if (!url) return false;
    const lower = url.toLowerCase().split('?')[0];
    return NATIVE_EXTS.some(ext => lower.endsWith(ext));
}

async function getTranscodeUrl(directUrl) {
    if (!RD_KEY) return null;
    try {
        // Re-unrestrict the RD link to get the file ID, then fetch transcode streams
        const unres = await fetch('https://api.real-debrid.com/rest/1.0/unrestrict/link', {
            method:  'POST',
            headers: { Authorization: `Bearer ${RD_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body:    `link=${encodeURIComponent(directUrl)}`,
            signal:  AbortSignal.timeout(10000),
        });
        if (!unres.ok) return null;
        const { id } = await unres.json();
        if (!id) return null;

        const trans = await fetch(`https://api.real-debrid.com/rest/1.0/streaming/transcode/${id}`, {
            headers: { Authorization: `Bearer ${RD_KEY}` },
            signal:  AbortSignal.timeout(10000),
        });
        if (!trans.ok) return null;
        const data = await trans.json();

        // RD returns { apple: { full: url }, dash: { full: url }, ... } — prefer apple (HLS)
        const hlsUrl = data?.apple?.full || data?.hls?.full;
        return hlsUrl || null;
    } catch {
        return null;
    }
}

async function resolve(content) {
    if (!content?.tmdbId) return null;

    try {
        const ext    = await tmdb.getExternalIds(content.tmdbId, content.type === 'movie' ? 'movie' : 'tv');
        const imdbId = ext?.imdb_id;

        if (!imdbId) {
            console.error(`[StreamResolver] No IMDb ID for TMDB ${content.tmdbId}`);
            return null;
        }

        const stream = await jackettio.getStream({ ...content, imdbId });
        if (!stream) return null;

        // If the best stream is natively playable, return as-is
        if (isNativePlayable(stream.url)) return stream;

        // MKV or unknown — try RD transcode to HLS
        console.log(`[StreamResolver] ${stream.url.split('/').pop()} is not natively playable — requesting RD transcode`);
        const hlsUrl = await getTranscodeUrl(stream.url);
        if (hlsUrl) {
            return { ...stream, url: hlsUrl, mimeType: 'hls' };
        }

        // Transcode unavailable — return original and let the player handle fallback
        return stream;
    } catch (err) {
        console.error('[StreamResolver]', err.message);
        return null;
    }
}

module.exports = { resolve };
