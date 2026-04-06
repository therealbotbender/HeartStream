/**
 * state.js — single source of truth for app-wide state.
 * Import { state } and read/write directly. No getters/setters needed at this scale.
 */

export const state = {
    // Active user profile
    currentUser: null,          // { id, name, avatar, theme }

    // Navigation
    currentSection: 'home',     // 'home' | 'movies' | 'tv' | 'anime' | 'search' | 'genre-list'
    previousSection: null,

    // Active content for detail modal
    selectedContent: null,      // full content object from TMDB

    // Active playback
    player: {
        contentId:  null,   // e.g. 'movie_12345' or 'tv_67890'
        type:       null,   // 'movie' | 'tv'
        tmdbId:     null,
        season:     null,
        episode:    null,
        allStreams: [],     // quality/language options from Jackettio
    },

    // Genre / category browser
    genreList: {
        type:    null,          // 'movie' | 'tv'
        genreId: null,
        title:   null,
        page:    1,
        totalPages: 1,
        sortBy:  'popular'
    },

    // Cached continue-watching list (refreshed on home load)
    continueWatching: [],
};
