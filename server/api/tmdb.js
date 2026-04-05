const axios = require('axios');

class TMDBService {
    constructor() {
        // TMDB API configuration
        this.baseURL = 'https://api.themoviedb.org/3';
        this.imageBaseURL = 'https://image.tmdb.org/t/p';
        
        // Backup image CDNs in case TMDB images fail
        this.backupImageCDNs = [
            'https://image.tmdb.org/t/p', // Primary
            'https://www.themoviedb.org/t/p', // Alternative TMDB URL
        ];

        // You'll need to get a free API key from https://www.themoviedb.org/settings/api
        this.apiKey = process.env.TMDB_API_KEY || '';

        if (!this.apiKey) {
            console.warn('TMDB API key not found. Set TMDB_API_KEY environment variable.');
        }

        this.defaultParams = {
            api_key: this.apiKey,
            language: 'en-US'
        };
        
        // Track API health
        this.apiHealthy = true;
        this.lastFailureTime = null;
    }

    // Helper method to build image URLs with CDN fallback
    getImageURL(path, size = 'w500') {
        if (!path) return null;
        
        // Return array of URLs for fallback support
        const urls = this.backupImageCDNs.map(cdn => `${cdn}/${size}${path}`);
        
        // For now, return primary URL (renderer will handle fallback)
        return urls[0];
    }
    
    // Get all image URL alternatives for client-side fallback
    getImageURLs(path, size = 'w500') {
        if (!path) return [];
        return this.backupImageCDNs.map(cdn => `${cdn}/${size}${path}`);
    }

    // Helper method to make API requests with retry logic
    async makeRequest(endpoint, params = {}) {
        // If API was recently unhealthy, wait before retrying
        if (!this.apiHealthy && this.lastFailureTime) {
            const timeSinceFailure = Date.now() - this.lastFailureTime;
            if (timeSinceFailure < 60000) { // Wait 1 minute before retry
                throw new Error('TMDB API temporarily unavailable');
            }
        }

        try {
            const response = await axios.get(`${this.baseURL}${endpoint}`, {
                params: { ...this.defaultParams, ...params },
                timeout: 10000 // 10 second timeout
            });
            
            // Mark API as healthy on success
            this.apiHealthy = true;
            this.lastFailureTime = null;
            
            return response.data;
        } catch (error) {
            // 404 means the resource doesn't exist — not an API health issue
            if (error.response?.status === 404) {
                throw error;
            }

            console.error(`TMDB API Error (${endpoint}):`, error.message);

            // Mark API as unhealthy
            this.apiHealthy = false;
            this.lastFailureTime = Date.now();

            throw error;
        }
    }

    // Get trending movies
    async getTrendingMovies(timeWindow = 'day') {
        return await this.makeRequest(`/trending/movie/${timeWindow}`);
    }

    // Get trending TV shows
    async getTrendingTV(timeWindow = 'day') {
        return await this.makeRequest(`/trending/tv/${timeWindow}`);
    }

    // Get popular movies
    async getPopularMovies(page = 1) {
        return await this.makeRequest('/movie/popular', { page });
    }

    // Get popular TV shows
    async getPopularTV(page = 1) {
        return await this.makeRequest('/tv/popular', { page });
    }

    // Get movies by genre
    async getMoviesByGenre(genreId, page = 1, options = {}) {
        const sortMap = { popular: 'popularity.desc', 'release_date.desc': 'release_date.desc', 'vote_average.desc': 'vote_average.desc' };
        const params = { with_genres: genreId, page, sort_by: sortMap[options.sortBy] || 'popularity.desc' };
        if (options.withKeyword) params.with_keywords = options.withKeyword;
        if (options.withoutKeyword) params.without_keywords = options.withoutKeyword;
        if (options.language) params.with_original_language = options.language;
        return await this.makeRequest('/discover/movie', params);
    }

    // Get TV shows by genre
    async getTVByGenre(genreId, page = 1, options = {}) {
        const sortMap = { popular: 'popularity.desc', 'first_air_date.desc': 'first_air_date.desc', 'vote_average.desc': 'vote_average.desc' };
        const params = { with_genres: genreId, page, sort_by: sortMap[options.sortBy] || 'popularity.desc' };
        if (options.withKeyword) params.with_keywords = options.withKeyword;
        if (options.withoutKeyword) params.without_keywords = options.withoutKeyword;
        if (options.language) params.with_original_language = options.language;
        return await this.makeRequest('/discover/tv', params);
    }

    // Get movie details
    async getMovieDetails(movieId) {
        return await this.makeRequest(`/movie/${movieId}`, {
            append_to_response: 'videos,credits,similar'
        });
    }

    // Get TV show details
    async getTVDetails(tvId) {
        return await this.makeRequest(`/tv/${tvId}`, {
            append_to_response: 'videos,credits,similar'
        });
    }

    // Get external IDs (includes imdb_id) — cached in-process to avoid repeat calls
    async getExternalIds(tmdbId, type = 'movie') {
        const key = `ext_${type}_${tmdbId}`;
        if (this._externalIdsCache?.has(key)) return this._externalIdsCache.get(key);
        if (!this._externalIdsCache) this._externalIdsCache = new Map();
        const endpoint = type === 'movie'
            ? `/movie/${tmdbId}/external_ids`
            : `/tv/${tmdbId}/external_ids`;
        const data = await this.makeRequest(endpoint);
        this._externalIdsCache.set(key, data);
        return data;
    }

    // Get TV season details
    async getTVSeason(tvId, seasonNumber) {
        return await this.makeRequest(`/tv/${tvId}/season/${seasonNumber}`);
    }

    // Get TV episode details
    async getTVEpisode(tvId, seasonNumber, episodeNumber) {
        return await this.makeRequest(`/tv/${tvId}/season/${seasonNumber}/episode/${episodeNumber}`);
    }

    // Search for content
    async searchMulti(query, page = 1) {
        return await this.makeRequest('/search/multi', { query, page });
    }

    // Search movies
    async searchMovies(query, page = 1) {
        return await this.makeRequest('/search/movie', { query, page });
    }

    // Search TV shows
    async searchTV(query, page = 1) {
        return await this.makeRequest('/search/tv', { query, page });
    }

    // Get genre list for movies
    async getMovieGenres() {
        return await this.makeRequest('/genre/movie/list');
    }

    // Get genre list for TV shows
    async getTVGenres() {
        return await this.makeRequest('/genre/tv/list');
    }

    // Transform TMDB movie data to our format
    transformMovie(tmdbMovie) {
        return {
            id: `movie_${tmdbMovie.id}`,
            tmdbId: tmdbMovie.id,
            title: tmdbMovie.title,
            type: 'movie',
            poster: this.getImageURL(tmdbMovie.poster_path),
            backdrop: this.getImageURL(tmdbMovie.backdrop_path, 'w1280'),
            overview: tmdbMovie.overview,
            releaseDate: tmdbMovie.release_date,
            rating: tmdbMovie.vote_average,
            genreIds: tmdbMovie.genre_ids || [],
            originalLanguage: tmdbMovie.original_language || null,
            adult: tmdbMovie.adult || false
        };
    }

    // Transform TMDB TV show data to our format
    transformTV(tmdbTV) {
        return {
            id: `tv_${tmdbTV.id}`,
            tmdbId: tmdbTV.id,
            title: tmdbTV.name,
            type: 'tv',
            poster: this.getImageURL(tmdbTV.poster_path),
            backdrop: this.getImageURL(tmdbTV.backdrop_path, 'w1280'),
            overview: tmdbTV.overview,
            firstAirDate: tmdbTV.first_air_date,
            rating: tmdbTV.vote_average,
            genreIds: tmdbTV.genre_ids || [],
            originalLanguage: tmdbTV.original_language || null,
            adult: tmdbTV.adult || false
        };
    }

    // Transform episode data
    transformEpisode(tmdbEpisode, tvId, seasonNumber) {
        return {
            id: `tv_${tvId}_s${seasonNumber}_e${tmdbEpisode.episode_number}`,
            tmdbId: tmdbEpisode.id,
            title: `${tmdbEpisode.name}`,
            type: 'tv',
            seasonNumber: seasonNumber,
            episodeNumber: tmdbEpisode.episode_number,
            poster: this.getImageURL(tmdbEpisode.still_path),
            overview: tmdbEpisode.overview,
            airDate: tmdbEpisode.air_date,
            rating: tmdbEpisode.vote_average,
            runtime: tmdbEpisode.runtime
        };
    }

    // Get content recommendations based on cineby.app structure
    async getCinebyContent() {
        try {
            const [trendingMovies, trendingTV, popularMovies, popularTV] = await Promise.all([
                this.getTrendingMovies(),
                this.getTrendingTV(),
                this.getPopularMovies(),
                this.getPopularTV()
            ]);

            return {
                trending: {
                    // Filter out items without posters for better UI
                    movies: trendingMovies.results
                        .filter(movie => movie.poster_path)
                        .map(movie => this.transformMovie(movie)),
                    tv: trendingTV.results
                        .filter(tv => tv.poster_path)
                        .map(tv => this.transformTV(tv))
                },
                popular: {
                    movies: popularMovies.results
                        .filter(movie => movie.poster_path)
                        .map(movie => this.transformMovie(movie)),
                    tv: popularTV.results
                        .filter(tv => tv.poster_path)
                        .map(tv => this.transformTV(tv))
                }
            };
        } catch (error) {
            console.error('Error getting Cineby content:', error);
            return { trending: { movies: [], tv: [] }, popular: { movies: [], tv: [] } };
        }
    }
}

module.exports = TMDBService;