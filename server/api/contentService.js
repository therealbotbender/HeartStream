const TMDBService = require('./tmdb');

class ContentService {
    constructor() {
        this.tmdb = new TMDBService();
        this.cache = new Map();
        this.cacheTTL = 10 * 60 * 1000; // 10 minutes
    }

    // Cache management
    getCacheKey(...args) {
        return args.join('_');
    }

    getFromCache(key) {
        const cached = this.cache.get(key);
        if (cached) {
            const ttl = cached.ttl || this.cacheTimeout;
            if (Date.now() - cached.timestamp < ttl) {
                return cached.data;
            }
        }
        this.cache.delete(key);
        return null;
    }

    setCache(key, data) {
        this.cache.set(key, {
            data,
            timestamp: Date.now()
        });
    }

    // Main content fetching methods
    async getTrendingContent(timeWindow = 'day') {
        const tw = timeWindow === 'week' ? 'week' : 'day';
        const cacheKey = this.getCacheKey('trending', tw);
        const cached = this.getFromCache(cacheKey);
        if (cached) return cached;

        try {
            const [trendingMovies, trendingTV] = await Promise.all([
                this.tmdb.getTrendingMovies(tw),
                this.tmdb.getTrendingTV(tw)
            ]);
            const content = {
                trending: {
                    movies: trendingMovies.results.filter(m => m.poster_path).map(m => this.tmdb.transformMovie(m)),
                    tv:     trendingTV.results.filter(t => t.poster_path).map(t => this.tmdb.transformTV(t))
                }
            };
            this.setCache(cacheKey, content);
            return content;
        } catch (error) {
            console.error('Error fetching trending content:', error);
            return { trending: { movies: [], tv: [] } };
        }
    }

    async getMovies(page = 1, genre = null, sort_by = 'popular', filterSources = true, keyword = null, excludeKeyword = null, language = null) {
        const cacheKey = this.getCacheKey('movies', page, `${genre || 'all'}-kw${keyword || ''}-ex${excludeKeyword || ''}-lang${language || ''}-sort${sort_by}`);
        const cached = this.getFromCache(cacheKey);
        if (cached) return cached;

        try {
            let result;
            if (genre) {
                const opts = { sortBy: sort_by };
                if (keyword) opts.withKeyword = keyword;
                if (excludeKeyword) opts.withoutKeyword = excludeKeyword;
                if (language) opts.language = language;
                result = await this.tmdb.getMoviesByGenre(genre, page, opts);
            } else {
                result = await this.tmdb.getPopularMovies(page);
            }

            const transformedMovies = result.results
                .filter(movie => movie.poster_path) // Filter out items without posters
                .map(movie => this.tmdb.transformMovie(movie));

            // Filter to only include movies with available sources (if enabled)
            const filteredMovies = filterSources ?
                await this.filterAvailableContent(transformedMovies, 'movie') :
                transformedMovies;

            const response = {
                movies: filteredMovies,
                page: result.page,
                totalPages: result.total_pages,
                totalResults: filteredMovies.length
            };

            this.setCache(cacheKey, response);
            return response;
        } catch (error) {
            console.error('Error fetching movies:', error);
            return { movies: [], page: 1, totalPages: 1, totalResults: 0 };
        }
    }

    async getTVShows(page = 1, genre = null, sort_by = 'popular', filterSources = true, keyword = null, excludeKeyword = null, language = null) {
        const cacheKey = this.getCacheKey('tv', page, `${genre || 'all'}-kw${keyword || ''}-ex${excludeKeyword || ''}-lang${language || ''}-sort${sort_by}`);
        const cached = this.getFromCache(cacheKey);
        if (cached) return cached;

        try {
            let result;
            if (genre) {
                const opts = { sortBy: sort_by };
                if (keyword) opts.withKeyword = keyword;
                if (excludeKeyword) opts.withoutKeyword = excludeKeyword;
                if (language) opts.language = language;
                result = await this.tmdb.getTVByGenre(genre, page, opts);
            } else {
                result = await this.tmdb.getPopularTV(page);
            }

            const transformedTV = result.results
                .filter(tv => tv.poster_path) // Filter out items without posters
                .map(tv => this.tmdb.transformTV(tv));

            // Filter to only include TV shows with available sources (if enabled)
            const filteredTV = filterSources ?
                await this.filterAvailableContent(transformedTV, 'tv') :
                transformedTV;

            const response = {
                tvShows: filteredTV,
                page: result.page,
                totalPages: result.total_pages,
                totalResults: filteredTV.length
            };

            this.setCache(cacheKey, response);
            return response;
        } catch (error) {
            console.error('Error fetching TV shows:', error);
            return { tvShows: [], page: 1, totalPages: 1, totalResults: 0 };
        }
    }

    async getContentDetails(contentId, type) {
        const cacheKey = this.getCacheKey('details', contentId, type);
        const cached = this.getFromCache(cacheKey);
        if (cached) return cached;

        try {
            // Extract TMDB ID from our content ID format
            const tmdbId = contentId.split('_')[1];

            let result;
            if (type === 'movie') {
                result = await this.tmdb.getMovieDetails(tmdbId);
                result = this.tmdb.transformMovie(result);
            } else if (type === 'tv') {
                result = await this.tmdb.getTVDetails(tmdbId);
                result = this.tmdb.transformTV(result);
            }

            this.setCache(cacheKey, result);
            return result;
        } catch (error) {
            console.error('Error fetching content details:', error);
            return null;
        }
    }

    async getTVEpisodes(tvId, seasonNumber) {
        const cacheKey = this.getCacheKey('episodes', tvId, seasonNumber);
        const cached = this.getFromCache(cacheKey);
        if (cached) return cached;

        try {
            // Extract TMDB ID from our TV ID format
            const tmdbId = tvId.split('_')[1];
            const seasonData = await this.tmdb.getTVSeason(tmdbId, seasonNumber);

            const episodes = seasonData.episodes.map(episode =>
                this.tmdb.transformEpisode(episode, tmdbId, seasonNumber)
            );

            this.setCache(cacheKey, episodes);
            return episodes;
        } catch (error) {
            console.error('Error fetching TV episodes:', error);
            return [];
        }
    }

    async searchContent(query, page = 1) {
        const cacheKey = this.getCacheKey('search', query, page);
        const cached = this.getFromCache(cacheKey);
        if (cached) return cached;

        try {
            const result = await this.tmdb.searchMulti(query, page);
            const transformedResults = result.results
                .filter(item => {
                    // Filter out items without posters and non-movie/tv items
                    return (item.media_type === 'movie' || item.media_type === 'tv') && item.poster_path;
                })
                .map(item => {
                    if (item.media_type === 'movie') {
                        return this.tmdb.transformMovie(item);
                    } else if (item.media_type === 'tv') {
                        return this.tmdb.transformTV(item);
                    }
                    return null;
                }).filter(Boolean);

            // Note: Source filtering disabled for search to maintain fast search experience
            // Users can check individual items when they try to play them

            const response = {
                results: transformedResults,
                page: result.page,
                totalPages: result.total_pages,
                totalResults: result.total_results
            };

            this.setCache(cacheKey, response);
            return response;
        } catch (error) {
            console.error('Error searching TMDB content:', error);
            return { results: [], page: 1, totalPages: 1, totalResults: 0 };
        }
    }

    async getGenres() {
        const cacheKey = this.getCacheKey('genres');
        const cached = this.getFromCache(cacheKey);
        if (cached) return cached;

        try {
            const [movieGenres, tvGenres] = await Promise.all([
                this.tmdb.getMovieGenres(),
                this.tmdb.getTVGenres()
            ]);

            const response = {
                movie: movieGenres.genres,
                tv: tvGenres.genres
            };

            this.setCache(cacheKey, response);
            return response;
        } catch (error) {
            console.error('Error fetching genres:', error);
            return { movie: [], tv: [] };
        }
    }

    // Multi-source video URL generator with fallback support
    // Primary: VidKing, Fallback: VidSrc
    getVideoURL(contentId, seasonNumber = null, episodeNumber = null) {
        // Extract TMDB ID from our content ID format (e.g., "movie_123" or "tv_456")
        const [type, tmdbId] = contentId.split('_');

        if (!tmdbId) {
            // Fallback for invalid content IDs
            return {
                url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
                source: 'fallback',
                sources: []
            };
        }

        const sources = this.generateVideoSources(type, tmdbId, seasonNumber, episodeNumber);

        // Return primary source (VidKing) with VidSrc as fallback
        // Frontend will automatically switch to fallback if primary fails
        return {
            url: sources[0].url,
            source: sources[0].name,
            sources: sources // All available sources in priority order
        };
    }

    // Generate all available video sources in priority order
    generateVideoSources(type, tmdbId, seasonNumber = null, episodeNumber = null) {
        const sources = [];

        // Primary Source: VidKing (no session expiry, postMessage progress API)
        const vkParams = new URLSearchParams({ autoPlay: 'true', color: '4f46e5' });
        if (type === 'movie') {
            sources.push({
                name: 'vidking',
                url: `https://www.vidking.net/embed/movie/${tmdbId}?${vkParams.toString()}`,
                baseUrl: `https://www.vidking.net/embed/movie/${tmdbId}`
            });
        } else if (type === 'tv' && seasonNumber && episodeNumber) {
            vkParams.set('nextEpisode', 'true');
            sources.push({
                name: 'vidking',
                url: `https://www.vidking.net/embed/tv/${tmdbId}/${seasonNumber}/${episodeNumber}?${vkParams.toString()}`,
                baseUrl: `https://www.vidking.net/embed/tv/${tmdbId}/${seasonNumber}/${episodeNumber}`
            });
        }

        // Secondary Source: VidSrc.cc
        if (type === 'movie') {
            sources.push({
                name: 'vidsrc-cc',
                url: `https://vidsrc.cc/v2/embed/movie/${tmdbId}`,
                baseUrl: `https://vidsrc.cc/v2/embed/movie/${tmdbId}`
            });
        } else if (type === 'tv' && seasonNumber && episodeNumber) {
            sources.push({
                name: 'vidsrc-cc',
                url: `https://vidsrc.cc/v2/embed/tv/${tmdbId}/${seasonNumber}/${episodeNumber}`,
                baseUrl: `https://vidsrc.cc/v2/embed/tv/${tmdbId}/${seasonNumber}/${episodeNumber}`
            });
        }

        // Tertiary Source: VidSrc.net
        if (type === 'movie') {
            sources.push({
                name: 'vidsrc-net',
                url: `https://vidsrc.net/embed/movie?tmdb=${tmdbId}`,
                baseUrl: `https://vidsrc.net/embed/movie?tmdb=${tmdbId}`
            });
        } else if (type === 'tv' && seasonNumber && episodeNumber) {
            sources.push({
                name: 'vidsrc-net',
                url: `https://vidsrc.net/embed/tv?tmdb=${tmdbId}&season=${seasonNumber}&episode=${episodeNumber}`,
                baseUrl: `https://vidsrc.net/embed/tv?tmdb=${tmdbId}&season=${seasonNumber}&episode=${episodeNumber}`
            });
        }

        // Quaternary Source: SuperEmbed
        if (type === 'movie') {
            sources.push({
                name: 'superembed',
                url: `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1`,
                baseUrl: `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1`
            });
        } else if (type === 'tv' && seasonNumber && episodeNumber) {
            sources.push({
                name: 'superembed',
                url: `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1&s=${seasonNumber}&e=${episodeNumber}`,
                baseUrl: `https://multiembed.mov/?video_id=${tmdbId}&tmdb=1&s=${seasonNumber}&e=${episodeNumber}`
            });
        }

        return sources;
    }

    // Clear cache (useful for debugging)
    clearCache() {
        this.cache.clear();
    }

    // Get cache stats
    getCacheStats() {
        return {
            size: this.cache.size,
            keys: Array.from(this.cache.keys())
        };
    }

    // Check if video source is available.
    // Embed sites use Cloudflare and return 200 for error pages, so we check
    // the HTTP status code only — 404 means definitively unavailable.
    // If we can't reach the site (timeout, bot block, etc.) we assume available
    // rather than incorrectly hiding content.
    async checkSourceAvailability(contentId, seasonNumber = null, episodeNumber = null) {
        const cacheKey = this.getCacheKey('source_check', contentId, seasonNumber, episodeNumber);
        const cached = this.getFromCache(cacheKey);
        if (cached !== null) return cached;

        const cacheResult = (isAvailable, ttlMs) => {
            this.cache.set(cacheKey, { data: isAvailable, timestamp: Date.now(), ttl: ttlMs });
            return isAvailable;
        };

        try {
            const [type, tmdbId] = contentId.split('_');
            if (!tmdbId) return false;

            const fetch = require('node-fetch');

            let vidkingUrl;
            if (type === 'movie') {
                vidkingUrl = `https://www.vidking.net/embed/movie/${tmdbId}`;
            } else if (type === 'tv' && seasonNumber && episodeNumber) {
                vidkingUrl = `https://www.vidking.net/embed/tv/${tmdbId}/${seasonNumber}/${episodeNumber}`;
            } else {
                return false;
            }

            try {
                const response = await fetch(vidkingUrl, {
                    method: 'HEAD',
                    timeout: 6000,
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                });

                // 404 = definitively not found
                if (response.status === 404) {
                    return cacheResult(false, 30 * 60 * 1000);
                }
                // Any other status (200, 403, redirect) = assume available
                return cacheResult(true, 2 * 60 * 60 * 1000);
            } catch (_) {
                // Timeout or network error — assume available, don't hide content
                return cacheResult(true, 15 * 60 * 1000);
            }
        } catch (error) {
            console.error('Error checking source availability:', error);
            return true; // Don't hide content on unexpected errors
        }
    }

    // Filter content to only include items with available sources
    async filterAvailableContent(contentArray, type = 'movie') {
        if (!contentArray || !Array.isArray(contentArray)) return [];

        const availableContent = [];

        // Check availability for each content item (in batches to avoid overwhelming the server)
        const batchSize = 5;
        for (let i = 0; i < contentArray.length; i += batchSize) {
            const batch = contentArray.slice(i, i + batchSize);

            const batchPromises = batch.map(async (content) => {
                const contentId = `${type}_${content.id}`;

                let isAvailable = false;
                if (type === 'movie') {
                    isAvailable = await this.checkSourceAvailability(contentId);
                } else if (type === 'tv') {
                    // For TV shows, check if at least S1E1 is available
                    isAvailable = await this.checkSourceAvailability(contentId, 1, 1);
                }

                return isAvailable ? content : null;
            });

            const batchResults = await Promise.all(batchPromises);
            availableContent.push(...batchResults.filter(content => content !== null));

            // Small delay between batches to be respectful to the server
            if (i + batchSize < contentArray.length) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }

        return availableContent;
    }
}

module.exports = ContentService;