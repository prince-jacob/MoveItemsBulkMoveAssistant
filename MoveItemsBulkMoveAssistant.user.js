// ==UserScript==
// @name         MoveItems Bulk Move Assistant - NCL1
// @namespace    PrinceJacob-Amazon
// @version      2.0.2
// @description  Ultra compact bulk helper for AFT MoveItems with presets, responsive/resizable UI, white inputs, FCResearch tab-bridge CUSTOMER_SHIPMENT auto-fill, FNSKU auto-clear, auto-resume, qty list, and auto Change container.
// @author       Prince Jacob (Wprijaco)
// @updateURL    https://github.com/prince-jacob/MoveItemsBulkMoveAssistant/raw/refs/heads/main/MoveItemsBulkMoveAssistant.user.js
// @downloadURL  https://github.com/prince-jacob/MoveItemsBulkMoveAssistant/raw/refs/heads/main/MoveItemsBulkMoveAssistant.user.js
// @homepageURL  https://github.com/prince-jacob/MoveItemsBulkMoveAssistant
// @match        https://aft-qt-eu.aka.amazon.com/app/moveitems*
// @match        https://qi-fcresearch-eu.corp.amazon.com/NCL1/*
// @match        file:///*MoveItemsApp*.html
// @include      file://*/MoveItemsApp*.html
// @run-at       document-idle
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_openInTab
// @grant        GM_info
// @connect      qi-fcresearch-eu.corp.amazon.com
// @connect      github.com
// @connect      raw.githubusercontent.com
// ==/UserScript==

(function () {
  'use strict';

  /**********************************************************************
   * MoveItems Bulk Move Assistant
   * - This script does NOT store cookies/tokens.
   * - This script does NOT call hidden APIs for moving stock.
   * - It submits the current MoveItems input box like a normal scanner.
   * - On file:// saved HTML it runs in test/view mode only.
   **********************************************************************/

  const CREATOR = 'Creator: Prince Jacob (Wprijaco)';
  const STORE_KEY = 'pj_moveitems_bulk_v12';
  const RUN_KEY = 'pj_moveitems_bulk_run_v13';
  const IS_LOCAL_FILE = location.protocol === 'file:';
  const TICK_MS = 650;
  const AFTER_SUBMIT_MS = 950;
  const MAX_WAIT_MS = 30000;
  const READY_POLL_MS = 250;
  const READY_STABLE_TICKS = 3;
  const READY_MAX_MS = 30000;
  const AUTO_RESUME_MAX_AGE_MS = 45 * 60 * 1000;
  const FOCUS_AFTER_CHANGE_KEY = 'pj_moveitems_focus_source_after_change';
  const FCRESEARCH_BASE = 'https://qi-fcresearch-eu.corp.amazon.com/NCL1/results?s=';
  const IS_FCRESEARCH_PAGE = location.hostname === 'qi-fcresearch-eu.corp.amazon.com';
  const FC_BRIDGE_REQ_KEY = 'pj_mi_fcresearch_bridge_request_v20';
  const FC_BRIDGE_RES_KEY = 'pj_mi_fcresearch_bridge_response_v20';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const state = {
    running: false,
    paused: false,
    busy: false,
    queue: [],
    index: 0,
    lastSubmitAt: 0,
    lastPrompt: '',
    stopRequested: false,
    startTime: 0
  };


  function gmSet(key, value) {
    if (typeof GM_setValue === 'function') return GM_setValue(key, value);
    localStorage.setItem(key, JSON.stringify(value));
  }

  function gmGet(key, fallback = null) {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(key, fallback);
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function gmDel(key) {
    try {
      if (typeof GM_deleteValue === 'function') return GM_deleteValue(key);
      localStorage.removeItem(key);
    } catch {}
  }

  function gmListen(key, cb) {
    if (typeof GM_addValueChangeListener === 'function') {
      return GM_addValueChangeListener(key, (_name, oldValue, newValue, remote) => cb(newValue, oldValue, remote));
    }
    return null;
  }

  function currentFcResearchSearchValue() {
    try { return new URL(location.href).searchParams.get('s') || ''; }
    catch { return ''; }
  }

  async function runFcResearchBridgePage() {
    if (!IS_FCRESEARCH_PAGE) return false;

    // This same userscript also runs on FCResearch. Its only job there is to read the normally-opened
    // FCResearch result page and pass CUSTOMER_SHIPMENT item barcodes back to MoveItems.
    const req = gmGet(FC_BRIDGE_REQ_KEY, null);
    if (!req || !req.id || !req.source) return true;

    const urlSource = currentFcResearchSearchValue();
    if (urlSource && urlSource.toLowerCase() !== String(req.source).toLowerCase()) return true;

    const started = Date.now();
    while (Date.now() - started < 25000) {
      const pageText = document.body ? document.body.innerText : '';
      const htmlText = document.documentElement ? document.documentElement.outerHTML : '';

      if (/midway|sign\s*in|login/i.test(pageText) && !/CUSTOMER_SHIPMENT|UNOWNED/i.test(pageText)) {
        gmSet(FC_BRIDGE_RES_KEY, {
          id: req.id,
          source: req.source,
          ok: false,
          error: 'FCResearch tab opened login page. Refresh FCResearch/Midway, then try again.',
          updatedAt: Date.now()
        });
        return true;
      }

      if (/CUSTOMER_SHIPMENT|UNOWNED|SELLABLE/i.test(pageText + ' ' + htmlText)) {
        const parsed = parseFcResearchCustomerShipment(htmlText, req.source);
        gmSet(FC_BRIDGE_RES_KEY, {
          id: req.id,
          source: req.source,
          ok: true,
          lines: parsed.lines,
          customerRows: parsed.customerRows,
          skippedRows: parsed.skippedRows,
          updatedAt: Date.now()
        });
        // Close only if this tab was opened by the bridge. Some browsers may ignore window.close(); that's OK.
        if (req.autoClose !== false) setTimeout(() => { try { window.close(); } catch {} }, 700);
        return true;
      }
      await sleep(500);
    }

    gmSet(FC_BRIDGE_RES_KEY, {
      id: req.id,
      source: req.source,
      ok: false,
      error: 'FCResearch tab did not finish loading result rows in time.',
      updatedAt: Date.now()
    });
    return true;
  }

  function cleanText(el) {
    return (el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function parsePresets(text) {
    const seen = new Set();
    return String(text || '')
      .split(/\r?\n/)
      .map(x => x.trim())
      .filter(x => x && !x.startsWith('#') && !x.startsWith('//'))
      .filter(x => {
        const key = x.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function optionHtml(list, current, label) {
    const cur = String(current || '').trim();
    const opts = [`<option value="">${escapeHtml(label)}</option>`];
    list.forEach(v => {
      const selected = cur && v.toLowerCase() === cur.toLowerCase() ? ' selected' : '';
      opts.push(`<option value="${escapeHtml(v)}"${selected}>${escapeHtml(v)}</option>`);
    });
    return opts.join('');
  }

  function refreshPresetSelects() {
    const saved = getSaved();
    const sourceList = parsePresets($('#mib-source-presets')?.value ?? saved.sourcePresets ?? '');
    const destList = parsePresets($('#mib-dest-presets')?.value ?? saved.destPresets ?? '');
    const sourceSel = $('#mib-source-preset');
    const destSel = $('#mib-dest-preset');
    if (sourceSel) sourceSel.innerHTML = optionHtml(sourceList, $('#mib-source')?.value || '', 'Source preset');
    if (destSel) destSel.innerHTML = optionHtml(destList, $('#mib-dest')?.value || '', 'Dest preset');
  }

  function focusNextAfterPreset(kind) {
    const dest = $('#mib-dest');
    const list = $('#mib-list');
    setTimeout(() => {
      if (kind === 'source' && dest) { dest.focus(); dest.select?.(); }
      if (kind === 'dest' && list) {
        list.focus();
        const len = list.value.length;
        list.setSelectionRange(len, len);
      }
    }, 30);
  }

  function applyPreset(kind) {
    const sel = kind === 'source' ? $('#mib-source-preset') : $('#mib-dest-preset');
    const input = kind === 'source' ? $('#mib-source') : $('#mib-dest');
    if (!sel || !input || !sel.value) return;
    input.value = sel.value;
    saveUi();
    refreshPresetSelects();
    setStatus(kind === 'source' ? 'Source preset selected. Scan/select destination.' : 'Destination preset selected. Scan/paste FNSKUs.');
    if (kind === 'source') maybeAutoFetchFromSource('preset');
    focusNextAfterPreset(kind);
  }

  function getSaved() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); }
    catch { return {}; }
  }

  function saveUi() {
    const data = {
      source: $('#mib-source')?.value || '',
      dest: $('#mib-dest')?.value || '',
      list: $('#mib-list')?.value || '',
      delay: $('#mib-delay')?.value || '1500',
      repeatQty: $('#mib-repeatqty')?.checked ?? true,
      pauseErrors: $('#mib-pauseerrors')?.checked ?? true,
      skipSourceIfPresent: $('#mib-skipsource')?.checked ?? true,
      smartWait: $('#mib-smartwait')?.checked ?? true,
      autoChangeContainer: $('#mib-autochangec')?.checked ?? true,
      fcAutoFetch: $('#mib-autofcfetch')?.checked ?? true,
      sourcePresets: $('#mib-source-presets')?.value || '',
      destPresets: $('#mib-dest-presets')?.value || '',
      panelW: ($('#mib-panel')?.classList.contains('mib-collapsed') ? (getSaved().panelW || '') : (Math.round($('#mib-panel')?.getBoundingClientRect().width || 0) || '')),
      panelH: ($('#mib-panel')?.classList.contains('mib-collapsed') ? (getSaved().panelH || '') : (Math.round($('#mib-panel')?.getBoundingClientRect().height || 0) || '')),
      panelLeft: Math.round($('#mib-panel')?.getBoundingClientRect().left || 0) || '',
      panelTop: Math.round($('#mib-panel')?.getBoundingClientRect().top || 0) || '',
      panelCollapsed: $('#mib-panel')?.classList.contains('mib-collapsed') || false
    };
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
  }


  function getRun() {
    try { return JSON.parse(localStorage.getItem(RUN_KEY) || 'null'); }
    catch { return null; }
  }

  function persistRun(extra = {}) {
    const saved = getSaved();
    const data = {
      active: !!(state.running && !state.paused && !state.stopRequested),
      paused: !!state.paused,
      queue: Array.isArray(state.queue) ? state.queue : [],
      index: Math.max(0, state.index || 0),
      source: $('#mib-source')?.value || saved.source || '',
      dest: $('#mib-dest')?.value || saved.dest || '',
      list: $('#mib-list')?.value || saved.list || '',
      delay: $('#mib-delay')?.value || saved.delay || '1500',
      repeatQty: $('#mib-repeatqty')?.checked ?? saved.repeatQty ?? true,
      pauseErrors: $('#mib-pauseerrors')?.checked ?? saved.pauseErrors ?? true,
      skipSourceIfPresent: $('#mib-skipsource')?.checked ?? saved.skipSourceIfPresent ?? true,
      smartWait: $('#mib-smartwait')?.checked ?? saved.smartWait ?? true,
      autoChangeContainer: $('#mib-autochangec')?.checked ?? saved.autoChangeContainer ?? true,
      fcAutoFetch: $('#mib-autofcfetch')?.checked ?? saved.fcAutoFetch ?? true,
      sourcePresets: $('#mib-source-presets')?.value ?? saved.sourcePresets ?? '',
      destPresets: $('#mib-dest-presets')?.value ?? saved.destPresets ?? '',
      startTime: state.startTime || Date.now(),
      updatedAt: Date.now(),
      ...extra
    };
    localStorage.setItem(RUN_KEY, JSON.stringify(data));
  }

  function clearRun() {
    localStorage.removeItem(RUN_KEY);
  }

  function applyRunToUi(run) {
    if (!run) return false;
    if ($('#mib-source')) $('#mib-source').value = run.source || '';
    if ($('#mib-dest')) $('#mib-dest').value = run.dest || '';
    if ($('#mib-list')) $('#mib-list').value = run.list || '';
    if ($('#mib-delay')) $('#mib-delay').value = run.delay || '1500';
    if ($('#mib-repeatqty')) $('#mib-repeatqty').checked = run.repeatQty !== false;
    if ($('#mib-pauseerrors')) $('#mib-pauseerrors').checked = run.pauseErrors !== false;
    if ($('#mib-skipsource')) $('#mib-skipsource').checked = run.skipSourceIfPresent !== false;
    if ($('#mib-smartwait')) $('#mib-smartwait').checked = run.smartWait !== false;
    if ($('#mib-autochangec')) $('#mib-autochangec').checked = run.autoChangeContainer !== false;
    if ($('#mib-autofcfetch')) $('#mib-autofcfetch').checked = run.fcAutoFetch !== false;
    const saved = getSaved();
    if ($('#mib-source-presets')) $('#mib-source-presets').value = run.sourcePresets ?? saved.sourcePresets ?? '';
    if ($('#mib-dest-presets')) $('#mib-dest-presets').value = run.destPresets ?? saved.destPresets ?? '';
    refreshPresetSelects();

    state.queue = Array.isArray(run.queue) ? run.queue : [];
    state.index = Math.max(0, Number(run.index || 0));
    state.running = !!(run.active || run.paused);
    state.paused = !!run.paused;
    state.stopRequested = false;
    state.startTime = run.startTime || Date.now();
    saveUi();
    return true;
  }

  function restoreSavedRunAfterRefresh() {
    if (IS_LOCAL_FILE) return;
    const run = getRun();
    if (!run || (!run.active && !run.paused)) return;
    if (!Array.isArray(run.queue) || !run.queue.length) return;

    const age = Date.now() - (run.updatedAt || 0);
    if (age > AUTO_RESUME_MAX_AGE_MS) {
      run.active = false;
      run.paused = true;
      run.updatedAt = Date.now();
      localStorage.setItem(RUN_KEY, JSON.stringify(run));
      applyRunToUi(run);
      setButtons();
      refreshSummary();
      setStatus(`Saved run paused because it is old. Press Resume to continue ${state.index}/${state.queue.length}.`, true);
      addLog(`Old saved run found. Paused at ${state.index}/${state.queue.length}.`, true);
      return;
    }

    applyRunToUi(run);
    setButtons();
    refreshSummary();

    if (run.paused) {
      setStatus(`Saved paused run loaded: ${state.index}/${state.queue.length}. Press Resume.`);
      addLog(`Saved paused run loaded at ${state.index}/${state.queue.length}.`);
      return;
    }

    setStatus(`Auto-resuming after page refresh: ${state.index}/${state.queue.length}...`);
    addLog(`Auto-resume after refresh. Last step: ${run.lastStep || 'unknown'}.`);
    setTimeout(() => runLoop(), 1000);
  }

  function setStatus(msg, bad = false) {
    const el = $('#mib-status');
    if (!el) return;
    el.textContent = msg;
    el.style.color = bad ? '#fecaca' : '#a7f3d0';
  }

  function addLog(msg, bad = false) {
    const log = $('#mib-log');
    if (!log) return;
    const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const row = document.createElement('div');
    row.className = bad ? 'mib-log-row bad' : 'mib-log-row';
    row.textContent = `[${time}] ${msg}`;
    log.prepend(row);
    while (log.children.length > 80) log.lastChild.remove();
  }

  function beep(type = 'ok') {
    // Tiny optional browser beep. Ignored when AudioContext is blocked.
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = type === 'bad' ? 180 : 650;
      gain.gain.value = 0.045;
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start();
      setTimeout(() => { osc.stop(); ctx.close(); }, type === 'bad' ? 230 : 110);
    } catch {}
  }

  function getAState() {
    const node = $$('script[type="a-state"]').find(s => {
      const attr = s.getAttribute('data-a-state') || '';
      const text = s.textContent || '';
      return attr.includes('"key":"id"') || attr.includes('&quot;key&quot;:&quot;id&quot;') || text.includes('"instructionId"');
    });
    if (!node) return null;
    try { return JSON.parse(node.textContent.trim()); } catch { return null; }
  }

  function getWorkflowInfo() {
    const contextText = cleanText($('#context'));
    const workflowText = cleanText($('#workflow'));
    const prompt = cleanText($('#workflow .aft-tool-action-box h1, #workflow h1'));
    const label = cleanText($('#workflow label'));
    const error = cleanText($('#workflow .a-alert-content, #workflow .a-alert-error .a-alert-content'));
    const mode = matchOne(contextText, /Mode:\s*([^:]+?)(?:\s+Source container|\s+Item|$)/i) || matchOne(contextText, /Mode\s+([^\s]+)/i);
    const source = matchOne(contextText, /Source container\s+Barcode:\s*([^\s]+)/i) || matchOne(contextText, /Source\s+container\s+([^\s]+)/i);
    const currentFnsku = matchOne(contextText, /FCSku:\s*([^\s]+)/i) || matchOne(contextText, /FNSKU:\s*([^\s]+)/i);
    const qty = matchOne(contextText, /Quantity:\s*(\d+)/i);
    const title = matchOne(contextText, /Title:\s*(.*?)(?:\s+FCSku:|\s+FNSKU:|\s+Quantity:|$)/i);
    const appState = getAState() || {};

    return { contextText, workflowText, prompt, label, error, mode, source, currentFnsku, qty, title, appState };
  }

  function matchOne(text, re) {
    const m = String(text || '').match(re);
    return m ? m[1].trim() : '';
  }

  function currentInput() {
    return $('#workflow input[type="text"], #workflow textarea, form input[type="text"], form textarea');
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  function isInputReady() {
    const input = currentInput();
    if (!input || !isVisible(input)) return false;
    if (input.disabled || input.readOnly) return false;
    const form = input.closest('form');
    if (!form) return false;
    const btn = form.querySelector('input[type="submit"], button[type="submit"], .a-button-input');
    if (btn && (btn.disabled || btn.getAttribute('aria-disabled') === 'true')) return false;
    return true;
  }

  async function waitForReadyToScan(expectedStep = '') {
    if (IS_LOCAL_FILE) return;
    const settings = getJobSettings();
    if (!settings.smartWait) return;

    const start = Date.now();
    let stableCount = 0;
    let lastSig = '';

    while (Date.now() - start < READY_MAX_MS) {
      const det = detectStep();
      const workflow = cleanText($('#workflow'));
      const okStep = !expectedStep || det.step === expectedStep;
      const ok = isInputReady() && okStep && !['error', 'noinput', 'unknown'].includes(det.step);
      const sig = `${det.step}|${workflow}`;

      if (ok && sig === lastSig) stableCount += 1;
      else stableCount = ok ? 1 : 0;
      lastSig = sig;

      if (stableCount >= READY_STABLE_TICKS) return;
      await sleep(READY_POLL_MS);
    }
    throw new Error(expectedStep ? `Timed out waiting for ${expectedStep} input to be ready.` : 'Timed out waiting for MoveItems input to be ready.');
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findChangeContainerButton() {
    const actionNode = $$('[data-action="click-action"], .a-declarative[data-action="click-action"]').find(el => {
      const data = el.getAttribute('data-click-action') || '';
      const text = cleanText(el);
      return /change\s+container/i.test(text) || /\"action\"\s*:\s*\"Done\"/.test(data) || /'action'\s*:\s*'Done'/.test(data);
    });
    if (actionNode) return actionNode.querySelector('.a-button-input, input[type="submit"], button') || actionNode;

    const textNode = $$('button, input[type="submit"], input[type="button"], .a-button, a, span').find(el => /change\s+container/i.test(cleanText(el)));
    if (!textNode) return null;
    return textNode.querySelector?.('.a-button-input, input[type="submit"], button') || textNode;
  }

  function clickChangeContainer() {
    if (IS_LOCAL_FILE) {
      addLog('LOCAL TEST: would click Change container.');
      setStatus('Local test: would change container.');
      return true;
    }

    const btn = findChangeContainerButton();
    if (!btn) return false;

    const actionWrap = btn.closest?.('[data-action="click-action"]');
    const target = actionWrap?.querySelector?.('.a-button-input, input[type="submit"], button') || btn;
    sessionStorage.setItem(FOCUS_AFTER_CHANGE_KEY, '1');
    target.click();
    state.lastSubmitAt = Date.now();
    return true;
  }

  async function waitAndClickChangeContainerAfterDone() {
    if (IS_LOCAL_FILE) return clickChangeContainer();

    const start = Date.now();
    while (Date.now() - start < READY_MAX_MS) {
      if (findChangeContainerButton()) {
        addLog('Clicking Change container so next source can be scanned.');
        setStatus('Finished. Changing container...');
        return clickChangeContainer();
      }
      await sleep(READY_POLL_MS);
    }
    return false;
  }

  function clearFnskuOnlyAfterFinish() {
    const list = $('#mib-list');
    if (!list) return;
    list.value = '';
    const saved = getSaved();
    saved.list = '';
    localStorage.setItem(STORE_KEY, JSON.stringify(saved));
    addLog('FNSKU list cleared. Source and destination kept.');
  }

  function decodeHtmlText(v) {
    const div = document.createElement('div');
    div.innerHTML = String(v || '');
    return (div.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function cellsFromFcResearchRow(rowHtml) {
    const cells = [];
    const parts = String(rowHtml || '').split(/<td\b[^>]*>/i).slice(1);
    for (const part of parts) {
      const raw = part.split(/(?=<td\b|<\/tr>|<tr\b)/i)[0] || '';
      cells.push(decodeHtmlText(raw));
    }
    return cells;
  }

  function parseFcResearchCustomerShipment(htmlText, source) {
    const sourceKey = String(source || '').trim().toLowerCase();
    const totals = new Map();
    let customerRows = 0;
    let skippedRows = 0;

    const rowRe = /<tr\s+data-row-id=(['"]?)([^'"\s>]+)\1[^>]*>([\s\S]*?)(?=<tr\s+data-row-id=|<\/tbody>|<\/table>)/gi;
    let m;
    while ((m = rowRe.exec(String(htmlText || '')))) {
      const rowId = decodeHtmlText(m[2]);
      const cells = cellsFromFcResearchRow(m[3]);
      if (cells.length < 8) continue;

      const container = (cells[0] || '').trim();
      const consumer = (cells[7] || '').trim().toUpperCase();
      if (sourceKey && container && container.toLowerCase() !== sourceKey) {
        skippedRows += 1;
        continue;
      }

      if (consumer !== 'CUSTOMER_SHIPMENT') {
        skippedRows += 1;
        continue;
      }

      // FCResearch table columns in your sample are:
      // Container, ASIN, FNSku, FCSku, LPN, Qty, Disposition, Consumer, ...
      // MoveItems item barcode matches the FCSku-style ZZV/ZZW values from column 4.
      let itemBarcode = (cells[3] || '').trim();
      if (!itemBarcode && rowId.includes('-')) itemBarcode = rowId.split('-').pop().trim();
      if (!itemBarcode) continue;

      const qtyMatch = String(cells[5] || '').match(/\d+/);
      const qty = qtyMatch ? Math.max(1, parseInt(qtyMatch[0], 10)) : 1;
      totals.set(itemBarcode, (totals.get(itemBarcode) || 0) + qty);
      customerRows += 1;
    }

    const lines = Array.from(totals.entries()).map(([code, qty]) => qty > 1 ? `${code} x${qty}` : code);
    return { lines, customerRows, skippedRows };
  }

  function gmGetText(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest not available. Check Tampermonkey permissions.'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        anonymous: false,
        timeout: 30000,
        onload: res => {
          if (res.status >= 200 && res.status < 300) resolve(res.responseText || '');
          else reject(new Error(`FCResearch returned HTTP ${res.status}`));
        },
        ontimeout: () => reject(new Error('FCResearch request timed out.')),
        onerror: () => reject(new Error('FCResearch request failed.'))
      });
    });
  }


  function openFcResearchBridgeTab(source) {
    const url = `${FCRESEARCH_BASE}${encodeURIComponent(source)}`;
    if (typeof GM_openInTab === 'function') {
      try {
        return GM_openInTab(url, { active: false, insert: true, setParent: true });
      } catch {
        try { return GM_openInTab(url, false); } catch {}
      }
    }
    window.open(url, '_blank', 'noopener,noreferrer');
    return null;
  }

  function fetchFcResearchViaTabBridge(source) {
    return new Promise((resolve, reject) => {
      if (typeof GM_setValue !== 'function' || typeof GM_getValue !== 'function') {
        reject(new Error('Tampermonkey GM storage permission is missing. Reinstall this v2.0 script.'));
        return;
      }

      const id = `fc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timeoutMs = 45000;
      let done = false;
      let timer = null;
      let listener = null;

      const cleanup = () => {
        clearTimeout(timer);
        // Tampermonkey does not always provide remove-listener; leaving one listener for this page load is harmless.
        gmDel(FC_BRIDGE_REQ_KEY);
      };

      const handleResponse = res => {
        if (!res || res.id !== id || done) return;
        done = true;
        cleanup();
        if (res.ok) resolve(res);
        else reject(new Error(res.error || 'FCResearch tab bridge failed.'));
      };

      listener = gmListen(FC_BRIDGE_RES_KEY, newValue => handleResponse(newValue));
      gmDel(FC_BRIDGE_RES_KEY);
      gmSet(FC_BRIDGE_REQ_KEY, { id, source, createdAt: Date.now(), autoClose: true });
      openFcResearchBridgeTab(source);

      timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error('Timed out waiting for FCResearch tab. Check popup blocker or open FCResearch manually.'));
      }, timeoutMs);
    });
  }

  async function fetchCustomerShipmentFromFcResearch(reason = 'manual') {
    const source = ($('#mib-source')?.value || '').trim();
    const list = $('#mib-list');
    if (!source) {
      setStatus('Add/scan source first, then fetch FCResearch.', true);
      return;
    }
    if (!list) return;
    if (IS_LOCAL_FILE) {
      setStatus('Local test: FCResearch tab bridge works only on live MoveItems page.', true);
      addLog('Local test: FCResearch fetch skipped.', true);
      return;
    }

    const btn = $('#mib-fetchfc');
    if (btn) btn.disabled = true;
    setStatus(`Opening FCResearch tab bridge for ${source}...`);
    addLog(`FCResearch tab bridge started for ${source} (${reason}).`);

    try {
      const parsed = await fetchFcResearchViaTabBridge(source);
      if (!parsed.lines || !parsed.lines.length) {
        setStatus(`No CUSTOMER_SHIPMENT FCSku found for ${source}. List unchanged.`, true);
        addLog(`FCResearch found 0 CUSTOMER_SHIPMENT rows for ${source}.`, true);
        return;
      }
      list.value = parsed.lines.join('\n');
      list.dispatchEvent(new Event('input', { bubbles: true }));
      saveUi();
      refreshSummary();
      setStatus(`Loaded ${parsed.lines.length} CUSTOMER_SHIPMENT item barcode(s) from FCResearch tab.`);
      addLog(`FCResearch tab loaded ${parsed.lines.length} item barcode(s); skipped ${parsed.skippedRows || 0} non-customer/other rows.`);
    } catch (e) {
      setStatus(e.message || String(e), true);
      addLog(e.message || String(e), true);
      beep('bad');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function maybeAutoFetchFromSource(reason = 'source-enter') {
    if (!($('#mib-autofcfetch')?.checked ?? true)) return;
    if (state.running && !state.paused) return;
    const source = ($('#mib-source')?.value || '').trim();
    if (!source) return;
    setTimeout(() => fetchCustomerShipmentFromFcResearch(reason), 100);
  }

  async function finishRun() {
    const total = state.queue.length;
    state.running = false;
    state.paused = false;
    state.stopRequested = false;
    clearRun();
    clearFnskuOnlyAfterFinish();
    setButtons();
    refreshSummary();
    addLog(`Finished queue: ${state.index}/${total}`);
    beep('ok');

    const settings = getJobSettings();
    if (settings.autoChangeContainer) {
      const clicked = await waitAndClickChangeContainerAfterDone();
      if (clicked) {
        setStatus('Finished. Change container clicked. Scan next source.');
      } else {
        setStatus('Finished, but Change container button was not found. Press d manually.', true);
        addLog('Finished, but Change container button was not found.', true);
      }
    } else {
      setStatus(`Finished. Moved ${state.index}/${total} scans.`);
    }
  }

  function submitCurrentInput(value) {
    if (IS_LOCAL_FILE) {
      addLog(`LOCAL TEST: would submit: ${value}`);
      setStatus(`Local test: would submit ${value}`);
      return true;
    }

    const input = currentInput();
    const form = input?.closest('form');
    if (!input || !form) throw new Error('MoveItems input/form not found on this step.');

    input.focus();
    setNativeValue(input, value);

    // Try normal submit button first because AFT declarative handler is attached there.
    const submit = form.querySelector('input[type="submit"], button[type="submit"], .a-button-input');
    if (submit) {
      submit.click();
    } else {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
    state.lastSubmitAt = Date.now();
    return true;
  }

  function detectStep() {
    const info = getWorkflowInfo();
    const p = `${info.prompt} ${info.label}`.toLowerCase();

    if (info.error && $('#mib-pauseerrors')?.checked) {
      return { step: 'error', info, reason: info.error };
    }

    if (!currentInput()) {
      return { step: 'noinput', info, reason: 'No visible MoveItems input found.' };
    }

    if (/destination/.test(p)) return { step: 'dest', info };

    // Initial source prompt usually says just "Scan container" / label "Container" and context has no source container.
    if (/source/.test(p) || (/scan\s+container|container/.test(p) && !info.source && !info.currentFnsku)) {
      return { step: 'source', info };
    }

    // Item/FNSKU step wording can vary by mode, so detect common words plus context source already present.
    if (/fnsku|fcsku|item|asin|barcode|scan\s+product|scan\s+unit/.test(p)) {
      if (!/destination/.test(p)) return { step: 'item', info };
    }

    // After source is present and no current item is waiting for destination, the next input is normally item scan.
    if (info.source && !info.currentFnsku && /container/.test(info.contextText.toLowerCase()) && !/destination/.test(p)) {
      return { step: 'item', info };
    }

    // If current item is in context and page asks container, that usually means destination.
    if (info.currentFnsku && /container/.test(p)) return { step: 'dest', info };

    return { step: 'unknown', info, reason: `Unknown page prompt: ${info.prompt || info.label || 'blank'}` };
  }

  function parseList() {
    const raw = $('#mib-list')?.value || '';
    const repeatQty = $('#mib-repeatqty')?.checked ?? true;
    const rows = [];
    const errors = [];

    raw.split(/\r?\n/).forEach((line, idx) => {
      const original = line;
      line = line.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) return;

      // Accept:
      // FNSKU
      // FNSKU 3
      // FNSKU x3
      // FNSKU,3
      // FNSKU\t3
      // FNSKU - 3
      const cleaned = line.replace(/[;,]+/g, ' ').replace(/\s+-\s+/g, ' ').replace(/\s+/g, ' ');
      const parts = cleaned.split(' ').filter(Boolean);
      const fnsku = (parts[0] || '').trim();
      let qty = 1;
      if (parts[1]) {
        const q = String(parts[1]).replace(/^x/i, '');
        if (/^\d+$/.test(q)) qty = Math.max(1, parseInt(q, 10));
      }

      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,80}$/.test(fnsku)) {
        errors.push(`Line ${idx + 1}: invalid FNSKU/barcode: ${original}`);
        return;
      }
      if (qty > 999) {
        errors.push(`Line ${idx + 1}: quantity too high: ${qty}`);
        return;
      }

      if (repeatQty) {
        for (let i = 1; i <= qty; i++) rows.push({ fnsku, qty, copy: i, line: idx + 1 });
      } else {
        rows.push({ fnsku, qty, copy: 1, line: idx + 1 });
      }
    });

    return { rows, errors };
  }

  function getJobSettings() {
    return {
      source: ($('#mib-source')?.value || '').trim(),
      dest: ($('#mib-dest')?.value || '').trim(),
      delay: Math.max(700, parseInt($('#mib-delay')?.value || '1500', 10) || 1500),
      skipSourceIfPresent: $('#mib-skipsource')?.checked ?? true,
      smartWait: $('#mib-smartwait')?.checked ?? true,
      autoChangeContainer: $('#mib-autochangec')?.checked ?? true
    };
  }

  function validateStart() {
    const s = getJobSettings();
    const { rows, errors } = parseList();
    if (!s.source) errors.unshift('Source container is empty.');
    if (!s.dest) errors.unshift('Destination container is empty.');
    if (s.source && s.dest && s.source.toLowerCase() === s.dest.toLowerCase()) errors.unshift('Source and destination cannot be the same.');
    if (!rows.length) errors.unshift('FNSKU list is empty.');
    return { settings: s, rows, errors };
  }

  function refreshSummary() {
    const info = getWorkflowInfo();
    const parsed = parseList();
    const done = state.index;
    const total = state.queue.length || parsed.rows.length;
    const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;

    const bar = $('#mib-progress-bar');
    if (bar) bar.style.width = `${pct}%`;
    const txt = $('#mib-progress-text');
    if (txt) txt.textContent = `${done}/${total} moves`;
    const mini = $('#mib-mini-progress');
    if (mini) mini.textContent = total ? `${done}/${total}` : '';

    const next = state.queue[state.index];
    const nextEl = $('#mib-next');
    if (nextEl) nextEl.textContent = next ? `Next: ${next.fnsku}${next.qty > 1 ? ` (${next.copy}/${next.qty})` : ''}` : 'Next: -';

    const errEl = $('#mib-page-error');
    if (errEl) {
      if (info.error) {
        errEl.style.display = 'block';
        errEl.textContent = info.error;
      } else {
        errEl.style.display = 'none';
        errEl.textContent = '';
      }
    }
  }

  async function runLoop() {
    if (state.busy) return;
    state.busy = true;
    try {
      while (state.running && !state.paused && !state.stopRequested) {
        refreshSummary();

        if (state.index >= state.queue.length) {
          await finishRun();
          break;
        }

        const settings = getJobSettings();
        if (settings.smartWait) await waitForReadyToScan();
        const det = detectStep();
        const info = det.info;

        if (det.step === 'error') {
          state.paused = true;
          persistRun({ active: false, paused: true, lastStep: 'page-error', lastError: det.reason });
          setButtons();
          setStatus(`Paused: ${det.reason}`, true);
          addLog(`Paused because page error: ${det.reason}`, true);
          beep('bad');
          break;
        }

        if (det.step === 'noinput' || det.step === 'unknown') {
          state.paused = true;
          persistRun({ active: false, paused: true, lastStep: det.step, lastError: det.reason });
          setButtons();
          setStatus(`Paused: ${det.reason}`, true);
          addLog(`Paused: ${det.reason}`, true);
          beep('bad');
          break;
        }

        if (det.step === 'source') {
          if (settings.skipSourceIfPresent && info.source && info.source.toLowerCase() === settings.source.toLowerCase()) {
            addLog(`Source already selected: ${settings.source}`);
          } else {
            if (settings.smartWait) await waitForReadyToScan('source');
            addLog(`Submitting source: ${settings.source}`);
            persistRun({ active: true, paused: false, lastStep: 'submitting-source', lastValue: settings.source, expectedNext: 'item' });
            submitCurrentInput(settings.source);
            await waitForPageAdvance('source');
          }
          await sleep(settings.delay);
          continue;
        }

        const current = state.queue[state.index];

        if (det.step === 'item') {
          if (settings.smartWait) await waitForReadyToScan('item');
          addLog(`Submitting item ${state.index + 1}/${state.queue.length}: ${current.fnsku}${current.qty > 1 ? ` (${current.copy}/${current.qty})` : ''}`);
          persistRun({ active: true, paused: false, lastStep: 'submitting-item', lastValue: current.fnsku, expectedNext: 'dest' });
          submitCurrentInput(current.fnsku);
          await waitForPageAdvance('item');
          await sleep(settings.delay);
          continue;
        }

        if (det.step === 'dest') {
          if (settings.smartWait) await waitForReadyToScan('dest');
          addLog(`Submitting destination: ${settings.dest} for ${current.fnsku}`);
          state.index += 1;
          persistRun({ active: true, paused: false, lastStep: 'submitting-destination', lastValue: settings.dest, completedFnsku: current.fnsku, expectedNext: 'item' });
          submitCurrentInput(settings.dest);
          await waitForPageAdvance('dest');
          await sleep(settings.delay);
          continue;
        }
      }
    } catch (e) {
      state.paused = true;
      state.running = true;
      persistRun({ active: false, paused: true, lastStep: 'exception', lastError: e.message || String(e) });
      setStatus(e.message || String(e), true);
      addLog(e.message || String(e), true);
      beep('bad');
      setButtons();
    } finally {
      state.busy = false;
      refreshSummary();
    }
  }

  async function waitForPageAdvance(previousStep) {
    if (IS_LOCAL_FILE) {
      await sleep(350);
      return;
    }

    const start = Date.now();
    const startPrompt = cleanText($('#workflow'));
    while (Date.now() - start < MAX_WAIT_MS) {
      await sleep(TICK_MS);
      const info = getWorkflowInfo();
      const nowPrompt = cleanText($('#workflow'));
      const det = detectStep();

      if (info.error && $('#mib-pauseerrors')?.checked) return;
      if (det.step !== previousStep || nowPrompt !== startPrompt) {
        await sleep(AFTER_SUBMIT_MS);
        return;
      }
    }
    throw new Error(`MoveItems did not advance after submitting ${previousStep}.`);
  }

  function startRun() {
    saveUi();
    const { settings, rows, errors } = validateStart();
    if (errors.length) {
      setStatus(errors[0], true);
      addLog(errors.join(' | '), true);
      return;
    }

    if (IS_LOCAL_FILE) {
      addLog('Local file mode: script will only simulate submissions. Open live MoveItems for real movement.');
    } else {
      const msg = `Start bulk move?\n\nSource: ${settings.source}\nDestination: ${settings.dest}\nMove scans: ${rows.length}\n\nThis will submit through MoveItems one by one.`;
      if (!confirm(msg)) return;
    }

    state.queue = rows;
    state.index = 0;
    state.running = true;
    state.paused = false;
    state.stopRequested = false;
    state.startTime = Date.now();
    persistRun({ active: true, paused: false, lastStep: 'started' });
    setButtons();
    addLog(`Started: ${rows.length} move scans from ${settings.source} to ${settings.dest}`);
    setStatus('Running...');
    runLoop();
  }

  function pauseRun() {
    state.paused = true;
    state.running = true;
    persistRun({ active: false, paused: true, lastStep: 'manual-pause' });
    setButtons();
    setStatus(`Paused at ${state.index}/${state.queue.length}`);
    addLog(`Paused at ${state.index}/${state.queue.length}`);
  }

  function resumeRun() {
    if (!state.queue.length) return startRun();
    state.paused = false;
    state.running = true;
    persistRun({ active: true, paused: false, lastStep: 'manual-resume' });
    setButtons();
    setStatus('Running...');
    addLog('Resumed');
    runLoop();
  }

  function stopRun() {
    state.stopRequested = true;
    state.running = false;
    state.paused = false;
    clearRun();
    setButtons();
    setStatus(`Stopped at ${state.index}/${state.queue.length}`);
    addLog(`Stopped at ${state.index}/${state.queue.length}`);
  }

  async function stepOnce() {
    if (!state.queue.length) {
      const { rows, errors } = validateStart();
      if (errors.length) {
        setStatus(errors[0], true);
        addLog(errors.join(' | '), true);
        return;
      }
      state.queue = rows;
      state.index = 0;
    }
    state.running = true;
    state.paused = false;
    state.stopRequested = false;

    // Run exactly one page submission, then pause.
    const oldIndex = state.index;
    const oldSubmit = state.lastSubmitAt;
    const originalRunning = state.running;
    state.busy = false;
    try {
      const settings = getJobSettings();
      const det = detectStep();
      const current = state.queue[state.index];
      if (settings.smartWait) await waitForReadyToScan(det.step);
      if (det.step === 'source') {
        addLog(`STEP: source ${settings.source}`);
        submitCurrentInput(settings.source);
      } else if (det.step === 'item') {
        addLog(`STEP: item ${current.fnsku}`);
        submitCurrentInput(current.fnsku);
      } else if (det.step === 'dest') {
        addLog(`STEP: destination ${settings.dest}`);
        state.index += 1;
        persistRun({ active: false, paused: true, lastStep: 'step-destination', lastValue: settings.dest });
        submitCurrentInput(settings.dest);
      } else {
        throw new Error(`Cannot step: ${det.reason || det.step}`);
      }
      state.running = false;
      state.paused = true;
      setButtons();
      setStatus(`Step submitted. Index ${state.index}/${state.queue.length}`);
    } catch (e) {
      state.running = originalRunning;
      state.index = oldIndex;
      state.lastSubmitAt = oldSubmit;
      setStatus(e.message, true);
      addLog(e.message, true);
      beep('bad');
    }
  }

  function setButtons() {
    const running = state.running && !state.paused;
    $('#mib-start').disabled = running;
    $('#mib-pause').disabled = !running;
    $('#mib-resume').disabled = !state.paused;
    $('#mib-stop').disabled = !state.running && !state.paused && !state.queue.length;
    $('#mib-step').disabled = running;
  }

  function copyLog() {
    const data = Array.from($('#mib-log')?.children || []).reverse().map(x => x.textContent).join('\n');
    if (typeof GM_setClipboard === 'function') GM_setClipboard(data, 'text');
    else navigator.clipboard?.writeText(data);
    setStatus('Copied log.');
  }

  function fillDemo() {
    $('#mib-source').value = $('#mib-source').value || 'tspsP2R2_06';
    $('#mib-dest').value = $('#mib-dest').value || 'DEST_CONTAINER_B';
    $('#mib-list').value = $('#mib-list').value || 'ZZVKJ98QBU\nB012345678 x2\nX001ABCDEF,3';
    saveUi();
    setStatus('Example format added. Replace with real values.');
    refreshSummary();
  }


  function setupScanEntryKeys() {
    const source = $('#mib-source');
    const dest = $('#mib-dest');
    const list = $('#mib-list');

    function focusAndSelect(el) {
      if (!el) return;
      setTimeout(() => {
        el.focus();
        if (typeof el.select === 'function' && el.tagName !== 'TEXTAREA') el.select();
        if (el.tagName === 'TEXTAREA') {
          const len = el.value.length;
          el.setSelectionRange(len, len);
        }
      }, 30);
    }

    if (source) {
      source.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveUi();
          refreshPresetSelects();
          maybeAutoFetchFromSource('source-enter');
          focusAndSelect(dest);
          setStatus('Source saved. Scan destination. Fetching FCResearch if enabled.');
        }
      });
    }

    if (dest) {
      dest.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          saveUi();
          refreshPresetSelects();
          focusAndSelect(list);
          setStatus('Destination saved. Scan/paste FNSKUs.');
        }
      });
    }

    if (list) {
      list.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          startRun();
        }
      });
    }
  }

  function maybeFocusSourceAfterAutoChange() {
    if (sessionStorage.getItem(FOCUS_AFTER_CHANGE_KEY) !== '1') return;
    sessionStorage.removeItem(FOCUS_AFTER_CHANGE_KEY);
    const source = $('#mib-source');
    if (!source) return;
    setTimeout(() => {
      source.focus();
      if (typeof source.select === 'function') source.select();
      setStatus('Ready. Scan next source.');
    }, 350);
  }

  function makePanel() {
    if ($('#mib-panel')) return;
    const saved = getSaved();
    const box = document.createElement('div');
    box.id = 'mib-panel';
    box.innerHTML = `
      <div id="mib-head">
        <div class="mib-title"><b>MI Bulk <span id="mib-local">${IS_LOCAL_FILE ? 'LOCAL' : ''}</span> <span id="mib-mini-progress"></span></b></div>
        <div class="mib-head-actions">
          <button id="mib-fit" type="button" title="Reset size">↔</button>
          <button id="mib-min" type="button" title="Minimize">−</button>
        </div>
      </div>
      <div id="mib-body">
        <div id="mib-page-error"></div>
        <div class="mib-hint">Scan Source ↵ Dest ↵ FNSKUs</div>

        <label>Source</label>
        <div class="mib-combo">
          <select id="mib-source-preset"></select>
          <input id="mib-source" placeholder="scan / type source" autocomplete="off" value="${escapeHtml(saved.source || '')}" />
        </div>

        <label>Destination</label>
        <div class="mib-combo">
          <select id="mib-dest-preset"></select>
          <input id="mib-dest" placeholder="scan / type dest" autocomplete="off" value="${escapeHtml(saved.dest || '')}" />
        </div>

        <div class="mib-fnsku-top">
          <label>FNSKUs <span>one per line / x2</span></label>
          <button id="mib-fetchfc" type="button" title="Open FCResearch tab and import CUSTOMER_SHIPMENT item barcodes for the source">FC</button>
        </div>
        <textarea id="mib-list" placeholder="Scan, paste, or use FC:
ZZVKJ98QBU
B012345678 x2">${escapeHtml(saved.list || '')}</textarea>

        <div id="mib-progress"><div id="mib-progress-bar"></div></div>
        <div id="mib-progress-line"><span id="mib-progress-text">0/0</span><span id="mib-next">Next: -</span></div>

        <div class="mib-buttons main">
          <button id="mib-start" type="button">Start</button>
          <button id="mib-pause" type="button">Pause</button>
          <button id="mib-resume" type="button">Resume</button>
          <button id="mib-stop" type="button">Stop</button>
        </div>

        <div id="mib-status">Ready.</div>

        <details id="mib-more">
          <summary>More / settings</summary>
          <div class="mib-options">
            <label><input type="checkbox" id="mib-repeatqty" ${saved.repeatQty !== false ? 'checked' : ''}> Repeat qty</label>
            <label><input type="checkbox" id="mib-pauseerrors" ${saved.pauseErrors !== false ? 'checked' : ''}> Pause on error</label>
            <label><input type="checkbox" id="mib-skipsource" ${saved.skipSourceIfPresent !== false ? 'checked' : ''}> Skip source if already selected</label>
            <label><input type="checkbox" id="mib-smartwait" ${saved.smartWait !== false ? 'checked' : ''}> Slow page safe wait</label>
            <label><input type="checkbox" id="mib-autochangec" ${saved.autoChangeContainer !== false ? 'checked' : ''}> Change container when finished</label>
            <label><input type="checkbox" id="mib-autofcfetch" ${saved.fcAutoFetch !== false ? 'checked' : ''}> Auto fetch from FCResearch tab when source entered</label>
          </div>
          <div class="mib-delay-row">
            <label>Delay</label>
            <input id="mib-delay" type="number" min="700" step="100" value="${escapeHtml(saved.delay || '1500')}" /> ms
          </div>
          <label>Source presets <span>one per line</span></label>
          <textarea id="mib-source-presets" class="mib-preset-list" placeholder="tspsP2R2_01\ntspsP2R2_02">${escapeHtml(saved.sourcePresets || '')}</textarea>
          <label>Destination presets <span>one per line</span></label>
          <textarea id="mib-dest-presets" class="mib-preset-list" placeholder="DEST_CONTAINER_1\nDEST_CONTAINER_2">${escapeHtml(saved.destPresets || '')}</textarea>
          <div class="mib-buttons more">
            <button id="mib-step" type="button">Step</button>
            <button id="mib-demo" type="button">Example</button>
            <button id="mib-copylog" type="button">Copy log</button>
          </div>
          <div class="mib-note">Auto-resume: ON · FC tab bridge · CUSTOMER_SHIPMENT only</div>
          <div id="mib-log"></div>
        </details>
      </div>
      <div id="mib-resize-grip" title="Drag to resize"></div>
    `;
    document.body.appendChild(box);
    applySavedPanelGeometry(box, saved);

    const css = document.createElement('style');
    css.textContent = `
      #mib-panel{position:fixed;right:8px;top:54px;z-index:2147483647;width:270px;height:auto;min-width:240px;min-height:190px;max-width:calc(100vw - 10px);max-height:calc(100vh - 10px);background:#05070b;color:#e5e7eb;border:1px solid #1f2937;border-radius:9px;box-shadow:0 8px 24px #000a;font-family:Arial,Helvetica,sans-serif;font-size:11px;overflow:hidden;display:flex;flex-direction:column;box-sizing:border-box}
      #mib-panel *{box-sizing:border-box} #mib-panel.mib-resizing,#mib-panel.mib-dragging{user-select:none}
      #mib-head{cursor:move;background:#070b12;padding:5px 7px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #1f2937;gap:6px;flex:0 0 auto;min-height:28px}
      .mib-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mib-title b{font-size:12px;display:block;line-height:1}.mib-title #mib-mini-progress{color:#9ca3af;font-weight:700;margin-left:4px}#mib-local{font-size:9px;color:#fbbf24;margin-left:3px}
      .mib-head-actions{display:flex;align-items:center;gap:4px;flex:0 0 auto}#mib-min,#mib-fit{background:#111827;color:#d1d5db;border:1px solid #263244;border-radius:5px;width:22px;height:18px;cursor:pointer;font-size:10px;padding:0;line-height:1}
      #mib-body{padding:6px 7px;overflow:auto;flex:1 1 auto;min-height:0;scrollbar-width:thin}#mib-panel.mib-collapsed{width:168px!important;height:30px!important;min-width:168px!important;min-height:30px!important;max-height:30px!important;border-radius:999px}#mib-panel.mib-collapsed #mib-body,#mib-panel.mib-collapsed #mib-resize-grip,#mib-panel.mib-collapsed #mib-fit{display:none}#mib-panel.mib-collapsed #mib-head{border-bottom:0;min-height:28px;padding:5px 8px;cursor:move}#mib-panel.mib-collapsed .mib-title b{font-size:11px}
      .mib-hint{font-size:10px;color:#9ca3af;margin-bottom:4px;line-height:1.1}
      #mib-page-error{display:none;background:#260b0b;color:#fecaca;border:1px solid #7f1d1d;border-radius:6px;padding:4px 5px;margin-bottom:5px;line-height:1.2;font-size:10px}
      #mib-panel label{display:block;color:#aab4c5;font-weight:700;margin-top:4px;margin-bottom:2px;font-size:10px;line-height:1} #mib-panel label span{font-weight:400;color:#6b7280}
      .mib-fnsku-top{display:flex;align-items:center;justify-content:space-between;gap:5px}.mib-fnsku-top label{margin:4px 0 2px!important}.mib-fnsku-top button{cursor:pointer;background:#111827;color:#bfdbfe;border:1px solid #1e3a8a;border-radius:5px;font-size:10px;font-weight:700;height:18px;min-width:30px;padding:0 5px}.mib-fnsku-top button:disabled{opacity:.45;cursor:not-allowed}
      #mib-source,#mib-dest,#mib-delay,#mib-list,#mib-source-preset,#mib-dest-preset,.mib-preset-list{box-sizing:border-box;width:100%;background:#fff;color:#111827;border:1px solid #9ca3af;border-radius:6px;padding:5px 6px;font-size:11px;font-family:Arial,Helvetica,sans-serif;outline:none}
      #mib-source::placeholder,#mib-dest::placeholder,#mib-list::placeholder,.mib-preset-list::placeholder{color:#6b7280}
      #mib-source-preset,#mib-dest-preset{color:#111827;background:#fff}
      #mib-source:focus,#mib-dest:focus,#mib-delay:focus,#mib-list:focus,#mib-source-preset:focus,#mib-dest-preset:focus,.mib-preset-list:focus{border-color:#2563eb;box-shadow:0 0 0 1px #2563eb;background:#fff;color:#111827}
      .mib-combo{display:grid;grid-template-columns:minmax(72px,32%) 1fr;gap:4px}.mib-combo select{padding:5px 4px;color:#9ca3af}#mib-list{height:clamp(68px,22vh,160px);resize:vertical;font-family:Consolas,monospace;font-size:10.5px;line-height:1.2}.mib-preset-list{height:42px;resize:vertical;font-family:Consolas,monospace;font-size:10px;line-height:1.15;margin-bottom:3px}
      #mib-progress{height:6px;background:#1f2937;border-radius:999px;overflow:hidden;margin:6px 0 2px}#mib-progress-bar{width:0%;height:100%;background:#16a34a;transition:.25s width}
      #mib-progress-line{display:flex;justify-content:space-between;gap:5px;color:#9ca3af;font-size:10px;margin-bottom:5px;line-height:1.1}#mib-next{max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
      .mib-buttons{display:grid;gap:4px}.mib-buttons.main{grid-template-columns:repeat(4,minmax(0,1fr))}.mib-buttons.more{grid-template-columns:repeat(3,minmax(0,1fr));margin-top:5px}
      .mib-buttons button,#mib-copylog{cursor:pointer;color:#e5e7eb;border:1px solid #243042;border-radius:6px;padding:5px 3px;font-weight:700;font-size:10px;background:#111827;line-height:1;min-width:0}.mib-buttons button:hover,#mib-copylog:hover{background:#1f2937}
      #mib-start{color:#bbf7d0;border-color:#14532d}.mib-buttons #mib-resume{color:#bfdbfe;border-color:#1e3a8a}.mib-buttons #mib-pause{color:#fed7aa;border-color:#7c2d12}.mib-buttons #mib-stop{color:#fecaca;border-color:#7f1d1d}.mib-buttons #mib-step{color:#ddd6fe;border-color:#4c1d95}
      .mib-buttons button:disabled{opacity:.35;cursor:not-allowed;background:#0b1018}#mib-status{font-size:10px;color:#a7f3d0;min-height:12px;margin:5px 0 3px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #mib-more{border-top:1px solid #111827;margin-top:4px;padding-top:3px}#mib-more summary{cursor:pointer;color:#6b7280;font-size:10px;line-height:1.2;user-select:none}
      .mib-options{display:grid;grid-template-columns:1fr;gap:1px;margin:5px 0}.mib-options label{margin:0;font-weight:400;color:#9ca3af;font-size:10px;line-height:1.2}.mib-options input{width:auto;margin-right:4px}
      .mib-delay-row{display:flex;align-items:center;gap:4px;color:#9ca3af;font-size:10px}.mib-delay-row label{margin:0;flex:1;font-size:10px}.mib-delay-row input{width:58px;padding:4px 5px;font-size:10px}
      .mib-note{color:#6b7280;font-size:9px;margin-top:5px;line-height:1.15}
      #mib-log{max-height:62px;overflow:auto;background:#05070b;border:1px solid #111827;border-radius:6px;margin-top:5px;padding:3px}.mib-log-row{font-family:Consolas,monospace;font-size:9px;color:#9ca3af;border-bottom:1px dotted #111827;padding:1px 0;line-height:1.15}.mib-log-row.bad{color:#fecaca}
      #mib-resize-grip{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 0 45%,#374151 46% 55%,transparent 56% 68%,#374151 69% 78%,transparent 79%)}
      @media (max-width:640px){#mib-panel{right:4px;top:44px;width:min(270px,calc(100vw - 8px));max-width:calc(100vw - 8px)}.mib-combo{grid-template-columns:1fr}.mib-buttons.main{grid-template-columns:repeat(2,minmax(0,1fr))}#mib-list{height:72px}}
    `;
    document.head.appendChild(css);

    $('#mib-min').addEventListener('click', () => toggleCollapsed(box));
    $('#mib-fit').addEventListener('click', () => resetPanelSize(box));
    $('#mib-start').addEventListener('click', startRun);
    $('#mib-pause').addEventListener('click', pauseRun);
    $('#mib-resume').addEventListener('click', resumeRun);
    $('#mib-stop').addEventListener('click', stopRun);
    $('#mib-step').addEventListener('click', stepOnce);
    $('#mib-demo').addEventListener('click', fillDemo);
    $('#mib-copylog').addEventListener('click', copyLog);
    $('#mib-fetchfc')?.addEventListener('click', () => fetchCustomerShipmentFromFcResearch('button'));

    $('#mib-source-preset')?.addEventListener('change', () => applyPreset('source'));
    $('#mib-dest-preset')?.addEventListener('change', () => applyPreset('dest'));

    ['#mib-source','#mib-dest','#mib-list','#mib-delay','#mib-repeatqty','#mib-pauseerrors','#mib-skipsource','#mib-smartwait','#mib-autochangec','#mib-autofcfetch','#mib-source-presets','#mib-dest-presets'].forEach(sel => {
      const el = $(sel);
      if (el) el.addEventListener('input', () => { saveUi(); refreshPresetSelects(); refreshSummary(); });
      if (el) el.addEventListener('change', () => { saveUi(); refreshPresetSelects(); refreshSummary(); });
    });
    refreshPresetSelects();
    setupScanEntryKeys();
    setupSettingsAutoFit(box);

    drag(box, $('#mib-head'));
    setupCustomResize(box);
    setupResizePersistence(box);
    window.addEventListener('resize', () => clampPanelToViewport(box, true));
    setButtons();
    refreshSummary();
    setInterval(refreshSummary, 1500);

    if (IS_LOCAL_FILE) {
      setStatus('Local test mode: it will not move anything; open live MoveItems for real run.');
      addLog('Local test mode active.');
    } else {
      setTimeout(() => {
        restoreSavedRunAfterRefresh();
        maybeFocusSourceAfterAutoChange();
      }, 700);
    }
  }


  function clampNumber(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function panelLimits() {
    return {
      minW: 240,
      minH: 190,
      maxW: Math.max(168, window.innerWidth - 10),
      maxH: Math.max(30, window.innerHeight - 10)
    };
  }

  function applySavedPanelGeometry(box, saved) {
    const lim = panelLimits();
    const w = clampNumber(Number(saved.panelW) || 270, lim.minW, lim.maxW);
    const h = Number(saved.panelH) ? clampNumber(Number(saved.panelH), lim.minH, lim.maxH) : 0;
    box.style.width = `${w}px`;
    if (h) box.style.height = `${h}px`;

    const left = Number(saved.panelLeft);
    const top = Number(saved.panelTop);
    if (Number.isFinite(left) && left > 0) {
      box.style.left = `${clampNumber(left, 0, window.innerWidth - w)}px`;
      box.style.right = 'auto';
    }
    if (Number.isFinite(top) && top > 0) {
      box.style.top = `${clampNumber(top, 0, window.innerHeight - (h || 30))}px`;
    }

    if (saved.panelCollapsed) {
      box.classList.add('mib-collapsed');
      setMinButtonState(box);
    }
    setTimeout(() => clampPanelToViewport(box, true), 80);
  }

  function clampPanelToViewport(box, save = false) {
    if (!box) return;
    const lim = panelLimits();
    if (!box.classList.contains('mib-collapsed')) {
      const r0 = box.getBoundingClientRect();
      const w = clampNumber(r0.width || 270, lim.minW, lim.maxW);
      const h = clampNumber(r0.height || 220, lim.minH, lim.maxH);
      box.style.width = `${w}px`;
      box.style.height = `${h}px`;
    }
    const r = box.getBoundingClientRect();
    const left = clampNumber(r.left, 0, Math.max(0, window.innerWidth - r.width));
    const top = clampNumber(r.top, 0, Math.max(0, window.innerHeight - r.height));
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.right = 'auto';
    if (save) saveUi();
  }

  function setMinButtonState(box) {
    const btn = $('#mib-min');
    if (!btn) return;
    const collapsed = box?.classList.contains('mib-collapsed');
    btn.textContent = collapsed ? '+' : '−';
    btn.title = collapsed ? 'Expand' : 'Minimize';
  }

  function toggleCollapsed(box) {
    if (!box) return;
    box.classList.toggle('mib-collapsed');
    setMinButtonState(box);
    clampPanelToViewport(box, true);
    saveUi();
  }

  function resetPanelSize(box) {
    if (!box) return;
    box.classList.remove('mib-collapsed');
    setMinButtonState(box);
    const w = Math.min(280, window.innerWidth - 10);
    const h = Math.min(360, window.innerHeight - 10);
    box.style.width = `${Math.max(240, w)}px`;
    box.style.height = `${Math.max(220, h)}px`;
    clampPanelToViewport(box, true);
    setStatus('Window size reset.');
  }

  function autoFitPanelToContent(box) {
    if (!box || box.classList.contains('mib-collapsed')) return;
    const lim = panelLimits();
    const r = box.getBoundingClientRect();
    const oldH = box.style.height;

    box.style.height = 'auto';
    const naturalH = Math.ceil(box.getBoundingClientRect().height + 2);
    const targetH = clampNumber(naturalH, lim.minH, lim.maxH);
    box.style.width = `${clampNumber(r.width || 270, lim.minW, lim.maxW)}px`;
    box.style.height = `${targetH}px`;

    clampPanelToViewport(box, true);
    saveUi();
  }

  function setupSettingsAutoFit(box) {
    const more = $('#mib-more');
    if (!more || !box) return;
    more.addEventListener('toggle', () => {
      // Wait for <details> content to finish opening/closing before measuring.
      setTimeout(() => autoFitPanelToContent(box), 80);
      setTimeout(() => autoFitPanelToContent(box), 220);
    });
  }

  function setupCustomResize(box) {
    const grip = $('#mib-resize-grip');
    if (!box || !grip) return;
    let sx = 0, sy = 0, sw = 0, sh = 0, active = false;
    const start = e => {
      if (box.classList.contains('mib-collapsed')) return;
      active = true;
      const p = e.touches ? e.touches[0] : e;
      sx = p.clientX; sy = p.clientY;
      const r = box.getBoundingClientRect();
      sw = r.width; sh = r.height;
      box.classList.add('mib-resizing');
      document.body.style.userSelect = 'none';
      e.preventDefault();
    };
    const move = e => {
      if (!active) return;
      const p = e.touches ? e.touches[0] : e;
      const lim = panelLimits();
      box.style.width = `${clampNumber(sw + p.clientX - sx, lim.minW, lim.maxW)}px`;
      box.style.height = `${clampNumber(sh + p.clientY - sy, lim.minH, lim.maxH)}px`;
      clampPanelToViewport(box, false);
      e.preventDefault();
    };
    const end = () => {
      if (!active) return;
      active = false;
      box.classList.remove('mib-resizing');
      document.body.style.userSelect = '';
      clampPanelToViewport(box, true);
    };
    grip.addEventListener('mousedown', start);
    grip.addEventListener('touchstart', start, { passive: false });
    document.addEventListener('mousemove', move);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('mouseup', end);
    document.addEventListener('touchend', end);
  }

  function setupResizePersistence(box) {
    if (!box || typeof ResizeObserver === 'undefined') return;
    let ready = false;
    let timer = null;
    setTimeout(() => { ready = true; }, 1000);
    const ro = new ResizeObserver(() => {
      if (!ready) return;
      clearTimeout(timer);
      timer = setTimeout(() => saveUi(), 300);
    });
    ro.observe(box);
  }

  function drag(box, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, moving = false;
    handle.addEventListener('mousedown', e => {
      if (e.target.closest('button')) return;
      moving = true;
      sx = e.clientX; sy = e.clientY;
      const r = box.getBoundingClientRect();
      ox = r.left; oy = r.top;
      box.classList.add('mib-dragging');
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', e => {
      if (!moving) return;
      box.style.left = `${Math.max(0, ox + e.clientX - sx)}px`;
      box.style.top = `${Math.max(0, oy + e.clientY - sy)}px`;
      box.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (moving) clampPanelToViewport(box, true);
      moving = false;
      box.classList.remove('mib-dragging');
      document.body.style.userSelect = '';
    });
  }


  // ===== Prince Jacob Custom Update Checker - Every 10 Hours =====
  function princeUpdateChecker() {
    const UPDATE_URL = "https://github.com/prince-jacob/MoveItemsBulkMoveAssistant/raw/refs/heads/main/MoveItemsBulkMoveAssistant.user.js";
    const CHECK_KEY = "prince_last_update_check_" + (GM_info?.script?.name || "MoveItemsBulkMoveAssistant");
    const CHECK_INTERVAL = 10 * 60 * 60 * 1000; // 10 hours

    if (typeof GM_xmlhttpRequest !== 'function' || typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function') {
      console.log('[Update Checker] GM_* functions unavailable.');
      return;
    }

    const lastCheck = Number(GM_getValue(CHECK_KEY, 0));
    const now = Date.now();

    // Skip if already checked within the last 10 hours
    if (now - lastCheck < CHECK_INTERVAL) return;

    GM_setValue(CHECK_KEY, now);

    GM_xmlhttpRequest({
      method: 'GET',
      url: UPDATE_URL,
      nocache: true,
      onload: function (res) {
        const remoteScript = res.responseText || '';
        const remoteMatch = remoteScript.match(/\/\/\s*@version\s+([0-9.]+)/i);

        if (!remoteMatch) {
          console.log('[Update Checker] Remote version not found.');
          return;
        }

        const remoteVersion = remoteMatch[1];
        const currentVersion = GM_info?.script?.version || '0.0.0';

        if (isNewerVersion(remoteVersion, currentVersion)) {
          const openUpdate = confirm(
            'New script update available!\n\n' +
            'Script: ' + (GM_info?.script?.name || 'MoveItems Bulk Move Assistant') + '\n' +
            'Current version: ' + currentVersion + '\n' +
            'New version: ' + remoteVersion + '\n\n' +
            'Open update page now?'
          );

          if (openUpdate) window.open(UPDATE_URL, '_blank');
        } else {
          console.log('[Update Checker] Up to date:', currentVersion);
        }
      },
      onerror: function () {
        console.log('[Update Checker] Failed to check update.');
      }
    });

    function isNewerVersion(remote, current) {
      const r = String(remote).split('.').map(Number);
      const c = String(current).split('.').map(Number);
      const len = Math.max(r.length, c.length);

      for (let i = 0; i < len; i++) {
        const rv = r[i] || 0;
        const cv = c[i] || 0;

        if (rv > cv) return true;
        if (rv < cv) return false;
      }

      return false;
    }
  }

  princeUpdateChecker();

  if (IS_FCRESEARCH_PAGE) {
    runFcResearchBridgePage();
    return;
  }

  makePanel();
})();
