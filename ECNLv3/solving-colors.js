// ==UserScript==
// @name         ECNL Shape & Color Game Helper
// @namespace    local.ecnl-shape-colors
// @version      2.7.1
// @description  Waits for a stable board, reads the requested shape, and highlights its color choice.
// @match        *://ecnlmediamarket.com/dashboard/tasks/colors*
// @match        *://www.ecnlmediamarket.com/dashboard/tasks/colors*
// @match        *://ecnlmediamarket.com/solving-colors*
// @match        *://www.ecnlmediamarket.com/solving-colors*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  function isColorsGameRoute() {
    return /\/dashboard\/tasks\/colors(?:\/|$)/i.test(location.pathname) ||
      /\/solving-colors(?:\/|$)/i.test(location.pathname);
  }

  if (window.__ecnlServiceUnavailable || !isColorsGameRoute()) return;

  const STORAGE_KEY     = 'sc-auto-correct-count-v1';
  const WRONG_KEY       = 'sc-auto-wrong-count-v1';
  const RELOAD_KEY      = 'sc-auto-broken-image-reloads-v1';
  const HEALTH_RELOAD_KEY = 'sc-auto-stuck-page-reloads-v1';
  const CHECKING_STUCK_MS  = 30000;
  const EMPTY_PUZZLE_STUCK_MS = 15000;
  const BOARD_STABLE_MS = 1100;
  const COLOR_WORDS = ['red','orange','yellow','green','blue','purple','pink','brown','black','white','gray','grey'];

  const state = {
    running: false,
    busy: false,
    awaitingResult: false,
    submittedPuzzle: '',
    handledImage: '',
    candidateKey: '',
    candidateSince: 0,
    candidateSamples: 0,
    correct: Number.parseInt(localStorage.getItem(STORAGE_KEY) || '0', 10) || 0,
    wrong:   Number.parseInt(localStorage.getItem(WRONG_KEY)   || '0', 10) || 0,
    retryTimer: 0,
    brokenImageSince: 0,
    checkingSince: 0,
    awaitingSince: 0,
    emptyPuzzleSince: 0,
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalize = (s) => String(s || '').trim().toLowerCase();

  function hardReload() {
    if (typeof chrome !== 'undefined' && chrome.runtime?.id && chrome.runtime.sendMessage) {
      const fallback = window.setTimeout(() => location.reload(), 2500);
      try {
        chrome.runtime.sendMessage({ type: 'ECNL_BYPASS_CACHE_RELOAD' }, () => {
          if (chrome.runtime.lastError) {
            clearTimeout(fallback);
            location.reload();
          }
        });
        return;
      } catch {}
      clearTimeout(fallback);
    }
    location.reload();
  }

  // -------------------------------------------------------------------------
  // DOM Discovery
  // -------------------------------------------------------------------------

  function isVisibleElement(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.05;
  }

  function findTaskCard() {
    const headings = [...document.querySelectorAll('h1,h2,h3')];
    const heading = headings.find((h) =>
      /find the emoji('|’)?s color|colors task/i.test(h.textContent || '')
    );
    if (heading) {
      let node = heading;
      for (let i = 0; i < 6 && node.parentElement; i++) {
        node = node.parentElement;
        const rect = node.getBoundingClientRect();
        if (rect.width > 300 && rect.height > 200) return node;
      }
      return heading.parentElement;
    }
    return document.querySelector('main') || document.body;
  }

  function scoreCandidate(el, width, height, cardRect) {
    if (!width || !height) return -1;
    const aspect = width / height;
    let score = 0;
    if (aspect > 3 && aspect < 10) score += 40;
    if (aspect > 4 && aspect < 7)  score += 20;
    if (width >= 400) score += 20;
    if (width >= 700) score += 15;
    const rect = el.getBoundingClientRect();
    if (rect.width >= 300) score += 10;
    if (cardRect &&
        rect.top    >= cardRect.top    - 40 &&
        rect.bottom <= cardRect.bottom + 40 &&
        rect.left   >= cardRect.left   - 40 &&
        rect.right  <= cardRect.right  + 40) {
      score += 30;
    }
    return score;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('bg image failed to load'));
      im.src = url;
    });
  }

  async function findPuzzleSource() {
    const card = findTaskCard();
    const cardRect = card ? card.getBoundingClientRect() : null;
    const candidates = [];

    // 1) Legacy selector
    for (const img of document.querySelectorAll('#pro_colors_show_colors img')) {
      if (img.naturalWidth && img.naturalHeight && isVisibleElement(img)) {
        candidates.push({ el: img, w: img.naturalWidth, h: img.naturalHeight, kind: 'img', legacy: true });
      }
    }
    // 2) Any <img>
    for (const img of document.querySelectorAll('img')) {
      if (!img.complete || !img.naturalWidth || !img.naturalHeight) continue;
      if (!isVisibleElement(img)) continue;
      candidates.push({ el: img, w: img.naturalWidth, h: img.naturalHeight, kind: 'img' });
    }
    // 3) <canvas>
    for (const cv of document.querySelectorAll('canvas')) {
      if (!cv.width || !cv.height || !isVisibleElement(cv)) continue;
      candidates.push({ el: cv, w: cv.width, h: cv.height, kind: 'canvas' });
    }
    // 4) background-image
    for (const el of document.querySelectorAll('div,section,figure')) {
      const bg = getComputedStyle(el).backgroundImage;
      const m = bg && /url\(["']?(.+?)["']?\)/.exec(bg);
      if (!m) continue;
      if (!isVisibleElement(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 60) continue;
      candidates.push({ el, w: Math.round(rect.width), h: Math.round(rect.height), kind: 'bg', url: m[1] });
    }

    if (!candidates.length) return null;

    let best = null, bestScore = -1;
    for (const c of candidates) {
      const s = scoreCandidate(c.el, c.w, c.h, cardRect) + (c.legacy ? 5 : 0);
      if (s > bestScore) { bestScore = s; best = c; }
    }
    if (!best || bestScore < 30) return null;

    if (best.kind === 'bg') {
      try {
        const im = await loadImage(best.url);
        return { pixelSource: im, width: im.naturalWidth, height: im.naturalHeight, kind: 'bg', element: best.el, candidates };
      } catch {
        return null;
      }
    }
    return { pixelSource: best.el, width: best.w, height: best.h, kind: best.kind, element: best.el, candidates };
  }

  function findColorOptions() {
    const card = findTaskCard() || document.body;
    const nodes = card.querySelectorAll('button,[role="button"],a,[data-color]');
    const out = [];
    for (const el of nodes) {
      if (!isVisibleElement(el)) continue;
      const label = normalize(el.getAttribute('data-color') || el.getAttribute('aria-label') || el.textContent || el.value || '');
      // Normalize spelling: if button says 'grey', map it to 'gray' so it matches our detection
      const mappedLabel = label.replace(/\s+/g, ' ');
      const colorLabel = mappedLabel === 'grey' ? 'gray' : mappedLabel;
      if (COLOR_WORDS.includes(colorLabel)) {
        out.push({
          el,
          label: colorLabel,
          enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !el.hasAttribute('disabled'),
        });
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Controller UI
  // -------------------------------------------------------------------------

  function makeController() {
    const host = document.createElement('div');
    host.id = 'sc-auto-controller';
    host.innerHTML = `
      <div class="sc-heading"><div class="sc-title">Shape &amp; Color Helper</div><button type="button" class="sc-hide" data-action="hide" aria-label="Hide helper">Hide</button></div>
      <div class="sc-status"><span class="sc-dot"></span><span data-role="status">Paused</span></div>
      <div class="sc-detail" data-role="detail">Ready</div>
      <div class="sc-count">Correct: <strong data-role="count">${state.correct}</strong> · Wrong: <strong data-role="wrong">${state.wrong}</strong></div>
      <div class="sc-actions">
        <button type="button" data-action="start">Start</button>
        <button type="button" data-action="pause">Pause</button>
        <button type="button" class="sc-reset" data-action="reset">Reset count</button>
      </div>`;

    const showTab = document.createElement('button');
    showTab.id = 'sc-auto-show';
    showTab.type = 'button';
    showTab.textContent = 'Show helper';
    showTab.setAttribute('aria-label', 'Show Shape and Color Helper');

    const style = document.createElement('style');
    style.textContent = `
      #sc-auto-controller{position:fixed;right:18px;bottom:18px;z-index:2147483647;width:250px;
        padding:14px;border:1px solid rgba(255,255,255,.17);border-radius:14px;background:#171a21;
        color:#f4f7fb;box-shadow:0 12px 35px rgba(0,0,0,.38);font:13px/1.35 system-ui,-apple-system,Segoe UI,sans-serif}
      #sc-auto-controller *{box-sizing:border-box}
      #sc-auto-controller .sc-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
      #sc-auto-controller .sc-title{font-size:15px;font-weight:750}
      #sc-auto-controller button.sc-hide{padding:4px 8px;background:#303642;color:#cbd3df;font-size:11px}
      #sc-auto-show{position:fixed;right:0;bottom:18px;z-index:2147483647;border:1px solid rgba(255,255,255,.2);
        border-right:0;border-radius:9px 0 0 9px;padding:9px 11px;background:#171a21;color:#f4f7fb;
        box-shadow:0 5px 18px rgba(0,0,0,.28);font:700 12px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;cursor:pointer}
      #sc-auto-show:hover{background:#2678e5}
      #sc-auto-controller .sc-status{display:flex;align-items:center;gap:7px;font-weight:650}
      #sc-auto-controller .sc-dot{width:9px;height:9px;border-radius:50%;background:#f0a81e;box-shadow:0 0 0 3px rgba(240,168,30,.15)}
      #sc-auto-controller[data-running="true"] .sc-dot{background:#35c46a;box-shadow:0 0 0 3px rgba(53,196,106,.16)}
      #sc-auto-controller .sc-detail{min-height:34px;margin:7px 0;color:#aeb8c8;word-break:break-word}
      #sc-auto-controller .sc-count{margin-bottom:10px;color:#dce4ef}
      #sc-auto-controller .sc-actions{display:grid;grid-template-columns:1fr 1fr;gap:7px}
      #sc-auto-controller button{border:0;border-radius:8px;padding:8px 10px;color:#fff;background:#2678e5;font-weight:700;cursor:pointer}
      #sc-auto-controller button[data-action="pause"]{background:#596273}
      #sc-auto-controller button.sc-reset{grid-column:1/-1;padding:6px;background:#303642;color:#cbd3df;font-size:11px}
      #sc-auto-controller button:disabled{opacity:.45;cursor:not-allowed}
      button.sc-auto-answer-ready{outline:3px solid #35c46a!important;outline-offset:2px!important;
        box-shadow:0 0 0 5px rgba(53,196,106,.22),0 0 22px rgba(53,196,106,.75)!important}`;

    document.documentElement.append(style, host, showTab);

    const setHidden = (hidden) => {
      host.hidden = hidden;
      showTab.hidden = !hidden;
      localStorage.setItem('sc-auto-controller-hidden', String(hidden));
    };
    host.querySelector('[data-action="hide"]').addEventListener('click', () => setHidden(true));
    showTab.addEventListener('click', () => setHidden(false));
    setHidden(localStorage.getItem('sc-auto-controller-hidden') === 'true');

    host.querySelector('[data-action="start"]').addEventListener('click', start);
    host.querySelector('[data-action="pause"]').addEventListener('click', () => pause('Paused by user'));
    host.querySelector('[data-action="reset"]').addEventListener('click', () => {
      state.correct = 0;
      state.wrong = 0;
      localStorage.setItem(STORAGE_KEY, '0');
      localStorage.setItem(WRONG_KEY, '0');
      updateController();
    });
    updateController();
  }

  function updateController(status, detail) {
    const host = document.querySelector('#sc-auto-controller');
    if (!host) return;
    host.dataset.running = String(state.running);
    host.querySelector('[data-role="status"]').textContent = status || (state.running ? 'Running' : 'Paused');
    if (detail !== undefined) host.querySelector('[data-role="detail"]').textContent = detail;
    host.querySelector('[data-role="count"]').textContent = String(state.correct);
    host.querySelector('[data-role="wrong"]').textContent = String(state.wrong);
    host.querySelector('[data-action="start"]').disabled = state.running;
    host.querySelector('[data-action="pause"]').disabled = !state.running;
  }

  function prepareManualAnswer(button, solution) {
    clearAnswerHighlight();
    button.classList.add('sc-auto-answer-ready');
    button.scrollIntoView({ block: 'center', behavior: 'smooth' });
    button.focus({ preventScroll: true });

    const onTrustedClick = (event) => {
      if (!event.isTrusted) return;
      button.removeEventListener('click', onTrustedClick);
      state.awaitingResult = true;
      state.awaitingSince = Date.now();
      updateController('Checking', `Submitted ${solution.color}. Waiting for the game result...`);
    };
    button.addEventListener('click', onTrustedClick);
  }

  function clearAnswerHighlight() {
    document.querySelectorAll('.sc-auto-answer-ready').forEach((el) => el.classList.remove('sc-auto-answer-ready'));
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  function start() {
    if (state.running) return;
    state.running = true;
    state.handledImage = '';
    state.candidateKey = '';
    state.candidateSince = 0;
    state.candidateSamples = 0;
    updateController('Running', 'Waiting for a puzzle...');
    scheduleScan(0);
  }

  function pause(reason = 'Paused') {
    state.running = false;
    state.busy = false;
    clearTimeout(state.retryTimer);
    updateController('Paused', reason);
  }

  function scheduleScan(delay = 250) {
    clearTimeout(state.retryTimer);
    if (!state.running) return;
    state.retryTimer = window.setTimeout(scan, delay);
  }

  function reloadBrokenPage(reason = 'Puzzle image is broken', historyKey = RELOAD_KEY) {
    const now = Date.now();
    let history = [];
    try {
      history = JSON.parse(sessionStorage.getItem(historyKey) || '[]')
        .filter((t) => Number.isFinite(t) && now - t < 90000);
    } catch { history = []; }
    if (history.length >= 3) {
      pause(`Recovery stopped after 3 reloads: ${reason}.`);
      return;
    }
    history.push(now);
    sessionStorage.setItem(historyKey, JSON.stringify(history));
    updateController('Reloading', `${reason} (${history.length}/3). Reloading...`);
    window.setTimeout(hardReload, 500);
  }

  function checkPageHealth() {
    if (!state.running || !isColorsGameRoute()) return;
    const card = findTaskCard() || document.body;
    const text = (card.innerText || '').replace(/\s+/g, ' ').trim();
    if (/checking(?:\.{1,3}|…)?|submitting|processing answer/i.test(text)) {
      state.checkingSince ||= Date.now();
      if (Date.now() - state.checkingSince >= CHECKING_STUCK_MS) {
        state.checkingSince = 0;
        reloadBrokenPage('Answer check stayed in progress for 30s', HEALTH_RELOAD_KEY);
        return;
      }
    } else {
      state.checkingSince = 0;
    }

    if (state.awaitingResult && state.awaitingSince && Date.now() - state.awaitingSince >= CHECKING_STUCK_MS) {
      state.awaitingResult = false;
      state.awaitingSince = 0;
      reloadBrokenPage('No answer result appeared within 30s', HEALTH_RELOAD_KEY);
      return;
    }
    
    if (!state.awaitingResult) {
      findPuzzleSource().then((found) => {
        if (found) { state.emptyPuzzleSince = 0; return; }
        state.emptyPuzzleSince ||= Date.now();
        if (Date.now() - state.emptyPuzzleSince >= EMPTY_PUZZLE_STUCK_MS) {
          state.emptyPuzzleSince = 0;
          reloadBrokenPage('No puzzle detected for 15s', HEALTH_RELOAD_KEY);
        }
      });
    }
  }

  async function scan() {
    if (!state.running || state.busy || state.awaitingResult) return;

    const found = await findPuzzleSource();
    if (!found) return scheduleScan(400);

    state.busy = true;
    try {
      updateController('Reading', 'Finding the requested shape and its color...');
      const pixels = readSourcePixels(found.pixelSource);
      const signature = hashImagePixels(pixels);
      const key = `${found.width}x${found.height}|${found.kind}|${found.element?.src || found.element?.style?.backgroundImage || ''}|${signature}`;
      if (key === state.handledImage) return scheduleScan(350);

      if (key !== state.candidateKey) {
        state.candidateKey = key;
        state.candidateSince = Date.now();
        state.candidateSamples = 1;
        updateController('Loading', 'Puzzle detected; waiting for the image to finish rendering...');
        return scheduleScan(450);
      }
      state.candidateSamples++;
      if (Date.now() - state.candidateSince < BOARD_STABLE_MS || state.candidateSamples < 3) {
        updateController('Loading', 'Checking that the puzzle image is stable...');
        return scheduleScan(450);
      }

      const solution = solveImage(found.pixelSource, pixels, signature);
      clearAnswerHighlight();
      updateController('Solved', `Shape ${solution.position}: ${solution.color}`);

      const choices = findColorOptions();
      const matchingChoice = choices.find((o) => o.label === solution.color);
      if (!matchingChoice) {
        updateController('Waiting', `Detected ${solution.color}; waiting for its game answer option...`);
        state.busy = false;
        return scheduleScan(300);
      }

      if (!matchingChoice.enabled) {
        updateController('Answer ready', `Position ${solution.position}: ${solution.color} · row ${solution.row + 1}, column ${solution.column + 1}. Waiting for the game to enable the choice.`);
        return scheduleScan(300);
      }

      state.handledImage = key;
      prepareManualAnswer(matchingChoice.el, solution);
      updateController('Answer ready', `Position ${solution.position}: ${solution.color} · ${solution.confidenceVotes}/9 color samples agree. Click the highlighted choice to submit.`);
    } catch (error) {
      console.error('[Solving Colors Auto]', error);
      pause(`Could not read puzzle: ${error.message}`);
    } finally {
      state.busy = false;
    }
  }

  // -------------------------------------------------------------------------
  // Image Analysis
  // -------------------------------------------------------------------------

  function readSourcePixels(source) {
    const canvas = document.createElement('canvas');
    canvas.width  = source.naturalWidth  || source.width;
    canvas.height = source.naturalHeight || source.height;
    if (!canvas.width || !canvas.height) throw new Error('puzzle source has no size');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  function hashImagePixels(pixels) {
    const { width, height, data } = pixels;
    let signature = 2166136261;
    const stepX = Math.max(1, Math.floor(width / 48));
    const stepY = Math.max(1, Math.floor(height / 16));
    for (let sy = 0; sy < height; sy += stepY) {
      for (let sx = 0; sx < width; sx += stepX) {
        const p = (sy * width + sx) * 4;
        signature = Math.imul(signature ^ data[p], 16777619);
        signature = Math.imul(signature ^ data[p + 1], 16777619);
        signature = Math.imul(signature ^ data[p + 2], 16777619);
      }
    }
    return (signature >>> 0).toString(36);
  }

  function solveImage(source, pixels = readSourcePixels(source), signature = hashImagePixels(pixels)) {
    const canvas = { width: pixels.width, height: pixels.height };

    const position = readHighlightedNumber(pixels);
    if (!Number.isInteger(position) || position < 1 || position > 36) {
      throw new Error(`invalid emoji number (${position || 'not found'})`);
    }
    const index = position - 1;
    const row = Math.floor(index / 12);
    const column = index % 12;
    
    // Calibrated to the visible 12-column by 3-row board. The row spacing is
    // about 20% of the image height, correcting the old undershoot on row 3.
    const x = Math.round(canvas.width  * (0.079 + column * 0.0765));
    const y = Math.round(canvas.height * (0.150 + row    * 0.201));
    const spacingX = canvas.width * 0.0765;
    const spacingY = canvas.height * 0.201;
    const samples = [
      [0, 0], [-0.045, 0], [0.045, 0], [0, -0.045], [0, 0.045],
      [-0.035, -0.035], [0.035, -0.035], [-0.035, 0.035], [0.035, 0.035],
    ].map(([ox, oy]) => {
      const rgb = sampleCenterColor(pixels, Math.round(x + spacingX * ox), Math.round(y + spacingY * oy));
      return { rgb, color: nameColor(rgb) };
    });
    const counts = new Map();
    for (const sample of samples) counts.set(sample.color, (counts.get(sample.color) || 0) + 1);
    const [color, votes] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (votes < 8) {
      throw new Error(`target color samples disagree (${[...counts].map(([name, count]) => `${name}:${count}`).join(', ')})`);
    }
    const matchingSample = samples.find((sample) => sample.color === color);
    return { position, row, column, rgb: matchingSample.rgb, color, confidence: votes / samples.length, confidenceVotes: votes, signature };
  }

  function readHighlightedNumber(imageData) {
    const { width: w, height: h, data } = imageData;
    const yStart = Math.floor(h * 0.60);
    const yEnd = Math.floor(h * 0.92);
    const visited = new Uint8Array(w * h);
    let best = null;

    const isMarkerPixel = (x, y) => {
      const p = (y * w + x) * 4;
      const r = data[p], g = data[p + 1], b = data[p + 2];
      // The older game used a blue marker. The current game uses a gold one.
      const blue = r >= 55 && r <= 155 && g >= 75 && g <= 180 &&
        b >= 100 && b <= 205 && b - r > 12 && g - r > 5;
      const gold = r >= 145 && g >= 85 && g <= 215 && b <= 115 &&
        r - g > 18 && g - b > 25;
      return blue || gold;
    };

    // Find separate colored components so background decoration cannot join
    // the marker into one enormous bounding box.
    for (let y = yStart; y < yEnd; y++) {
      for (let x = 0; x < w; x++) {
        const start = y * w + x;
        if (visited[start] || !isMarkerPixel(x, y)) continue;
        const stack = [[x, y]];
        visited[start] = 1;
        let left = x, right = x, top = y, bottom = y, area = 0;
        while (stack.length) {
          const [cx, cy] = stack.pop();
          area++;
          left = Math.min(left, cx); right = Math.max(right, cx);
          top = Math.min(top, cy); bottom = Math.max(bottom, cy);
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || nx >= w || ny < yStart || ny >= yEnd) continue;
            const index = ny * w + nx;
            if (!visited[index] && isMarkerPixel(nx, ny)) {
              visited[index] = 1;
              stack.push([nx, ny]);
            }
          }
        }
        const boxWidth = right - left + 1;
        const boxHeight = bottom - top + 1;
        const aspect = boxWidth / boxHeight;
        if (area >= 80 && boxWidth >= 15 && boxHeight >= 12 && aspect >= 0.65 && aspect <= 3.5 &&
            (!best || area > best.area)) {
          best = { left, right, top, bottom, area };
        }
      }
    }
    if (!best) throw new Error('gold/blue position marker not found');
    const { left, right, top, bottom } = best;

    const padX = Math.max(3, Math.round((right - left) * 0.08));
    const padY = Math.max(2, Math.round((bottom - top) * 0.10));
    const x0 = left + padX, x1 = right - padX;
    const y0 = top + padY, y1 = bottom - padY;
    const mw = x1 - x0 + 1, mh = y1 - y0 + 1;

    // Build a mask using adaptive ink threshold
    const lums = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const p = (y * w + x) * 4;
        lums.push(0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]);
      }
    }
    lums.sort((a, b) => a - b);
    const median = lums[Math.floor(lums.length / 2)];
    const inkThreshold = median * 0.62; // Dark strokes vs light pill

    const mask = [];
    for (let y = y0; y <= y1; y++) {
      const row = [];
      for (let x = x0; x <= x1; x++) {
        const p = (y * w + x) * 4;
        const r = data[p], g = data[p + 1], b = data[p + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        row.push(lum < inkThreshold ? 1 : 0);
      }
      mask.push(row);
    }

    const segments = splitGlyphs(mask, mw, mh);
    // The current prompt renders the position as “#7”. Ignore the leading #;
    // the remaining one or two glyphs are the position number (1–36).
    if (segments.length < 2 || segments.length > 3) {
      throw new Error(`glyph count ${segments.length} (expected # plus 1 or 2 digits)`);
    }
    const digits = segments.slice(1).map(classifyDigit).join('');
    return Number.parseInt(digits, 10);
  }

  function splitGlyphs(mask, width, height) {
    const active = Array(width).fill(false);
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) if (mask[y][x]) { active[x] = true; break; }
    }
    const spans = [];
    let start = -1;
    for (let x = 0; x <= width; x++) {
      if (x < width && active[x] && start < 0) start = x;
      if ((x === width || !active[x]) && start >= 0) {
        if (x - start >= 2) spans.push([start, x - 1]);
        start = -1;
      }
    }
    return spans.map(([a, b]) => cropMask(mask, a, 0, b, height - 1));
  }

  function cropMask(mask, left, top, right, bottom) {
    while (top <= bottom && !mask[top].slice(left, right + 1).some(Boolean)) top++;
    while (bottom >= top && !mask[bottom].slice(left, right + 1).some(Boolean)) bottom--;
    return mask.slice(top, bottom + 1).map((row) => row.slice(left, right + 1));
  }

  let digitTemplates;
  function classifyDigit(source) {
    digitTemplates ||= buildDigitTemplates();
    const observed = fitMask(source, 20, 30);
    let bestDigit = '?', bestScore = -1, secondScore = -1;
    for (const t of digitTemplates) {
      const score = maskScore(observed, t.mask);
      if (score > bestScore) { secondScore = bestScore; bestScore = score; bestDigit = t.digit; }
      else if (score > secondScore) { secondScore = score; }
    }
    if (bestScore < 0.42) throw new Error(`low OCR confidence (${bestScore.toFixed(2)})`);
    if (secondScore > 0 && bestScore - secondScore < 0.06 && bestScore < 0.65) {
      throw new Error(`ambiguous digit (${bestScore.toFixed(2)} vs ${secondScore.toFixed(2)})`);
    }
    return bestDigit;
  }

  function buildDigitTemplates() {
    const fonts = ['monospace', 'Consolas', 'Courier New', 'Lucida Console'];
    const templates = [];
    for (const font of fonts) {
      for (let digit = 0; digit <= 9; digit++) {
        const canvas = document.createElement('canvas');
        canvas.width = 54; canvas.height = 52;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.fillStyle = '#fff';
        context.font = `30px ${font}`;
        context.textBaseline = 'alphabetic';
        context.fillText(String(digit), 12, 38);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const rows = [];
        for (let y = 0; y < canvas.height; y++) {
          const row = [];
          for (let x = 0; x < canvas.width; x++) row.push(image.data[(y * canvas.width + x) * 4 + 3] > 100 ? 1 : 0);
          rows.push(row);
        }
        const box = boundingBox(rows);
        templates.push({ digit: String(digit), mask: fitMask(cropMask(rows, box.left, box.top, box.right, box.bottom), 20, 30) });
      }
    }
    return templates;
  }

  function boundingBox(mask) {
    let left = Infinity, top = Infinity, right = -1, bottom = -1;
    for (let y = 0; y < mask.length; y++) for (let x = 0; x < mask[y].length; x++) if (mask[y][x]) {
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
    return { left, top, right, bottom };
  }

  function fitMask(source, outW, outH) {
    const srcH = source.length, srcW = source[0].length;
    const scale = Math.min((outW - 4) / srcW, (outH - 4) / srcH);
    const drawW = Math.max(1, Math.round(srcW * scale));
    const drawH = Math.max(1, Math.round(srcH * scale));
    const offsetX = Math.floor((outW - drawW) / 2), offsetY = Math.floor((outH - drawH) / 2);
    const output = Array.from({ length: outH }, () => Array(outW).fill(0));
    for (let y = 0; y < drawH; y++) for (let x = 0; x < drawW; x++) {
      output[offsetY + y][offsetX + x] = source[Math.min(srcH - 1, Math.floor(y / scale))][Math.min(srcW - 1, Math.floor(x / scale))];
    }
    return output;
  }

  function maskScore(a, b) {
    let intersection = 0, whiteA = 0, whiteB = 0, equal = 0, total = 0;
    for (let y = 0; y < a.length; y++) for (let x = 0; x < a[y].length; x++) {
      if (a[y][x]) whiteA++;
      if (b[y][x]) whiteB++;
      if (a[y][x] && b[y][x]) intersection++;
      if (a[y][x] === b[y][x]) equal++;
      total++;
    }
    const f1 = (2 * intersection) / Math.max(1, whiteA + whiteB);
    return f1 * 0.72 + (equal / total) * 0.28;
  }

  function sampleCenterColor(imageData, centerX, centerY) {
    const { width, height, data } = imageData;
    const radius = Math.max(2, Math.round(width * 0.005));
    const values = [[], [], []];
    for (let y = centerY - radius; y <= centerY + radius; y++) for (let x = centerX - radius; x <= centerX + radius; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const p = (y * width + x) * 4;
      values[0].push(data[p]); values[1].push(data[p + 1]); values[2].push(data[p + 2]);
    }
    return values.map((ch) => ch.sort((a, b) => a - b)[Math.floor(ch.length / 2)]);
  }

  function nameColor([r, g, b]) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    
    // Handle gray explicitly
    if (delta < 20) {
      if (lum < 40) return 'black';
      if (lum > 220) return 'white';
      return 'gray';
    }
    
    if (max < 80) return 'black';
    if (delta < 32) return lum > 150 ? 'white' : 'black';
    
    let hue;
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
    if (hue < 0) hue += 360;
    
    if (hue < 13 || hue >= 345) return 'red';
    if (hue < 43) return max < 190 ? 'brown' : 'orange';
    if (hue < 70) return 'yellow';
    if (hue < 170) return 'green';
    if (hue < 260) return 'blue';
    if (hue < 310) return 'purple';
    return 'pink';
  }

  // -------------------------------------------------------------------------
  // Result Detection (React-safe text scanning)
  // -------------------------------------------------------------------------

  const observer = new MutationObserver(() => {
    if (state.awaitingResult) {
      const card = findTaskCard() || document.body;
      const text = (card.innerText || '').replace(/\s+/g, ' ').trim();
      
      if (/\b(correct!?(?:\s+(?:progress recorded|cap reached))?|accepted|nice work|well done)\b/i.test(text)) {
        state.awaitingResult = false;
        state.awaitingSince = 0;
        state.correct++;
        localStorage.setItem(STORAGE_KEY, String(state.correct));
        updateController('Correct', `Accepted. Total correct: ${state.correct}`);
        scheduleScan(500);
      } else if (/\b(incorrect|wrong|try again|invalid answer)\b/i.test(text)) {
        state.awaitingResult = false;
        state.awaitingSince = 0;
        state.wrong++;
        localStorage.setItem(WRONG_KEY, String(state.wrong));
        updateController('Continuing', `Wrong answer (${state.wrong} total). Waiting...`);
        scheduleScan(900);
      } else if (/limit reached|task limit/i.test(text)) {
        state.awaitingResult = false;
        state.awaitingSince = 0;
        pause('The site reports its task limit was reached.');
      } else if (/network interruption/i.test(text)) {
        state.awaitingResult = false;
        state.awaitingSince = 0;
        updateController('Recovering', 'Network interruption. Reloading...');
        hardReload();
      }
    } else if (state.running) {
      scheduleScan(120);
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  makeController();
  window.setInterval(checkPageHealth, 1000);
  start();
})();
