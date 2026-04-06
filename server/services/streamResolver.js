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

// Extensions the browser <video> tag can play natively without remuxing
const NATIVE_EXTS = ['.mp4', '.webm', '.mov', '.m3u8'];

function isNativePlayable(url) {
    if (!url) return false;
    const lower = url.toLowerCase().split('?')[0];
    return NATIVE_EXTS.some(ext => lower.endsWith(ext));
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

        // Natively playable (MP4, WebM) — return direct URL
        if (isNativePlayable(stream.url)) return stream;

        // MKV or unknown container — route through server-side FFmpeg remux proxy
        console.log(`[StreamResolver] remuxing via proxy: ${stream.url.split('/').pop()}`);
        const proxyUrl = `/api/proxy/stream?url=${encodeURIComponent(stream.url)}`;
        return { ...stream, url: proxyUrl, mimeType: 'mp4' };
    } catch (err) {
        console.error('[StreamResolver]', err.message);
        return null;
    }
}

module.exports = { resolve };
