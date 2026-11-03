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
// @match        https://football.fantasysports.yahoo.com/college/*/*
// @match        https://football.fantasysports.yahoo.com/pickem/*/*
// @noframes
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// @ts-check

(function () {
  'use strict';

  // ---------- Config ----------
  // Everything tied to Yahoo's page (selectors, labels) lives here: update it first if Yahoo changes its markup.
  const CONFIG = {
    LOG_PREFIX: '[BYP]',
    COLORS: { win: '#2e9e4f', lose: '#d9534f' },
    SELECTORS: {
      // Pick form (absent on past weeks and on weeks whose games are not set yet)
      form: 'form[name="ysf-picks-form"]',
      row: 'tr',
      infoLink: 'td.info a',
      favCell: 'td.favorite',
      undCell: 'td.underdog',
      teamLink: 'a',
      // Pick distribution module (one per game)
      module: '.ysf-matchup-dist',
      modFavLink: 'dl.favorite dd.team a',
      modUndLink: 'dl.underdog dd.team a',
      modFavPct: 'dl.favorite dd.percent',
      modUndPct: 'dl.underdog dd.percent',
      modStatRow: '.ft tbody tr',
      modStatLabel: 'td.label'
    },
    // Labels of the module's stat rows: [favorite value, label, underdog value]
    LABELS: { record: 'Record', spread: 'Favorite' }
  };

  /**
   * @typedef {Object} MatchupInfo
   * @property {string} favKey   favorite team page URL (see teamKey)
   * @property {string} undKey   underdog team page URL
   * @property {number} favPct   favorite pick percentage
   * @property {number} undPct   underdog pick percentage
   * @property {string} favRec   favorite record, e.g. "5-1 (3-0)"
   * @property {string} undRec   underdog record
   * @property {string|null} pts spread in favor of the favorite
   */

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
  /**
   * Team identifier: its team page URL, the same in the form and in the pick distribution page.
   * Unlike the displayed name, it ignores rankings, "@" and similar names (Texas / Texas Tech).
   * @param {Element | null} link
   */
  const teamKey = link => (link?.getAttribute('href') || '').replace(/\/$/, '');

  // ---------- Parsing ----------
  /**
   * Cell texts of the module's stat row with the given label.
   * @param {Element} m
   * @param {string} label
   * @returns {string[] | null}
   */
  function statCells(m, label) {
    const { modStatRow, modStatLabel } = CONFIG.SELECTORS;
    const row = [...m.querySelectorAll(modStatRow)]
      .find(r => r.querySelector(modStatLabel)?.textContent?.trim() === label);
    return row ? [...row.children].map(c => c.textContent?.trim() ?? '') : null;
  }

  /**
   * Extract a matchup's data from its module element.
   * @param {Element} m
   * @returns {MatchupInfo | null} null if the expected elements are missing
   */
  function parseModule(m) {
    const { SELECTORS, LABELS } = CONFIG;
    const favKey = teamKey(m.querySelector(SELECTORS.modFavLink));
    const undKey = teamKey(m.querySelector(SELECTORS.modUndLink));
    const favPct = Number.parseInt(m.querySelector(SELECTORS.modFavPct)?.textContent ?? '', 10);
    const undPct = Number.parseInt(m.querySelector(SELECTORS.modUndPct)?.textContent ?? '', 10);
    const record = statCells(m, LABELS.record);
    const spread = statCells(m, LABELS.spread);
    if (!favKey || !undKey || Number.isNaN(favPct) || Number.isNaN(undPct) || !record) return null;
    return {
      favKey,
      undKey,
      favPct,
      undPct,
      favRec: record[0],
      undRec: record[2],
      pts: /[\d.]+/.exec(spread?.[0] ?? '')?.[0] ?? null
    };
  }

  // ---------- Loading ----------
  /**
   * Fetch the picks page; it holds a module for ALL games. Failures are logged and give no modules.
   * @param {string} url
   * @returns {Promise<MatchupInfo[]>}
   */
  async function loadModules(url) {
    try {
      const r = await fetch(url, { credentials: 'same-origin' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
      const modules = [...doc.querySelectorAll(CONFIG.SELECTORS.module)].map(parseModule).filter(m => m !== null);
      if (!modules.length) console.warn(CONFIG.LOG_PREFIX, 'no usable pick distribution found; Yahoo markup may have changed');
      return modules;
    } catch (err) {
      console.warn(CONFIG.LOG_PREFIX, 'failed to load picks page', err);
      return [];
    }
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
    const f = teamKey(favCell.querySelector(CONFIG.SELECTORS.teamLink));
    const u = teamKey(undCell.querySelector(CONFIG.SELECTORS.teamLink));
    return modules.find(m => m.favKey === f && m.undKey === u) || null;
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
   * Decorate both team cells of a game row.
   * @param {Element} favCell
   * @param {Element} undCell
   * @param {MatchupInfo | null} info
   */
  function render(favCell, undCell, info) {
    if (!info) {
      console.warn(CONFIG.LOG_PREFIX, 'no module found for', favCell.textContent?.trim(), '-', undCell.textContent?.trim());
      return;
    }
    const favWins = info.favPct >= info.undPct;
    addBlock(favCell, { pct: info.favPct, rec: info.favRec, isFav: true,  pts: info.pts, winning: favWins });
    addBlock(undCell, { pct: info.undPct, rec: info.undRec, isFav: false, pts: null,     winning: !favWins });
  }

  // ---------- Orchestration ----------
  /** Decorate every game row of the pick form; do nothing on pages without one. */
  async function init() {
    const { SELECTORS } = CONFIG;
    const form = document.querySelector(SELECTORS.form);
    const firstLink = /** @type {HTMLAnchorElement | null} */ (form?.querySelector(SELECTORS.infoLink));
    if (!form || !firstLink) return;

    injectStyles();
    const modules = await loadModules(firstLink.href);
    for (const row of form.querySelectorAll(SELECTORS.row)) {
      const favCell = row.querySelector(SELECTORS.favCell);
      const undCell = row.querySelector(SELECTORS.undCell);
      if (favCell && undCell) render(favCell, undCell, findInfo(modules, favCell, undCell));
    }
  }

  init().catch(err => console.warn(CONFIG.LOG_PREFIX, 'unexpected error', err));
})();
