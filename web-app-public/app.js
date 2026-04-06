/**
 * app.js — HeartStream V2 entry point.
 * Handles: init, user selection, navigation, section loading, detail modal.
 * Playback is delegated to player.js. Rendering to content.js.
 */

import { API } from './api-client.js';
import { state } from './state.js';
import { initPlayer, play, closePlayer } from './player.js';
import { initAnimePage } from './anime.js';
import {
    populateCarousel, populateGrid, buildCard,
    buildGenreRow, buildGenreRowShell, buildSubRowShell,
    buildEpisodeCard, scrollCarousel
} from './content.js';

// ── Boot ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    loadSavedPrefs();
    initPlayer();
    wireGlobalEvents();
    wireCustomizeModal();
    await loadUserScreen();
});

// Refresh continue watching after player closes
document.addEventListener('player:closed', async () => {
    if (!state.currentUser) return;
    state.continueWatching = await API.progress.continueWatching(state.currentUser.id).catch(() => []);
    if (state.currentSection === 'home') {
        populateCarousel('continue-watching-grid', state.continueWatching.map(item => ({
            id:    item.content_id,
            type:  item.content_type,
            title: item.title || item.content_id,
            poster: item.poster || null
        })));
    }
});

// ── User selection screen ─────────────────────────────────────────────────────

async function loadUserScreen() {
    showScreen('user-selection');
    const users = await API.users.list().catch(() => []);
    renderUserGrid(users);
}

function renderUserGrid(users) {
    const grid = document.getElementById('user-grid');
    grid.innerHTML = users.map(u => `
        <div class="user-card" data-id="${u.id}" data-has-password="${u.password ? '1' : '0'}">
            <img src="${u.avatar || '/icons/default-avatar.png'}" alt="${u.name}"
                 onerror="this.src='/icons/default-avatar.png'">
            <span>${u.name}</span>
        </div>
    `).join('');

    grid.querySelectorAll('.user-card').forEach(card => {
        card.addEventListener('click', () => {
            const hasPassword = card.dataset.hasPassword === '1';
            if (hasPassword) {
                promptPassword(parseInt(card.dataset.id));
            } else {
                selectUser(parseInt(card.dataset.id));
            }
        });
    });
}

async function selectUser(userId) {
    const user = await API.users.get(userId).catch(() => null);
    if (!user) return;
    state.currentUser = user;
    applyTheme(user.theme);
    document.getElementById('user-name').textContent   = user.name;
    document.getElementById('user-avatar').src         = user.avatar || '/icons/default-avatar.png';
    state.continueWatching = await API.progress.continueWatching(userId).catch(() => []);
    showScreen('main-app');
    navigateTo('home');
}

function promptPassword(userId) {
    const modal = document.getElementById('password-prompt-modal');
    const form  = document.getElementById('password-prompt-form');
    const err   = document.getElementById('password-error');
    const input = document.getElementById('password-prompt-input');
    err.style.display = 'none';
    input.value = '';
    modal.classList.add('active');

    const onSubmit = async (e) => {
        e.preventDefault();
        try {
            const user = await API.users.get(userId);
            if (user.password && user.password !== input.value) {
                err.style.display = 'block';
                return;
            }
            modal.classList.remove('active');
            form.removeEventListener('submit', onSubmit);
            selectUser(userId);
        } catch {
            err.style.display = 'block';
        }
    };
    form.addEventListener('submit', onSubmit);
}

// ── Navigation ────────────────────────────────────────────────────────────────

async function navigateTo(section) {
    state.previousSection = state.currentSection;
    state.currentSection  = section;

    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.section === section);
    });
    document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));

    switch (section) {
        case 'home':
            document.getElementById('home-section').classList.add('active');
            await loadHome();
            break;
        case 'movies':
            document.getElementById('movies-section').classList.add('active');
            await loadMovies();
            break;
        case 'tv':
            document.getElementById('tv-section').classList.add('active');
            await loadTV();
            break;
        case 'anime':
            document.getElementById('anime-section').classList.add('active');
            await initAnimePage();
            break;
        case 'search':
            document.getElementById('search-section').classList.add('active');
            break;
        case 'genre-list':
            document.getElementById('genre-list-section').classList.add('active');
            await loadGenreList();
            break;
    }
}

// ── Home ──────────────────────────────────────────────────────────────────────

async function loadHome() {
    // Continue watching
    populateCarousel('continue-watching-grid', state.continueWatching.map(item => ({
        id:    item.content_id,
        type:  item.content_type,
        title: item.title || item.content_id,
        poster: item.poster || null
    })));

    // Trending
    const trending = await API.content.trending().catch(() => ({ trending: { movies: [], tv: [] } }));
    const mixed = [...(trending.trending?.movies || []), ...(trending.trending?.tv || [])]
        .sort(() => Math.random() - 0.5)
        .slice(0, 20);
    populateCarousel('trending-grid', mixed);

    // Hero banner — pick a random trending item with a backdrop
    const heroPool = mixed.filter(i => i.backdrop);
    const hero = heroPool[Math.floor(Math.random() * heroPool.length)];
    if (hero) renderHero(hero);
}

function renderHero(item) {
    const banner = document.getElementById('hero-banner');
    if (!banner) return;
    const tmdbId = item.tmdbId || item.id?.split('_')[1];
    const year   = item.releaseDate?.slice(0, 4) || item.firstAirDate?.slice(0, 4) || '';
    const rating = item.rating ? `★ ${item.rating.toFixed(1)}` : '';
    const meta   = [year, rating].filter(Boolean).join('  ·  ');
    const overview = item.overview
        ? item.overview.length > 160 ? item.overview.slice(0, 157) + '…' : item.overview
        : '';

    banner.innerHTML = `
        <img class="hero-backdrop" src="https://image.tmdb.org/t/p/w1280${item.backdrop}"
             alt="${escapeHtml(item.title)}" onerror="this.style.opacity=0">
        <div class="hero-content">
            <p class="hero-meta">${escapeHtml(meta)}</p>
            <h2>${escapeHtml(item.title)}</h2>
            ${overview ? `<p class="hero-overview">${escapeHtml(overview)}</p>` : ''}
            <div class="hero-actions">
                <button class="hero-play-btn" data-id="${item.id}" data-type="${item.type}">▶ Play</button>
                <button class="hero-info-btn" data-id="${item.id}" data-type="${item.type}">More Info</button>
            </div>
        </div>
    `;

    banner.querySelector('.hero-play-btn').addEventListener('click', () => {
        play(item.id, item.type, tmdbId, 1, 1);
    });
    banner.querySelector('.hero-info-btn').addEventListener('click', () => {
        window.__openContentDetail?.(item.id, item.type);
    });
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Lazy genre row loader ─────────────────────────────────────────────────────

function observeGenreRows(container, loadFn) {
    // Wait for layout to be computed before observing — prevents all rows
    // firing at once because they're all at y=0 before the browser paints.
    requestAnimationFrame(() => {
        // One more frame to be safe (some browsers need two)
        requestAnimationFrame(() => {
            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (!entry.isIntersecting) return;
                    const row = entry.target;
                    if (row.dataset.lazy !== 'pending') return;
                    row.dataset.lazy = 'loading';
                    observer.unobserve(row);
                    loadFn(row).catch(() => {}).then(() => { row.dataset.lazy = 'loaded'; });
                });
            }, { rootMargin: '0px 0px 80px 0px' });

            container.querySelectorAll('.genre-row[data-lazy="pending"]').forEach(row => observer.observe(row));
        });
    });
}

// ── Category tree ──────────────────────────────────────────────────────────────

const CATEGORIES = {
    movie: [
        { label: 'Trending', trending: true, subs: [] },
        { label: 'Action',      genreIds: [28],    subs: [
            { label: 'Superhero', keyword: 9715 },
            { label: 'War',       genreIds: [28, 10752] },
            { label: 'Spy',       genreIds: [28, 53] },
            { label: 'Heist',     keyword: 10174 },
        ]},
        { label: 'Horror',      genreIds: [27],    subs: [
            { label: 'Zombie',        keyword: 12377 },
            { label: 'Psychological', genreIds: [27, 53] },
        ]},
        { label: 'Sci-Fi',      genreIds: [878],   subs: [
            { label: 'Superhero',   keyword: 9715 },
            { label: 'Time Travel', keyword: 9882 },
        ]},
        { label: 'Comedy',      genreIds: [35],    subs: [
            { label: 'Rom-Com', genreIds: [35, 10749] },
        ]},
        { label: 'Drama',       genreIds: [18],    subs: [
            { label: 'Crime',   genreIds: [18, 80] },
            { label: 'K-Drama', language: 'ko' },
        ]},
        { label: 'Thriller',    genreIds: [53],    subs: [
            { label: 'Mystery', genreIds: [9648] },
            { label: 'Crime',   genreIds: [53, 80] },
        ]},
        { label: 'Romance',     genreIds: [10749], subs: [
            { label: 'Rom-Com', genreIds: [10749, 35] },
            { label: 'K-Drama', language: 'ko' },
        ]},
        { label: 'Animation',   genreIds: [16],    subs: [
            { label: 'Anime',    keyword: 210024 },
            { label: 'Kids',     genreIds: [16, 10751] },
            { label: 'Western',  excludeKeyword: 210024 },
        ]},
        { label: 'Documentary', genreIds: [99],    subs: [] },
        { label: 'Family',      genreIds: [10751], subs: [
            { label: 'Kids',      genreIds: [10751, 10762] },
            { label: 'Animation', genreIds: [10751, 16] },
        ]},
    ],
    tv: [
        { label: 'Trending', trending: true, subs: [] },
        { label: 'Drama',              genreIds: [18],    subs: [
            { label: 'Crime',   genreIds: [18, 80] },
            { label: 'K-Drama', language: 'ko' },
        ]},
        { label: 'Comedy',             genreIds: [35],    subs: [
            { label: 'Rom-Com', genreIds: [35, 10749] },
        ]},
        { label: 'Sci-Fi & Fantasy',   genreIds: [10765], subs: [
            { label: 'Superhero',   keyword: 9715 },
            { label: 'Time Travel', keyword: 9882 },
        ]},
        { label: 'Crime & Mystery',    genreIds: [80],    subs: [
            { label: 'Mystery', genreIds: [9648] },
        ]},
        { label: 'Action & Adventure', genreIds: [10759], subs: [
            { label: 'Superhero', keyword: 9715 },
        ]},
        { label: 'Animation',          genreIds: [16],    subs: [
            { label: 'Anime',    keyword: 210024 },
            { label: 'Kids',     genreIds: [16, 10762] },
            { label: 'Western',  excludeKeyword: 210024 },
        ]},
        { label: 'Romance',            genreIds: [10749], subs: [
            { label: 'K-Drama', language: 'ko' },
        ]},
        { label: 'Reality',      genreIds: [10764], subs: [] },
        { label: 'Kids',         genreIds: [10762], subs: [] },
        { label: 'Documentary',  genreIds: [99],    subs: [] },
    ]
};

const SECTION_IDS = {
    movie: { mainPills: 'movie-main-categories', subPills: 'movie-sub-categories', content: 'movie-genre-sections-container', sort: 'movies-sort' },
    tv:    { mainPills: 'tv-main-categories',    subPills: 'tv-sub-categories',    content: 'tv-genre-sections-container',    sort: 'tv-sort'     }
};

// Per-section UI state
const catState = {
    movie: { mainIdx: 0, subIdx: null, page: 1, totalPages: 1 },
    tv:    { mainIdx: 0, subIdx: null, page: 1, totalPages: 1 }
};

// Stored handler refs so removeEventListener works across re-renders
const _subPillHandlers = { movie: null, tv: null };

// ── Movies ─────────────────────────────────────────────────────────────────────

async function loadMovies() {
    await loadCategorySection('movie');
}

// ── TV Shows ───────────────────────────────────────────────────────────────────

async function loadTV() {
    await loadCategorySection('tv');
}

// ── Category section (shared movies + TV) ─────────────────────────────────────

async function loadCategorySection(mt) {
    const ids = SECTION_IDS[mt];
    const mainPillsEl = document.getElementById(ids.mainPills);
    if (!mainPillsEl.querySelector('.main-pill')) {
        renderMainPills(mt);
    }
    renderSubPills(mt);
    await renderCategoryContent(mt);
}

function renderMainPills(mt) {
    const ids = SECTION_IDS[mt];
    const el  = document.getElementById(ids.mainPills);
    el.innerHTML = CATEGORIES[mt].map((cat, i) =>
        `<button class="main-pill category-pill${i === catState[mt].mainIdx ? ' active' : ''}" data-idx="${i}">${escapeHtml(cat.label)}</button>`
    ).join('');
    el.addEventListener('click', e => {
        const btn = e.target.closest('.main-pill');
        if (!btn) return;
        const idx = parseInt(btn.dataset.idx);
        if (idx === catState[mt].mainIdx && catState[mt].subIdx === null) return;
        catState[mt].mainIdx = idx;
        catState[mt].subIdx  = null;
        catState[mt].page    = 1;
        el.querySelectorAll('.main-pill').forEach((b, i) => b.classList.toggle('active', i === idx));
        renderSubPills(mt);
        renderCategoryContent(mt);
    });
}

function renderSubPills(mt) {
    const ids     = SECTION_IDS[mt];
    const mainIdx = catState[mt].mainIdx;
    const subs    = CATEGORIES[mt][mainIdx].subs;
    const el      = document.getElementById(ids.subPills);

    // Already rendered for this main category — just sync active states
    if (parseInt(el.dataset.forIdx) === mainIdx) {
        el.querySelectorAll('.sub-pill').forEach((b, i) => b.classList.toggle('active', i === catState[mt].subIdx));
        return;
    }

    el.dataset.forIdx = mainIdx;
    if (_subPillHandlers[mt]) el.removeEventListener('click', _subPillHandlers[mt]);
    el.innerHTML = '';
    if (!subs.length) return;

    el.innerHTML = subs.map((sub, i) =>
        `<button class="sub-pill sub-category-pill${i === catState[mt].subIdx ? ' active' : ''}" data-idx="${i}">${escapeHtml(sub.label)}</button>`
    ).join('');

    _subPillHandlers[mt] = e => {
        const btn = e.target.closest('.sub-pill');
        if (!btn) return;
        const idx = parseInt(btn.dataset.idx);
        catState[mt].subIdx = catState[mt].subIdx === idx ? null : idx;
        catState[mt].page   = 1;
        el.querySelectorAll('.sub-pill').forEach((b, i) => b.classList.toggle('active', i === catState[mt].subIdx));
        renderCategoryContent(mt);
    };
    el.addEventListener('click', _subPillHandlers[mt]);
}

async function renderCategoryContent(mt) {
    const { mainIdx, subIdx } = catState[mt];
    const main = CATEGORIES[mt][mainIdx];
    if (main.trending) {
        await renderTrendingGrid(mt);
    } else if (subIdx !== null || !main.subs.length) {
        await renderFilteredGrid(mt, 1);
    } else {
        renderSubRows(mt);
    }
}

async function renderTrendingGrid(mt) {
    const container = document.getElementById(SECTION_IDS[mt].content);
    container.innerHTML = '<p class="loading-msg">Loading...</p>';
    const data  = await API.content.trending().catch(() => ({ trending: { movies: [], tv: [] } }));
    const items = mt === 'movie'
        ? (data.trending?.movies || [])
        : (data.trending?.tv    || []);
    container.innerHTML = `<div class="content-grid cat-grid-content"></div>`;
    container.querySelector('.cat-grid-content').innerHTML =
        items.length ? items.map(buildCard).join('') : '<p class="empty-msg">Nothing trending right now.</p>';
}

function renderSubRows(mt) {
    const ids       = SECTION_IDS[mt];
    const main      = CATEGORIES[mt][catState[mt].mainIdx];
    const sort      = document.getElementById(ids.sort)?.value || 'popular';
    const container = document.getElementById(ids.content);

    container.innerHTML = main.subs.map((sub, i) => buildSubRowShell(sub.label, i, mt)).join('');

    observeGenreRows(container, async (row) => {
        const subIdx  = parseInt(row.dataset.subIdx);
        const sub     = main.subs[subIdx];
        const params  = buildCatFetchParams(main, sub, sort);
        const fetcher = mt === 'movie' ? API.content.movies : API.content.tvShows;
        const data    = await fetcher(params).catch(() => ({}));
        const items   = data.movies || data.tvShows || [];
        const el      = row.querySelector('.carousel-content');
        if (el) el.innerHTML = items.slice(0, 20).map(buildCard).join('') || '<p class="empty-msg">No results.</p>';
    });
}

async function renderFilteredGrid(mt, page) {
    const ids       = SECTION_IDS[mt];
    const main      = CATEGORIES[mt][catState[mt].mainIdx];
    const sub       = catState[mt].subIdx !== null ? main.subs[catState[mt].subIdx] : null;
    const sort      = document.getElementById(ids.sort)?.value || 'popular';
    const container = document.getElementById(ids.content);
    catState[mt].page = page;

    container.innerHTML = `
        <div class="content-grid cat-grid-content"></div>
        <div class="pagination-controls">
            <button class="pagination-btn cat-prev-btn" ${page <= 1 ? 'disabled' : ''}>← Prev</button>
            <span class="cat-page-info">Loading…</span>
            <button class="pagination-btn cat-next-btn">Next →</button>
        </div>
    `;

    const params  = buildCatFetchParams(main, sub, sort, page);
    const fetcher = mt === 'movie' ? API.content.movies : API.content.tvShows;
    const data    = await fetcher(params).catch(() => ({}));
    const items   = data.movies || data.tvShows || [];
    const total   = data.totalPages || 1;
    catState[mt].totalPages = total;

    container.querySelector('.cat-grid-content').innerHTML =
        items.length ? items.map(buildCard).join('') : '<p class="empty-msg">No results found.</p>';
    container.querySelector('.cat-page-info').textContent = `Page ${page} of ${total}`;
    container.querySelector('.cat-prev-btn').disabled = page <= 1;
    container.querySelector('.cat-next-btn').disabled = page >= total;
    container.querySelector('.cat-prev-btn').addEventListener('click', () => renderFilteredGrid(mt, catState[mt].page - 1));
    container.querySelector('.cat-next-btn').addEventListener('click', () => renderFilteredGrid(mt, catState[mt].page + 1));
}

function buildCatFetchParams(main, sub, sort, page = 1) {
    const genreIds = sub?.genreIds ?? main.genreIds;
    return {
        genre:          genreIds.join(','),
        keyword:        sub?.keyword,
        excludeKeyword: sub?.excludeKeyword,
        language:       sub?.language,
        sortBy:         sort,
        page
    };
}

// ── Anime — handled by anime.js / initAnimePage() ────────────────────────────

// ── Genre list (full paginated grid) ─────────────────────────────────────────

async function loadGenreList() {
    const { type, genreId, title, page, sortBy } = state.genreList;
    document.getElementById('genre-title').textContent = title || 'Browse';

    const container = document.getElementById('genre-list-grid');
    container.innerHTML = '<p class="loading-msg">Loading...</p>';

    const fetcher = type === 'movie' ? API.content.movies : API.content.tvShows;
    const data    = await fetcher({ genre: genreId, page, sortBy }).catch(() => ({}));
    const items   = data.movies || data.tvShows || [];
    const total   = data.totalPages || 1;

    state.genreList.totalPages = total;

    populateGrid('genre-list-grid', items);
    document.getElementById('page-info').textContent = `Page ${page} of ${total}`;
    document.getElementById('prev-page-btn').disabled = page <= 1;
    document.getElementById('next-page-btn').disabled = page >= total;
}

function openGenreList(genreId, type, title) {
    state.genreList = { type, genreId, title, page: 1, totalPages: 1, sortBy: 'popular' };
    navigateTo('genre-list');
}

// ── Search ────────────────────────────────────────────────────────────────────

async function runSearch(query) {
    if (!query.trim()) return;
    navigateTo('search');
    document.getElementById('search-title').textContent = `Results for "${query}"`;
    document.getElementById('search-grid').innerHTML = '<p class="loading-msg">Searching...</p>';

    const data = await API.content.search(query).catch(() => ({ results: [] }));
    populateGrid('search-grid', data.results);
}

// ── Content detail modal ──────────────────────────────────────────────────────

async function openContentDetail(contentId, type) {
    const modal = document.getElementById('content-detail-modal');
    modal.classList.add('active');

    const data = await API.content.details(type, contentId).catch(() => null);
    if (!data) { modal.classList.remove('active'); return; }
    state.selectedContent = data;

    const tmdbId = contentId.split('_')[1] || contentId;

    document.getElementById('detail-poster').src       = data.poster
        ? `https://image.tmdb.org/t/p/w342${data.poster}` : '/icons/placeholder.png';
    document.getElementById('detail-title').textContent    = data.title;
    document.getElementById('detail-overview').textContent = data.overview || '';
    document.getElementById('detail-meta').innerHTML =
        [data.year, data.rating ? `★ ${data.rating}` : null].filter(Boolean).join(' · ');

    // Movie progress bar
    const progSection = document.getElementById('detail-movie-progress');
    if (type === 'movie' && state.currentUser) {
        const p = await API.progress.get(state.currentUser.id, contentId).catch(() => null);
        if (p?.progress_time && p?.total_time) {
            const pct = Math.round((p.progress_time / p.total_time) * 100);
            document.getElementById('detail-movie-progress-text').textContent = `Watched: ${pct}%`;
            document.getElementById('detail-movie-progress-fill').style.width = `${pct}%`;
            progSection.style.display = 'block';
        } else {
            progSection.style.display = 'none';
        }
    } else {
        progSection.style.display = 'none';
    }

    // Episodes for TV
    const episodesSection = document.getElementById('detail-episodes-section');
    if (type === 'tv' && data.seasons?.length) {
        episodesSection.style.display = 'block';
        populateSeasonDropdown(data, contentId, tmdbId);
    } else {
        episodesSection.style.display = 'none';
    }

    // Prefetch stream in background — warms the server cache so Play is instant
    if (type === 'movie') {
        API.streams.movie(tmdbId).catch(() => {});
    } else if (data.seasons?.length) {
        const lastWatched = state.continueWatching?.find(c => c.content_id === contentId);
        const s = lastWatched?.season_number  || 1;
        const e = lastWatched?.episode_number || 1;
        API.streams.tv(tmdbId, s, e).catch(() => {});
    }

    // Play button label + action
    const lastWatched = state.continueWatching?.find(c => c.content_id === contentId);
    updatePlayButtonLabel(contentId, type, lastWatched);

    document.getElementById('detail-play-btn').onclick = () => {
        modal.classList.remove('active');
        if (type === 'movie') {
            play(contentId, 'movie', tmdbId);
        } else {
            const s = lastWatched?.season_number  || 1;
            const e = lastWatched?.episode_number || 1;
            play(contentId, 'tv', tmdbId, s, e);
        }
    };
}

async function updatePlayButtonLabel(contentId, type, lastWatched) {
    const btn = document.getElementById('detail-play-btn');
    if (type === 'tv') {
        btn.textContent = lastWatched ? '▶ Continue Watching' : '▶ Play';
        return;
    }
    // Movie
    if (!state.currentUser) { btn.textContent = '▶ Play'; return; }
    const p = await API.progress.get(state.currentUser.id, contentId).catch(() => null);
    if (!p?.progress_time) btn.textContent = '▶ Play';
    else if (p.completed)  btn.textContent = '▶ Watch Again';
    else                   btn.textContent = '▶ Continue Watching';
}

function populateSeasonDropdown(data, contentId, tmdbId) {
    const dropdown = document.getElementById('detail-season-dropdown');
    const seasons  = data.seasons.filter(s => s.seasonNumber > 0);
    dropdown.innerHTML = seasons.map(s =>
        `<option value="${s.seasonNumber}">Season ${s.seasonNumber}</option>`
    ).join('');

    dropdown.addEventListener('change', () => {
        loadEpisodeGrid(contentId, tmdbId, parseInt(dropdown.value));
    });
    loadEpisodeGrid(contentId, tmdbId, seasons[0]?.seasonNumber || 1);
}

async function loadEpisodeGrid(contentId, tmdbId, season) {
    const grid = document.getElementById('detail-episodes-grid');
    grid.innerHTML = '<p class="loading-msg">Loading episodes...</p>';

    const episodes = await API.content.episodes(contentId, season).catch(() => []);
    const progList = state.currentUser
        ? await API.progress.get(state.currentUser.id, contentId, season).catch(() => [])
        : [];

    const progMap = {};
    if (Array.isArray(progList)) {
        progList.forEach(p => { progMap[p.episode_number] = p.progress_time / (p.total_time || 1); });
    }

    grid.innerHTML = episodes.map(ep =>
        buildEpisodeCard(ep, progMap[ep.episodeNumber])
    ).join('');

    grid.querySelectorAll('.episode-card').forEach(card => {
        card.addEventListener('click', () => {
            const ep = parseInt(card.dataset.episode);
            const s  = parseInt(card.dataset.season);
            document.getElementById('content-detail-modal').classList.remove('active');
            play(contentId, 'tv', tmdbId, s, ep);
        });
    });
}

// ── User management ───────────────────────────────────────────────────────────

function wireUserModals() {
    // Create user
    document.getElementById('create-user-btn').addEventListener('click', () => {
        document.getElementById('new-user-modal').classList.add('active');
    });
    document.getElementById('cancel-user').addEventListener('click', () => {
        document.getElementById('new-user-modal').classList.remove('active');
    });
    document.getElementById('new-user-form').addEventListener('submit', async e => {
        e.preventDefault();
        const name     = document.getElementById('user-name-input').value.trim();
        const password = document.getElementById('user-password-input').value || null;
        const avatar   = document.querySelector('#new-user-modal .avatar-option.selected')
            ?.dataset.avatar || null;
        await API.users.create(name, avatar, password);
        document.getElementById('new-user-modal').classList.remove('active');
        await loadUserScreen();
    });

    // Avatar selection
    document.querySelectorAll('.avatar-option').forEach(opt => {
        opt.addEventListener('click', () => {
            opt.closest('.avatar-selection').querySelectorAll('.avatar-option')
               .forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
        });
    });

    // Theme selection (in create user modal)
    document.querySelectorAll('.theme-option').forEach(opt => {
        opt.addEventListener('click', () => {
            opt.closest('.theme-selection').querySelectorAll('.theme-option')
               .forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
        });
    });

    // Switch user
    document.getElementById('switch-user-btn').addEventListener('click', () => {
        state.currentUser = null;
        loadUserScreen();
    });

    // Password cancel
    document.getElementById('cancel-password-prompt').addEventListener('click', () => {
        document.getElementById('password-prompt-modal').classList.remove('active');
    });
}

// ── Theme & UI mode ───────────────────────────────────────────────────────────

function applyTheme(theme) {
    document.body.dataset.theme = theme || 'default';
}

function loadSavedPrefs() {
    applyTheme(localStorage.getItem('hs-theme') || 'default');
}

function wireCustomizeModal() {
    const modal      = document.getElementById('theme-settings-modal');
    const openBtn    = document.getElementById('theme-settings-btn');
    const closeBtn   = document.getElementById('close-customize');
    const cancelBtn  = document.getElementById('cancel-theme-settings');
    const applyBtn   = document.getElementById('apply-theme-settings');

    // Open
    openBtn?.addEventListener('click', () => {
        const savedTheme = localStorage.getItem('hs-theme') || 'default';
        modal.querySelectorAll('.theme-option').forEach(o =>
            o.classList.toggle('selected', o.dataset.theme === savedTheme)
        );
        modal.classList.add('active');
    });

    // Theme pill clicks
    modal.querySelectorAll('.theme-option').forEach(o =>
        o.addEventListener('click', () => {
            modal.querySelectorAll('.theme-option').forEach(x => x.classList.remove('selected'));
            o.classList.add('selected');
        })
    );

    // Apply
    applyBtn?.addEventListener('click', () => {
        const theme = modal.querySelector('.theme-option.selected')?.dataset.theme || 'default';
        localStorage.setItem('hs-theme', theme);
        applyTheme(theme);
        modal.classList.remove('active');
    });

    // Close / cancel
    [closeBtn, cancelBtn].forEach(b => b?.addEventListener('click', () => modal.classList.remove('active')));
}

// ── Global event wiring ───────────────────────────────────────────────────────

function wireGlobalEvents() {
    // Nav buttons
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => navigateTo(btn.dataset.section));
    });

    // Search
    const searchInput = document.getElementById('search-input');
    const searchBtn   = document.getElementById('search-btn');
    searchBtn.addEventListener('click', () => runSearch(searchInput.value));
    searchInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') runSearch(searchInput.value);
    });

    // Sort dropdowns — re-render current category view with new sort
    document.getElementById('movies-sort')?.addEventListener('change', () => {
        renderCategoryContent('movie');
    });
    document.getElementById('tv-sort')?.addEventListener('change', () => {
        renderCategoryContent('tv');
    });

    // Genre list pagination
    document.getElementById('prev-page-btn').addEventListener('click', async () => {
        if (state.genreList.page > 1) { state.genreList.page--; await loadGenreList(); }
    });
    document.getElementById('next-page-btn').addEventListener('click', async () => {
        if (state.genreList.page < state.genreList.totalPages) { state.genreList.page++; await loadGenreList(); }
    });
    document.getElementById('genre-sort')?.addEventListener('change', e => {
        state.genreList.sortBy = e.target.value;
        state.genreList.page   = 1;
        loadGenreList();
    });
    document.getElementById('back-to-section-btn').addEventListener('click', () => {
        navigateTo(state.previousSection || 'home');
    });

    // Content detail close
    document.querySelector('#content-detail-modal .close-modal')
        ?.addEventListener('click', () => {
            document.getElementById('content-detail-modal').classList.remove('active');
        });

    // Escape closes any open modal
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active'));
    });

    // Delegated card clicks (play + detail)
    document.addEventListener('click', e => {
        const card = e.target.closest('.content-card');
        if (!card) return;
        const playBtn = e.target.closest('.card-play-btn');
        const id   = card.dataset.id;
        const type = card.dataset.type;
        if (!id || !type) return;

        if (playBtn) {
            const tmdbId = id.split('_')[1] || id;
            if (type === 'movie') play(id, 'movie', tmdbId);
            else openContentDetail(id, type);
        } else {
            openContentDetail(id, type);
        }
    });

    // Delegated "See all" buttons
    document.addEventListener('click', e => {
        const btn = e.target.closest('.see-all-btn');
        if (!btn) return;
        const genreId = btn.dataset.genreId;
        const type    = btn.dataset.type;
        const row     = btn.closest('.genre-row');
        const title   = row?.querySelector('h3')?.textContent || 'Browse';
        openGenreList(genreId, type, title);
    });

    wireUserModals();
}

// ── Screen switching ──────────────────────────────────────────────────────────

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id)?.classList.add('active');
}

// Expose to inline HTML onclick attributes and cross-module calls
window.heartStreamApp = {
    closeContentDetail: () => {
        document.getElementById('content-detail-modal').classList.remove('active');
    }
};

// Used by anime.js to open the content detail modal after TMDB lookup
window.__openContentDetail = (contentId, type, fallback = null) => {
    if (contentId && type) {
        openContentDetail(contentId, type);
    } else if (fallback) {
        // No TMDB match — show a minimal modal with title + fallback iframe
        const modal = document.getElementById('content-detail-modal');
        document.getElementById('detail-title').textContent    = fallback.title || 'Unknown';
        document.getElementById('detail-overview').textContent = '';
        document.getElementById('detail-meta').innerHTML       = '';
        document.getElementById('detail-poster').src           = fallback.poster || '/icons/placeholder.png';
        document.getElementById('detail-episodes-section').style.display = 'none';
        document.getElementById('detail-movie-progress').style.display   = 'none';
        document.getElementById('detail-play-btn').textContent = '▶ Play';
        document.getElementById('detail-play-btn').onclick = () => {
            modal.classList.remove('active');
            // Search TMDB one more time then play — simplified: just show iframe
            alert('No stream found for this title yet.');
        };
        modal.classList.add('active');
    }
};
