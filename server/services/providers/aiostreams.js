/**
 * AIOStreams Provider
 *
 * Calls a self-hosted AIOStreams instance to resolve direct stream URLs.
 * AIOStreams aggregates torrent indexers and converts results via Real-Debrid
 * into plain HTTPS stream URLs.
 *
 * Docs: https://github.com/Viren070/AIOStreams/wiki/API-Documentation
 *
 * Environment:
 *   AIOSTREAMS_URL     — base URL of your AIOStreams instance (default: http://aiostreams:3000)
 *   AIOSTREAMS_API_KEY — API key set in AIOStreams config (optional if no password set)
 */

const axios = require('axios');

const BASE_URL = (process.env.AIOSTREAMS_URL || 'http://aiostreams:3000').replace(/\/$/, '');
const API_KEY  = process.env.AIOSTREAMS_API_KEY || '';

// Quality preference order for picking best stream
const QUALITY_RANK = ['2160p', '1080p', '720p', '480p', '360p'];

function buildContentId(content) {
    // AIOStreams accepts tmdb:ID for movies and tmdb:ID:season:episode for series
    const tmdbId = content.tmdbId || (content.id || '').split('_')[1] || content.id;
    if (content.type === 'movie') {
        return `tmdb:${tmdbId}`;
    }
    const season  = content.seasonNumber  || 1;
    const episode = content.episodeNumber || 1;
    return `tmdb:${tmdbId}:${season}:${episode}`;
}

function rankStream(stream) {
    const name = (stream.name || stream.title || '').toLowerCase();
    const qualityIndex = QUALITY_RANK.findIndex(q => name.includes(q.toLowerCase()));
    return qualityIndex === -1 ? QUALITY_RANK.length : qualityIndex;
}

function isDirectUrl(url) {
    return url && url.startsWith('http') && !url.startsWith('magnet:');
}

class AIOStreamsProvider {
    async getStream(content) {
        const contentId   = buildContentId(content);
        const contentType = content.type === 'movie' ? 'movie' : 'series';

        const headers = {};
        if (API_KEY) headers['x-aiostreams-api-key'] = API_KEY;

        const url = `${BASE_URL}/stremio/stream/${contentType}/${encodeURIComponent(contentId)}.json`;
        const response = await axios.get(url, { headers, timeout: 15000 });

        const streams = response.data?.streams || [];
        const direct  = streams.filter(s => isDirectUrl(s.url));

        if (!direct.length) return null;

        // Sort by quality preference
        direct.sort((a, b) => rankStream(a) - rankStream(b));
        const best = direct[0];

        return {
            success:  true,
            url:      best.url,
            mimeType: best.url.endsWith('.m3u8') ? 'hls' : 'mp4',
            name:     best.name || best.title || 'Direct Stream',
            provider: 'aiostreams',
            allStreams: direct.map(s => ({ url: s.url, name: s.name || s.title }))
        };
    }
}

module.exports = AIOStreamsProvider;
