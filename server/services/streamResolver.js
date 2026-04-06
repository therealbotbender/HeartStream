/**
 * StreamResolver
 *
 * Resolves a direct HTTPS stream URL for a given piece of content.
 *
 * Flow:
 *  1. Convert TMDB ID → IMDb ID + title (both cached in TMDBService)
 *  2. Call Jackettio — returns all ranked candidate streams
 *  3. For each candidate (best-first):
 *     a. Validate title — skip mislabeled torrents
 *     b. Unwrap MediaFlow proxy URLs → direct RD URL
 *     c. Follow RD redirect → final CDN URL
 *     d. First candidate that passes all checks is returned
 *  4. The winning candidate is cached so future calls skip the search
 *
 * StreamResult: { success, url, mimeType, name, provider, allStreams[] }
 */

const JackettioProvider = require('./providers/jackettio');
const TMDBService = require('../api/tmdb');

const jackettio = new JackettioProvider();
const tmdb      = new TMDBService();

// Returns true if at least one significant word (>3 chars) from the expected
// title appears in the stream name — catches clearly mislabeled torrents.
function titleMatchesStream(title, streamName) {
    if (!title || !streamName) return true;
    const words = s => s.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length > 3);
    const titleWords = words(title);
    if (!titleWords.length) return true;
    const streamWordSet = new Set(words(streamName));
    return titleWords.some(w => streamWordSet.has(w));
}

// Follow Jackettio's redirect chain to get the actual RD CDN URL.
// Returns null if the link is dead (4xx/5xx from RD).
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
        if (res.status >= 400) {
            console.warn(`[StreamResolver] resolveRedirect ${res.status} for ${url}`);
            return null;
        }
        return res.url || url;
    } catch {
        return null;
    }
}

// Unwrap a MediaFlow proxy URL to the direct RD URL stored in its `d=` param.
// Returns the original URL unchanged if it isn't a MediaFlow URL.
function unwrapMediaFlow(url) {
    if (!url.includes('/proxy/stream') && !url.includes('/proxy/hls/')) return url;
    try {
        const d = new URL(url).searchParams.get('d');
        if (d) { console.log('[StreamResolver] bypassing MediaFlow — using direct RD URL'); return d; }
    } catch { /* fall through */ }
    return null;
}

async function resolve(content) {
    if (!content?.tmdbId) return null;

    try {
        const tmdbType = content.type === 'movie' ? 'movie' : 'tv';

        // Fetch IMDb ID and expected title in parallel (both cached after first call)
        const [ext, expectedTitle] = await Promise.all([
            tmdb.getExternalIds(content.tmdbId, tmdbType),
            tmdb.getTitle(content.tmdbId, tmdbType).catch(() => null),
        ]);

        const imdbId = ext?.imdb_id;
        if (!imdbId) {
            console.error(`[StreamResolver] No IMDb ID for TMDB ${content.tmdbId}`);
            return null;
        }

        // Jackettio returns the best stream + all candidates ranked by quality
        const streamResult = await jackettio.getStream({ ...content, imdbId });
        if (!streamResult) return null;

        // Build ordered candidate list — best first, then the rest
        const candidates = streamResult.allStreams?.length
            ? streamResult.allStreams
            : [{ url: streamResult.url, name: streamResult.name }];

        for (const candidate of candidates) {
            const name = candidate.name || '';

            // 1. Title validation — skip mislabeled torrents
            if (!titleMatchesStream(expectedTitle, name)) {
                console.warn(`[StreamResolver] skipping mislabeled: "${name}" (expected "${expectedTitle}")`);
                continue;
            }

            // 2. Unwrap MediaFlow proxy URLs if Jackettio still returns them
            const unwrapped = unwrapMediaFlow(candidate.url);
            if (!unwrapped) { console.warn(`[StreamResolver] MediaFlow URL missing d= param — skipping`); continue; }

            // 3. Follow redirect chain → final CDN URL
            const finalUrl = await resolveRedirect(unwrapped);
            if (!finalUrl) { console.warn(`[StreamResolver] dead link for "${name}" — trying next`); continue; }

            const filename = finalUrl.split('/').pop().split('?')[0].toLowerCase();
            console.log(`[StreamResolver] serving "${name}" → ${filename}`);

            // Cache this winning result so the next call skips the search
            jackettio.cacheResult(content, { ...streamResult, url: finalUrl, name });

            return {
                success:   true,
                url:       finalUrl,
                mimeType:  'mp4',
                name,
                provider:  'jackettio',
                allStreams: streamResult.allStreams,
            };
        }

        console.warn(`[StreamResolver] no valid candidate found for "${expectedTitle}"`);
        return null;
    } catch (err) {
        console.error('[StreamResolver]', err.message);
        return null;
    }
}

module.exports = { resolve };
