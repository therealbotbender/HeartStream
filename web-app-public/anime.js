/**
 * anime.js — Anime page.
 *
 * Data source: AniList (via backend /api/anime/* routes).
 * Playback: anime card click → TMDB search by title → normal content detail modal.
 *
 * Layout:
 *   Default (no pill active): three carousels — Airing | This Season | Top Rated
 *   Pill active: single carousel for that genre/tag
 */

import { API } from './api-client.js';

const TMDB_IMG = 'https://image.tmdb.org/t/p/w342';

// Category pills — label + how to fetch
const CATEGORIES = [
    { label: 'Airing Now',   fetch: () => get('/api/anime/airing') },
    { label: 'This Season',  fetch: () => get('/api/anime/season') },
    { label: 'Top Rated',    fetch: () => get('/api/anime/top') },
    { label: 'Action',       fetch: () => get('/api/anime/genre/Action') },
    { label: 'Romance',      fetch: () => get('/api/anime/genre/Romance') },
    { label: 'Comedy',       fetch: () => get('/api/anime/genre/Comedy') },
    { label: 'Drama',        fetch: () => get('/api/anime/genre/Drama') },
    { label: 'Isekai',       fetch: () => get('/api/anime/tag/Isekai') },
    { label: 'Mecha',        fetch: () => get('/api/anime/genre/Mecha') },
    { label: 'Sports',       fetch: () => get('/api/anime/genre/Sports') },
    { label: 'Horror',       fetch: () => get('/api/anime/genre/Horror') },
    { label: 'Sci-Fi',       fetch: () => get('/api/anime/genre/Sci-Fi') },
];

let activeCategory = null;  // null = default multi-row view

// ── Init ──────────────────────────────────────────────────────────────────────

export async function initAnimePage() {
    renderPills();
    await loadDefaultView();
}

// ── Pills ─────────────────────────────────────────────────────────────────────

function renderPills() {
    const container = document.getElementById('anime-category-pills');
    if (!container) return;
    container.innerHTML = CATEGORIES.map((cat, i) =>
        `<button class="category-pill" data-index="${i}">${cat.label}</button>`
    ).join('');

    container.querySelectorAll('.category-pill').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.index);
            if (activeCategory === idx) {
                // Deselect → back to default
                activeCategory = null;
                container.querySelectorAll('.category-pill').forEach(b => b.classList.remove('active'));
                loadDefaultView();
            } else {
                activeCategory = idx;
                container.querySelectorAll('.category-pill').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                loadCategoryView(CATEGORIES[idx]);
            }
        });
    });
}

// ── Default view — three rows ─────────────────────────────────────────────────

async function loadDefaultView() {
    const container = document.getElementById('anime-content-container');
    container.innerHTML = '<p class="loading-msg">Loading anime...</p>';

    const [airing, seasonal, top] = await Promise.all([
        get('/api/anime/airing').catch(() => []),
        get('/api/anime/season').catch(() => []),
        get('/api/anime/top').catch(() => []),
    ]);

    container.innerHTML = [
        buildRow('Airing Now',  airing,   'airing'),
        buildRow('This Season', seasonal, 'seasonal'),
        buildRow('Top Rated',   top,      'top'),
    ].join('');

    wireCardClicks(container);
}

// ── Category view — single row ────────────────────────────────────────────────

async function loadCategoryView(cat) {
    const container = document.getElementById('anime-content-container');
    container.innerHTML = '<p class="loading-msg">Loading...</p>';

    const items = await cat.fetch().catch(() => []);
    container.innerHTML = items.length
        ? buildRow(cat.label, items, 'filtered')
        : '<p class="empty-msg">Nothing found.</p>';

    wireCardClicks(container);
}

// ── Row builder ───────────────────────────────────────────────────────────────

function buildRow(title, items, rowId) {
    if (!items?.length) return '';
    const cards = items.map(buildAnimeCard).join('');
    return `
        <div class="genre-row">
            <div class="section-header">
                <h3>${title}</h3>
            </div>
            <div class="genre-carousel-container">
                <button class="carousel-arrow carousel-arrow-left" data-target="anime-row-${rowId}">‹</button>
                <div id="anime-row-${rowId}" class="carousel-content">${cards}</div>
                <button class="carousel-arrow carousel-arrow-right" data-target="anime-row-${rowId}">›</button>
            </div>
        </div>
    `.trim();
}

// ── Anime card ────────────────────────────────────────────────────────────────

function buildAnimeCard(anime) {
    const poster = anime.poster || '/icons/placeholder.png';
    const title  = escapeHtml(anime.title || anime.titleRomaji || '');
    const year   = anime.year || '';
    const score  = anime.rating ? `★ ${anime.rating}` : '';
    const eps    = anime.episodes ? `${anime.episodes} ep` : '';
    const meta   = [year, score, eps].filter(Boolean).join(' · ');

    // Store data on the element — click handler reads it
    return `
        <div class="content-card anime-card"
             data-anilist-id="${anime.anilistId}"
             data-title="${title}"
             data-type="${anime.type}"
             data-poster="${escapeHtml(poster)}">
            <div class="card-poster">
                <img src="${escapeHtml(poster)}" alt="${title}" loading="lazy"
                     onerror="this.src='/icons/placeholder.png'">
                <div class="card-overlay">
                    <button class="card-play-btn" title="Play">▶</button>
                </div>
                ${anime.status === 'RELEASING'
                    ? '<span class="anime-badge">AIRING</span>'
                    : ''}
            </div>
            <div class="card-info">
                <p class="card-title">${title}</p>
                ${meta ? `<span class="card-year">${meta}</span>` : ''}
            </div>
        </div>
    `.trim();
}

// ── Card click → TMDB lookup → content detail ─────────────────────────────────

function wireCardClicks(container) {
    container.querySelectorAll('.anime-card').forEach(card => {
        card.addEventListener('click', () => openAnimeDetail(card));
    });
}

async function openAnimeDetail(card) {
    const title = card.dataset.title;
    const type  = card.dataset.type || 'tv';

    // Show brief loading state on the card
    card.style.opacity = '0.6';

    try {
        // Search TMDB for this anime title
        const results = await API.content.search(title);
        const match   = results?.results?.find(r => r.type === type)
                     || results?.results?.[0];

        card.style.opacity = '';

        if (match) {
            // Fire the global content detail opener (defined in app.js)
            window.__openContentDetail?.(match.id, match.type);
        } else {
            // No TMDB match — fall back to iframe search
            window.__openContentDetail?.(null, null, { title, poster: card.dataset.poster });
        }
    } catch {
        card.style.opacity = '';
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function get(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json();
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
