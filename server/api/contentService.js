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
            const ttl = cached.ttl || this.cacheTTL;
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

    async getMovies(page = 1, genre = null, sort_by = 'popular', keyword = null, excludeKeyword = null, language = null) {
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

            const movies = result.results
                .filter(movie => movie.poster_path)
                .map(movie => this.tmdb.transformMovie(movie));

            const response = { movies, page: result.page, totalPages: result.total_pages, totalResults: movies.length };
            this.setCache(cacheKey, response);
            return response;
        } catch (error) {
            console.error('Error fetching movies:', error);
            return { movies: [], page: 1, totalPages: 1, totalResults: 0 };
        }
    }

    async getTVShows(page = 1, genre = null, sort_by = 'popular', keyword = null, excludeKeyword = null, language = null) {
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

            const tvShows = result.results
                .filter(tv => tv.poster_path)
                .map(tv => this.tmdb.transformTV(tv));

            const response = { tvShows, page: result.page, totalPages: result.total_pages, totalResults: tvShows.length };
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

    clearCache() { this.cache.clear(); }
}

module.exports = ContentService;