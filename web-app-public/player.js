/**
 * player.js — all playback logic.
 *
 * Flow:
 *  1. play(contentId, type, tmdbId, season?, episode?) called from app.js
 *  2. Calls /api/stream/* — Jackettio via Real-Debrid
 *  3a. Direct URL returned → load into <video>, track via timeupdate
 *  3b. No direct URL     → load VidKing iframe as fallback
 *  4. Progress saved every 10s, on pause, and on close
 */

import { API } from './api-client.js';
import { state } from './state.js';

// DOM refs — resolved once in initPlayer()
let videoEl, iframeEl, modal, closeBtn, dubToggle, subBtn, dubBtnEl, qualityPicker, unmuteBtn;
let progressSaveTimer = null;
let lastSavedTime     = 0;
let currentHls        = null;
let countdownTimer    = null;

export function initPlayer() {
    videoEl       = document.getElementById('video-player');
    iframeEl      = document.getElementById('video-iframe');
    modal         = document.getElementById('video-player-modal');
    closeBtn      = document.getElementById('close-player');
    dubToggle     = document.getElementById('dub-toggle');
    subBtn        = document.getElementById('sub-btn');
    dubBtnEl      = document.getElementById('dub-btn-el');
    qualityPicker = document.getElementById('quality-picker');
    unmuteBtn     = document.getElementById('unmute-btn');

    closeBtn.addEventListener('click', closePlayer);
    modal.addEventListener('click', e => { if (e.target === modal) closePlayer(); });

    unmuteBtn?.addEventListener('click', () => {
        videoEl.muted = false;
        unmuteBtn.style.display = 'none';
    });

    videoEl.addEventListener('pause',  saveProgress);
    videoEl.addEventListener('ended',  onEnded);

    subBtn?.addEventListener('click',   () => setDubPref(false));
    dubBtnEl?.addEventListener('click', () => setDubPref(true));

    qualityPicker?.addEventListener('change', () => switchStream(qualityPicker.value));

    document.getElementById('play-next-btn')?.addEventListener('click', playNextEpisode);
    document.getElementById('cancel-next-btn')?.addEventListener('click', cancelNextEpisode);
    document.getElementById('cancel-auto-play')?.addEventListener('click', cancelNextEpisode);
}

// Attempt to play; if autoplay is blocked, retry muted and show the unmute button.
function tryPlay() {
    videoEl.muted = false;
    videoEl.play().catch(err => {
        if (err.name === 'NotAllowedError') {
            videoEl.muted = true;
            videoEl.play().catch(() => {});
            if (unmuteBtn) unmuteBtn.style.display = 'block';
        }
    });
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function play(contentId, type, tmdbId, season = null, episode = null) {
    state.player = { contentId, type, tmdbId, season, episode, usingFallback: false, allStreams: [] };

    openModal();
    showLoading();

    try {
        const result = type === 'movie'
            ? await API.streams.movie(tmdbId)
            : await API.streams.tv(tmdbId, season, episode);

        if (result.success && result.url) {
            await loadDirect(result);
        } else if (result.fallback && result.sources?.length) {
            loadIframe(result.sources[0].url);
        } else {
            showError('No stream found for this title.');
        }
    } catch (err) {
        console.error('[player]', err);
        showError('Could not load stream. Try again later.');
    }
}

// ── Direct stream ─────────────────────────────────────────────────────────────

function fallbackToIframe() {
    const { type, tmdbId, season, episode } = state.player;
    const url = type === 'movie'
        ? `https://vidsrc.xyz/embed/movie?tmdb=${tmdbId}`
        : `https://vidsrc.xyz/embed/tv?tmdb=${tmdbId}&season=${season}&episode=${episode}`;
    loadIframe(url);
}

async function loadDirect(result) {
    state.player.usingFallback = false;
    state.player.allStreams    = result.allStreams || [];

    const saved = await getSavedProgress();

    destroyHls();
    iframeEl.style.display = 'none';
    iframeEl.src           = '';
    videoEl.style.display  = 'block';

    if (result.mimeType === 'hls' && window.Hls?.isSupported()) {
        currentHls = new Hls();
        currentHls.loadSource(result.url);
        currentHls.attachMedia(videoEl);
        currentHls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (saved > 0) videoEl.currentTime = saved;
            tryPlay();
        });
    } else {
        videoEl.src = result.url;
        videoEl.load();

        let startupTimer = setTimeout(() => fallbackToIframe(), 25000);

        videoEl.addEventListener('loadedmetadata', () => {
            clearTimeout(startupTimer);
            if (saved > 0) videoEl.currentTime = saved;
            tryPlay();
        }, { once: true });

        videoEl.addEventListener('error', () => {
            clearTimeout(startupTimer);
            fallbackToIframe();
        }, { once: true });
    }

    hideLoading();
    updateQualityPicker(state.player.allStreams);
    updateDubToggle(state.player.allStreams);
    startProgressTimer();
}

// ── Iframe fallback ───────────────────────────────────────────────────────────

function loadIframe(url) {
    state.player.usingFallback = true;
    destroyHls();
    videoEl.style.display  = 'none';
    videoEl.src            = '';
    iframeEl.style.display = 'block';
    iframeEl.src           = url;
    hideLoading();
    if (qualityPicker) qualityPicker.style.display = 'none';
    if (dubToggle)     dubToggle.style.display     = 'none';
}

// ── Quality picker ────────────────────────────────────────────────────────────

function updateQualityPicker(streams) {
    if (!qualityPicker || !streams.length) {
        if (qualityPicker) qualityPicker.style.display = 'none';
        return;
    }
    qualityPicker.innerHTML = streams.map((s, i) =>
        `<option value="${i}">${s.name || `Stream ${i + 1}`}</option>`
    ).join('');
    qualityPicker.style.display = streams.length > 1 ? 'inline-block' : 'none';
    qualityPicker.value = '0';
}

function switchStream(index) {
    const stream = state.player.allStreams[parseInt(index)];
    if (!stream?.url) return;
    const current = videoEl.currentTime;
    destroyHls();
    videoEl.src = stream.url;
    videoEl.load();
    videoEl.addEventListener('loadedmetadata', () => {
        videoEl.currentTime = current;
        videoEl.play().catch(() => {});
    }, { once: true });
}

// ── Sub / Dub ─────────────────────────────────────────────────────────────────

function updateDubToggle(streams) {
    if (!dubToggle) return;
    const hasDub = streams.some(s => (s.name || '').toLowerCase().includes('dub'));
    dubToggle.style.display = hasDub ? 'flex' : 'none';
}

export function setDubPref(wantDub) {
    const streams = state.player.allStreams;
    const match = wantDub
        ? streams.find(s => (s.name || '').toLowerCase().includes('dub'))
        : streams.find(s => !(s.name || '').toLowerCase().includes('dub'));
    if (!match) return;

    subBtn?.classList.toggle('active', !wantDub);
    dubBtnEl?.classList.toggle('active', wantDub);

    const current = videoEl.currentTime;
    destroyHls();
    videoEl.src = match.url;
    videoEl.load();
    videoEl.addEventListener('loadedmetadata', () => {
        videoEl.currentTime = current;
        videoEl.play().catch(() => {});
    }, { once: true });
}

// ── Progress tracking ─────────────────────────────────────────────────────────

function startProgressTimer() {
    clearInterval(progressSaveTimer);
    progressSaveTimer = setInterval(saveProgress, 10000);
}

async function saveProgress() {
    if (state.player.usingFallback) return;
    if (!state.currentUser)         return;
    if (!videoEl.duration)          return;

    const progressTime = Math.floor(videoEl.currentTime);
    const totalTime    = Math.floor(videoEl.duration);
    if (progressTime === lastSavedTime || progressTime < 5) return;
    lastSavedTime = progressTime;

    await API.progress.save({
        userId:        state.currentUser.id,
        contentId:     state.player.contentId,
        contentType:   state.player.type,
        seasonNumber:  state.player.season,
        episodeNumber: state.player.episode,
        progressTime,
        totalTime,
        completed:     (progressTime / totalTime) >= 0.9
    }).catch(() => {});
}

async function getSavedProgress() {
    if (!state.currentUser) return 0;
    try {
        const p = await API.progress.get(
            state.currentUser.id,
            state.player.contentId,
            state.player.season,
            state.player.episode
        );
        if (!p?.progress_time || !p?.total_time) return 0;
        if (p.completed) return 0;
        return p.progress_time;
    } catch {
        return 0;
    }
}

function onEnded() {
    saveProgress();
    clearInterval(progressSaveTimer);
    if (state.player.type === 'tv' && state.player.episode != null) {
        scheduleNextEpisode();
    }
}

function scheduleNextEpisode() {
    const { season, episode } = state.player;
    const nextEp = episode + 1;

    const panel = document.getElementById('next-episode-panel');
    const countdownEl = document.getElementById('auto-play-countdown');
    const timerSpan = document.getElementById('countdown-timer');

    if (panel) {
        document.getElementById('next-episode-title').textContent = `Season ${season}, Episode ${nextEp}`;
        panel.style.display = 'flex';
    }
    if (countdownEl) countdownEl.style.display = 'flex';

    let seconds = 15;
    if (timerSpan) timerSpan.textContent = seconds;

    countdownTimer = setInterval(() => {
        seconds--;
        if (timerSpan) timerSpan.textContent = seconds;
        if (seconds <= 0) {
            clearInterval(countdownTimer);
            playNextEpisode();
        }
    }, 1000);
}

function playNextEpisode() {
    clearInterval(countdownTimer);
    hideNextEpisodeUI();
    const { contentId, type, tmdbId, season, episode } = state.player;
    play(contentId, type, tmdbId, season, episode + 1);
}

function cancelNextEpisode() {
    clearInterval(countdownTimer);
    hideNextEpisodeUI();
}

function hideNextEpisodeUI() {
    const panel = document.getElementById('next-episode-panel');
    const countdown = document.getElementById('auto-play-countdown');
    if (panel) panel.style.display = 'none';
    if (countdown) countdown.style.display = 'none';
}

// ── Modal helpers ─────────────────────────────────────────────────────────────

function openModal() {
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

export function closePlayer() {
    saveProgress();
    clearInterval(progressSaveTimer);
    clearInterval(countdownTimer);
    hideNextEpisodeUI();
    lastSavedTime = 0;
    videoEl.pause();  // settle any pending play() promise before HLS.js teardown
    destroyHls();
    videoEl.muted          = false;
    videoEl.src            = '';
    iframeEl.src           = '';
    if (unmuteBtn) unmuteBtn.style.display = 'none';
    videoEl.style.display  = 'none';
    iframeEl.style.display = 'none';

    modal.classList.remove('active');
    document.body.style.overflow = '';

    state.player = {
        contentId: null, type: null, tmdbId: null,
        season: null, episode: null, usingFallback: false, allStreams: []
    };

    document.dispatchEvent(new CustomEvent('player:closed'));
}

function showLoading() {
    videoEl.style.display  = 'none';
    iframeEl.style.display = 'none';
    const overlay = document.getElementById('stream-reconnect-overlay');
    overlay.innerHTML = `<div class="reconnect-content"><div class="reconnect-spinner"></div><p>Finding stream...</p></div>`;
    overlay.style.display = 'flex';
}

function hideLoading() {
    document.getElementById('stream-reconnect-overlay').style.display = 'none';
}

function showError(msg) {
    const overlay = document.getElementById('stream-reconnect-overlay');
    overlay.innerHTML = `<div class="reconnect-content"><p style="color:#ef4444">${msg}</p><button onclick="document.getElementById('close-player').click()" style="margin-top:1rem;padding:0.5rem 1rem;background:#374151;border:none;border-radius:6px;color:#fff;cursor:pointer">Close</button></div>`;
    overlay.style.display = 'flex';
}

function destroyHls() {
    if (currentHls) {
        currentHls.destroy();
        currentHls = null;
    }
}
