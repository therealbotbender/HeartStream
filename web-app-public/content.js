/**
 * content.js — rendering helpers.
 * Builds card HTML, populates carousels and grids.
 * No fetch calls here — data comes in, DOM goes out.
 */

import { state } from './state.js';

const TMDB_IMG = 'https://image.tmdb.org/t/p/w342';
const TMDB_IMG_BACKDROP = 'https://image.tmdb.org/t/p/w780';

// ── Card builder ─────────────────────────────────────────────────────────────

export function buildCard(item) {
    const poster = item.poster
        ? `${TMDB_IMG}${item.poster}`
        : item.posterPath
            ? `${TMDB_IMG}${item.posterPath}`
            : '/icons/placeholder.png';

    const watchEntry = getWatchEntry(item.id);
    const progress   = watchEntry && watchEntry.total_time ? watchEntry.progress_time / watchEntry.total_time : 0;

    const epLabel = item.type === 'tv' && watchEntry?.season_number
        ? `<span class="card-ep-label">S${watchEntry.season_number} E${watchEntry.episode_number}</span>`
        : '';

    const progressBar = progress > 0
        ? `<div class="card-progress-wrap">${epLabel}<div class="card-progress-bar"><div class="card-progress-fill" style="width:${Math.round(progress * 100)}%"></div></div></div>`
        : '';

    const year = item.year || item.releaseDate?.slice(0, 4) || item.firstAirDate?.slice(0, 4) || '';

    return `
        <div class="content-card" data-id="${item.id}" data-type="${item.type}">
            <div class="card-poster">
                <img src="${poster}" alt="${escapeHtml(item.title)}" loading="lazy"
                     onerror="this.src='/icons/placeholder.png'">
                <div class="card-overlay">
                    <button class="card-play-btn" title="Play">▶</button>
                </div>
                ${progressBar}
            </div>
            <div class="card-info">
                <p class="card-title">${escapeHtml(item.title)}</p>
                ${year ? `<span class="card-year">${year}</span>` : ''}
            </div>
        </div>
    `.trim();
}

function getWatchEntry(contentId) {
    if (!state.currentUser) return null;
    return state.continueWatching.find(c => c.content_id === contentId) || null;
}

// ── Carousel ──────────────────────────────────────────────────────────────────

export function populateCarousel(containerId, items) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = items.length
        ? items.map(buildCard).join('')
        : '<p class="empty-msg">Nothing here yet.</p>';
}

// ── Generic grid ─────────────────────────────────────────────────────────────

export function populateGrid(containerId, items) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = items.length
        ? items.map(buildCard).join('')
        : '<p class="empty-msg">No results found.</p>';
}

// ── Genre section rows (multi-row default view) ───────────────────────────────

export function buildGenreRow(title, items, genreId, type) {
    if (!items || !items.length) return '';
    const rowId = `genre-row-${genreId}`;
    const cards  = items.map(buildCard).join('');
    return `
        <div class="genre-row" data-genre-id="${genreId}" data-type="${type}">
            <div class="section-header">
                <h3>${escapeHtml(title)}</h3>
                <button class="see-all-btn" data-genre-id="${genreId}" data-type="${type}">See all →</button>
            </div>
            <div class="genre-carousel-container">
                <button class="carousel-arrow carousel-arrow-left" data-target="${rowId}">‹</button>
                <div id="${rowId}" class="carousel-content">${cards}</div>
                <button class="carousel-arrow carousel-arrow-right" data-target="${rowId}">›</button>
            </div>
        </div>
    `.trim();
}

// Sub-category row shell — populated by lazy observer; uses data-sub-idx instead of data-genre-id
export function buildSubRowShell(title, subIdx, mt) {
    const rowId = `sub-row-${mt}-${subIdx}`;
    return `
        <div class="genre-row" data-sub-idx="${subIdx}" data-type="${mt}" data-lazy="pending">
            <div class="section-header">
                <h3>${escapeHtml(title)}</h3>
            </div>
            <div class="genre-carousel-container">
                <button class="carousel-arrow carousel-arrow-left" data-target="${rowId}">‹</button>
                <div id="${rowId}" class="carousel-content">
                    <div class="skeleton-cards">${Array(8).fill('<div class="skeleton-card"></div>').join('')}</div>
                </div>
                <button class="carousel-arrow carousel-arrow-right" data-target="${rowId}">›</button>
            </div>
        </div>
    `.trim();
}

// Shell with no cards — populated later via lazy observer
export function buildGenreRowShell(title, genreId, type) {
    const rowId = `genre-row-${genreId}`;
    return `
        <div class="genre-row" data-genre-id="${genreId}" data-type="${type}" data-lazy="pending">
            <div class="section-header">
                <h3>${escapeHtml(title)}</h3>
                <button class="see-all-btn" data-genre-id="${genreId}" data-type="${type}">See all →</button>
            </div>
            <div class="genre-carousel-container">
                <button class="carousel-arrow carousel-arrow-left" data-target="${rowId}">‹</button>
                <div id="${rowId}" class="carousel-content">
                    <div class="skeleton-cards">${Array(8).fill('<div class="skeleton-card"></div>').join('')}</div>
                </div>
                <button class="carousel-arrow carousel-arrow-right" data-target="${rowId}">›</button>
            </div>
        </div>
    `.trim();
}

// ── Episode card ──────────────────────────────────────────────────────────────

export function buildEpisodeCard(ep, watchedProgress) {
    const pct = watchedProgress ? Math.round(watchedProgress * 100) : 0;
    const watched = pct >= 90 ? ' ep-watched' : '';
    const overview = ep.overview ? `<p class="ep-overview">${escapeHtml(ep.overview)}</p>` : '';

    return `
        <div class="episode-card${watched}"
             data-episode="${ep.episodeNumber}"
             data-season="${ep.seasonNumber}">
            <div class="ep-row">
                <span class="ep-label">E${ep.episodeNumber}</span>
                <span class="ep-title">${escapeHtml(ep.title || 'Episode ' + ep.episodeNumber)}</span>
            </div>
            ${overview}
            <div class="ep-bar"><div class="ep-bar-fill" style="width:${pct}%"></div></div>
        </div>
    `.trim();
}

// ── Carousel scroll (called via delegated click) ──────────────────────────────

export function scrollCarousel(targetId, direction) {
    const el = document.getElementById(targetId);
    if (!el) return;
    const amount = el.clientWidth * 0.8;
    el.scrollBy({ left: direction === 'left' ? -amount : amount, behavior: 'smooth' });
}

// ── Utility ───────────────────────────────────────────────────────────────────

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
