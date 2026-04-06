/**
 * HeartStream V2 — API Client
 *
 * Thin fetch wrapper for all server routes.
 * No postMessage, no fallback chains, no source availability checks.
 */

export const API = (() => {

    async function get(path, params = {}) {
        const url = new URL(path, window.location.origin);
        Object.entries(params).forEach(([k, v]) => {
            if (v !== null && v !== undefined) url.searchParams.set(k, v);
        });
        const res = await fetch(url.toString());
        if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
        return res.json();
    }

    async function post(path, body = {}) {
        const res = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
        return res.json();
    }

    async function del(path) {
        const res = await fetch(path, { method: 'DELETE' });
        if (!res.ok) throw new Error(`DELETE ${path} → ${res.status}`);
        return res.json();
    }

    async function put(path, body = {}) {
        const res = await fetch(path, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(`PUT ${path} → ${res.status}`);
        return res.json();
    }

    // ── Content ──────────────────────────────────────────────────────────────

    const content = {
        trending: (timeWindow) => get('/api/content/trending', timeWindow ? { timeWindow } : {}),

        movies: (opts = {}) => get('/api/content/movies', {
            page:            opts.page,
            genre:           opts.genre,
            sort_by:         opts.sortBy,
            keyword:         opts.keyword,
            exclude_keyword: opts.excludeKeyword,
            language:        opts.language
        }),

        tvShows: (opts = {}) => get('/api/content/tv-shows', {
            page:            opts.page,
            genre:           opts.genre,
            sort_by:         opts.sortBy,
            keyword:         opts.keyword,
            exclude_keyword: opts.excludeKeyword,
            language:        opts.language
        }),

        details: (type, id) => get(`/api/content/details/${type}/${id}`),

        episodes: (tvId, season) => get(`/api/content/episodes/${tvId}/${season}`),

        search: (q, page = 1) => get('/api/content/search', { q, page }),

        genres: () => get('/api/content/genres')
    };

    // ── Streams ──────────────────────────────────────────────────────────────

    const streams = {
        // Returns { success, url, mimeType, name, provider, allStreams[] }
        // or      { success: false, fallback: true, sources: [...iframeSources] }
        movie: (tmdbId) =>
            get(`/api/stream/movie/${tmdbId}`),

        tv: (tmdbId, season, episode) =>
            get(`/api/stream/tv/${tmdbId}/${season}/${episode}`)
    };

    // ── Users ─────────────────────────────────────────────────────────────────

    const users = {
        list:   ()                      => get('/api/users'),
        get:    (id)                    => get(`/api/users/${id}`),
        create: (name, avatar, password) => post('/api/users', { name, avatar, password }),
        update: (id, data)              => put(`/api/users/${id}`, data),
        delete: (id)                    => del(`/api/users/${id}`)
    };

    // ── Progress ──────────────────────────────────────────────────────────────

    const progress = {
        all: (userId) =>
            get(`/api/progress/${userId}`),

        get: (userId, contentId, season = null, episode = null) =>
            get(`/api/progress/${userId}/${contentId}`, { season, episode }),

        save: (data) => post('/api/progress', data),

        continueWatching: (userId) =>
            get(`/api/continue-watching/${userId}`)
    };

    // ── Favorites ─────────────────────────────────────────────────────────────

    const favorites = {
        list:   (userId)                  => get(`/api/favorites/${userId}`),
        add:    (userId, contentId, type) => post('/api/favorites', { userId, contentId, contentType: type }),
        remove: (userId, contentId)       => del(`/api/favorites/${userId}/${encodeURIComponent(contentId)}`)
    };

    // ── Playlists ─────────────────────────────────────────────────────────────

    const playlists = {
        list:       (userId)                        => get(`/api/playlists/${userId}`),
        create:     (userId, name, description)     => post('/api/playlists', { userId, name, description }),
        update:     (id, name, description)         => put(`/api/playlists/${id}`, { name, description }),
        delete:     (id)                            => del(`/api/playlists/${id}`),
        items:      (id)                            => get(`/api/playlists/${id}/items`),
        addItem:    (id, contentId, contentType)    => post(`/api/playlists/${id}/items`, { contentId, contentType }),
        removeItem: (id, contentId)                 => del(`/api/playlists/${id}/items/${encodeURIComponent(contentId)}`)
    };

    // ── Intro times ───────────────────────────────────────────────────────────

    const intro = {
        get:    (contentId, season, episode, tmdbId) => get(`/api/intro/${encodeURIComponent(contentId)}`, { season, episode, tmdbId }),
        submit: (data)                       => post('/api/intro', data)
    };

    return { content, streams, users, progress, favorites, playlists, intro };
})();

