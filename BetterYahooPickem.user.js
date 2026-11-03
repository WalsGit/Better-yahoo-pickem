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

(function () {
  'use strict';

  const LOG_PREFIX = '[BYP]';

  let PAGE = null; // promise: list of matchup modules (single request)

  // ---------- Styles ----------
  const css = `
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
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ---------- Name normalization ----------
  const norm = s => (s || '').toLowerCase()
    .replace(/\(\d+\)/g, ' ')          // ranking, e.g. "(25)"
    .replace(/[^a-z0-9]+/g, ' ')       // punctuation, "@", etc.
    .trim();

  // ---------- Parse one matchup module ----------
  function parseModule(m) {
    const txt = (m.textContent || '').replace(/\s+/g, ' ');
    const favName = (/Favorite\s*@?\s*(.+?)\s*Favorite\s*Pick\s*Percentage/.exec(txt) || [])[1];
    const undName = (/Underdog\s*(.+?)\s*Underdog\s*Pick\s*Percentage/.exec(txt) || [])[1];
    const favPct  = /Favorite\s*Pick\s*Percentage\s*(\d+)%/.exec(txt);
    const undPct  = /Underdog\s*Pick\s*Percentage\s*(\d+)%/.exec(txt);
    const recs    = /(\d+-\d+\s*\(\d+-\d+\))\s*Record\s*(\d+-\d+\s*\(\d+-\d+\))/.exec(txt);
    const pts     = /([\d.]+)\s*pts/.exec(txt);
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

  // ---------- Load the picks page once ----------
  // The pick distribution section holds the blocks for ALL games (one per game, in order).
  function loadModules(url) {
    if (!PAGE) {
      PAGE = fetch(url, { credentials: 'same-origin' })
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
        .then(html => {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          return [...doc.querySelectorAll('.ysf-matchup-dist')].map(parseModule).filter(Boolean);
        })
        .catch(err => { console.warn(LOG_PREFIX, 'failed to load picks page', err); return []; });
    }
    return PAGE;
  }

  // ---------- Match a form row to its module ----------
  function findInfo(modules, favCell, undCell) {
    const f = norm(favCell.textContent);
    const u = norm(undCell.textContent);
    return modules.find(m => m.fav === f && m.und === u)
        || modules.find(m => m.raw.includes(f) && m.raw.includes(u))
        || null;
  }

  // ---------- Build the block shown under a team name ----------
  function addBlock(cell, { pct, rec, isFav, pts, winning }) {
    const box = document.createElement('div');
    const color = winning ? '#2e9e4f' : '#d9534f';
    const bar = `<div class="byp-bar"><span style="width:${pct}%;background:${color}"></span></div>`;
    const pctEl = `<span class="byp-pct">${pct}%</span>`;

    box.className = 'byp-box ' + (isFav ? 'byp-fav-box' : 'byp-und-box');
    // Favorite: % on the left, bar on the right (fills from the right)
    // Underdog: bar on the left (fills from the left), % on the right
    box.innerHTML = `
      <div class="byp-line">${isFav ? pctEl + bar : bar + pctEl}</div>
      <div class="byp-rec">${rec}${isFav && pts ? `<span class="byp-fav">${pts}pts FAV</span>` : ''}</div>`;
    cell.appendChild(box);
  }

  function render(row, info) {
    if (row.dataset.byp) return;
    const favCell = row.querySelector('td.favorite');
    const undCell = row.querySelector('td.underdog');
    if (!favCell || !undCell) return;
    row.dataset.byp = '1';

    if (!info) {
      console.warn(LOG_PREFIX, 'no module found for', favCell.textContent.trim(), '-', undCell.textContent.trim());
      return;
    }
    const favWins = info.favPct >= info.undPct;
    addBlock(favCell, { pct: info.favPct, rec: info.favRec, isFav: true,  pts: info.pts, winning: favWins });
    addBlock(undCell, { pct: info.undPct, rec: info.undRec, isFav: false, pts: null,     winning: !favWins });
  }

  // ---------- Picks table ----------
  function processTable() {
    const table = [...document.querySelectorAll('table')]
      .find(t => t.querySelector('th.favorite') && t.querySelector('td.info a'));
    if (!table || table.dataset.byp) return;
    table.dataset.byp = '1';

    const firstLink = table.querySelector('td.info a');
    loadModules(firstLink.href).then(modules => {
      [...table.rows].forEach(row => {
        if (!row.querySelector('td.info a')) return;
        render(row, findInfo(modules, row.querySelector('td.favorite'), row.querySelector('td.underdog')));
      });
    });
  }

  processTable();
  new MutationObserver(processTable).observe(document.body, { childList: true, subtree: true });
})();
