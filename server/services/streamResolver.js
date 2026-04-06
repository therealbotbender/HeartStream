/**
 * StreamResolver
 *
 * Resolves a direct HTTPS stream URL for a given piece of content.
 *
 * Flow:
 *  1. Convert TMDB ID → IMDb ID + title (cached in TMDBService)
 *  2. Call Jackettio → Real-Debrid → follow redirect → direct HTTPS URL
 *  3. Validate: stream name must share at least one significant word with the
 *     expected title — catches mislabeled torrents (e.g. Star Wars returned
 *     for Bloodhounds because of a bad IMDB ID in the indexer).
 *  4. Return StreamResult or null
 *
 * StreamResult: { success, url, mimeType, name, provider, allStreams[] }
 */

const JackettioProvider = require('./providers/jackettio');
const TMDBService = require('../api/tmdb');

const jackettio = new JackettioProvider();
const tmdb      = new TMDBService();

// Returns true if at least one significant word (>3 chars) from the expected
// title appears somewhere in the stream name. Catches clearly wrong content.
function titleMatchesStream(title, streamName) {
    if (!title || !streamName) return true; // can't validate — let it through
    const words = s => s.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length > 3);
    const titleWords = words(title);
    if (!titleWords.length) return true; // title has no long words — skip check
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

async function resolve(content) {
    if (!content?.tmdbId) return null;

    try {
        const tmdbType = content.type === 'movie' ? 'movie' : 'tv';

        // Fetch IMDB ID and title in parallel — both are cached after first call
        const [ext, expectedTitle] = await Promise.all([
            tmdb.getExternalIds(content.tmdbId, tmdbType),
            tmdb.getTitle(content.tmdbId, tmdbType).catch(() => null),
        ]);

        const imdbId = ext?.imdb_id;
        if (!imdbId) {
            console.error(`[StreamResolver] No IMDb ID for TMDB ${content.tmdbId}`);
            return null;
        }

        const stream = await jackettio.getStream({ ...content, imdbId });
        if (!stream) return null;

        // Validate stream name against expected title — rejects mislabeled torrents
        if (!titleMatchesStream(expectedTitle, stream.name)) {
            console.warn(`[StreamResolver] title mismatch — expected "${expectedTitle}" but stream is "${stream.name}" — skipping`);
            return null;
        }

        let streamUrl = stream.url;

        // Jackettio may still return MediaFlow proxy URLs (from its cached config).
        // Extract the direct RD URL from the `d=` query param — no transcoding needed.
        if (streamUrl.includes('/proxy/stream') || streamUrl.includes('/proxy/hls/')) {
            try {
                const d = new URL(streamUrl).searchParams.get('d');
                if (!d) { console.warn('[StreamResolver] MediaFlow URL missing d= param'); return null; }
                console.log('[StreamResolver] bypassing MediaFlow — using direct RD URL');
                streamUrl = d;
            } catch { return null; }
        }

        const finalUrl = await resolveRedirect(streamUrl);
        if (!finalUrl) return null;

        const filename = finalUrl.split('/').pop().split('?')[0].toLowerCase();
        console.log(`[StreamResolver] serving "${stream.name}" → ${filename}`);

        return { ...stream, url: finalUrl, mimeType: 'mp4' };
    } catch (err) {
        console.error('[StreamResolver]', err.message);
        return null;
    }
}

module.exports = { resolve };
