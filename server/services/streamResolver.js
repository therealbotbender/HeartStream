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
 * StreamResult: { success, url, mimeType, nativeUrl?, name, provider, allStreams[] }
 *
 * nativeUrl is included when the source is a non-native container (e.g. MKV).
 * Capable browsers (Chrome) can use nativeUrl directly, skipping transcode latency.
 * Incompatible browsers (Firefox) fall back to url (HLS transcode via MediaFlow).
 */

const JackettioProvider = require('./providers/jackettio');
const TMDBService = require('../api/tmdb');

const jackettio = new JackettioProvider();
const tmdb      = new TMDBService();

// Route MediaFlow URLs through the Node.js server's /api/mf proxy so the
// browser never needs to reach MediaFlow directly (avoids mixed-content and
// keeps MediaFlow off the public internet).
function toProxyUrl(url) {
    try {
        const u = new URL(url);
        return '/api/mf' + u.pathname + u.search;
    } catch {
        return url;
    }
}

// Follow Jackettio's redirect chain to get the actual RD CDN URL.
async function resolveRedirect(url) {
    try {
        const res = await fetch(url, {
            method:   'HEAD',
            redirect: 'manual',
            signal:   AbortSignal.timeout(10000),
        });
        if (res.status >= 300 && res.status < 400) {
            return res.headers.get('location') || url;
        }
        return res.url || url;
    } catch {
        return url;
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

        // MediaFlow URL — check if it needs upgrading to HLS transcoding
        if (stream.url.includes('/proxy/stream') || stream.url.includes('/proxy/hls/')) {
            let finalUrl = stream.url;
            let mimeType = 'hls';

            if (stream.url.includes('/proxy/stream')) {
                const targetParam = new URL(stream.url).searchParams.get('d') || '';
                const fileExt = targetParam.toLowerCase().split('?')[0].split('.').pop();
                const native = ['mp4', 'webm', 'mov'].includes(fileExt);

                if (native) {
                    mimeType = 'mp4';
                } else {
                    // Return both transcode URL (universal) and raw stream URL (capable browsers)
                    const transcodeUrl = stream.url.replace('/proxy/stream', '/proxy/transcode/playlist.m3u8');
                    console.log(`[StreamResolver] MediaFlow: upgrading ${fileExt} → HLS transcode (nativeUrl available)`);
                    return {
                        ...stream,
                        url:       toProxyUrl(transcodeUrl),
                        mimeType:  'hls',
                        nativeUrl: toProxyUrl(stream.url),
                    };
                }
            }

            return { ...stream, url: toProxyUrl(finalUrl), mimeType };
        }

        // Otherwise follow Jackettio → RD redirect to get the direct CDN URL
        const finalUrl = await resolveRedirect(stream.url);

        // Redirect may have resolved to a MediaFlow /proxy/stream URL — upgrade if needed
        if (finalUrl.includes('/proxy/stream')) {
            const targetParam = new URL(finalUrl).searchParams.get('d') || '';
            const resolvedExt = targetParam.toLowerCase().split('?')[0].split('.').pop();
            const native = ['mp4', 'webm', 'mov'].includes(resolvedExt);
            if (native) {
                console.log(`[StreamResolver] MediaFlow (via redirect): native ${resolvedExt}`);
                return { ...stream, url: toProxyUrl(finalUrl), mimeType: 'mp4' };
            }
            const transcodeUrl = finalUrl.replace('/proxy/stream', '/proxy/transcode/playlist.m3u8');
            console.log(`[StreamResolver] MediaFlow (via redirect): upgrading ${resolvedExt} → HLS transcode (nativeUrl available)`);
            return {
                ...stream,
                url:       toProxyUrl(transcodeUrl),
                mimeType:  'hls',
                nativeUrl: toProxyUrl(finalUrl),
            };
        }

        const filename = finalUrl.split('/').pop().split('?')[0].toLowerCase();
        const mimeType = filename.endsWith('.m3u8') ? 'hls' : 'mp4';

        console.log(`[StreamResolver] resolved: ${filename}`);
        return { ...stream, url: finalUrl, mimeType };
    } catch (err) {
        console.error('[StreamResolver]', err.message);
        return null;
    }
}

module.exports = { resolve };
