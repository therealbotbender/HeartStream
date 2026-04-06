/**
 * player.js — all playback logic.
 *
 * Flow:
 *  1. play(contentId, type, tmdbId, season?, episode?) called from app.js
 *  2. Calls /api/stream/* — Jackettio via Real-Debrid
 *  3. Direct URL → <video> with HLS.js or native, custom controls
 *  4. Progress saved every 10s, on pause, and on close
 *  5. Skip intro button shown when within detected intro window
 *  6. Play next episode on video end with 15s countdown + season boundary check
 */

import { API } from './api-client.js';
import { state } from './state.js';

// DOM refs — resolved once in initPlayer()
let videoEl, modal, closeBtn, dubToggle,
    subBtn, dubBtnEl, qualityPicker, unmuteBtn, customControls;
let progressSaveTimer = null;
let lastSavedTime     = 0;
let currentHls        = null;
let countdownTimer    = null;
let hideControlsTimer = null;
let introTimes        = null; // { intro_start, intro_end } seconds
let endingTimes       = null; // { ending_start, ending_end } seconds — from AniSkip 'ed' or null
let autoSkipIntro     = localStorage.getItem('hs-auto-skip-intro') === 'true';
let autoPlayNext      = localStorage.getItem('hs-auto-play-next')  === 'true';

export function initPlayer() {
    videoEl        = document.getElementById('video-player');
    modal          = document.getElementById('video-player-modal');
    closeBtn       = document.getElementById('close-player');
    dubToggle      = document.getElementById('dub-toggle');
    subBtn         = document.getElementById('sub-btn');
    dubBtnEl       = document.getElementById('dub-btn-el');
    qualityPicker  = document.getElementById('quality-picker');
    unmuteBtn      = document.getElementById('unmute-btn');
    customControls = document.getElementById('custom-controls');

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

    document.getElementById('skip-intro-btn')?.addEventListener('click', skipIntro);
    document.getElementById('submit-intro-btn')?.addEventListener('click', openSubmitIntroModal);

    // Auto-skip toggle
    const autoSkipEl = document.getElementById('auto-skip-toggle');
    if (autoSkipEl) {
        autoSkipEl.checked = autoSkipIntro;
        autoSkipEl.addEventListener('change', () => {
            autoSkipIntro = autoSkipEl.checked;
            localStorage.setItem('hs-auto-skip-intro', autoSkipIntro);
        });
    }

    // Auto-play-next toggle
    const autoPlayEl = document.getElementById('auto-play-next-toggle');
    if (autoPlayEl) {
        autoPlayEl.checked = autoPlayNext;
        autoPlayEl.addEventListener('change', () => {
            autoPlayNext = autoPlayEl.checked;
            localStorage.setItem('hs-auto-play-next', autoPlayNext);
        });
    }

    wireSubmitIntroModal();
    initCustomControls();
}

// ── Custom controls ───────────────────────────────────────────────────────────

function initCustomControls() {
    const playBtn      = document.getElementById('ctrl-play');
    const muteBtn      = document.getElementById('ctrl-mute');
    const volumeSlider = document.getElementById('ctrl-volume');
    const seekBar      = document.getElementById('ctrl-seek-bar');
    const fsBtn        = document.getElementById('ctrl-fullscreen');

    playBtn?.addEventListener('click', () => {
        if (videoEl.paused) videoEl.play().catch(() => {});
        else videoEl.pause();
    });

    muteBtn?.addEventListener('click', () => {
        videoEl.muted = !videoEl.muted;
        updateMuteIcon();
    });

    volumeSlider?.addEventListener('input', () => {
        videoEl.volume = parseFloat(volumeSlider.value);
        videoEl.muted  = videoEl.volume === 0;
        updateMuteIcon();
    });

    fsBtn?.addEventListener('click', toggleFullscreen);

    seekBar?.addEventListener('mousedown', e => {
        seekToEvent(e);
        const onMove = ev => seekToEvent(ev);
        const onUp   = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });

    videoEl.addEventListener('timeupdate',   () => { updateSeekBar(); checkSkipIntro(); checkNearEnd(); });
    videoEl.addEventListener('play',         () => { if (playBtn) playBtn.textContent = '⏸'; });
    videoEl.addEventListener('pause',        () => { if (playBtn) playBtn.textContent = '▶'; });
    videoEl.addEventListener('volumechange', updateMuteIcon);

    const container = document.querySelector('.video-player-container');
    container?.addEventListener('mousemove', showControls);
    container?.addEventListener('mouseleave', () => scheduleHideControls(1000));

    document.addEventListener('keydown', onKeyDown);
}

function seekToEvent(e) {
    const seekBar = document.getElementById('ctrl-seek-bar');
    if (!seekBar || !videoEl.duration) return;
    const rect = seekBar.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    videoEl.currentTime = pct * videoEl.duration;
}

function updateSeekBar() {
    const fill   = document.getElementById('ctrl-seek-fill');
    const handle = document.getElementById('ctrl-seek-handle');
    const time   = document.getElementById('ctrl-time');
    if (!videoEl.duration) return;
    const pct = videoEl.currentTime / videoEl.duration;
    if (fill)   fill.style.width  = `${pct * 100}%`;
    if (handle) handle.style.left = `${pct * 100}%`;
    if (time)   time.textContent  = `${fmtTime(videoEl.currentTime)} / ${fmtTime(videoEl.duration)}`;
}

function updateMuteIcon() {
    const btn = document.getElementById('ctrl-mute');
    const vol = document.getElementById('ctrl-volume');
    if (!btn) return;
    btn.textContent = (videoEl.muted || videoEl.volume === 0) ? '🔇' : '🔊';
    if (vol) vol.value = videoEl.muted ? 0 : videoEl.volume;
}

function toggleFullscreen() {
    const container = document.querySelector('.video-player-container');
    if (!document.fullscreenElement) container?.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
}

function showControls() {
    if (!customControls) return;
    customControls.classList.remove('controls-hidden');
    scheduleHideControls(3000);
}

function scheduleHideControls(delay) {
    clearTimeout(hideControlsTimer);
    hideControlsTimer = setTimeout(() => {
        if (!videoEl.paused) customControls?.classList.add('controls-hidden');
    }, delay);
}

function onKeyDown(e) {
    if (!modal.classList.contains('active')) return;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    switch (e.key) {
        case ' ': case 'k':
            e.preventDefault();
            videoEl.paused ? videoEl.play().catch(() => {}) : videoEl.pause();
            break;
        case 'ArrowRight': videoEl.currentTime += 10; break;
        case 'ArrowLeft':  videoEl.currentTime -= 10; break;
        case 'ArrowUp':    videoEl.volume = Math.min(1, videoEl.volume + 0.1); break;
        case 'ArrowDown':  videoEl.volume = Math.max(0, videoEl.volume - 0.1); break;
        case 'm': case 'M': videoEl.muted = !videoEl.muted; break;
        case 'f': case 'F': toggleFullscreen(); break;
    }
}

function fmtTime(s) {
    const h   = Math.floor(s / 3600);
    const m   = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return h > 0
        ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
        : `${m}:${String(sec).padStart(2,'0')}`;
}

// ── Autoplay helper ───────────────────────────────────────────────────────────

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
    state.player = { contentId, type, tmdbId, season, episode, allStreams: [] };
    introTimes   = null;
    endingTimes  = null;

    openModal();
    showLoading();

    try {
        const result = type === 'movie'
            ? await API.streams.movie(tmdbId)
            : await API.streams.tv(tmdbId, season, episode);

        if (result.success && result.url) {
            await loadDirect(result);
        } else {
            showError('No stream found for this title.');
        }
    } catch (err) {
        console.error('[player]', err);
        showError('Could not load stream. Try again later.');
    }
}

// ── Codec / container capability detection ────────────────────────────────────

function canPlayNativeMkv() {
    return /Chrome\//.test(navigator.userAgent);
}

// ── Direct stream ─────────────────────────────────────────────────────────────

async function loadDirect(result) {
    state.player.allStreams = result.allStreams || [];

    if (result.nativeUrl && canPlayNativeMkv()) {
        result = { ...result, url: result.nativeUrl, mimeType: 'mp4' };
    }

    const saved = await getSavedProgress();

    destroyHls();
    videoEl.style.display        = 'block';
    customControls.style.display = 'flex';

    if (result.mimeType === 'hls' && window.Hls?.isSupported()) {
        currentHls = new Hls({
            fragLoadingTimeOut:    120000,
            fragLoadingMaxRetry:   6,
            fragLoadingRetryDelay: 2000,
        });
        currentHls.loadSource(result.url);
        currentHls.attachMedia(videoEl);
        currentHls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (saved > 0) videoEl.currentTime = saved;
            tryPlay();
        });
    } else {
        videoEl.src = result.url;
        videoEl.load();
        videoEl.addEventListener('loadedmetadata', () => {
            if (saved > 0) videoEl.currentTime = saved;
            tryPlay();
        }, { once: true });
        videoEl.addEventListener('error', () => {
            showError('Stream failed to load. The file may be unsupported.');
        }, { once: true });
    }

    hideLoading();
    updateQualityPicker(state.player.allStreams);
    updateDubToggle(state.player.allStreams);
    startProgressTimer();
    showControls();

    // Show/hide submit intro button and fetch times (TV only)
    const submitBtn = document.getElementById('submit-intro-btn');
    if (state.player.type === 'tv' && state.player.season != null) {
        if (submitBtn) submitBtn.style.display = 'block';
        fetchIntroTimes();
    } else {
        if (submitBtn) submitBtn.style.display = 'none';
    }
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

// ── Skip intro ────────────────────────────────────────────────────────────────

async function fetchIntroTimes() {
    try {
        const data = await API.intro.get(
            state.player.contentId,
            state.player.season,
            state.player.episode,
            state.player.tmdbId,
            state.player.type
        );
        introTimes  = (data?.intro_start != null)  ? data : null;
        endingTimes = (data?.ending_start != null)  ? data : null;
    } catch {
        introTimes  = null;
        endingTimes = null;
    }
}

function checkSkipIntro() {
    const container = document.getElementById('skip-intro-container');
    if (!container) return;
    if (!introTimes) { container.style.display = 'none'; return; }
    const t = videoEl.currentTime;
    const inIntro = t >= introTimes.intro_start && t < introTimes.intro_end;
    if (inIntro) {
        container.style.display = 'flex';
        if (autoSkipIntro) { skipIntro(); return; }
    } else {
        container.style.display = 'none';
    }
}

function skipIntro() {
    if (introTimes) videoEl.currentTime = introTimes.intro_end;
}

function checkNearEnd() {
    if (state.player.type !== 'tv') return;
    if (!videoEl.duration || videoEl.duration < 120) return;

    const panel = document.getElementById('next-episode-panel');
    if (!panel || panel.style.display !== 'none') return; // already showing

    const t         = videoEl.currentTime;
    const remaining = videoEl.duration - t;

    // Use AniSkip ending timestamp if available, otherwise 90s heuristic
    const triggered = endingTimes
        ? (t >= endingTimes.ending_start)
        : (remaining <= 90);

    if (!triggered) return;

    const next = getNextEpisode();
    if (!next) return;

    if (autoPlayNext) {
        playNextEpisode();
        return;
    }

    document.getElementById('next-episode-title').textContent =
        `Season ${next.season}, Episode ${next.episode}`;
    panel.style.display = 'flex';
}

// ── Submit intro modal ────────────────────────────────────────────────────────

function openSubmitIntroModal() {
    const m = document.getElementById('submit-intro-modal');
    if (!m) return;
    updateCurrentVideoTime();
    document.getElementById('intro-start-input').value = '';
    document.getElementById('intro-end-input').value   = '';
    document.getElementById('intro-preview').style.display = 'none';
    m.classList.add('active');
}

function updateCurrentVideoTime() {
    const el = document.getElementById('current-video-time');
    if (el) el.textContent = fmtTime(videoEl.currentTime);
}

function wireSubmitIntroModal() {
    const m = document.getElementById('submit-intro-modal');
    if (!m) return;

    // Keep current time display updated while modal is open
    videoEl.addEventListener('timeupdate', () => {
        if (m.classList.contains('active')) updateCurrentVideoTime();
    });

    document.getElementById('set-intro-start-btn')?.addEventListener('click', () => {
        document.getElementById('intro-start-input').value = Math.floor(videoEl.currentTime);
        updateIntroPreview();
    });

    document.getElementById('set-intro-end-btn')?.addEventListener('click', () => {
        document.getElementById('intro-end-input').value = Math.floor(videoEl.currentTime);
        updateIntroPreview();
    });

    ['intro-start-input', 'intro-end-input'].forEach(id =>
        document.getElementById(id)?.addEventListener('input', updateIntroPreview)
    );

    document.getElementById('cancel-intro-submission')?.addEventListener('click', () => {
        m.classList.remove('active');
    });

    document.getElementById('intro-submission-form')?.addEventListener('submit', async e => {
        e.preventDefault();
        const introStart = parseInt(document.getElementById('intro-start-input').value);
        const introEnd   = parseInt(document.getElementById('intro-end-input').value);
        if (isNaN(introStart) || isNaN(introEnd) || introEnd <= introStart) return;

        try {
            await API.intro.submit({
                userId:        state.currentUser?.id || null,
                contentId:     state.player.contentId,
                seasonNumber:  state.player.season,
                episodeNumber: state.player.episode,
                introStart, introEnd
            });
            introTimes = { intro_start: introStart, intro_end: introEnd };
            m.classList.remove('active');
        } catch (err) {
            console.error('[player] intro submit failed', err);
        }
    });
}

function updateIntroPreview() {
    const start = parseInt(document.getElementById('intro-start-input').value);
    const end   = parseInt(document.getElementById('intro-end-input').value);
    const preview = document.getElementById('intro-preview');
    if (!preview) return;
    if (!isNaN(start) && !isNaN(end) && end > start) {
        document.getElementById('preview-start').textContent    = start;
        document.getElementById('preview-end').textContent      = end;
        document.getElementById('preview-duration').textContent = end - start;
        preview.style.display = 'block';
    } else {
        preview.style.display = 'none';
    }
}

// ── Progress tracking ─────────────────────────────────────────────────────────

function startProgressTimer() {
    clearInterval(progressSaveTimer);
    progressSaveTimer = setInterval(saveProgress, 10000);
}

async function saveProgress() {
    if (!state.currentUser)  return;
    if (!videoEl.duration)   return;

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

// ── Play next episode ─────────────────────────────────────────────────────────

function onEnded() {
    saveProgress();
    clearInterval(progressSaveTimer);
    if (state.player.type === 'tv' && state.player.episode != null) {
        scheduleNextEpisode();
    }
}

function getNextEpisode() {
    const { season, episode } = state.player;
    const seasons = state.selectedContent?.seasons || [];

    const currentSeasonInfo = seasons.find(s => s.seasonNumber === season);
    const hasNextInSeason   = currentSeasonInfo
        ? episode < currentSeasonInfo.episodeCount
        : true; // unknown — optimistically try

    if (hasNextInSeason) {
        return { season, episode: episode + 1 };
    }

    // Try next season
    const nextSeasonInfo = seasons.find(s => s.seasonNumber === season + 1);
    if (nextSeasonInfo) {
        return { season: season + 1, episode: 1 };
    }

    return null; // Series complete
}

function scheduleNextEpisode() {
    const next = getNextEpisode();
    if (!next) return; // Last episode — nothing to queue

    if (autoPlayNext) {
        playNextEpisode();
        return;
    }

    const panel      = document.getElementById('next-episode-panel');
    const countdownEl = document.getElementById('auto-play-countdown');
    const timerSpan  = document.getElementById('countdown-timer');

    if (panel) {
        document.getElementById('next-episode-title').textContent =
            `Season ${next.season}, Episode ${next.episode}`;
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
    const next = getNextEpisode();
    if (!next) return;
    clearInterval(countdownTimer);
    hideNextEpisodeUI();
    const { contentId, type, tmdbId } = state.player;
    play(contentId, type, tmdbId, next.season, next.episode);
}

function cancelNextEpisode() {
    clearInterval(countdownTimer);
    hideNextEpisodeUI();
}

function hideNextEpisodeUI() {
    const panel     = document.getElementById('next-episode-panel');
    const countdown = document.getElementById('auto-play-countdown');
    if (panel)     panel.style.display     = 'none';
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
    clearTimeout(hideControlsTimer);
    hideNextEpisodeUI();
    const skipContainer = document.getElementById('skip-intro-container');
    if (skipContainer) skipContainer.style.display = 'none';
    document.getElementById('submit-intro-btn').style.display   = 'none';
    document.getElementById('submit-intro-modal')?.classList.remove('active');
    lastSavedTime = 0;
    introTimes    = null;
    endingTimes   = null;
    videoEl.pause();
    destroyHls();
    videoEl.muted  = false;
    videoEl.src    = '';
    if (unmuteBtn) unmuteBtn.style.display = 'none';
    videoEl.style.display        = 'none';
    customControls.style.display = 'none';
    customControls.classList.remove('controls-hidden');

    modal.classList.remove('active');
    document.body.style.overflow = '';

    state.player = { contentId: null, type: null, tmdbId: null, season: null, episode: null, allStreams: [] };
    document.dispatchEvent(new CustomEvent('player:closed'));
}

function showLoading() {
    videoEl.style.display        = 'none';
    customControls.style.display = 'none';
    const overlay = document.getElementById('stream-reconnect-overlay');
    overlay.innerHTML = `<div class="reconnect-content"><div class="reconnect-spinner"></div><p>Finding stream...</p></div>`;
    overlay.style.display = 'flex';
}

function hideLoading() {
    document.getElementById('stream-reconnect-overlay').style.display = 'none';
}

function showError(msg) {
    videoEl.style.display        = 'none';
    customControls.style.display = 'none';
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
