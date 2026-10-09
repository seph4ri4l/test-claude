// ==UserScript==
// @name         Pinterest - Trieur MAISON (bouton orange + dossiers)
// @namespace    https://local/pinterest-trieur-maison
// @version      2.1.0
// @description  Masque la barre d'actions native de Pinterest et la remplace par un bouton orange. Au survol du bouton, une rangee de categories se deploie : un clic enregistre l'image en resolution maximale dans le bon sous-dossier de MAISON.
// @match        https://*.pinterest.com/*
// @match        https://*.pinterest.fr/*
// @match        https://*.pinterest.co.uk/*
// @match        https://*.pinterest.de/*
// @match        https://*.pinterest.es/*
// @match        https://*.pinterest.ca/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      pinimg.com
// @run-at       document-idle
// @noframes
// ==/UserScript==
(function () {
  'use strict';
  /* ============================================================
     1. CONFIGURATION
     ============================================================ */
  const PINIMG   = /(^|\.)pinimg\.com$/i;
  const SIZE_SEG = /\/(?:originals|\d+x\d*(?:_RS)?)\//i;
  // du plus grand au plus petit : le premier qui repond est le meilleur
  const SIZES    = ['originals', '1200x', '736x', '564x', '474x', '236x'];
  const ORIGINAL_EXTS = ['jpg', 'png', 'webp', 'gif'];
  const DEFAULT_CATEGORIES = ['cuisine', 'salle de bain', 'cour', 'autre'];
  const HIDE_DELAY = 1200; // ms avant que l'overlay disparaisse quand la souris sort
  const ROW_DELAY  = 1500; // ms avant que la rangee de categories se replie
  const MIN_SIDE   = 140;  // taille mini (px a l'ecran) d'une image prise en charge
  const VISIT_TEXT = /^(Visiter|Visit|Besuchen|Visitar)\b/i;

  /* ============================================================
     2. ETAT PERSISTANT
     ============================================================ */
  let categories = GM_getValue('categories', DEFAULT_CATEGORIES.slice());
  let index      = GM_getValue('index', {});   // { "<hash>": ["cuisine", ...] }
  let logEntries = GM_getValue('log', []);
  let hideNative = GM_getValue('hideNative', true);
  let barMini    = GM_getValue('barMini', false);
  const saveCategories = function () { GM_setValue('categories', categories); };
  const saveIndex      = function () { GM_setValue('index', index); };
  const saveLog        = function () { GM_setValue('log', logEntries.slice(-2000)); };
  const saveHideNative = function () { GM_setValue('hideNative', hideNative); };
  const saveBarMini    = function () { GM_setValue('barMini', barMini); };

  /* ============================================================
     3. CSS
     GM_addStyle passe outre la politique de securite (CSP) du site,
     contrairement a un <style> ajoute a la main.
     ============================================================ */
  GM_addStyle(`
    /* barre d'actions native reperee par le script (voir section 8) */
    html.pst-hide-native .pst-native-hidden { display: none !important; }

    .pst-ov {
      position: fixed;
      z-index: 2147483646;
      display: none;
      align-items: center;
      gap: 6px;
      font: 600 12px system-ui, -apple-system, sans-serif;
    }
    .pst-ov.pst-open { display: flex; }

    .pst-trigger {
      flex: 0 0 auto;
      width: 30px; height: 30px; padding: 0;
      border: 0; border-radius: 50%;
      background: #ff6a00;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 3px 12px rgba(0,0,0,.45);
      transition: transform .15s ease, background .15s ease;
    }
    .pst-trigger:hover { transform: scale(1.12); background: #ff8124; }
    .pst-trigger::after {
      content: '';
      width: 11px; height: 11px; border-radius: 50%;
      background: #fff;
    }
    .pst-trigger.pst-busy { background: #a16207; animation: pst-pulse 1s infinite; }
    .pst-trigger.pst-fail { background: #7f1d1d; }
    @keyframes pst-pulse { 0%,100% { opacity: 1; } 50% { opacity: .45; } }

    /* rangee de categories : repliee par defaut, deployee par la classe
       pst-expanded (posee en JS, avec un delai avant repli) */
    .pst-row {
      display: flex; align-items: center; gap: 6px;
      max-width: 0; opacity: 0; overflow: hidden;
      pointer-events: none;
      transition: max-width .2s ease, opacity .2s ease;
    }
    .pst-ov.pst-expanded .pst-row {
      max-width: 640px; opacity: 1; pointer-events: auto;
    }
    .pst-row button {
      border: 0; border-radius: 9px; padding: 7px 11px;
      cursor: pointer; white-space: nowrap;
      background: #16a34a; color: #fff;
      font: 600 12px system-ui, sans-serif;
      box-shadow: 0 3px 12px rgba(0,0,0,.35);
      transition: background .12s ease;
    }
    .pst-row button:hover { background: #22c55e; }
    .pst-row button.pst-done { background: #14532d; box-shadow: inset 0 0 0 2px #86efac, 0 3px 12px rgba(0,0,0,.35); }
    .pst-row button.pst-busy { background: #a16207; }
    .pst-row button.pst-fail { background: #7f1d1d; }
  `);

  function applyNativeFlag() {
    document.documentElement.classList.toggle('pst-hide-native', !!hideNative);
  }

  /* ============================================================
     4. INDEXEDDB - memorise le dossier choisi
     ============================================================ */
  let dbPromise = null;
  function idb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      const rq = indexedDB.open('pinterest-trieur', 1);
      rq.onupgradeneeded = function () {
        if (!rq.result.objectStoreNames.contains('handles')) rq.result.createObjectStore('handles');
      };
      rq.onsuccess = function () { resolve(rq.result); };
      rq.onerror   = function () { dbPromise = null; reject(rq.error); };
    });
    return dbPromise;
  }
  async function idbSet(key, value) {
    const db = await idb();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(value, key);
      tx.oncomplete = function () { resolve(); };
      tx.onerror    = function () { reject(tx.error); };
    });
  }
  async function idbGet(key) {
    const db = await idb();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction('handles', 'readonly');
      const rq = tx.objectStore('handles').get(key);
      rq.onsuccess = function () { resolve(rq.result); };
      rq.onerror   = function () { reject(rq.error); };
    });
  }

  // storedHandle : le dossier memorise ; rootReady : l'autorisation d'ecrire est active
  let storedHandle = null;
  let rootReady    = false;

  function dirPicker() {
    if (typeof window.showDirectoryPicker === 'function') {
      return function (o) { return window.showDirectoryPicker(o); };
    }
    if (typeof unsafeWindow !== 'undefined' && typeof unsafeWindow.showDirectoryPicker === 'function') {
      return function (o) { return unsafeWindow.showDirectoryPicker(o); };
    }
    return null;
  }

  async function restoreRoot() {
    try {
      const h = await idbGet('root');
      if (!h) return;
      storedHandle = h;
      rootReady = (await h.queryPermission({ mode: 'readwrite' })) === 'granted';
    } catch (e) { /* pas de dossier memorise */ }
  }

  async function pickRoot() {
    const picker = dirPicker();
    if (!picker) {
      toast('Ton navigateur ne permet pas de choisir un dossier. Utilise Edge ou Chrome a jour.', true);
      return null;
    }
    try {
      const h = await picker({ id: 'maison', mode: 'readwrite', startIn: 'desktop' });
      storedHandle = h;
      rootReady = true;
      // si la memorisation echoue, le dossier reste utilisable jusqu'a la fermeture de l'onglet
      try { await idbSet('root', h); } catch (e) { /* non bloquant */ }
      renderBar();
      toast('Dossier « ' + h.name + ' » selectionne.');
      return h;
    } catch (e) {
      if (!e || e.name !== 'AbortError') toast('Impossible de choisir le dossier.', true);
      return null;
    }
  }

  // Redemande l'autorisation sur le dossier memorise (doit partir d'un clic)
  async function reauthorize() {
    if (!storedHandle) return false;
    try {
      let p = await storedHandle.queryPermission({ mode: 'readwrite' });
      if (p !== 'granted') p = await storedHandle.requestPermission({ mode: 'readwrite' });
      rootReady = (p === 'granted');
    } catch (e) { rootReady = false; }
    renderBar();
    return rootReady;
  }

  async function ensureRoot() {
    if (storedHandle && (rootReady || await reauthorize())) return storedHandle;
    toast('Clique sur « Choisir le dossier » en bas a gauche.', true);
    return null;
  }

  /* ============================================================
     5. UTILITAIRES IMAGE
     ============================================================ */
  function hashOf(url) {
    const last = (url.split('?')[0].split('/').pop() || 'image');
    return last.replace(/\.[a-z0-9]+$/i, '').toLowerCase() || 'image';
  }
  function extOf(url) {
    const m = url.split('?')[0].match(/\.(jpe?g|png|gif|webp)$/i);
    return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
  }
  function withSize(raw, size, ext) {
    let u;
    try { u = new URL(raw, location.href); } catch (e) { return null; }
    if (!PINIMG.test(u.hostname) || !SIZE_SEG.test(u.pathname)) return null;
    u.pathname = u.pathname.replace(SIZE_SEG, '/' + size + '/');
    if (ext) u.pathname = u.pathname.replace(/\.[a-z0-9]+$/i, '.' + ext);
    u.search = '';
    return u.href;
  }

  // Liste des adresses a essayer, de la meilleure a la moins bonne.
  // L'original peut avoir une autre extension que la miniature (png au lieu de jpg).
  function candidatesFor(src) {
    const out = [];
    const push = function (u) { if (u && out.indexOf(u) === -1) out.push(u); };
    const ext = extOf(src);
    push(withSize(src, 'originals', ext));
    ORIGINAL_EXTS.forEach(function (e) { push(withSize(src, 'originals', e)); });
    SIZES.slice(1).forEach(function (s) { push(withSize(src, s)); });
    push(src.split('?')[0]);
    return out;
  }

  function fetchBlob(url) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        responseType: 'blob',
        timeout: 45000,
        onload: function (r) {
          const blob = r.response;
          if (r.status >= 200 && r.status < 300 && blob && blob.size > 0 &&
              (!blob.type || blob.type.indexOf('image/') === 0)) resolve(blob);
          else reject(new Error('HTTP ' + r.status));
        },
        onerror:   function () { reject(new Error('erreur reseau')); },
        ontimeout: function () { reject(new Error('delai depasse')); }
      });
    });
  }

  async function dimsOf(blob) {
    try {
      const bmp = await createImageBitmap(blob);
      const d = { w: bmp.width, h: bmp.height };
      if (bmp.close) bmp.close();
      return d;
    } catch (e) { return { w: 0, h: 0 }; }
  }

  // Telecharge la plus grande version disponible : une seule fois, sans doublon.
  async function downloadBest(src) {
    const urls = candidatesFor(src);
    let lastErr = null;
    for (let i = 0; i < urls.length; i++) {
      try {
        const blob = await fetchBlob(urls[i]);
        const d = await dimsOf(blob);
        if (d.w && d.w < 100) continue; // vignette inutilisable
        return { url: urls[i], blob: blob, w: d.w, h: d.h };
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('aucune version telechargeable');
  }

  function sanitize(name) {
    return String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  }

  /* ============================================================
     6. ECRITURE DISQUE
     ============================================================ */
  async function writeFile(dirHandle, filename, blob) {
    const fh = await dirHandle.getFileHandle(filename, { create: true });
    const w  = await fh.createWritable();
    await w.write(blob);
    await w.close();
  }
  async function writeLog(root) {
    try {
      const blob = new Blob([JSON.stringify(logEntries.slice(-2000), null, 2)], { type: 'application/json' });
      await writeFile(root, '_pinterest-log.json', blob);
    } catch (e) { /* le journal est un confort, jamais bloquant */ }
  }

  async function saveTo(src, category, onState) {
    if (!src || !PINIMG.test(new URL(src, location.href).hostname)) throw new Error('image non prise en charge');
    const hash = hashOf(src);
    if (index[hash] && index[hash].indexOf(category) !== -1) { onState('deja'); return null; }

    // en premier : l'autorisation doit etre demandee tant que le clic est "frais"
    const root = await ensureRoot();
    if (!root) throw new Error('dossier non autorise');

    onState('telechargement');
    const best = await downloadBest(src);
    onState('ecriture');
    const dir  = await root.getDirectoryHandle(sanitize(category), { create: true });
    const name = 'pin_' + hash + '.' + extOf(best.url);
    await writeFile(dir, name, best.blob);

    if (!index[hash]) index[hash] = [];
    index[hash].push(category);
    saveIndex();
    logEntries.push({
      fichier: sanitize(category) + '/' + name,
      categorie: category,
      largeur: best.w,
      hauteur: best.h,
      url: best.url,
      pin: location.href,
      date: new Date().toISOString()
    });
    saveLog();
    writeLog(root);
    onState('ok');
    return best;
  }

  /* ============================================================
     7. OVERLAY : bouton orange + rangee de categories
     ============================================================ */
  const overlay = document.createElement('div');
  overlay.className = 'pst-ov';
  const trigger = document.createElement('button');
  trigger.className = 'pst-trigger';
  trigger.title = 'Enregistrer dans MAISON';
  const row = document.createElement('div');
  row.className = 'pst-row';
  overlay.appendChild(trigger);
  overlay.appendChild(row);
  document.body.appendChild(overlay);

  let hoveredImg = null;
  let hoveredEl  = null;
  let hideTimer  = null;
  let rowTimer   = null;
  let busy       = false;

  const PIN_SELECTOR = [
    'div[data-test-id="pin"]',
    'div[data-test-id="pinWrapper"]',
    'div[data-test-id="closeup-image"]',
    'div[role="listitem"]',
    'a[href*="/pin/"]'
  ].join(',');

  function containerOf(el) {
    return el && el.closest ? el.closest(PIN_SELECTOR) : null;
  }
  function isPinImg(img) {
    const s = img && (img.currentSrc || img.src);
    if (!s) return false;
    try { return PINIMG.test(new URL(s, location.href).hostname); } catch (e) { return false; }
  }
  // Plus grande image pinimg visible dans un conteneur
  function mainImgIn(container) {
    let best = null, bestArea = 0;
    const list = container.querySelectorAll('img');
    for (let i = 0; i < list.length; i++) {
      const im = list[i];
      if (!isPinImg(im)) continue;
      const rr = im.getBoundingClientRect();
      if (rr.width < MIN_SIDE || rr.height < MIN_SIDE) continue;
      const area = rr.width * rr.height;
      if (area > bestArea) { bestArea = area; best = im; }
    }
    return best;
  }
  function pointIn(rect, x, y, margin) {
    const m = margin || 0;
    return x >= rect.left - m && x <= rect.right + m && y >= rect.top - m && y <= rect.bottom + m;
  }
  function savedCategoriesOf(img) {
    if (!isPinImg(img)) return [];
    return index[hashOf(img.currentSrc || img.src)] || [];
  }

  function buildRow() {
    row.innerHTML = '';
    categories.forEach(function (cat) {
      const b = document.createElement('button');
      b.dataset.cat = cat;
      b.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        handleSaveClick(cat, b);
      });
      row.appendChild(b);
    });
  }
  function paintStates() {
    const cats = hoveredImg ? savedCategoriesOf(hoveredImg) : [];
    Array.prototype.forEach.call(row.querySelectorAll('button'), function (b) {
      const done = cats.indexOf(b.dataset.cat) !== -1;
      b.classList.remove('pst-busy', 'pst-fail');
      b.classList.toggle('pst-done', done);
      b.textContent = (done ? '✓ ' : '') + b.dataset.cat;
    });
  }

  // renvoie false si l'image n'est plus visible a l'ecran
  function positionOverlay(img) {
    const r = img.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight || r.width === 0) return false;
    overlay.classList.add('pst-open');
    const h = overlay.offsetHeight || 30;
    // en bas a gauche de l'image, la ou etait la barre de Pinterest
    let left = r.left + 10;
    let top  = r.bottom - h - 10;
    if (top < r.top + 6) top = r.top + 6;
    left = Math.max(8, Math.min(left, window.innerWidth - 60));
    top  = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    overlay.style.left = left + 'px';
    overlay.style.top  = top + 'px';
    return true;
  }

  function expandRow() {
    clearTimeout(rowTimer);
    overlay.classList.add('pst-expanded');
  }
  function collapseRowSoon() {
    clearTimeout(rowTimer);
    rowTimer = setTimeout(function () {
      if (!busy) overlay.classList.remove('pst-expanded');
    }, ROW_DELAY);
  }

  function showOverlay(img, container) {
    if (busy) return;
    clearTimeout(hideTimer);
    if (container !== hoveredEl) {
      clearTimeout(rowTimer);
      overlay.classList.remove('pst-expanded');
    }
    hoveredImg = img;
    hoveredEl  = container || img;
    watchNative(hoveredEl);
    buildRow();
    paintStates();
    if (!positionOverlay(img)) hideOverlay();
  }
  function hideOverlay() {
    clearTimeout(hideTimer);
    clearTimeout(rowTimer);
    overlay.classList.remove('pst-open', 'pst-expanded');
    hoveredImg = null;
    hoveredEl  = null;
    watchNative(null);
  }
  function scheduleHide() {
    if (busy) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideOverlay, HIDE_DELAY);
  }

  trigger.addEventListener('mouseenter', expandRow);
  trigger.addEventListener('click', function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    expandRow();
  });
  overlay.addEventListener('mouseenter', function () {
    clearTimeout(hideTimer);
    if (overlay.classList.contains('pst-expanded')) clearTimeout(rowTimer);
  });
  overlay.addEventListener('mouseleave', function () {
    collapseRowSoon();
    scheduleHide();
  });

  async function handleSaveClick(cat, btn) {
    if (!hoveredImg || busy) return;
    const src = hoveredImg.currentSrc || hoveredImg.src;
    busy = true;
    clearTimeout(hideTimer);
    expandRow();
    trigger.classList.add('pst-busy');
    btn.classList.remove('pst-done', 'pst-fail');
    btn.classList.add('pst-busy');
    const setState = function (state) {
      if (state === 'deja') {
        btn.classList.remove('pst-busy');
        btn.classList.add('pst-done');
        btn.textContent = '✓ deja enregistre';
      }
      else if (state === 'telechargement') btn.textContent = 'telechargement...';
      else if (state === 'ecriture')       btn.textContent = 'ecriture...';
      else if (state === 'ok') {
        btn.classList.remove('pst-busy');
        btn.classList.add('pst-done');
        btn.textContent = '✓ ' + cat;
      }
    };
    try {
      const best = await saveTo(src, cat, setState);
      if (best) {
        applyVisuals();
        renderBar();
        toast('✓ ' + cat + (best.w ? ' - ' + best.w + ' × ' + best.h + ' px' : ''));
      }
    } catch (e) {
      btn.classList.remove('pst-busy');
      btn.classList.add('pst-fail');
      btn.textContent = '✗ echec';
      trigger.classList.add('pst-fail');
      toast('Echec : ' + e.message, true);
    } finally {
      busy = false;
      trigger.classList.remove('pst-busy');
      setTimeout(function () {
        trigger.classList.remove('pst-fail');
        if (overlay.classList.contains('pst-open')) paintStates();
      }, 1800);
    }
  }

  /* ============================================================
     8. MASQUAGE DE LA BARRE NATIVE ("Visiter le site" / partager / ...)
     Pinterest cree cette barre au moment du survol : on surveille le pin
     survole et on la cache des qu'elle apparait, avant meme l'affichage.
     ============================================================ */
  function hasBigImage(el) {
    const imgs = el.querySelectorAll('img');
    for (let i = 0; i < imgs.length; i++) {
      const r = imgs[i].getBoundingClientRect();
      if (r.width >= MIN_SIDE && r.height >= MIN_SIDE) return true;
    }
    return false;
  }
  function hideNativeBarIn(container) {
    if (!hideNative || !container || !container.querySelectorAll) return;
    const cands = container.querySelectorAll('a, button, div[role="button"]');
    for (let i = 0; i < cands.length; i++) {
      const el = cands[i];
      if (el.closest('.pst-native-hidden')) continue;
      if (!VISIT_TEXT.test((el.textContent || '').trim()) &&
          !VISIT_TEXT.test(el.getAttribute('aria-label') || '')) continue;
      // On remonte tant que l'element reste une "barre" (peu haute, sans la photo) :
      // le dernier ancetre valide regroupe Visiter + partager + "...".
      let bar = null;
      let cur = el;
      for (let up = 0; up < 6 && cur && cur !== container; up++) {
        const r = cur.getBoundingClientRect();
        if (r.height > 90 || hasBigImage(cur)) break;
        bar = cur;
        cur = cur.parentElement;
      }
      if (bar) bar.classList.add('pst-native-hidden');
    }
  }

  let nativeObserver = null;
  function watchNative(container) {
    if (nativeObserver) { nativeObserver.disconnect(); nativeObserver = null; }
    if (!container || !hideNative) return;
    hideNativeBarIn(container);
    nativeObserver = new MutationObserver(function () { hideNativeBarIn(container); });
    nativeObserver.observe(container, { childList: true, subtree: true });
  }

  /* ============================================================
     9. SURVOL
     ============================================================ */
  document.addEventListener('mouseover', function (ev) {
    const target = ev.target;
    if (!target || !target.closest) return;
    if (overlay.contains(target) || bar.contains(target)) return;

    let img = target.tagName === 'IMG' ? target : null;
    let container = containerOf(target);
    if (!img || !isPinImg(img)) {
      // Pinterest pose des calques PAR-DESSUS l'image : on remonte au pin.
      if (!container) return;
      img = mainImgIn(container);
      if (!img) return;
    }
    const r = img.getBoundingClientRect();
    if (r.width < MIN_SIDE || r.height < MIN_SIDE) return;
    container = container || img;
    if (container === hoveredEl && overlay.classList.contains('pst-open')) return;
    showOverlay(img, container);
  }, true);

  // Tant que le curseur reste dans la zone (image OU overlay), on garde ouvert
  document.addEventListener('mousemove', function (ev) {
    if (busy || !overlay.classList.contains('pst-open')) return;
    const x = ev.clientX, y = ev.clientY;
    if (pointIn(overlay.getBoundingClientRect(), x, y, 6)) { clearTimeout(hideTimer); return; }
    if (hoveredEl && hoveredEl.isConnected &&
        pointIn(hoveredEl.getBoundingClientRect(), x, y, 6)) { clearTimeout(hideTimer); return; }
    scheduleHide(); // la souris sort de la zone -> tout disparait
  }, { passive: true });

  // Au defilement on suit l'image au lieu de tout fermer
  let scrollRaf = 0;
  window.addEventListener('scroll', function () {
    if (!hoveredImg || scrollRaf) return;
    scrollRaf = requestAnimationFrame(function () {
      scrollRaf = 0;
      if (!hoveredImg) return;
      if (!hoveredImg.isConnected || !positionOverlay(hoveredImg)) { if (!busy) hideOverlay(); }
    });
  }, { passive: true });
  window.addEventListener('resize', function () { if (!busy) hideOverlay(); });
  window.addEventListener('blur', function () { if (!busy) hideOverlay(); });

  /* ============================================================
     10. MARQUAGE DES IMAGES DEJA ENREGISTREES + FILTRE
     ============================================================ */
  let activeFilter = null;
  function applyVisuals() {
    const imgs = document.querySelectorAll('img');
    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      if (!isPinImg(img)) continue;
      const cats  = index[hashOf(img.currentSrc || img.src)] || [];
      const saved = cats.length > 0;
      let opacity = '', outline = '';
      if (activeFilter && activeFilter.size) {
        let match = false;
        for (let j = 0; j < cats.length; j++) if (activeFilter.has(cats[j])) { match = true; break; }
        opacity = match ? '' : '0.2';
        outline = match ? '3px solid #22c55e' : '';
      } else {
        outline = saved ? '3px solid #22c55e' : '';
      }
      outline && (img.style.outlineOffset = '-3px');
      if (img.style.opacity !== opacity) img.style.opacity = opacity;
      if (img.style.outline !== outline) img.style.outline = outline;
    }
  }

  /* ============================================================
     11. BARRE DU BAS (dossier, filtres, reglages)
     ============================================================ */
  const bar = document.createElement('div');
  bar.style.cssText = [
    'position:fixed', 'left:18px', 'bottom:18px', 'z-index:2147483645',
    'background:#111', 'color:#fff', 'border-radius:14px', 'padding:11px',
    'font:600 12px/1.35 system-ui,-apple-system,sans-serif',
    'box-shadow:0 8px 30px rgba(0,0,0,.45)', 'max-width:min(620px,82vw)'
  ].join(';');
  document.body.appendChild(bar);

  const toastEl = document.createElement('div');
  toastEl.style.cssText = [
    'position:fixed', 'left:50%', 'bottom:24px', 'transform:translateX(-50%)',
    'z-index:2147483647', 'display:none',
    'background:#111', 'color:#fff', 'padding:9px 15px', 'border-radius:10px',
    'font:600 12px system-ui,sans-serif', 'box-shadow:0 6px 24px rgba(0,0,0,.5)',
    'max-width:70vw', 'text-align:center'
  ].join(';');
  document.body.appendChild(toastEl);
  let toastTimer = null;
  function toast(msg, isError) {
    toastEl.textContent = msg;
    toastEl.style.background = isError ? '#7f1d1d' : '#111';
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.display = 'none'; }, 3200);
  }

  function chip(label, opts) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = [
      'border:0', 'border-radius:8px', 'padding:6px 10px', 'cursor:pointer',
      'margin:0 5px 5px 0', 'font:600 12px system-ui,sans-serif',
      'background:' + (opts.bg || '#2f2f2f'), 'color:' + (opts.color || '#fff')
    ].join(';');
    if (opts.title) b.title = opts.title;
    if (opts.onClick) b.addEventListener('click', opts.onClick);
    return b;
  }

  function renderBar() {
    bar.innerHTML = '';
    bar.style.padding = barMini ? '6px' : '11px';

    if (barMini) {
      bar.appendChild(chip('\u{1F4C1} MAISON +', {
        title: 'Afficher la barre',
        bg: storedHandle && rootReady ? '#2f2f2f' : '#e60023',
        onClick: function () { barMini = false; saveBarMini(); renderBar(); }
      }));
      return;
    }

    // --- ligne 1 : dossier + reglages ---
    const row1 = document.createElement('div');
    row1.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:8px;flex-wrap:wrap';
    const folderLabel = document.createElement('span');
    folderLabel.textContent = storedHandle ? '\u{1F4C1} ' + storedHandle.name : '\u{1F4C1} aucun dossier';
    folderLabel.style.cssText = 'opacity:.85;margin-right:2px';
    row1.appendChild(folderLabel);

    if (storedHandle && !rootReady) {
      row1.appendChild(chip('Autoriser', {
        bg: '#e60023',
        title: 'Le navigateur redemande la permission d\'ecrire dans ce dossier',
        onClick: async function () {
          if (await reauthorize()) toast('Dossier « ' + storedHandle.name + ' » pret.');
        }
      }));
    }
    row1.appendChild(chip(storedHandle ? 'Changer' : 'Choisir le dossier', {
      bg: storedHandle ? '#2f2f2f' : '#e60023',
      onClick: pickRoot
    }));
    row1.appendChild(chip('Pinterest natif : ' + (hideNative ? 'masque' : 'visible'), {
      bg: hideNative ? '#15803d' : '#2f2f2f',
      title: 'Afficher ou masquer la barre Visiter / partager de Pinterest',
      onClick: function () {
        hideNative = !hideNative;
        saveHideNative();
        applyNativeFlag();
        if (hideNative && hoveredEl) watchNative(hoveredEl);
        else watchNative(null);
        renderBar();
        toast(hideNative ? 'Boutons Pinterest masques.' : 'Boutons Pinterest reaffiches.');
      }
    }));
    row1.appendChild(chip('–', {
      title: 'Reduire la barre',
      onClick: function () { barMini = true; saveBarMini(); renderBar(); }
    }));
    bar.appendChild(row1);

    // --- ligne 2 : filtres ---
    const row2 = document.createElement('div');
    row2.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap';
    const label = document.createElement('span');
    label.textContent = 'Filtre :';
    label.style.cssText = 'opacity:.6;margin-right:7px';
    row2.appendChild(label);

    const counts = {};
    categories.forEach(function (c) { counts[c] = 0; });
    Object.keys(index).forEach(function (h) {
      index[h].forEach(function (c) { if (counts[c] !== undefined) counts[c] += 1; });
    });

    row2.appendChild(chip('Tout', {
      bg: !activeFilter ? '#e60023' : '#2f2f2f',
      onClick: function () { activeFilter = null; renderBar(); applyVisuals(); }
    }));
    categories.forEach(function (cat) {
      const on = activeFilter && activeFilter.has(cat);
      const b = chip(cat + ' (' + counts[cat] + ')', {
        bg: on ? '#e60023' : '#2f2f2f',
        title: 'Filtrer - clic droit : renommer - Alt+clic : retirer',
        onClick: function (ev) {
          if (ev.altKey) { removeCategory(cat); return; }
          if (!activeFilter) activeFilter = new Set();
          if (activeFilter.has(cat)) activeFilter.delete(cat);
          else activeFilter.add(cat);
          if (!activeFilter.size) activeFilter = null;
          renderBar();
          applyVisuals();
        }
      });
      b.addEventListener('contextmenu', function (ev) { ev.preventDefault(); renameCategory(cat); });
      row2.appendChild(b);
    });
    row2.appendChild(chip('+ categorie', { bg: '#1c1c1c', color: '#9fd', onClick: addCategory }));
    bar.appendChild(row2);
  }

  function addCategory() {
    const name = prompt('Nom de la nouvelle categorie (ce sera le nom du sous-dossier) :');
    if (!name) return;
    const clean = sanitize(name);
    if (!clean) return;
    if (categories.indexOf(clean) !== -1) { toast('Cette categorie existe deja.', true); return; }
    categories.push(clean);
    saveCategories();
    renderBar();
    toast('Categorie « ' + clean + ' » ajoutee.');
  }
  function renameCategory(old) {
    const name = prompt('Renommer « ' + old + ' » en :\n(Le dossier deja cree sur le disque garde son ancien nom.)', old);
    if (!name) return;
    const clean = sanitize(name);
    if (!clean || clean === old) return;
    if (categories.indexOf(clean) !== -1) { toast('Cette categorie existe deja.', true); return; }
    const i = categories.indexOf(old);
    if (i === -1) return;
    categories[i] = clean;
    saveCategories();
    Object.keys(index).forEach(function (h) {
      const j = index[h].indexOf(old);
      if (j !== -1) index[h][j] = clean;
    });
    saveIndex();
    if (activeFilter && activeFilter.has(old)) { activeFilter.delete(old); activeFilter.add(clean); }
    renderBar(); applyVisuals();
    toast('Renomme en « ' + clean + ' ».');
  }
  function removeCategory(cat) {
    if (!confirm('Retirer la categorie « ' + cat + ' » de la liste ?\n(Les fichiers deja enregistres ne sont PAS supprimes.)')) return;
    categories = categories.filter(function (c) { return c !== cat; });
    saveCategories();
    if (activeFilter) activeFilter.delete(cat);
    if (activeFilter && !activeFilter.size) activeFilter = null;
    renderBar(); applyVisuals();
    toast('Categorie retiree de la liste.');
  }

  GM_registerMenuCommand('Reinitialiser la memoire des images (les fichiers restent)', function () {
    if (!confirm('Oublier la memoire des images deja enregistrees ?')) return;
    index = {}; logEntries = [];
    saveIndex(); saveLog();
    renderBar(); applyVisuals();
    toast('Memoire reinitialisee.');
  });
  GM_registerMenuCommand('Afficher la barre du bas', function () {
    barMini = false; saveBarMini(); renderBar();
  });

  /* ============================================================
     12. DEMARRAGE
     ============================================================ */
  (async function init() {
    applyNativeFlag();
    await restoreRoot();
    renderBar();
    applyVisuals();
    // Pinterest recharge ses images en continu : on re-applique le marquage
    setInterval(applyVisuals, 2000);
    if (!dirPicker()) toast('Edge ou Chrome requis pour enregistrer dans un dossier.', true);
    else if (storedHandle && rootReady) toast('Dossier « ' + storedHandle.name + ' » pret.');
    else if (storedHandle) toast('Clique sur « Autoriser » en bas a gauche pour reprendre.', true);
    else toast('Choisis le dossier MAISON en bas a gauche.', true);
  })();
})();
