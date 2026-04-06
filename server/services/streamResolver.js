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
// The browser will use this directly — no proxy, no transcode latency.
async function resolveRedirect(url) {
    try {
        // Use redirect:manual so we get the Location header on the first hop
        // without triggering any upstream HEAD requests on the redirect target.
        // For Jackettio → MediaFlow chains this avoids a ~1s RD preflight.
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
                // Inspect the target file — if not natively playable, switch to HLS endpoint
                const targetParam = new URL(stream.url).searchParams.get('d') || '';
                const ext = targetParam.toLowerCase().split('?')[0].split('.').pop();
                const native = ['mp4', 'webm', 'mov'].includes(ext);

                if (native) {
                    mimeType = 'mp4';
                } else {
                    // Rewrite /proxy/stream → /proxy/transcode/playlist.m3u8 (MediaFlow FFmpeg → HLS fMP4)
                    finalUrl = stream.url.replace('/proxy/stream', '/proxy/transcode/playlist.m3u8');
                    console.log(`[StreamResolver] MediaFlow: upgrading ${ext} → HLS transcode`);
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
            const hlsUrl = finalUrl.replace('/proxy/stream', '/proxy/transcode/playlist.m3u8');
            console.log(`[StreamResolver] MediaFlow (via redirect): upgrading ${resolvedExt} → HLS transcode`);
            return { ...stream, url: toProxyUrl(hlsUrl), mimeType: 'hls' };
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
