// ==UserScript==
// @name         Better Yahoo Pick'em Form
// @namespace    https://github.com/WalsGit/Better-yahoo-pickem
// @version      1.0.0
// @description  In Yahoo! Pick'em forms (CFB or NFL), shows the pick distribution, team records and spread directly under each team
// @author       Wa!id
// @license      MIT
// @homepageURL  https://github.com/WalsGit/Better-yahoo-pickem
// @supportURL   https://github.com/WalsGit/Better-yahoo-pickem/issues
// @downloadURL  https://raw.githubusercontent.com/WalsGit/Better-yahoo-pickem/main/BetterYahooPickem.user.js
// @updateURL    https://raw.githubusercontent.com/WalsGit/Better-yahoo-pickem/main/BetterYahooPickem.user.js
// @match        https://football.fantasysports.yahoo.com/college/*
// @match        https://football.fantasysports.yahoo.com/pickem/*
// @noframes
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// @ts-check

(function () {
  'use strict';

  // ---------- Config ----------
  // Everything tied to Yahoo's page (selectors, wording) lives here: update it first if Yahoo changes its markup.
  const CONFIG = {
    LOG_PREFIX: '[BYP]',
    COLORS: { win: '#2e9e4f', lose: '#d9534f' },
    SELECTORS: {
      favHeader: 'th.favorite',
      infoLink: 'td.info a',
      favCell: 'td.favorite',
      undCell: 'td.underdog',
      module: '.ysf-matchup-dist'
    },
    // Applied to a module's flattened text
    REGEX: {
      favName: /Favorite\s*@?\s*(.+?)\s*Favorite\s*Pick\s*Percentage/,
      undName: /Underdog\s*(.+?)\s*Underdog\s*Pick\s*Percentage/,
      favPct: /Favorite\s*Pick\s*Percentage\s*(\d+)%/,
      undPct: /Underdog\s*Pick\s*Percentage\s*(\d+)%/,
      records: /(\d+-\d+\s*\(\d+-\d+\))\s*Record\s*(\d+-\d+\s*\(\d+-\d+\))/,
      pts: /([\d.]+)\s*pts/
    }
  };

  /**
   * @typedef {Object} MatchupInfo
   * @property {string} fav      normalized favorite name
   * @property {string} und      normalized underdog name
   * @property {string} raw      normalized full module text
   * @property {number} favPct   favorite pick percentage
   * @property {number} undPct   underdog pick percentage
   * @property {string} favRec   favorite record, e.g. "5-1 (3-0)"
   * @property {string} undRec   underdog record
   * @property {string|null} pts spread in favor of the favorite
   */

  /** @type {Promise<MatchupInfo[]> | null} picks page, fetched once */
  let picksPromise = null;

  // ---------- Styles ----------
  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .byp-box { clear: both; margin-top: 4px; font-size: 11px; line-height: 1.3; font-weight: normal; white-space: nowrap; }
      .byp-fav-box { text-align: right; }
      .byp-und-box { text-align: left; }
      .byp-line { display: flex; align-items: center; gap: 3px; }
      .byp-fav-box .byp-line { justify-content: flex-end; }   /* % on the left, bar on the right */
      .byp-und-box .byp-line { justify-content: flex-start; } /* bar on the left, % on the right */
      .byp-pct { font-weight: 700; }
      .byp-fav-box .byp-pct { text-align: left; }
      .byp-und-box .byp-pct { text-align: right; }
      .byp-bar { position: relative; flex: 0 0 110px; height: 8px; background: #e3e3e3; border-radius: 4px; overflow: hidden; }
      .byp-bar > span { position: absolute; top: 0; bottom: 0; border-radius: 4px; }
      .byp-fav-box .byp-bar > span { right: 0; } /* fills from the right */
      .byp-und-box .byp-bar > span { left: 0; }  /* fills from the left */
      .byp-rec { color: #555; margin-top: 2px; }
      .byp-fav { color: #1a7f37; font-weight: 700; margin-left: 4px; }
    `;
    document.head.appendChild(style);
  }

  // ---------- Utils ----------
  /** Lowercase and strip rankings, punctuation and "@" so names compare reliably. */
  const norm = (/** @type {string | null | undefined} */ s) => (s || '').toLowerCase()
    .replace(/\(\d+\)/g, ' ')          // ranking, e.g. "(25)"
    .replace(/[^a-z0-9]+/g, ' ')       // punctuation, "@", etc.
    .trim();

  // ---------- Parsing ----------
  /**
   * Extract a matchup's data from its module element.
   * @param {Element} m
   * @returns {MatchupInfo | null} null if the expected text is missing
   */
  function parseModule(m) {
    const { REGEX } = CONFIG;
    const txt = (m.textContent || '').replace(/\s+/g, ' ');
    const favName = (REGEX.favName.exec(txt) || [])[1];
    const undName = (REGEX.undName.exec(txt) || [])[1];
    const favPct = REGEX.favPct.exec(txt);
    const undPct = REGEX.undPct.exec(txt);
    const recs = REGEX.records.exec(txt);
    const pts = REGEX.pts.exec(txt);
    if (!favPct || !undPct || !recs) return null;
    return {
      fav: norm(favName),
      und: norm(undName),
      raw: norm(txt),
      favPct: +favPct[1],
      undPct: +undPct[1],
      favRec: recs[1].replace(/\s+/g, ' '),
      undRec: recs[2].replace(/\s+/g, ' '),
      pts: pts ? pts[1] : null
    };
  }

  // ---------- Loading ----------
  /**
   * Fetch the picks page once; it holds a module for ALL games (one per game, in order).
   * @param {string} url
   * @returns {Promise<MatchupInfo[]>}
   */
  function loadModules(url) {
    if (!picksPromise) {
      picksPromise = fetch(url, { credentials: 'same-origin' })
        .then(r => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.text();
        })
        .then(html => {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          return [...doc.querySelectorAll(CONFIG.SELECTORS.module)].map(parseModule).filter(m => m !== null);
        })
        .catch(err => { console.warn(CONFIG.LOG_PREFIX, 'failed to load picks page', err); return []; });
    }
    return picksPromise;
  }

  // ---------- Matching ----------
  /**
   * Find the module of a form row from its two team cells.
   * @param {MatchupInfo[]} modules
   * @param {Element} favCell
   * @param {Element} undCell
   * @returns {MatchupInfo | null}
   */
  function findInfo(modules, favCell, undCell) {
    const f = norm(favCell.textContent);
    const u = norm(undCell.textContent);
    return modules.find(m => m.fav === f && m.und === u)
        || modules.find(m => m.raw.includes(f) && m.raw.includes(u))
        || null;
  }

  // ---------- Rendering ----------
  /**
   * Create an element with an optional class and text content.
   * @param {string} tag
   * @param {string} [className]
   * @param {string} [text]
   */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * Append the distribution bar, record and spread under a team name.
   * @param {Element} cell
   * @param {{pct: number, rec: string, isFav: boolean, pts: string | null, winning: boolean}} data
   */
  function addBlock(cell, { pct, rec, isFav, pts, winning }) {
    const fill = el('span');
    fill.style.width = pct + '%';
    fill.style.background = winning ? CONFIG.COLORS.win : CONFIG.COLORS.lose;
    const bar = el('div', 'byp-bar');
    bar.append(fill);
    const pctEl = el('span', 'byp-pct', pct + '%');

    // Favorite: % on the left, bar on the right (fills from the right)
    // Underdog: bar on the left (fills from the left), % on the right
    const line = el('div', 'byp-line');
    line.append(...(isFav ? [pctEl, bar] : [bar, pctEl]));

    const recEl = el('div', 'byp-rec', rec);
    if (isFav && pts) recEl.append(el('span', 'byp-fav', pts + 'pts FAV'));

    const box = el('div', 'byp-box ' + (isFav ? 'byp-fav-box' : 'byp-und-box'));
    box.append(line, recEl);
    cell.appendChild(box);
  }

  /**
   * @param {HTMLTableRowElement} row
   * @param {MatchupInfo | null} info
   */
  function render(row, info) {
    if (row.dataset.byp) return;
    const favCell = row.querySelector(CONFIG.SELECTORS.favCell);
    const undCell = row.querySelector(CONFIG.SELECTORS.undCell);
    if (!favCell || !undCell) return;
    row.dataset.byp = '1';

    if (!info) {
      console.warn(CONFIG.LOG_PREFIX, 'no module found for', favCell.textContent?.trim(), '-', undCell.textContent?.trim());
      return;
    }
    const favWins = info.favPct >= info.undPct;
    addBlock(favCell, { pct: info.favPct, rec: info.favRec, isFav: true,  pts: info.pts, winning: favWins });
    addBlock(undCell, { pct: info.undPct, rec: info.undRec, isFav: false, pts: null,     winning: !favWins });
  }

  // ---------- Orchestration ----------
  /** Find the picks table (once) and decorate each of its game rows. */
  function enhancePickTable() {
    const { SELECTORS } = CONFIG;
    const table = [...document.querySelectorAll('table')]
      .find(t => t.querySelector(SELECTORS.favHeader) && t.querySelector(SELECTORS.infoLink));
    if (!table || table.dataset.byp) return;
    table.dataset.byp = '1';

    const firstLink = /** @type {HTMLAnchorElement} */ (table.querySelector(SELECTORS.infoLink));
    void loadModules(firstLink.href).then(modules => {
      [...table.rows].forEach(row => {
        const favCell = row.querySelector(SELECTORS.favCell);
        const undCell = row.querySelector(SELECTORS.undCell);
        if (!row.querySelector(SELECTORS.infoLink) || !favCell || !undCell) return;
        render(row, findInfo(modules, favCell, undCell));
      });
    }).catch(err => console.warn(CONFIG.LOG_PREFIX, 'failed to render picks', err));
  }

  function init() {
    injectStyles();
    enhancePickTable();
    new MutationObserver(enhancePickTable).observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
