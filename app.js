import {
  DEFAULT_PASSWORD,
  DEFAULT_PROMPT,
  SCOPES,
  PROVIDER_MODELS,
  SCHEMA,
  escapeHTML as e,
  isTrue,
  bool,
  resourceId,
  starsNumber,
  activeBusiness,
  summarize,
  makeLog,
  reviewKey,
  reviewFromGoogle,
  validSession,
} from './lib/core.js';
import { SheetsClient, GoogleBusinessClient, requestJSON, sleep } from './lib/api.js';
import { AIKeyRotator } from './lib/ai.js';
import { syncBusiness, persistReply, recountBusiness } from './lib/operations.js';
import { DemoStore, demoGoogle } from './data/demo.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const i = (name, classes = '') => `<i data-lucide="${name}" class="icon ${classes}" aria-hidden="true"></i>`;
const logo = `<a class="logo" href="dashboard.html" aria-label="ReplyRaven overview"><img src="assets/raven.svg" width="40" height="40" alt=""><span>Reply<span>Raven</span></span></a>`;
const page = document.body.dataset.page;
const configKeys = [
  'client_id',
  'client_secret',
  'api_key',
  'sheet_id',
  'access_token',
  'refresh_token',
  'apps_script_url',
];
function loadConfig() {
  let result = {};
  try {
    result = JSON.parse(localStorage.getItem('rr_config') || '{}');
  } catch {
    /* Recover from an edited local preference. */
  }
  for (const key of configKeys)
    if (localStorage.getItem(key) !== null) result[key] = localStorage.getItem(key);
  return result;
}
let config = loadConfig();
const state = {
  demo: localStorage.getItem('rr_demo') === 'true',
  businesses: [],
  reviews: [],
  keys: [],
  logs: [],
  settings: {},
  connected: false,
  filter: 'all',
  query: new URLSearchParams(location.search).get('q') || '',
  sort: 'sync',
  chartDays: 7,
  reviewFilter: new URLSearchParams(location.search).get('filter') || 'all',
  reviewQuery: '',
  reviewPage: 1,
  selectedBusiness: null,
  allReviews: false,
  settingsTab: location.hash.slice(1) || 'google',
};
let store,
  google,
  modalCleanup = null,
  modalReturnFocus = null,
  modalDismissible = true;
function token() {
  const expiry = Number(localStorage.getItem('access_token_expiry'));
  if (expiry && expiry <= Date.now()) return '';
  return localStorage.getItem('access_token') || config.access_token || '';
}
function configureClients() {
  store = state.demo
    ? new DemoStore()
    : new SheetsClient({ sheetId: config.sheet_id, apiKey: config.api_key, getToken: token });
  google = state.demo ? demoGoogle(store) : new GoogleBusinessClient({ getToken: token });
}
configureClients();
function saveLocal(values) {
  config = { ...config, ...values };
  for (const [key, value] of Object.entries(values)) localStorage.setItem(key, String(value));
  localStorage.setItem('rr_config', JSON.stringify(config));
}
function setting(key, fallback = '') {
  return state.settings[key] ?? localStorage.getItem(key) ?? fallback;
}
function configured() {
  return state.demo || Boolean(config.sheet_id && (token() || config.api_key));
}
function icons(root = document) {
  window.lucide?.createIcons({ root, attrs: { 'stroke-width': 1.8 } });
}
window.addEventListener('load', () => icons());
let motion = null;
// Framer Motion's DOM animate API; CSS remains a graceful, reduced-motion-aware fallback.
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
  import('https://cdn.jsdelivr.net/npm/framer-motion@11.18.2/+esm')
    .then((module) => {
      motion = module;
      enhance();
    })
    .catch(() => {});
}
function enhance(root = document) {
  icons(root);
  if (motion?.animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    $$('.motion-enter', root).forEach((element, index) =>
      motion.animate(
        element,
        { opacity: [0, 1], y: [8, 0] },
        { duration: 0.35, delay: Math.min(index * 0.03, 0.2) },
      ),
    );
  }
}
function redact(value) {
  let text = String(value || 'Something went wrong. Please try again.');
  for (const secret of [
    config.client_secret,
    config.access_token,
    config.refresh_token,
    ...state.keys.map((key) => key.api_key),
  ].filter((value) => value && value.length > 5))
    text = text.split(secret).join('[redacted]');
  return text;
}
function toast(message, type = 'success') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.setAttribute('role', type === 'error' ? 'alert' : 'status');
  node.innerHTML = `${i(type === 'error' ? 'circle-alert' : type === 'info' ? 'info' : 'circle-check')}<p>${e(redact(message))}</p><button aria-label="Dismiss notification">${i('x')}</button>`;
  $('#toast-stack').append(node);
  icons(node);
  const timer = setTimeout(() => node.remove(), type === 'error' ? 10000 : 5500);
  $('button', node).onclick = () => {
    clearTimeout(timer);
    node.remove();
  };
}
function handleError(error) {
  if (error.status === 401) {
    localStorage.setItem('access_token_expiry', '1');
    toast('Your Google session expired. Reconnect in Settings → Google.', 'error');
    renderBanner();
  } else toast(error.message, 'error');
  console.warn('[ReplyRaven]', redact(error.message));
}
async function busy(button, action) {
  if (button?.disabled) return;
  const old = button?.innerHTML;
  if (button) {
    button.disabled = true;
    button.innerHTML = `${i('loader-circle', 'spin')}${button.classList.contains('icon-btn') ? '' : `<span>${e(button.dataset.busyText || 'Working…')}</span>`}`;
    icons(button);
  }
  try {
    return await action();
  } catch (error) {
    handleError(error);
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.innerHTML = old;
      icons(button);
    }
  }
}
function relativeDate(value) {
  if (!value) return 'Not synced yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function formatDate(value) {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime())
    ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';
}
function initials(name) {
  return String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}
function starHTML(value = 5) {
  return `<span class="stars" aria-label="${starsNumber(value)} out of 5 stars">${[1, 2, 3, 4, 5].map((n) => i('star', n > Math.round(starsNumber(value)) ? 'empty-star' : '')).join('')}</span>`;
}
function businessHref(business) {
  return `business.html?${new URLSearchParams({ locationId: resourceId(business.google_location_id), accountId: resourceId(business.google_account_id) })}`;
}
function businessById(id) {
  return state.businesses.find((b) => resourceId(b.google_location_id) === resourceId(id));
}
function tile(business) {
  const name = business.business_name.toLowerCase();
  let type = ['building-2', '#ede7f6', '#9a86bd'];
  if (/café|coffee|cafe/.test(name)) type = ['coffee', '#e7efe7', '#7b9d84'];
  else if (/dental|bloom/.test(name)) type = ['flower-2', '#f3e6ed', '#bd8ca5'];
  else if (/table|restaurant|kitchen/.test(name)) type = ['utensils', '#f4ecde', '#c6a273'];
  else if (/fitness|gym/.test(name)) type = ['dumbbell', '#e7eaf3', '#8293b8'];
  else if (/beauty|salon|haven/.test(name)) type = ['sparkles', '#ede6f4', '#ad8ec2'];
  else if (/home|atlas/.test(name)) type = ['house', '#e4eeee', '#82a4a1'];
  return `<span class="business-symbol" style="--tile:${type[1]};--tile-text:${type[2]}">${i(type[0])}</span>`;
}
function empty(title, description, action = '', image = true) {
  return `<div class="panel empty-state">${image ? '<img src="assets/empty.svg" width="200" height="150" alt="">' : i('message-square')}<h3>${e(title)}</h3><p>${e(description)}</p>${action}</div>`;
}
function switchHTML(on, action, id, label, large = false) {
  return `<button type="button" role="switch" aria-checked="${on}" aria-label="${e(label)}" class="switch ${large ? 'switch-lg' : ''}" data-action="${action}" data-id="${e(id)}"></button>`;
}
function openModal({
  title,
  subtitle = '',
  body,
  footer = '',
  wide = false,
  onReady = null,
  dismissible = true,
}) {
  closeModal(true);
  modalReturnFocus = document.activeElement;
  modalDismissible = dismissible;
  $('#modal-root').innerHTML =
    `<div class="modal-overlay"><section class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1"><header class="modal-header"><div><h2 id="modal-title">${e(title)}</h2>${subtitle ? `<p>${e(subtitle)}</p>` : ''}</div>${dismissible ? `<button class="icon-btn modal-close" data-action="close-modal" aria-label="Close dialog">${i('x')}</button>` : ''}</header><div class="modal-body">${body}</div>${footer ? `<footer class="modal-footer">${footer}</footer>` : ''}</section></div>`;
  document.body.style.overflow = 'hidden';
  enhance($('#modal-root'));
  $('.modal').focus();
  const keyListener = (event) => {
    if (event.key === 'Escape' && modalDismissible) closeModal();
    if (event.key === 'Tab') {
      const focusable = $$(
        'a[href],button:not([disabled]),input:not([disabled]),textarea,select,[tabindex="0"]',
        $('.modal'),
      ).filter((el) => !el.hidden && el.offsetParent !== null);
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0],
        last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === $('.modal'))) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || document.activeElement === $('.modal'))
      ) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  document.addEventListener('keydown', keyListener);
  modalCleanup = () => document.removeEventListener('keydown', keyListener);
  $('.modal-overlay').onclick = (event) => {
    if (event.target === event.currentTarget && modalDismissible) closeModal();
  };
  onReady?.($('.modal'));
}
function closeModal(replacing = false) {
  if (!replacing && !modalDismissible) return;
  modalCleanup?.();
  modalCleanup = null;
  $('#modal-root').innerHTML = '';
  document.body.style.overflow = '';
  modalDismissible = true;
  if (!replacing) modalReturnFocus?.focus();
}
function confirmModal(title, copy, action, label = 'Confirm', dangerous = false) {
  openModal({
    title,
    body: `${dangerous ? `<div class="confirm-icon">${i('triangle-alert')}</div>` : ''}<p class="confirm-copy">${e(copy)}</p>`,
    footer: `<button class="btn" data-action="close-modal">Cancel</button><button id="confirm-action" class="btn ${dangerous ? 'btn-danger' : 'btn-primary'}">${e(label)}</button>`,
    onReady: (modal) => {
      $('#confirm-action').onclick = () =>
        busy($('#confirm-action'), async () => {
          modalDismissible = false;
          try {
            await action();
            if ($('.modal') === modal) closeModal(true);
          } finally {
            modalDismissible = true;
          }
        });
    },
  });
}
async function copyText(text, button = null) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard.');
  } catch {
    const input = document.createElement('textarea');
    input.value = text;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    const ok = document.execCommand('copy');
    input.remove();
    if (ok) toast('Copied to clipboard.');
    else toast('Select the text and copy it manually.', 'info');
  }
  if (button) {
    const old = button.innerHTML;
    button.innerHTML = i('check');
    icons(button);
    setTimeout(() => {
      if (button.isConnected) {
        button.innerHTML = old;
        icons(button);
      }
    }, 1300);
  }
}
function setTheme(theme = document.documentElement.classList.contains('dark') ? 'light' : 'dark') {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('rr_theme', theme);
  const preview = $('#dashboard-preview');
  if (preview) preview.src = `assets/dashboard-preview${theme === 'dark' ? '-dark' : ''}.png`;
  $$('[data-action="theme"]').forEach((button) => {
    button.innerHTML = i(theme === 'dark' ? 'sun' : 'moon');
    button.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`);
  });
  $$('[data-theme-choice]').forEach((button) =>
    button.classList.toggle('active', button.dataset.themeChoice === theme),
  );
  icons();
}
function login(demo = false) {
  localStorage.setItem('auth', 'true');
  localStorage.setItem('auth_expiry', String(Date.now() + 7 * 86400000));
  localStorage.setItem('rr_demo', String(demo));
  location.replace('dashboard.html');
}
function logout() {
  localStorage.removeItem('auth');
  localStorage.removeItem('auth_expiry');
  localStorage.removeItem('rr_demo');
  location.replace('index.html');
}
function renderShell() {
  const nav = (href, icon, label, active = false, count = '') =>
    `<a class="nav-item ${active ? 'active' : ''}" href="${href}" ${active ? 'aria-current="page"' : ''}>${i(icon)}<span>${label}</span>${count ? `<span class="nav-count" id="${count}">${count === 'nav-business-count' ? state.businesses.length : state.reviews.filter((r) => !isTrue(r.is_replied) && businessById(r.google_location_id)).length}</span>` : ''}</a>`;
  $('#sidebar-root').innerHTML =
    `<aside class="sidebar" aria-label="Workspace navigation">${logo}<button class="workspace-select" data-action="workspace"><span class="workspace-icon">${i('layers', 'icon-sm')}</span><span><strong>${state.demo ? 'Demo workspace' : 'Your workspace'}</strong><small>Personal · Unlimited locations</small></span>${i('chevrons-up-down')}</button><p class="nav-label">Workspace</p><nav class="sidebar-nav">${nav('dashboard.html', 'layout-dashboard', 'Overview', page === 'dashboard' && !location.hash)}${nav('dashboard.html#businesses', 'building-2', 'Businesses', page === 'dashboard' && location.hash === '#businesses', 'nav-business-count')}${nav('business.html', 'message-square', 'Review inbox', page === 'business', 'nav-review-count')}${nav('settings.html#automation', 'zap', 'Automation', page === 'settings' && state.settingsTab === 'automation')}${nav('settings.html#ai', 'key-round', 'AI keys', page === 'settings' && state.settingsTab === 'ai')}</nav><div class="sidebar-spacer"></div><div class="sheet-note">${i('sheet')}<strong>Your data. Your control.</strong><p>No hidden database.<br>Just your own Google Sheet.</p><a href="${config.sheet_id ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(config.sheet_id)}/edit` : 'settings.html#google'}" ${config.sheet_id ? 'target="_blank" rel="noopener noreferrer"' : ''}>${config.sheet_id ? 'Open your sheet' : 'Connect your sheet'} ${i('arrow-up-right')}</a></div><nav class="sidebar-nav">${nav('settings.html', 'settings-2', 'Settings', page === 'settings' && !['automation', 'ai'].includes(state.settingsTab))}<button class="nav-item" data-action="help">${i('circle-help')}<span>Help & setup</span></button></nav><div class="sidebar-footer"><span class="avatar">${state.demo ? 'DW' : 'YW'}</span><div><strong>${state.demo ? 'Demo workspace' : 'Your workspace'}</strong><small>Self-hosted with care</small></div><button class="icon-btn" data-action="logout" aria-label="Log out" title="Log out">${i('log-out')}</button></div></aside>`;
  const title = { dashboard: 'Overview', business: 'Review inbox', settings: 'Settings' }[page];
  $('#topbar-root').innerHTML =
    `<header class="topbar"><button class="icon-btn mobile-menu" data-action="mobile-menu" aria-label="Open navigation">${i('panel-left')}</button><div class="breadcrumbs"><span>Workspace</span>${i('chevron-right')}<strong>${title}</strong></div><div class="topbar-actions"><div class="global-search"><label for="global-search" class="sr-only">Search businesses</label>${i('search')}<input id="global-search" type="search" placeholder="Search businesses…" value="${e(state.query)}" autocomplete="off"><kbd>/</kbd><div id="search-results" class="search-results" hidden></div></div><button class="icon-btn notify" data-action="notifications" aria-label="Reviews needing attention">${i('bell')}<span class="notification-dot"></span></button><button class="icon-btn" data-action="theme" aria-label="Switch to ${document.documentElement.classList.contains('dark') ? 'light' : 'dark'} mode">${i(document.documentElement.classList.contains('dark') ? 'sun' : 'moon')}</button><button class="btn btn-gradient scan-pulse" data-action="scan" data-busy-text="Scanning…">${i('scan-line')}<span class="scan-button-label">Scan<span class="desktop-label"> businesses</span></span></button></div></header>`;
  $('#global-search').addEventListener('input', (event) => {
    const query = event.target.value;
    if (page === 'dashboard') {
      state.query = query;
      renderBusinesses();
    } else renderSearchResults(query);
  });
  $('#global-search').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && page !== 'dashboard')
      location.href = `dashboard.html?q=${encodeURIComponent(event.target.value)}`;
  });
  $('.topbar .global-search')?.addEventListener('click', (event) => {
    if (!event.target.closest('.icon')) return;
    if (innerWidth > 600) {
      $('#global-search').focus();
      return;
    }
    openModal({
      title: 'Find a business',
      body: `<div class="field"><label for="mobile-search">Business name or address</label><input id="mobile-search" type="search" placeholder="Search your businesses…" autofocus></div><div id="mobile-search-list" class="scan-list mt-4"></div>`,
      onReady: () => {
        const input = $('#mobile-search');
        input.focus();
        input.oninput = () => {
          $('#mobile-search-list').innerHTML =
            state.businesses
              .filter((b) =>
                `${b.business_name} ${b.address}`.toLowerCase().includes(input.value.toLowerCase()),
              )
              .map(
                (b) =>
                  `<a class="scan-result" href="${businessHref(b)}">${tile(b)}<span><strong>${e(b.business_name)}</strong><p>${e(b.address)}</p></span>${i('arrow-right')}</a>`,
              )
              .join('') || '<p class="small muted">No matching businesses.</p>';
          icons();
        };
        input.oninput();
      },
    });
  });
  $('.sidebar').inert = innerWidth <= 800;
  renderBanner();
  enhance();
}
function renderBanner() {
  const node = $('#mode-banner');
  if (!node) return;
  node.innerHTML = state.demo
    ? `<div class="mode-banner demo"><span class="flex items-center gap-2">${i('flask-conical')}<span>You're exploring a demo workspace. Sample data, no live Google actions.</span></span><a href="settings.html#google" data-action="exit-demo">Set up my workspace ${i('arrow-right')}</a></div>`
    : !state.connected
      ? `<div class="mode-banner"><span class="flex items-center gap-2">${i('sparkles')}<span>${config.sheet_id ? 'Connect Google and prepare your sheet to bring your workspace to life.' : 'Make yourself at home. Connect Google to bring your businesses together.'}</span></span><a href="settings.html#google">Connect Google ${i('arrow-right')}</a></div>`
      : '';
  icons(node);
}
function renderSearchResults(query) {
  const root = $('#search-results');
  if (!query.trim()) {
    root.hidden = true;
    return;
  }
  const results = state.businesses
    .filter((b) => `${b.business_name} ${b.address}`.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 5);
  root.innerHTML =
    results
      .map(
        (b) =>
          `<a class="search-result" href="${businessHref(b)}">${i('building-2')}<span>${e(b.business_name)}</span>${i('arrow-up-right', 'icon-sm')}</a>`,
      )
      .join('') || '<p class="small muted" style="padding:10px">No matching businesses.</p>';
  root.hidden = false;
  icons(root);
}
async function loadWorkspace() {
  if (!configured()) return;
  const [businesses, reviews, keys, settings, logs] = await Promise.all(
    Object.keys(SCHEMA)
      .filter((tab) => tab !== 'Logs')
      .map((tab) => store.read(tab))
      .concat(store.read('Logs')),
  );
  state.businesses = businesses.filter(activeBusiness);
  state.reviews = reviews;
  state.keys = keys;
  state.logs = logs;
  state.settings = Object.fromEntries(settings.map((row) => [row.key, row.value]));
  state.connected = true;
  renderBanner();
  $('#nav-business-count') && ($('#nav-business-count').textContent = state.businesses.length);
  $('#nav-review-count') &&
    ($('#nav-review-count').textContent = state.reviews.filter(
      (r) => !isTrue(r.is_replied) && businessById(r.google_location_id),
    ).length);
}
function dashboardHTML() {
  return `<div class="page-heading motion-enter"><div><h1>Overview</h1><p>Welcome back. Here's your reputation at a glance.</p></div><div class="date">${i('calendar-days')}<span>${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span></div></div><div id="dashboard-stats" class="stats-grid"></div><div class="analytics-grid"><section class="panel chart-card motion-enter"><div class="chart-heading"><div><h2>Review activity</h2><p id="chart-description">A little feedback. A lot of opportunity.</p></div><div class="segmented" aria-label="Activity time range"><button class="active" data-chart-days="7">7 days</button><button data-chart-days="30">30 days</button></div></div><div id="review-chart" class="chart"></div></section><aside class="panel autopilot-card motion-enter"><span class="autopilot-spark">${i('sparkles')}</span><div><div class="eyebrow">${i('zap', 'icon-sm')} Your AI co-pilot</div><h2>Your reputation,<br>on autopilot.</h2><p id="autopilot-description"></p></div><a class="btn" href="settings.html#automation">Manage automation ${i('arrow-up-right', 'icon-sm')}</a></aside></div><section id="businesses"><div class="section-header"><h2>Your businesses <span id="business-count" class="count-pill">0</span></h2><button class="text-link" data-action="export-businesses">${i('download')} Export</button></div><div class="business-toolbar"><div id="business-filters" class="filter-tabs"></div><label><span class="sr-only">Sort businesses</span><select id="business-sort" class="sort-select"><option value="name">Name A–Z</option><option value="rating">Highest rated</option><option value="unreplied">Most unreplied</option><option value="sync">Recently synced</option></select></label></div><div id="business-grid" class="business-grid"></div></section><section class="panel activity-panel motion-enter"><div class="between"><h2>Recent activity</h2><button class="text-link" data-action="logs">View all activity ${i('arrow-right')}</button></div><div id="activity-list" class="activity-list"></div></section>`;
}
function renderDashboard() {
  $('#page-root').innerHTML = dashboardHTML();
  $('#page-root').setAttribute('aria-busy', 'false');
  renderStats();
  renderChart();
  renderBusinesses();
  renderActivity();
  $('#autopilot-description').textContent = state.businesses.length
    ? `${state.businesses.filter((b) => isTrue(b.is_auto_reply)).length} of ${state.businesses.length} businesses set to auto-reply. You focus on the experience. AI helps with the thank-you.`
    : 'Thoughtful replies for your 4–5 star reviews. You focus on the experience. AI helps with the thank-you.';
  $('#business-sort').value = state.sort;
  $('#business-sort').onchange = (event) => {
    state.sort = event.target.value;
    renderBusinesses();
  };
  $$('[data-chart-days]').forEach((button) => {
    button.classList.toggle('active', Number(button.dataset.chartDays) === state.chartDays);
    button.onclick = () => {
      state.chartDays = Number(button.dataset.chartDays);
      $$('[data-chart-days]').forEach((b) => b.classList.toggle('active', b === button));
      renderChart();
    };
  });
  enhance();
  if (location.hash === '#businesses') $('#businesses').scrollIntoView({ behavior: 'smooth' });
}
function renderStats() {
  const stats = summarize(state.businesses, state.reviews),
    attention = state.reviews.filter(
      (r) => isTrue(r.needs_attention) && businessById(r.google_location_id),
    ).length;
  const items = [
    ['Total businesses', stats.businesses, 'building-2', '', 'Across all your locations', ''],
    ['Total reviews', stats.reviews, 'message-square', '', 'Every voice, in one place', ''],
    [
      'Unreplied',
      stats.unreplied,
      'messages-square',
      'red',
      `${attention} need a personal touch`,
      'text-red',
    ],
    ['Auto-replied today', stats.autoToday, 'sparkles', 'green', 'Only 4–5 star reviews · UTC', 'text-green'],
  ];
  $('#dashboard-stats').innerHTML = items
    .map(
      ([label, number, icon, color, foot, fc]) =>
        `<article class="panel stat-card ${color} motion-enter"><div class="stat-top"><span class="stat-label">${label}</span><span class="stat-icon">${i(icon)}</span></div><div class="stat-value">${number.toLocaleString()}</div><p class="stat-footer ${fc}">${color ? i(color === 'red' ? 'flag' : 'check-check') : '<span class="dot" style="color:var(--green)"></span>'}${e(foot)}</p></article>`,
    )
    .join('');
}
function renderChart() {
  const days = state.chartDays,
    counts = [],
    dates = [],
    today = new Date();
  for (let n = days - 1; n >= 0; n--) {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - n);
    const day = date.toISOString().slice(0, 10);
    dates.push(date);
    counts.push(
      state.reviews.filter((r) => r.review_date.slice(0, 10) === day && businessById(r.google_location_id))
        .length,
    );
  }
  const max = Math.max(...counts, 4);
  const w = 600,
    h = 116,
    left = 28,
    base = 103;
  const points = counts.map((count, index) => [
    left + (index * (w - left - 8)) / (days - 1),
    base - (count / max) * 87,
  ]);
  let path = `M${points[0].join(' ')}`;
  points.slice(1).forEach((point, index) => {
    const prev = points[index],
      mid = (prev[0] + point[0]) / 2;
    path += ` C${mid} ${prev[1]} ${mid} ${point[1]} ${point.join(' ')}`;
  });
  const lines = [0, 0.5, 1]
    .map((n) => {
      const y = base - n * 87;
      return `<line x1="28" y1="${y}" x2="600" y2="${y}" stroke="var(--line)" stroke-width=".8" stroke-dasharray="3 4"/><text x="4" y="${y + 3}" font-size="8" fill="var(--muted)">${Math.round(max * n)}</text>`;
    })
    .join('');
  const labels = days === 7 ? dates : dates.filter((_, index) => index % 5 === 0 || index === days - 1);
  $('#review-chart').innerHTML =
    `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${counts.reduce((a, b) => a + b, 0)} reviews in the last ${days} days"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a084ed" stop-opacity=".17"/><stop offset="1" stop-color="#a084ed" stop-opacity="0"/></linearGradient></defs>${lines}<path d="${path} L${points.at(-1)[0]} ${base} L${left} ${base} Z" fill="url(#chart-fill)"/><path d="${path}" fill="none" stroke="#a084ed" stroke-width="2.2"/><circle cx="${points.at(-1)[0]}" cy="${points.at(-1)[1]}" r="3" fill="#a084ed" stroke="var(--surface)" stroke-width="2"/></svg><div class="chart-labels">${labels.map((date) => `<span>${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}</span>`).join('')}</div>${state.reviews.length ? '' : '<div class="chart-empty">Your review story starts here.</div>'}`;
  $('#chart-description').textContent =
    `${counts.reduce((a, b) => a + b, 0)} new reviews in the last ${days} days · UTC`;
}
function renderBusinesses() {
  const root = $('#business-grid');
  if (!root) return;
  const totals = {
    all: state.businesses.length,
    auto: state.businesses.filter((b) => isTrue(b.is_auto_reply)).length,
    attention: state.businesses.filter((b) =>
      state.reviews.some((r) => r.google_location_id === b.google_location_id && isTrue(r.needs_attention)),
    ).length,
  };
  $('#business-filters').innerHTML = [
    ['all', 'All businesses'],
    ['auto', 'Auto-reply on'],
    ['attention', 'Needs attention'],
  ]
    .map(
      ([key, label]) =>
        `<button class="filter-tab ${state.filter === key ? 'active' : ''}" data-business-filter="${key}">${label}<span class="filter-count">${totals[key]}</span></button>`,
    )
    .join('');
  $$('[data-business-filter]').forEach(
    (button) =>
      (button.onclick = () => {
        state.filter = button.dataset.businessFilter;
        renderBusinesses();
      }),
  );
  $('#business-count').textContent = state.businesses.length;
  let businesses = state.businesses.filter((b) =>
    `${b.business_name} ${b.address}`.toLowerCase().includes(state.query.toLowerCase()),
  );
  if (state.filter === 'auto') businesses = businesses.filter((b) => isTrue(b.is_auto_reply));
  if (state.filter === 'attention')
    businesses = businesses.filter((b) =>
      state.reviews.some((r) => r.google_location_id === b.google_location_id && isTrue(r.needs_attention)),
    );
  businesses.sort((a, b) =>
    state.sort === 'rating'
      ? Number(b.avg_rating) - Number(a.avg_rating)
      : state.sort === 'unreplied'
        ? Number(b.unreplied_count) - Number(a.unreplied_count)
        : state.sort === 'sync'
          ? b.last_sync.localeCompare(a.last_sync)
          : a.business_name.localeCompare(b.business_name),
  );
  root.innerHTML = businesses.length
    ? businesses
        .map(
          (b) =>
            `<article class="panel business-card motion-enter" data-business="${e(b.google_location_id)}"><div class="business-card-top">${tile(b)}<div class="title-wrap"><h3 title="${e(b.business_name)}">${e(b.business_name)}</h3><span class="badge ${isTrue(b.is_auto_reply) ? 'badge-green' : ''}"><span class="dot"></span>${isTrue(b.is_auto_reply) ? (isTrue(setting('automation_enabled', 'TRUE')) ? 'On autopilot' : 'Automation paused') : 'Manual care'}</span></div><button class="icon-btn" data-action="business-menu" data-id="${e(b.google_location_id)}" aria-label="Options for ${e(b.business_name)}" aria-expanded="false">${i('ellipsis')}</button><div class="dropdown-menu" hidden><button data-action="business-prompt" data-id="${e(b.google_location_id)}">${i('sparkles', 'icon-sm')} Customize AI voice</button><button data-action="delete-business" data-id="${e(b.google_location_id)}">${i('trash-2', 'icon-sm')} Remove business</button></div></div><div class="address">${i('map-pin')}<span title="${e(b.address)}">${e(b.address || 'Service-area business')}</span></div><div class="rating-row"><strong>${Number(b.avg_rating) ? Number(b.avg_rating).toFixed(1) : '—'}</strong>${starHTML(b.avg_rating)}<span class="review-count">${Number(b.total_reviews).toLocaleString()} reviews</span>${Number(b.unreplied_count) ? `<span class="badge badge-red">${Number(b.unreplied_count)} unreplied</span>` : '<span class="badge badge-green">All caught up</span>'}</div><div class="auto-row"><span class="auto-row-label">${i('sparkles')} Auto-reply <span class="tiny muted">4–5 stars</span></span>${switchHTML(isTrue(b.is_auto_reply), 'toggle-auto', b.google_location_id, `Auto-reply for ${b.business_name}`)}</div><div class="business-card-footer"><span class="last-sync" title="${e(b.last_sync)}">${i('clock-3')} ${e(relativeDate(b.last_sync))}</span><div class="card-actions"><button class="icon-btn" data-action="sync-business" data-id="${e(b.google_location_id)}" aria-label="Sync ${e(b.business_name)} now" title="Sync now">${i('refresh-cw')}</button><a href="${businessHref(b)}">View reviews ${i('arrow-up-right')}</a></div></div></article>`,
        )
        .join('')
    : empty(
        state.businesses.length ? 'No businesses match just yet.' : 'A home for all your businesses.',
        state.businesses.length
          ? 'Try another search or switch to all businesses.'
          : 'No businesses yet. Click Scan to find the Google locations you manage.',
        state.businesses.length
          ? '<button class="btn btn-soft" data-action="reset-business-filters">Clear filters</button>'
          : `<button class="btn btn-primary" data-action="scan">${i('scan-line')} Scan businesses where I'm manager</button>`,
      );
  enhance(root);
  icons($('#business-filters'));
}
function activityHTML(log) {
  const failed = log.status === 'ERROR',
    sync = log.action === 'SYNC',
    auto = log.action === 'AUTO_REPLY';
  return `<div class="activity-item"><span class="activity-icon ${failed ? 'error' : sync ? 'sync' : ''}">${i(failed ? 'circle-alert' : sync ? 'refresh-cw' : auto ? 'sparkles' : 'message-circle')}</span><div style="min-width:0"><strong>${e(log.business_name)} <span class="muted">· ${e(failed ? 'Needs attention' : sync ? 'Reviews synced' : auto ? 'AI reply sent' : log.action.replaceAll('_', ' ').toLowerCase())}</span></strong><p>${e(log.details)}</p></div><time datetime="${e(log.timestamp)}">${e(relativeDate(log.timestamp))}</time></div>`;
}
function renderActivity() {
  $('#activity-list').innerHTML = state.logs.length
    ? [...state.logs]
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, 4)
        .map(activityHTML)
        .join('')
    : '<p class="small muted" style="grid-column:1/-1;padding:4px 0 10px">Your syncs and replies will leave a little trail here.</p>';
}
function renderLogs() {
  openModal({
    title: 'Workspace activity',
    subtitle: 'Latest 100 events. Your complete history stays in the Logs tab.',
    wide: true,
    body: `<div class="logs-list">${
      [...state.logs]
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, 100)
        .map(activityHTML)
        .join('') || '<p class="small muted">No activity yet. Sync your first business to get started.</p>'
    }</div>`,
    footer: '<button class="btn" data-action="close-modal">Close</button>',
  });
}
async function scanManagedBusinesses() {
  if (!state.demo && !token()) {
    openModal({
      title: 'Let’s connect your Google account.',
      body: `<div class="loading-state">${i('scan-line')}<h3>One connection. Every location you manage.</h3><p>Connect the Google account that is a manager or owner of your businesses, then come back to scan.</p></div><div class="notice">${i('shield-check')}<span>Google OAuth authorizes the scan. Your workspace password does not grant Google access.</span></div>`,
      footer:
        '<button class="btn" data-action="close-modal">Not now</button><a class="btn btn-primary" href="settings.html#google">Connect Google →</a>',
    });
    return;
  }
  if (!state.demo && !config.sheet_id) {
    toast('Add and prepare your Google Sheet in Settings before scanning.', 'info');
    location.href = 'settings.html#google';
    return;
  }
  openModal({
    title: 'Finding your businesses',
    subtitle: 'Looking for locations your Google account can manage.',
    body: `<div class="loading-state">${i('scan-line', 'spin')}<h3>A home for every location.</h3><p>Checking your accessible accounts, one page at a time. This may take a moment.</p></div>`,
    dismissible: false,
  });
  try {
    const [accounts, tracked] = await Promise.all([google.accounts(), store.read('Businesses')]);
    const existing = new Set(tracked.map((b) => resourceId(b.google_location_id))),
      found = new Map(),
      warnings = [];
    for (const account of accounts) {
      try {
        const locations = await google.locations(account.name);
        for (const location of locations) {
          const id = resourceId(location.name);
          if (existing.has(id) || found.has(id)) continue;
          const address = location.storefrontAddress;
          found.set(id, {
            google_account_id: resourceId(account.name),
            google_location_id: id,
            business_name: location.title || 'Untitled business',
            address: address
              ? [
                  ...(address.addressLines || []),
                  address.locality,
                  address.administrativeArea,
                  address.postalCode,
                ]
                  .filter(Boolean)
                  .join(', ')
              : 'Service-area business',
            is_auto_reply: 'FALSE',
            ai_prompt_template: '',
            total_reviews: '0',
            avg_rating: '0',
            last_sync: '',
            status: 'ACTIVE',
            unreplied_count: '0',
          });
        }
      } catch (error) {
        warnings.push(`${account.accountName || 'One account'}: ${redact(error.message)}`);
      }
    }
    if (!found.size) {
      openModal({
        title: warnings.length ? 'Some accounts need attention.' : 'You’re all caught up.',
        body: `<div class="loading-state">${i(warnings.length ? 'circle-alert' : 'circle-check')}<h3>${warnings.length ? 'Google couldn’t read every account.' : 'No new businesses to add.'}</h3><p>${accounts.length ? 'All locations found are already in your sheet. Accounts must have accessible, approved Business Profile APIs.' : 'No accounts were returned. Check that this Google account is a manager of a Business Profile.'}</p></div>${warnings.length ? `<div class="notice warning">${i('triangle-alert')}<span>${warnings.map(e).join('<br>')}</span></div>` : ''}`,
        footer: '<button class="btn btn-primary" data-action="close-modal">Got it</button>',
      });
      return;
    }
    const businesses = [...found.values()];
    openModal({
      title: `${businesses.length} new ${businesses.length === 1 ? 'business' : 'businesses'} found.`,
      subtitle: 'Choose the locations you’d like to make part of your workspace.',
      body: `<p class="scan-description">${state.demo ? 'These are sample locations for your demo. ' : ''}Locations are available to your signed-in manager or owner account. Auto-reply starts off, so you stay in control.</p>${warnings.length ? `<div class="notice warning mb-4">${i('triangle-alert')}<span>Some accounts could not be checked:<br>${warnings.map(e).join('<br>')}</span></div>` : ''}<div class="between mb-4"><label class="small subtle flex items-center gap-2"><input id="scan-select-all" type="checkbox" checked style="accent-color:var(--brand)"> Select all</label><span class="tiny muted">${businesses.length} available</span></div><div class="scan-list">${businesses.map((b) => `<label class="scan-result"><input type="checkbox" class="scan-checkbox" value="${e(b.google_location_id)}" checked>${tile(b)}<span><strong>${e(b.business_name)}</strong><p>${e(b.address)}</p></span><span class="badge badge-purple">New location</span></label>`).join('')}</div>`,
      footer:
        '<span id="scan-selected-count" class="scan-count"></span><button class="btn" data-action="close-modal">Cancel</button><button id="add-scanned" class="btn btn-primary">Add selected businesses</button>',
      onReady: () => {
        const updateCount = () => {
          const count = $$('.scan-checkbox:checked').length;
          $('#scan-selected-count').textContent = `${count} selected`;
          $('#add-scanned').disabled = count === 0;
          $('#scan-select-all').checked = count === businesses.length;
          $('#scan-select-all').indeterminate = count > 0 && count < businesses.length;
        };
        $$('.scan-checkbox').forEach((box) => (box.onchange = updateCount));
        $('#scan-select-all').onchange = (event) => {
          $$('.scan-checkbox').forEach((box) => {
            box.checked = event.target.checked;
          });
          updateCount();
        };
        updateCount();
        $('#add-scanned').onclick = () =>
          busy($('#add-scanned'), async () => {
            modalDismissible = false;
            try {
              const selected = new Set($$('.scan-checkbox:checked').map((box) => box.value));
              // Re-read before append so a repeated scan cannot add the same location twice.
              const nowTracked = new Set(
                (await store.read('Businesses')).map((b) => resourceId(b.google_location_id)),
              );
              const additions = businesses.filter(
                (b) => selected.has(b.google_location_id) && !nowTracked.has(b.google_location_id),
              );
              await store.append('Businesses', additions);
              if (additions.length)
                await store.append(
                  'Logs',
                  additions.map((b) =>
                    makeLog(
                      b,
                      'ADD_BUSINESS',
                      'SUCCESS',
                      state.demo
                        ? 'Sample business added to demo.'
                        : 'Added from your Google manager account.',
                    ),
                  ),
                );
              await loadWorkspace();
              closeModal(true);
              renderPage();
              toast(
                `${additions.length} ${state.demo ? 'sample ' : ''}${additions.length === 1 ? 'business' : 'businesses'} added. Sync to bring in their reviews.`,
              );
            } finally {
              modalDismissible = true;
            }
          });
      },
    });
  } catch (error) {
    closeModal(true);
    throw error;
  }
}
async function syncReviewsForBusiness(business) {
  if (typeof business === 'string') business = businessById(business);
  if (!business) throw new Error('This business could not be found. Reload your workspace.');
  const result = await syncBusiness(store, google, business);
  return result;
}
async function log(action, business, status, details, review = null) {
  const row = makeLog(business, action, status, redact(details), review);
  await store.append('Logs', [row]);
  state.logs.push(row);
}
async function toggleBusiness(id, button) {
  button.disabled = true;
  try {
    const current = (await store.read('Businesses')).find(
      (b) => resourceId(b.google_location_id) === resourceId(id),
    );
    if (!current) throw new Error('Business not found. Reload to refresh your sheet.');
    const on = !isTrue(current.is_auto_reply);
    await store.update('Businesses', { ...current, is_auto_reply: bool(on) });
    await log(
      'AUTOMATION',
      current,
      'SUCCESS',
      `Auto-reply ${on ? 'enabled for 4–5 star reviews' : 'paused'}.`,
    );
    await loadWorkspace();
    renderPage();
    toast(
      `${on ? 'Auto-reply enabled' : 'Auto-reply paused'} for ${current.business_name}.${!state.demo && on ? ' Configure Actions secrets to run scheduled replies.' : state.demo ? ' Demo only.' : ''}`,
    );
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}
function deleteBusiness(id) {
  const b = businessById(id);
  if (!b) return;
  confirmModal(
    'Remove this business?',
    `${b.business_name} and its cached reviews will be removed from your sheet. Nothing on Google is deleted, and your manager access will not change. You can scan and add it again later.`,
    async () => {
      const businesses = await store.read('Businesses');
      const current = businesses.find((row) => resourceId(row.google_location_id) === resourceId(id));
      if (!current) throw new Error('This business was already removed. Reload your workspace.');
      const reviews = (await store.read('Reviews')).filter(
        (r) => resourceId(r.google_location_id) === resourceId(id),
      );
      await store.deleteRows(
        'Reviews',
        reviews.map((r) => r._row),
      );
      await store.deleteRows('Businesses', [current._row]);
      await log(
        'REMOVE_BUSINESS',
        current,
        'SUCCESS',
        'Removed from tracking; Google profile was not changed.',
      );
      await loadWorkspace();
      renderPage();
      toast(`${b.business_name} removed from ${state.demo ? 'the demo' : 'your workspace'}.`);
    },
    'Remove business',
    true,
  );
}
function exportBusinesses() {
  if (!state.businesses.length) {
    toast('Add a business before exporting.', 'info');
    return;
  }
  const safeCell = (value) => {
    let text = String(value ?? '');
    if (/^\s*[=+@\-\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const csv = [SCHEMA.Businesses, ...state.businesses.map((b) => SCHEMA.Businesses.map((key) => b[key]))]
    .map((row) => row.map(safeCell).join(','))
    .join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'replyraven-businesses.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Your businesses have been exported.');
}
function relevantReviews() {
  return state.reviews.filter(
    (r) =>
      businessById(r.google_location_id) &&
      (state.allReviews ||
        resourceId(r.google_location_id) === resourceId(state.selectedBusiness?.google_location_id)),
  );
}
function filteredReviews() {
  let reviews = relevantReviews();
  if (state.reviewFilter === 'unreplied') reviews = reviews.filter((r) => !isTrue(r.is_replied));
  if (state.reviewFilter === 'negative') reviews = reviews.filter((r) => starsNumber(r.star_rating) <= 3);
  if (state.reviewFilter === 'positive') reviews = reviews.filter((r) => starsNumber(r.star_rating) >= 4);
  if (state.reviewFilter === 'auto')
    reviews = reviews.filter((r) => isTrue(r.is_auto_replied) && isTrue(r.is_replied));
  if (state.reviewQuery)
    reviews = reviews.filter((r) =>
      `${r.reviewer_name} ${r.comment} ${r.business_name} ${r.reply_comment}`
        .toLowerCase()
        .includes(state.reviewQuery.toLowerCase()),
    );
  return reviews.sort((a, b) => b.review_date.localeCompare(a.review_date));
}
function renderReviewPage() {
  const params = new URLSearchParams(location.search),
    locationId = params.get('locationId');
  state.allReviews = !locationId;
  state.selectedBusiness = locationId ? businessById(locationId) : null;
  if (locationId && !state.selectedBusiness) {
    $('#page-root').innerHTML = empty(
      'This business isn’t in your workspace.',
      'It may have been removed, or your sheet is not connected. Go back to your businesses and scan to find it.',
      '<a class="btn btn-primary" href="dashboard.html">Back to overview</a>',
    );
    $('#page-root').setAttribute('aria-busy', 'false');
    enhance();
    return;
  }
  const b = state.selectedBusiness,
    reviews = relevantReviews();
  const rating = b
    ? Number(b.avg_rating)
    : reviews.length
      ? reviews.reduce((sum, r) => sum + starsNumber(r.star_rating), 0) / reviews.length
      : 0;
  $('#page-root').innerHTML =
    `<a class="back-link" href="dashboard.html#businesses">${i('arrow-left')} Back to businesses</a><div class="page-heading review-page-heading"><div><h1>${e(b?.business_name || 'Review inbox')}</h1><p>${e(b?.address || 'Every voice, in one place. Make the next impression a good one.')}</p>${rating ? `<div class="review-summary"><strong>${rating.toFixed(1)}</strong>${starHTML(rating)}<span>${b ? Number(b.total_reviews).toLocaleString() : reviews.length.toLocaleString()} reviews ${b ? '' : 'in your sheet'}</span>${b && isTrue(b.is_auto_reply) ? '<span class="badge badge-green"><span class="dot"></span> On autopilot</span>' : ''}</div>` : ''}</div><div class="flex gap-2 heading-actions"><button class="btn" data-action="sync-reviews">${i('refresh-cw', 'icon-sm')} Sync reviews</button><button class="btn btn-primary" data-action="bulk-reply">${i('sparkles', 'icon-sm')} Bulk reply 4–5 stars</button></div></div><div class="review-controls"><div id="review-filters" class="chips"></div><div class="global-search review-search">${i('search')}<label class="sr-only" for="review-search">Search reviews</label><input type="search" id="review-search" placeholder="Search reviews…" value="${e(state.reviewQuery)}"></div></div><div id="review-list" class="review-list"></div><div id="review-pagination" class="review-pagination"></div>`;
  $('#review-search').oninput = (event) => {
    state.reviewQuery = event.target.value;
    state.reviewPage = 1;
    renderReviewList();
  };
  renderReviewList();
  $('#page-root').setAttribute('aria-busy', 'false');
  enhance();
}
function renderReviewList() {
  const reviews = relevantReviews();
  const filters = [
    ['all', 'All', reviews.length],
    ['unreplied', 'Unreplied', reviews.filter((r) => !isTrue(r.is_replied)).length],
    ['negative', '1–3 stars', reviews.filter((r) => starsNumber(r.star_rating) <= 3).length],
    ['positive', '4–5 stars', reviews.filter((r) => starsNumber(r.star_rating) >= 4).length],
    ['auto', 'Auto-replied', reviews.filter((r) => isTrue(r.is_auto_replied) && isTrue(r.is_replied)).length],
  ];
  $('#review-filters').innerHTML = filters
    .map(
      ([key, label, count]) =>
        `<button class="chip ${key} ${state.reviewFilter === key ? 'active' : ''}" data-review-filter="${key}">${label}<span>${count}</span></button>`,
    )
    .join('');
  $$('[data-review-filter]').forEach(
    (button) =>
      (button.onclick = () => {
        state.reviewFilter = button.dataset.reviewFilter;
        state.reviewPage = 1;
        renderReviewList();
      }),
  );
  const filtered = filteredReviews(),
    pageSize = 12,
    pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  state.reviewPage = Math.min(state.reviewPage, pages);
  const shown = filtered.slice((state.reviewPage - 1) * pageSize, state.reviewPage * pageSize);
  $('#review-list').innerHTML = shown.length
    ? shown
        .map((r) => {
          const replied = isTrue(r.is_replied),
            auto = replied && isTrue(r.is_auto_replied),
            attention = isTrue(r.needs_attention);
          const key = reviewKey(r);
          return `<article class="panel review-card motion-enter" data-review-key="${e(key)}"><div class="review-card-top"><span class="avatar">${e(initials(r.reviewer_name))}</span><div class="reviewer-info"><strong>${e(r.reviewer_name)}</strong>${starHTML(r.star_rating)}</div><div class="review-meta"><time datetime="${e(r.review_date)}">${formatDate(r.review_date)}</time><span class="badge ${auto ? 'badge-purple' : replied ? 'badge-green' : attention ? 'badge-red' : 'badge-amber'}"><span class="dot"></span>${auto ? 'Auto-replied' : replied ? 'Replied' : attention ? 'Needs attention' : 'Unreplied'}</span></div></div>${state.allReviews ? `<a class="review-business-tag" href="${businessHref(businessById(r.google_location_id))}">${e(r.business_name)}</a>` : ''}<p class="review-comment">${e(r.comment || 'This customer left a rating without a written review.')}</p>${replied && r.reply_comment ? `<div class="reply-preview"><strong>${i(auto ? 'sparkles' : 'corner-down-right')} Your ${auto ? 'AI ' : ''}reply <span class="muted" style="font-weight:400;margin-left:auto">${formatDate(r.reply_date)}</span></strong><p>${e(r.reply_comment)}</p></div>` : ''}<div class="review-actions"><div class="review-actions-left">${!replied ? `<button class="btn btn-soft btn-sm" data-action="generate-reply" data-key="${e(key)}">${i('sparkles', 'icon-sm')} Generate AI reply</button><button class="btn btn-sm" data-action="write-reply" data-key="${e(key)}">${i('pen-line', 'icon-sm')} Write reply</button>` : `<button class="btn btn-sm" data-action="write-reply" data-key="${e(key)}">${i('pencil', 'icon-sm')} Edit reply</button><button class="btn btn-ghost btn-sm text-red" data-action="delete-reply" data-key="${e(key)}">${i('trash-2', 'icon-sm')} Delete reply</button>`}</div><a class="icon-btn" href="${whatsappLink(r)}" target="_blank" rel="noopener noreferrer" aria-label="Share ${e(r.reviewer_name)}’s review on WhatsApp" title="Share on WhatsApp">${i('send', 'icon-sm')}</a></div></article>`;
        })
        .join('')
    : empty(
        reviews.length ? 'You’re all caught up here.' : 'Your first conversation is waiting.',
        reviews.length
          ? 'No reviews match this filter. Try another view or clear your search.'
          : 'Sync reviews to bring customer feedback into your workspace.',
        reviews.length
          ? '<button class="btn btn-soft" data-action="reset-review-filters">Show all reviews</button>'
          : '<button class="btn btn-primary" data-action="sync-reviews">Sync reviews</button>',
      );
  $('#review-pagination').innerHTML = filtered.length
    ? `<span>Showing ${(state.reviewPage - 1) * pageSize + 1}–${Math.min(state.reviewPage * pageSize, filtered.length)} of ${filtered.length} reviews</span><div class="flex gap-2"><button class="btn btn-sm" data-review-page="${state.reviewPage - 1}" ${state.reviewPage === 1 ? 'disabled' : ''}>${i('chevron-left', 'icon-sm')} Previous</button><button class="btn btn-sm" data-review-page="${state.reviewPage + 1}" ${state.reviewPage === pages ? 'disabled' : ''}>Next ${i('chevron-right', 'icon-sm')}</button></div>`
    : '';
  $$('[data-review-page]').forEach(
    (button) =>
      (button.onclick = () => {
        state.reviewPage = Number(button.dataset.reviewPage);
        renderReviewList();
        $('#review-list').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }),
  );
  enhance($('#review-list'));
  icons($('#review-pagination'));
}
function whatsappLink(review) {
  const phone = String(setting('whatsapp_number')).replace(/[^0-9]/g, '');
  const text = `${starsNumber(review.star_rating) <= 3 ? '⚠️ Review needs attention' : '⭐ New customer review'}\n${review.business_name} · ${review.star_rating}/5 stars\n${review.reviewer_name}: ${review.comment || '(Rating only)'}\n${isTrue(review.is_replied) ? `Reply: ${review.reply_comment}` : 'No reply yet.'}`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}
function findReview(key) {
  return state.reviews.find((r) => reviewKey(r) === key);
}
async function getAIEngine() {
  state.keys = await store.read('AI_Keys');
  if (!state.demo && config.apps_script_url && !config.apps_script_token)
    throw new Error('Enter your Apps Script bridge token in Google settings before generating a reply.');
  return new AIKeyRotator(state.keys, {
    index: Number(localStorage.getItem('ai_index')) || 0,
    onRotate: async (index) => localStorage.setItem('ai_index', String(index)),
    onAttempt: async (key) => {
      const current = (await store.read('AI_Keys')).find((row) => row.id === key.id);
      if (current)
        await store.update('AI_Keys', {
          ...current,
          request_count: String((Number(current.request_count) || 0) + 1),
          last_used_at: new Date().toISOString(),
        });
    },
    proxy:
      !state.demo && config.apps_script_url
        ? async (data) => {
            if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(config.apps_script_url))
              throw new Error('Use a deployed HTTPS Apps Script /exec URL.');
            if (!config.apps_script_token)
              throw new Error('Enter your Apps Script bridge token in Google settings.');
            const result = await requestJSON(config.apps_script_url, {
              method: 'POST',
              headers: { 'Content-Type': 'text/plain;charset=utf-8' },
              body: JSON.stringify({
                action: 'generateReply',
                bridgeToken: config.apps_script_token,
                ...data,
              }),
              timeout: 60000,
            });
            if (!result.ok)
              throw new Error(result.error || 'The Apps Script bridge could not generate a reply.');
            return result;
          }
        : null,
  });
}
async function getNextAIKey() {
  const engine = await getAIEngine(),
    key = engine.getNextAIKey();
  await engine.onRotate(engine.index);
  await engine.onAttempt(key, null);
  return key;
}
async function generateAI(review, business) {
  const engine = await getAIEngine();
  if (state.demo) {
    await sleep(550);
    const key = engine.getNextAIKey();
    await engine.onRotate(engine.index);
    await engine.onAttempt(key, null);
    return {
      key,
      reply:
        starsNumber(review.star_rating) <= 3
          ? `Thank you for sharing your experience, ${review.reviewer_name.split(' ')[0]}. We're sorry this visit didn't meet your expectations. Your feedback matters to our team at ${business.business_name}, and we'd welcome the chance to speak with you directly and better understand what happened.`
          : `Thank you so much, ${review.reviewer_name.split(' ')[0]}! We're delighted you had a great experience at ${business.business_name}. It means a lot to know our team's care made a difference. We truly appreciate your kind words and look forward to welcoming you back!`,
    };
  }
  return engine.generate(
    review,
    business,
    business.ai_prompt_template || setting('default_ai_prompt', DEFAULT_PROMPT),
  );
}
function replyModal(key, generate = false) {
  const review = findReview(key),
    business = review && businessById(review.google_location_id);
  if (!business) return;
  const alreadyReplied = isTrue(review.is_replied);
  openModal({
    title: alreadyReplied ? 'Make your reply even better.' : 'A thoughtful reply starts here.',
    subtitle: `${business.business_name} · ${review.reviewer_name}`,
    body: `<div class="review-card-top"><span class="avatar">${e(initials(review.reviewer_name))}</span><div class="reviewer-info"><strong>${e(review.reviewer_name)}</strong>${starHTML(review.star_rating)}</div><span class="tiny muted">${formatDate(review.review_date)}</span></div><p class="review-comment">${e(review.comment || 'Rating only, no written comment.')}</p>${starsNumber(review.star_rating) <= 3 ? `<div class="notice warning mb-4">${i('heart-handshake')}<span>This customer needs a personal touch. AI can help with a draft, but please review it carefully before posting.</span></div>` : ''}<div class="field"><label for="reply-text">Your reply ${state.demo ? '<span class="optional">· demo only</span>' : ''}</label><textarea id="reply-text" class="reply-input" maxlength="4096" placeholder="A warm thank-you goes a long way…">${e(review.reply_comment || '')}</textarea></div><div class="reply-dialog-tools"><button id="generate-modal-reply" class="btn btn-soft btn-sm" data-busy-text="Drafting…">${i('sparkles', 'icon-sm')} Generate AI suggestion</button><span id="reply-character-count">${(review.reply_comment || '').length} / 4,096</span></div><p id="ai-suggestion-source" class="tiny muted">You’re in control. Nothing is posted until you choose.</p>`,
    footer: `<button class="btn" data-action="close-modal">Cancel</button><button id="post-modal-reply" class="btn btn-primary" ${!review.reply_comment ? 'disabled' : ''}>${i('send', 'icon-sm')} ${state.demo ? 'Post demo reply' : alreadyReplied ? 'Update Google reply' : 'Post to Google'}</button>`,
    onReady: () => {
      const text = $('#reply-text'),
        post = $('#post-modal-reply');
      const validate = () => {
        $('#reply-character-count').textContent = `${text.value.length} / 4,096`;
        post.disabled = !text.value.trim();
      };
      text.oninput = validate;
      $('#generate-modal-reply').onclick = () =>
        busy($('#generate-modal-reply'), async () => {
          const { reply, key: aiKey } = await generateAI(review, business);
          if (!text.isConnected) return;
          text.value = reply;
          validate();
          $('#ai-suggestion-source').textContent =
            `${state.demo ? 'Sample suggestion' : 'Draft generated'} with ${aiKey.provider} · ${aiKey.model_name}. Review before sending.`;
          text.focus();
        });
      post.onclick = () =>
        busy(post, async () => {
          modalDismissible = false;
          try {
            // A new reply must not silently replace one posted since the page was opened.
            const latest = await google.getReview(business, review.google_review_id);
            if (!alreadyReplied && latest.reviewReply?.comment) {
              await syncReviewsForBusiness(business);
              await loadWorkspace();
              renderPage();
              closeModal(true);
              toast(
                'This review already has a Google reply. We synced it instead of overwriting it.',
                'info',
              );
              return;
            }
            if (alreadyReplied && (latest.reviewReply?.comment || '') !== (review.reply_comment || ''))
              throw new Error(
                'The Google reply changed after this page loaded. Sync the business before editing it.',
              );
            const reply = await google.postReply(business, review.google_review_id, text.value.trim());
            try {
              await persistReply(store, business, review, reply, false);
              await log('MANUAL_REPLY', business, 'SUCCESS', 'Reply posted after human review.', review);
            } catch (error) {
              throw new Error(
                `The Google reply was saved, but Sheets needs reconciling: ${error.message} Use Sync, not Post again.`,
              );
            }
            await loadWorkspace();
            closeModal(true);
            renderPage();
            toast(
              state.demo
                ? 'Demo reply saved. Nothing was posted to Google.'
                : 'Your reply is live on Google. A good impression, made.',
            );
          } finally {
            modalDismissible = true;
          }
        });
      if (generate) $('#generate-modal-reply').click();
      else text.focus();
    },
  });
}
function deleteReviewReply(key) {
  const review = findReview(key),
    business = review && businessById(review.google_location_id);
  if (!business || !isTrue(review.is_replied)) return;
  confirmModal(
    'Delete your reply?',
    `Your reply to ${review.reviewer_name} will be removed ${state.demo ? 'from the demo' : 'from Google'}. The customer’s review will remain. This cannot be undone.`,
    async () => {
      const latest = await google.getReview(business, review.google_review_id);
      if ((latest.reviewReply?.comment || '') !== review.reply_comment)
        throw new Error('This Google reply changed. Sync before deleting it.');
      await google.deleteReply(business, review.google_review_id);
      const current = (await store.read('Reviews')).find((row) => reviewKey(row) === key);
      if (!current) throw new Error('Reply removed from Google. Sync to reconcile your sheet.');
      await store.update('Reviews', {
        ...current,
        reply_comment: '',
        is_replied: 'FALSE',
        reply_date: '',
        is_auto_replied: 'FALSE',
        needs_attention: bool(starsNumber(current.star_rating) <= 3),
      });
      await recountBusiness(store, business);
      await log(
        'DELETE_REPLY',
        business,
        'SUCCESS',
        'Owner reply deleted; customer review was not deleted.',
        review,
      );
      await loadWorkspace();
      renderPage();
      toast(state.demo ? 'Demo reply deleted.' : 'Reply deleted from Google.');
    },
    'Delete reply',
    true,
  );
}
async function syncPageReviews() {
  const businesses = state.allReviews ? state.businesses : [state.selectedBusiness].filter(Boolean);
  if (!businesses.length) {
    toast('Add a business from the overview first.', 'info');
    return;
  }
  let success = 0;
  const errors = [];
  for (const business of businesses) {
    try {
      await syncReviewsForBusiness(business);
      success++;
    } catch (error) {
      errors.push(`${business.business_name}: ${redact(error.message)}`);
    }
  }
  await loadWorkspace();
  renderPage();
  if (success)
    toast(
      `${success} ${state.demo ? 'sample ' : ''}${success === 1 ? 'business' : 'businesses'} synced. Your inbox is up to date.`,
    );
  if (errors.length) toast(errors.join(' · '), 'error');
}
function bulkReply() {
  const reviews = relevantReviews().filter((r) => !isTrue(r.is_replied) && starsNumber(r.star_rating) >= 4);
  if (!reviews.length) {
    toast('Every 4–5 star review is already replied to. Nicely done.', 'info');
    return;
  }
  if (
    !state.keys.some(
      (key) =>
        isTrue(key.is_active) &&
        (state.demo || key.api_key || (config.apps_script_url && config.apps_script_token)),
    )
  ) {
    toast(
      'Add a browser AI key or configure the Apps Script relay first. Actions-only keys cannot be used directly by this browser.',
      'info',
    );
    return;
  }
  confirmModal(
    'A thank-you for every kind word.',
    `${reviews.length} unreplied 4–5 star reviews will each receive an AI-generated reply ${state.demo ? 'in this demo only' : 'on Google'}. Lower-star reviews are excluded. Existing Google replies are checked and left untouched. This uses your AI credits.`,
    async () => {
      openModal({
        title: 'Thoughtful replies, one at a time.',
        body: `<div class="loading-state">${i('sparkles', 'spin')}<h3 id="bulk-progress">Preparing ${reviews.length} replies…</h3><p>Please leave this tab open. Reviews with an existing Google reply will be skipped.</p></div>`,
        dismissible: false,
      });
      let sent = 0,
        skipped = 0;
      const errors = [];
      try {
        for (let index = 0; index < reviews.length; index++) {
          const review = reviews[index],
            business = businessById(review.google_location_id);
          $('#bulk-progress').textContent = `Review ${index + 1} of ${reviews.length} · ${sent} replies sent`;
          try {
            const latest = await google.getReview(business, review.google_review_id);
            if (latest.reviewReply?.comment || starsNumber(latest.starRating) < 4) {
              skipped++;
              await syncReviewsForBusiness(business);
              continue;
            }
            const { reply } = await generateAI(review, business);
            // Check again immediately before PUT; another manager may have replied during generation.
            const beforePost = await google.getReview(business, review.google_review_id);
            if (beforePost.reviewReply?.comment || starsNumber(beforePost.starRating) < 4) {
              skipped++;
              await syncReviewsForBusiness(business);
              continue;
            }
            const saved = await google.postReply(business, review.google_review_id, reply);
            await persistReply(store, business, review, saved, true);
            await log(
              'BULK_REPLY',
              business,
              'SUCCESS',
              '4–5 star reply generated and posted in a confirmed bulk run.',
              review,
            );
            sent++;
          } catch (error) {
            errors.push(`${review.reviewer_name}: ${redact(error.message)}`);
            await log('BULK_REPLY', business, 'ERROR', error.message, review).catch(() => {});
          }
          await sleep(state.demo ? 80 : 2000);
        }
        await loadWorkspace();
        renderPage();
        openModal({
          title: 'A few more customers, heard.',
          body: `<div class="loading-state">${i('circle-check')}<h3>${sent} ${state.demo ? 'demo ' : ''}replies sent</h3><p>${skipped} existing replies skipped. ${errors.length} errors.${state.demo ? ' Nothing was sent to Google.' : ''}</p></div>${errors.length ? `<div class="notice warning">${i('triangle-alert')}<span>${errors.map(e).join('<br>')}</span></div>` : ''}`,
          footer: '<button class="btn btn-primary" data-action="close-modal">Back to reviews</button>',
        });
      } finally {
        modalDismissible = true;
      }
    },
    state.demo ? 'Run demo bulk replies' : 'Generate & post replies',
  );
}
function redirectURI() {
  return new URL('callback.html', location.href).href.split(/[?#]/)[0];
}
function fieldHTML(
  id,
  label,
  {
    value = '',
    placeholder = '',
    secret = false,
    full = false,
    hint = '',
    optional = false,
    type = 'text',
    autocomplete = 'off',
  } = {},
) {
  const input = `<input id="${id}" name="${id}" type="${secret ? 'password' : type}" autocomplete="${autocomplete}" value="${e(value)}" placeholder="${e(placeholder)}" spellcheck="false">`;
  return `<div class="field ${full ? 'full' : ''}"><label for="${id}">${label}${optional ? '<span class="optional">Optional</span>' : ''}</label>${secret ? `<div class="secret-field">${input}<button type="button" class="icon-btn" data-reveal="${id}" aria-label="Show ${e(label)}">${i('eye')}</button></div>` : input}${hint ? `<small>${hint}</small>` : ''}</div>`;
}
function settingsAside() {
  const steps = [
    [Boolean(config.client_id && token()), 'Connect Google', 'Use your manager or owner account.', 'google'],
    [state.connected && !state.demo, 'Prepare your sheet', 'Five tabs. One source of truth.', 'google'],
    [
      !state.demo && state.keys.some((key) => isTrue(key.is_active)),
      'Add an AI key',
      'Choose the voice behind your replies.',
      'ai',
    ],
    [
      !state.demo && state.logs.some((row) => row.action === 'AUTO_REPLY'),
      'Enable GitHub Actions',
      'See the secrets checklist to get started.',
      'secrets',
    ],
  ];
  const done = steps.filter((step) => step[0]).length;
  return `<aside class="panel settings-aside"><h3>A little setup. A lot of peace of mind.</h3><p>${state.demo ? 'This is a sample workspace. Set up your own to connect real businesses.' : `${done} of 4 milestones complete. The last step is verified by a scheduled reply log.`}</p><div class="progress-track"><span style="width:${(done / 4) * 100}%"></span></div><div class="setup-steps">${steps.map(([complete, title, copy, tab], index) => `<a class="setup-step" href="#${tab}"><span class="step-check ${complete ? 'done' : ''}">${complete ? i('check') : index + 1}</span><span><strong>${title}</strong><p>${copy}</p></span></a>`).join('')}</div><hr class="divider"><p>Need a hand with Google API approval or OAuth? Our setup guide walks you through every step.</p><a class="text-link mt-4" href="https://github.com/Joshbond123/ReplyRaven#readme" target="_blank" rel="noopener noreferrer">Open the setup guide ${i('arrow-up-right')}</a></aside>`;
}
function renderSettings() {
  const tabs = [
    ['google', 'link-2', 'Google connection'],
    ['ai', 'key-round', 'AI keys'],
    ['automation', 'zap', 'Automation'],
    ['secrets', 'github', 'GitHub secrets'],
    ['account', 'user-round', 'Account'],
  ];
  if (!tabs.some(([key]) => key === state.settingsTab)) state.settingsTab = 'google';
  $('#page-root').innerHTML =
    `<div class="page-heading"><div><h1>Settings</h1><p>A workspace that feels like you. Make yourself at home.</p></div><span class="badge ${state.demo ? 'badge-amber' : state.connected ? 'badge-green' : ''}"><span class="dot"></span>${state.demo ? 'Demo workspace' : state.connected ? 'Sheet connected' : 'Setup needed'}</span></div><div class="settings-tabs" role="tablist" aria-label="Settings">${tabs.map(([key, icon, name]) => `<button id="tab-${key}" class="settings-tab ${state.settingsTab === key ? 'active' : ''}" data-settings-tab="${key}" role="tab" aria-selected="${state.settingsTab === key}" aria-controls="settings-content" tabindex="${state.settingsTab === key ? 0 : -1}">${i(icon)} ${name}</button>`).join('')}</div><div class="settings-layout"><section id="settings-content" class="panel settings-panel" role="tabpanel" aria-labelledby="tab-${state.settingsTab}"></section>${settingsAside()}</div>`;
  const content = $('#settings-content');
  if (state.settingsTab === 'google') {
    content.innerHTML = googleSettingsHTML();
    bindGoogleSettings();
  }
  if (state.settingsTab === 'ai') {
    content.innerHTML = aiSettingsHTML();
    bindAISettings();
  }
  if (state.settingsTab === 'automation') {
    content.innerHTML = automationSettingsHTML();
    bindAutomationSettings();
  }
  if (state.settingsTab === 'secrets') {
    content.innerHTML = secretsSettingsHTML();
    bindSecretsSettings();
  }
  if (state.settingsTab === 'account') {
    content.innerHTML = accountSettingsHTML();
    bindAccountSettings();
  }
  $$('[data-settings-tab]').forEach((button) => {
    button.onclick = () => {
      location.hash = button.dataset.settingsTab;
    };
    button.onkeydown = (event) => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const all = $$('[data-settings-tab]'),
        index = all.indexOf(button);
      const next =
        event.key === 'Home'
          ? all[0]
          : event.key === 'End'
            ? all.at(-1)
            : all[(index + (event.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
      location.hash = next.dataset.settingsTab;
      setTimeout(() => $(`#tab-${next.dataset.settingsTab}`)?.focus(), 0);
    };
  });
  $('#page-root').setAttribute('aria-busy', 'false');
  enhance();
}
function googleSettingsHTML() {
  return `<div class="between"><div><h2>Good conversations start with a connection.</h2></div><span class="badge ${!state.demo && token() ? 'badge-green' : ''}"><span class="dot"></span>${!state.demo && token() ? 'Google authorized' : 'Not connected'}</span></div><p class="panel-subtitle" style="margin-top:6px">Connect the Google account that manages your locations. Keep your sheet private.</p><div class="notice mb-4">${i('shield-check')}<span><strong>Browser access and background automation are different.</strong> Connect Google for your live workspace. Use an offline refresh token in GitHub Secrets for Actions. Secrets are never synced to the Settings tab.</span></div><form id="google-settings-form"><div class="form-grid">${fieldHTML('client_id', 'Google OAuth client ID', { value: config.client_id, placeholder: '…apps.googleusercontent.com', hint: 'Web application client · used by the Google connect button.' })}${fieldHTML('sheet_id', 'Google Sheet ID', { value: config.sheet_id, placeholder: 'Paste your Sheet ID or URL', hint: 'You must have edit access. Do not publish the sheet.' })}${fieldHTML('api_key', 'Google API key', { value: config.api_key, placeholder: 'AIza…', secret: true, optional: true, hint: 'Optional for publicly readable sheet data. Cannot authorize writes.' })}${fieldHTML('access_token', 'Google access token', { value: config.access_token, placeholder: 'Filled when you connect Google', secret: true, optional: true, hint: 'Short-lived. Reconnect after expiry; never paste it in GitHub code.' })}</div><div class="form-actions"><button type="button" id="connect-google" class="btn btn-primary">${i('link-2', 'icon-sm')} Connect Google</button><button type="submit" class="btn">${i('save', 'icon-sm')} Save connection</button><button type="button" id="test-google" class="btn">${i('circle-check', 'icon-sm')} Test connection</button><button type="button" id="prepare-sheet" class="btn btn-soft">${i('sheet', 'icon-sm')} Prepare sheet</button></div><hr class="divider"><div class="between"><h3 style="font-size:12px">Offline authorization & advanced settings</h3><span class="badge">Local device only</span></div><p class="small muted mt-4" style="font-size:10px">The recommended token exchange runs locally with <code>scripts/get-token.js</code>. Leave secrets blank in the browser unless you explicitly need the advanced exchange.</p><div class="form-grid mt-6">${fieldHTML('client_secret', 'OAuth client secret', { value: config.client_secret, placeholder: 'Recommended: keep in your local .env', secret: true, optional: true, hint: 'Not required for the Connect Google button. Browser storage is not a vault.' })}${fieldHTML('refresh_token', 'Offline refresh token', { value: config.refresh_token, placeholder: 'Recommended: GitHub Secrets only', secret: true, optional: true, hint: 'Used by Actions, not by the static browser app.' })}${fieldHTML('apps_script_url', 'Apps Script AI bridge URL', { value: config.apps_script_url, placeholder: 'https://script.google.com/macros/s/…/exec', full: true, optional: true, hint: 'Optional CORS relay. Deploy scripts/apps-script.gs and set its Script Properties first.' })}${fieldHTML('apps_script_token', 'AI bridge token', { value: config.apps_script_token, placeholder: 'The BRIDGE_TOKEN Script Property', secret: true, full: true, optional: true, hint: 'Treat the bridge like an API key. Do not share this workspace or token.' })}</div><hr class="divider"><h3 style="font-size:12px">Your OAuth redirect URI</h3><p class="tiny muted mt-4">Add this exact URL to your web OAuth client’s authorized redirect URIs. Also add <code>${e(location.origin)}</code> as an authorized JavaScript origin.</p><div class="code-row mt-4"><code id="oauth-redirect-uri">${e(redirectURI())}</code><button type="button" class="icon-btn" data-copy-target="oauth-redirect-uri" aria-label="Copy redirect URI">${i('copy')}</button></div><div class="form-actions"><button type="button" id="build-oauth-url" class="btn">${i('external-link', 'icon-sm')} Build offline OAuth URL</button></div><div id="oauth-url-result" hidden class="mt-4"><div class="field"><label for="oauth-url">Offline authorization URL</label><textarea id="oauth-url" readonly rows="3"></textarea></div><div class="form-actions"><button type="button" class="btn btn-sm" data-copy-target="oauth-url">${i('copy', 'icon-sm')} Copy URL</button><a id="open-oauth-url" class="btn btn-primary btn-sm" href="#">Authorize offline access ${i('arrow-up-right', 'icon-sm')}</a></div></div></form><div class="notice warning mt-6">${i('triangle-alert')}<span>Local passwords do not secure a public GitHub Pages site. Anyone with access to this browser can inspect stored tokens. Use a dedicated, trusted device and private sheets. This is a self-hosted, single-user workspace—not a multi-tenant authentication system.</span></div>`;
}
function formConfig() {
  const values = Object.fromEntries(
    [...configKeys, 'apps_script_token'].map((key) => [key, $(`#${key}`)?.value.trim() || '']),
  );
  const match = values.sheet_id.match(/\/spreadsheets\/d\/([\w-]+)/);
  if (match) values.sheet_id = match[1];
  if (values.sheet_id && !/^[\w-]+$/.test(values.sheet_id))
    throw new Error('Enter a Google Sheet ID or a valid docs.google.com/spreadsheets URL.');
  if (
    values.apps_script_url &&
    !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(values.apps_script_url)
  )
    throw new Error('Apps Script URLs must be a deployed https://script.google.com/macros/s/…/exec URL.');
  return values;
}
function applyGoogleForm() {
  const values = formConfig();
  const previousToken = config.access_token,
    previousSheet = config.sheet_id;
  saveLocal(values);
  if (values.access_token && values.access_token !== previousToken)
    localStorage.setItem('access_token_expiry', String(Date.now() + 3600000));
  if (values.sheet_id !== previousSheet) {
    state.businesses = [];
    state.reviews = [];
    state.keys = [];
    state.logs = [];
    state.settings = {};
    state.connected = false;
  }
  configureClients();
  return values;
}
function bindGoogleSettings() {
  $('#google-settings-form').onsubmit = (event) => {
    event.preventDefault();
    busy($('button[type="submit"]', event.currentTarget), async () => {
      if (state.demo) {
        toast('Exit the demo to save real Google credentials. Sample data is isolated.', 'info');
        return;
      }
      const values = applyGoogleForm();
      toast('Connection settings saved on this device.');
      if (values.sheet_id && token()) {
        try {
          await store.saveSettings({
            client_id: values.client_id,
            sheet_id: values.sheet_id,
            apps_script_url: values.apps_script_url,
          });
          await loadWorkspace();
          toast('Non-sensitive settings saved to your private sheet.');
        } catch (error) {
          toast(
            `Saved locally, but the sheet needs attention: ${error.message} Use Prepare sheet for new sheets.`,
            'error',
          );
        }
      }
      renderSettings();
      renderShell();
    });
  };
  $('#connect-google').onclick = () => busy($('#connect-google'), connectGoogle);
  $('#test-google').onclick = () =>
    busy($('#test-google'), async () => {
      if (!state.demo) applyGoogleForm();
      const accounts = await google.accounts();
      toast(
        `${state.demo ? 'Demo connection: ' : 'Connected to Google: '}${accounts.length} accessible ${accounts.length === 1 ? 'account' : 'accounts'}. ${accounts.length ? 'Ready to scan.' : 'Use an account that manages a Business Profile.'}`,
        accounts.length ? 'success' : 'info',
      );
    });
  $('#prepare-sheet').onclick = () =>
    busy($('#prepare-sheet'), async () => {
      if (state.demo) {
        toast('The demo sheet is already prepared. Exit the demo to set up your own.', 'info');
        return;
      }
      applyGoogleForm();
      const tabs = await store.initialize();
      const existing = Object.fromEntries((await store.read('Settings')).map((row) => [row.key, row.value]));
      await store.saveSettings({
        client_id: config.client_id,
        sheet_id: config.sheet_id,
        default_ai_prompt: existing.default_ai_prompt || setting('default_ai_prompt', DEFAULT_PROMPT),
        automation_enabled: existing.automation_enabled ?? 'TRUE',
        reply_delay_seconds: existing.reply_delay_seconds || '2',
        max_replies_per_run: existing.max_replies_per_run || '100',
      });
      await loadWorkspace();
      renderSettings();
      renderShell();
      toast(
        tabs.length
          ? `${tabs.length} tabs prepared. Your sheet is ready.`
          : 'All five tabs look good. Your sheet is ready.',
      );
    });
  $('#build-oauth-url').onclick = () => {
    try {
      if (state.demo) {
        toast('Exit the demo to authorize a real Google account.', 'info');
        return;
      }
      const clientId = $('#client_id').value.trim();
      if (!clientId) throw new Error('Enter your OAuth client ID first.');
      saveLocal({ client_id: clientId });
      const oauthState = [...crypto.getRandomValues(new Uint8Array(24))]
        .map((n) => n.toString(16).padStart(2, '0'))
        .join('');
      sessionStorage.setItem('rr_oauth_state', oauthState);
      sessionStorage.setItem('rr_oauth_redirect', redirectURI());
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      Object.entries({
        client_id: clientId,
        redirect_uri: redirectURI(),
        response_type: 'code',
        scope: SCOPES,
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state: oauthState,
      }).forEach(([key, value]) => url.searchParams.set(key, value));
      $('#oauth-url-result').hidden = false;
      $('#oauth-url').value = url.href;
      $('#open-oauth-url').href = url.href;
    } catch (error) {
      handleError(error);
    }
  };
}
let gisPromise;
function loadGIS() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    const timeout = setTimeout(() => {
      gisPromise = null;
      reject(
        new Error(
          'Google sign-in could not load. Check your connection or use an access token from the local token helper.',
        ),
      );
    }, 15000);
    script.onload = () => {
      clearTimeout(timeout);
      resolve();
    };
    script.onerror = () => {
      clearTimeout(timeout);
      gisPromise = null;
      reject(new Error('Google sign-in was blocked. Check your browser or network.'));
    };
    document.head.append(script);
  });
  return gisPromise;
}
async function connectGoogle() {
  if (state.demo) {
    toast('The demo uses sample connections. Choose “Set up my workspace” to connect Google.', 'info');
    return;
  }
  const clientId = $('#client_id')?.value.trim() || config.client_id;
  if (!clientId) throw new Error('Enter your Google OAuth web client ID first.');
  saveLocal({
    client_id: clientId,
    sheet_id:
      $('#sheet_id')
        ?.value.trim()
        .match(/\/spreadsheets\/d\/([\w-]+)/)?.[1] ||
      $('#sheet_id')?.value.trim() ||
      config.sheet_id ||
      '',
  });
  await loadGIS();
  const response = await new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: (result) =>
        result.error ? reject(new Error(result.error_description || result.error)) : resolve(result),
      error_callback: (result) =>
        reject(
          new Error(
            result.type === 'popup_closed'
              ? 'Google sign-in was closed. Nothing changed.'
              : 'Google could not open sign-in. Check your OAuth origins and popup permissions.',
          ),
        ),
    });
    client.requestAccessToken({ prompt: 'consent' });
  });
  if (!response.access_token) throw new Error('Google did not return an access token.');
  saveLocal({ access_token: response.access_token });
  localStorage.setItem(
    'access_token_expiry',
    String(Date.now() + Math.max(0, Number(response.expires_in || 3600) - 60) * 1000),
  );
  configureClients();
  toast('Google connected. Your next good conversation is one step closer.');
  if (config.sheet_id) {
    try {
      await loadWorkspace();
    } catch (error) {
      toast(`Google is authorized. Prepare your sheet next: ${error.message}`, 'info');
    }
  }
  renderSettings();
  renderShell();
}
function aiSettingsHTML() {
  return `<h2>A little intelligence. A lot of personality.</h2><p class="panel-subtitle">Bring your own keys. Every request moves to the next active key, with automatic failover when a provider is rate-limited or unavailable.</p><div class="notice mb-4">${i('repeat-2')}<span><strong>Round-robin rotation.</strong> OpenAI (including “gpt”), Gemini, Anthropic, and Groq are supported. Request counts include attempted calls. ${state.demo ? 'Demo suggestions are generated locally; these keys are not real.' : 'Browser calls expose your key to this device. Keep AI_Keys private, or use the optional Apps Script relay.'}</span></div><form id="ai-key-form"><div class="form-grid"><div class="field"><label for="ai-provider">Provider</label><select id="ai-provider" name="provider"><option value="openai">OpenAI</option><option value="gpt">GPT · OpenAI alias</option><option value="gemini">Google Gemini</option><option value="anthropic">Anthropic</option><option value="groq">Groq</option></select></div>${fieldHTML('ai-model', 'Model', { value: 'gpt-4o-mini', placeholder: 'gpt-4o-mini', hint: 'Use a model your API key can access. Model availability varies.' })}${fieldHTML('ai-api-key', 'API key', { value: state.demo ? 'demo-key-not-a-real-credential' : '', placeholder: 'Paste your provider API key', secret: true, full: true })}</div><div class="form-actions"><button class="btn btn-primary" type="submit">${i('plus', 'icon-sm')} ${state.demo ? 'Add sample key' : 'Add AI key'}</button><span class="tiny muted">${state.keys.filter((k) => isTrue(k.is_active)).length} active keys · no per-key platform fee</span></div></form><div class="table-wrap"><table class="keys-table"><thead><tr><th>Provider</th><th>Key / Model</th><th>Active</th><th>Requests</th><th>Last used</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${state.keys.map((key) => `<tr><td><span class="provider-badge ${e(key.provider)}">${e(key.provider)}</span></td><td><code>${key.api_key ? `••••••••${e(key.api_key.slice(-4))}` : 'Actions / relay only'}</code><br><span class="tiny muted">${e(key.model_name)}</span></td><td>${switchHTML(isTrue(key.is_active), 'toggle-key', key.id, `Enable ${key.provider} key ${key.id}`)}</td><td>${Number(key.request_count).toLocaleString()}</td><td>${e(relativeDate(key.last_used_at))}</td><td><button class="icon-btn text-red" data-action="delete-key" data-id="${e(key.id)}" aria-label="Delete ${e(key.provider)} key">${i('trash-2', 'icon-sm')}</button></td></tr>`).join('') || '<tr><td colspan="6" style="text-align:center;padding:30px">Your first thoughtful reply starts with a key. Add one above.</td></tr>'}</tbody></table></div><div class="notice warning mt-6">${i('lock-keyhole')}<span>Never publish the AI_Keys tab or commit API keys. GitHub Actions uses the <code>AI_KEYS_JSON</code> secret, not browser storage. After changing keys, update that secret in the GitHub secrets tab.</span></div>`;
}
function bindAISettings() {
  $('#ai-provider').onchange = (event) => {
    $('#ai-model').value = PROVIDER_MODELS[event.target.value];
  };
  $('#ai-key-form').onsubmit = (event) => {
    event.preventDefault();
    busy($('button[type="submit"]', event.currentTarget), async () => {
      const provider = $('#ai-provider').value,
        model = $('#ai-model').value.trim(),
        apiKey = $('#ai-api-key').value.trim();
      if (!model || !apiKey) throw new Error('Enter both the model name and API key.');
      if (!state.demo && !configured())
        throw new Error('Connect and prepare your private sheet in the Google tab first.');
      await store.append('AI_Keys', [
        {
          provider,
          api_key: state.demo ? 'demo-key-not-a-real-credential' : apiKey,
          model_name: model,
          is_active: 'TRUE',
          request_count: '0',
          last_used_at: '',
          id: crypto.randomUUID(),
        },
      ]);
      state.keys = await store.read('AI_Keys');
      renderSettings();
      toast(`${provider} ${state.demo ? 'sample ' : ''}key added to your rotation.`);
    });
  };
}
async function toggleKey(id, button) {
  button.disabled = true;
  try {
    const key = (await store.read('AI_Keys')).find((row) => row.id === id);
    if (!key) throw new Error('Key not found. Refresh your workspace.');
    await store.update('AI_Keys', { ...key, is_active: bool(!isTrue(key.is_active)) });
    state.keys = await store.read('AI_Keys');
    renderSettings();
    toast('Key rotation updated. Remember to update AI_KEYS_JSON for Actions.');
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}
function deleteKey(id) {
  const key = state.keys.find((key) => key.id === id);
  if (!key) return;
  confirmModal(
    'Remove this AI key?',
    `This ${key.provider} key will be removed from your sheet. This does not revoke it at the provider or update GitHub Secrets. Update AI_KEYS_JSON after deleting it.`,
    async () => {
      const fresh = (await store.read('AI_Keys')).find((row) => row.id === id);
      if (fresh) await store.deleteRows('AI_Keys', [fresh._row]);
      state.keys = await store.read('AI_Keys');
      renderSettings();
      toast('Key removed from your workspace.');
    },
    'Remove key',
    true,
  );
}
function automationSettingsHTML() {
  return `<h2>A little more peace of mind.</h2><p class="panel-subtitle">Choose your guardrails. Actions does the background work; you keep the final say.</p><div class="automation-setting"><div><strong>Scheduled AI replies</strong><p>Master switch for Actions. Each business must also opt in to auto-reply.</p></div>${switchHTML(isTrue(setting('automation_enabled', 'TRUE')), 'toggle-automation', 'master', 'Enable scheduled AI replies', true)}</div><div class="automation-setting"><div><strong>4–5 star reviews only</strong><p>Lower-star reviews are always left for a personal response. This safety rule cannot be disabled.</p></div><span class="badge badge-green">${i('shield-check', 'icon-sm')} Always on</span></div><div class="automation-setting"><div><strong>Respect existing Google replies</strong><p>Actions checks Google immediately before posting. Already-replied reviews are synced, not overwritten.</p></div><span class="badge badge-green">${i('shield-check', 'icon-sm')} Always on</span></div><form id="automation-form" class="mt-6"><div class="form-grid">${fieldHTML('reply-delay', 'Seconds between replies', { value: setting('reply_delay_seconds', '2'), type: 'number', hint: '2–30 seconds. Helps protect provider and Google quotas.' })}${fieldHTML('max-replies', 'Maximum replies per Actions run', { value: setting('max_replies_per_run', '100'), type: 'number', hint: '1–1,000. Remaining reviews are picked up in later runs.' })}</div><div class="form-actions"><button class="btn btn-primary" type="submit">${i('save', 'icon-sm')} Save guardrails</button></div></form><div class="schedule-grid"><article class="schedule-card">${i('refresh-cw')}<h3>Review sync</h3><strong>Every 15 min</strong><p><code>*/15 * * * *</code> · UTC<br>All active tracked businesses</p><a class="text-link mt-4" href="https://github.com/Joshbond123/ReplyRaven/actions/workflows/sync.yml" target="_blank" rel="noopener noreferrer">Open workflow ${i('arrow-up-right')}</a></article><article class="schedule-card">${i('sparkles')}<h3>Auto-reply</h3><strong>Every 30 min</strong><p><code>*/30 * * * *</code> · UTC<br>Opted-in businesses · 4–5 stars</p><a class="text-link mt-4" href="https://github.com/Joshbond123/ReplyRaven/actions/workflows/reply.yml" target="_blank" rel="noopener noreferrer">Open workflow ${i('arrow-up-right')}</a></article></div><div class="notice mt-6">${i('workflow')}<span>Schedules run from your repository’s default branch and are best-effort, not exact timers. Set up GitHub Secrets first. Changing the cadence requires editing the workflow files; these settings do not rewrite YAML.</span></div><div class="form-actions"><a class="btn btn-soft" href="#secrets">${i('github', 'icon-sm')} Set up GitHub Secrets</a></div>`;
}
function bindAutomationSettings() {
  $('#reply-delay').min = '2';
  $('#reply-delay').max = '30';
  $('#reply-delay').required = true;
  $('#max-replies').min = '1';
  $('#max-replies').max = '1000';
  $('#max-replies').required = true;
  $('#automation-form').onsubmit = (event) => {
    event.preventDefault();
    busy($('button[type="submit"]', event.currentTarget), async () => {
      const delay = Number($('#reply-delay').value),
        max = Number($('#max-replies').value);
      if (
        !Number.isInteger(delay) ||
        delay < 2 ||
        delay > 30 ||
        !Number.isInteger(max) ||
        max < 1 ||
        max > 1000
      )
        throw new Error('Use 2–30 seconds and 1–1,000 replies per run.');
      await store.saveSettings({ reply_delay_seconds: String(delay), max_replies_per_run: String(max) });
      state.settings = {
        ...state.settings,
        reply_delay_seconds: String(delay),
        max_replies_per_run: String(max),
      };
      toast(state.demo ? 'Demo guardrails saved.' : 'Automation guardrails saved to Sheets.');
    });
  };
}
function activeKeysJSON() {
  return JSON.stringify(
    state.keys
      .filter((key) => isTrue(key.is_active))
      .map(({ id, provider, api_key, model_name, is_active }) => ({
        id,
        provider,
        api_key,
        model_name,
        is_active,
      })),
    null,
    2,
  );
}
function secretsSettingsHTML() {
  const names = [
    ['GOOGLE_SHEET_ID', 'sheet_id'],
    ['GOOGLE_CLIENT_ID', 'client_id'],
    ['GOOGLE_CLIENT_SECRET', 'client_secret'],
    ['GOOGLE_REFRESH_TOKEN', 'refresh_token'],
  ];
  return `<h2>Keep the care going. Even when your tab is closed.</h2><p class="panel-subtitle">Add these repository secrets in GitHub → Settings → Secrets and variables → Actions. GitHub encrypts them; workflows receive them only at runtime.</p><div class="notice">${i('lock-keyhole')}<span><strong>No secrets in your code.</strong> Browser storage is not available to Actions. If you kept your client secret and refresh token offline, paste them directly from your local token helper into GitHub—not into this browser.</span></div><div class="secret-list">${names.map(([name, key]) => `<div class="secret-item"><strong>${name}</strong><div class="code-row"><input type="${['client_secret', 'refresh_token'].includes(key) ? 'password' : 'text'}" value="${e(config[key] || '')}" readonly aria-label="${name}" placeholder="${key === 'client_secret' || key === 'refresh_token' ? 'Use the value from your local .env / token helper' : 'Save this value in Google settings first'}"><button type="button" class="icon-btn" data-secret-copy="${key}" aria-label="Copy ${name}">${i('copy')}</button></div></div>`).join('')}</div><strong class="section-label">AI_KEYS_JSON</strong><p class="tiny muted mb-4">An export of your ${state.keys.filter((key) => isTrue(key.is_active)).length} active keys, including their stable IDs. Update this secret whenever your key list changes.</p><div class="field"><label for="ai-keys-json" class="sr-only">Active AI keys JSON</label><textarea id="ai-keys-json" class="json-area" readonly placeholder="API keys are hidden. Generate or copy the JSON when you’re ready."></textarea></div><div class="form-actions"><button id="show-keys-json" class="btn">${i('eye', 'icon-sm')} Generate & reveal JSON</button><button id="copy-keys-json" class="btn btn-soft">${i('copy', 'icon-sm')} Copy AI_KEYS_JSON</button></div><hr class="divider"><div class="notice warning">${i('circle-alert')}<span>Enable Actions on the default branch, add all five secrets, then run <strong>Sync</strong> and <strong>Auto-Reply</strong> manually to verify the setup. GitHub can disable schedules in inactive repositories; review workflow logs regularly.</span></div><div class="form-actions"><a class="btn btn-primary" href="https://github.com/Joshbond123/ReplyRaven/settings/secrets/actions" target="_blank" rel="noopener noreferrer">${i('github', 'icon-sm')} Open repository secrets ${i('arrow-up-right', 'icon-sm')}</a><a class="btn" href="https://github.com/Joshbond123/ReplyRaven/actions" target="_blank" rel="noopener noreferrer">View Actions</a></div>`;
}
function bindSecretsSettings() {
  $('#show-keys-json').onclick = () => {
    if (!state.keys.length) {
      toast('Add an AI key first.', 'info');
      return;
    }
    const area = $('#ai-keys-json');
    if (area.value) {
      area.value = '';
      $('#show-keys-json').innerHTML = `${i('eye', 'icon-sm')} Generate & reveal JSON`;
    } else {
      area.value = activeKeysJSON();
      $('#show-keys-json').innerHTML = `${i('eye-off', 'icon-sm')} Hide JSON`;
    }
    icons();
  };
  $('#copy-keys-json').onclick = () => {
    if (
      !state.keys.some(
        (key) =>
          isTrue(key.is_active) &&
          (state.demo || key.api_key || (config.apps_script_url && config.apps_script_token)),
      )
    ) {
      toast('No active keys to export.', 'info');
      return;
    }
    copyText(activeKeysJSON());
    if (state.demo) toast('Demo keys are examples, not real credentials.', 'info');
  };
  $$('[data-secret-copy]').forEach(
    (button) =>
      (button.onclick = () => {
        const value = config[button.dataset.secretCopy];
        if (!value) {
          toast('This value is not stored here. Copy it from your local setup.', 'info');
          return;
        }
        copyText(value, button);
      }),
  );
}
function accountSettingsHTML() {
  const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  return `<h2>Your voice. Your workspace.</h2><p class="panel-subtitle">Set a default reply style, personalize your view, and keep your local workspace gate up to date.</p><div class="account-avatar"><span class="avatar">${state.demo ? 'DW' : 'YW'}</span><div><h3>${state.demo ? 'Demo workspace' : 'Your workspace'}</h3><p>Self-hosted · Unlimited businesses · Your data stays yours</p></div><span class="badge badge-purple" style="margin-left:auto">Personal</span></div><form id="account-form"><div class="form-grid"><div class="field full"><label for="default-prompt">Default AI prompt template</label><textarea id="default-prompt" rows="5">${e(setting('default_ai_prompt', DEFAULT_PROMPT))}</textarea><small>Make it sound like your business. Variables: <code>{stars}</code>, <code>{comment}</code>, <code>{business_name}</code>. A per-business prompt takes priority.</small></div>${fieldHTML('whatsapp-number', 'WhatsApp alert recipient', { value: setting('whatsapp_number'), full: true, optional: true, placeholder: 'Country code + number, e.g. 15125550100', hint: 'Used by the share link on each review. Links open WhatsApp; messages are not sent automatically.' })}<div class="field full"><label>Appearance</label><div class="theme-options"><button type="button" class="theme-option ${theme === 'light' ? 'active' : ''}" data-theme-choice="light">${i('sun', 'icon-sm')} Light</button><button type="button" class="theme-option ${theme === 'dark' ? 'active' : ''}" data-theme-choice="dark">${i('moon', 'icon-sm')} Dark</button></div></div></div><hr class="divider"><h3 style="font-size:12px;margin-bottom:19px">Change your workspace password</h3><div class="form-grid">${fieldHTML('new-password', 'New password', { secret: true, placeholder: 'At least 8 characters', autocomplete: 'new-password', optional: true })}${fieldHTML('confirm-password', 'Confirm new password', { secret: true, placeholder: 'One more time', autocomplete: 'new-password' })}</div><p class="tiny muted mt-4">The initial password is <code>ReplyRaven123</code>. A change applies only to this browser. There is no server-side password or account recovery.</p><div class="form-actions"><button type="submit" class="btn btn-primary">${i('save', 'icon-sm')} Save preferences</button><button type="button" class="btn" data-action="logout">${i('log-out', 'icon-sm')} Log out</button></div></form><div class="notice warning mt-6">${i('shield-alert')}<span>This localStorage gate is not security for a public SaaS. Google OAuth and private Sheet permissions protect your data. For a multi-user product, add a real identity-aware backend rather than relying on a browser password.</span></div>`;
}
function bindAccountSettings() {
  $('#account-form').onsubmit = (event) => {
    event.preventDefault();
    busy($('button[type="submit"]', event.currentTarget), async () => {
      const password = $('#new-password').value,
        confirm = $('#confirm-password').value,
        prompt = $('#default-prompt').value.trim(),
        phone = $('#whatsapp-number').value.replace(/[^0-9]/g, '');
      if (password && (password.length < 8 || password !== confirm))
        throw new Error('Use at least 8 characters and make sure both passwords match.');
      if (!password && confirm) throw new Error('Enter the new password in both fields.');
      if (!prompt) throw new Error('Your default prompt cannot be empty.');
      const values = { default_ai_prompt: prompt, whatsapp_number: phone };
      if (configured()) await store.saveSettings(values);
      else Object.entries(values).forEach(([key, value]) => localStorage.setItem(key, value));
      state.settings = { ...state.settings, ...values };
      if (password) localStorage.setItem('dashboard_password', password);
      renderSettings();
      toast(
        `${state.demo ? 'Demo preferences' : 'Preferences'} saved.${password ? ' Your local password has been changed.' : ''}`,
      );
    });
  };
}
function businessPromptModal(id) {
  const business = businessById(id);
  if (!business) return;
  openModal({
    title: 'A voice that feels like your business.',
    subtitle: business.business_name,
    body: `<div class="field"><label for="business-prompt">Business-specific prompt</label><textarea id="business-prompt" rows="6" placeholder="Leave blank to use your workspace default.">${e(business.ai_prompt_template)}</textarea><small>Variables: <code>{stars}</code>, <code>{comment}</code>, <code>{business_name}</code>. This overrides the default prompt for this business.</small></div>`,
    footer:
      '<button class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" id="save-business-prompt">Save voice</button>',
    onReady: () => {
      $('#save-business-prompt').onclick = () =>
        busy($('#save-business-prompt'), async () => {
          const current = (await store.read('Businesses')).find(
            (b) => resourceId(b.google_location_id) === resourceId(id),
          );
          if (!current) throw new Error('Business no longer exists.');
          await store.update('Businesses', {
            ...current,
            ai_prompt_template: $('#business-prompt').value.trim(),
          });
          await loadWorkspace();
          closeModal();
          renderPage();
          toast('Business reply voice saved.');
        });
    },
  });
}
function helpModal() {
  openModal({
    title: 'A good place to start.',
    subtitle: 'Your checklist for a connected ReplyRaven workspace.',
    body: `<div class="setup-steps" style="margin-top:0">${[
      [
        '1',
        'Create a Google Cloud project',
        'Enable Account Management, Business Information, Google My Business v4, and Sheets. Google must approve your Business Profile API access.',
      ],
      [
        '2',
        'Connect your manager account',
        'Create a web OAuth client, add your Pages origin and callback URI, and request business.manage + spreadsheets scopes.',
      ],
      [
        '3',
        'Give your data a home',
        'Create a private spreadsheet, enter its ID, then use Prepare sheet to create the five tabs and exact headers.',
      ],
      [
        '4',
        'Set your replies in motion',
        'Add AI keys, save the five GitHub Secrets, then run Sync and Auto-Reply manually from Actions.',
      ],
    ]
      .map(
        ([n, title, copy]) =>
          `<div class="setup-step"><span class="step-check">${n}</span><span><strong>${title}</strong><p>${copy}</p></span></div>`,
      )
      .join(
        '',
      )}</div><div class="notice warning mt-6">${i('shield-check')}<span>The default local password is <code>${DEFAULT_PASSWORD}</code>. It is a convenience gate, not server authentication. Never publish your Sheet or secrets.</span></div>`,
    footer:
      '<a class="btn" href="https://github.com/Joshbond123/ReplyRaven#readme" target="_blank" rel="noopener noreferrer">Full setup guide ↗</a><a class="btn btn-primary" href="settings.html#google">Open settings →</a>',
  });
}
function workspaceModal() {
  openModal({
    title: state.demo ? 'Your demo workspace' : 'Your personal workspace',
    body: `<div class="account-avatar" style="margin:0;border:0;padding:0"><span class="avatar">${state.demo ? 'DW' : 'YW'}</span><div><h3>${state.demo ? 'Sample businesses, real possibilities.' : 'Unlimited locations. Entirely yours.'}</h3><p>${state.businesses.length} businesses · ${state.demo ? 'sample data on this device' : 'Google Sheets is your database'}</p></div></div><p class="confirm-copy mt-6">${state.demo ? 'Explore the full workflow without connecting any accounts. Nothing in the demo calls Google or an AI provider. Ready to manage your own businesses? Set up a real workspace.' : 'This is a single-user, self-hosted workspace. Google OAuth controls which businesses and private sheets you can access.'}</p>`,
    footer: state.demo
      ? '<button id="reset-demo" class="btn">Reset demo</button><a class="btn btn-primary" href="settings.html#google" data-action="exit-demo">Set up my workspace →</a>'
      : '<button class="btn" data-action="close-modal">Close</button><a class="btn btn-primary" href="settings.html#google">Manage connections →</a>',
    onReady: () => {
      if ($('#reset-demo'))
        $('#reset-demo').onclick = () =>
          busy($('#reset-demo'), async () => {
            localStorage.removeItem('rr_demo_data');
            localStorage.removeItem('ai_index');
            configureClients();
            await loadWorkspace();
            closeModal();
            renderPage();
            toast('Demo reset. A fresh start awaits.');
          });
    },
  });
}
async function callbackPage() {
  const params = new URLSearchParams(location.search),
    code = params.get('code'),
    error = params.get('error');
  const expected = sessionStorage.getItem('rr_oauth_state'),
    received = params.get('state'),
    verified = Boolean(expected && received === expected);
  // Remove one-use authorization material from the URL/history before rendering.
  history.replaceState(null, '', location.pathname);
  if (error) {
    $('#callback-root').innerHTML =
      `${i('circle-alert', 'callback-status error')}<h1>Google authorization wasn't completed.</h1><p>${e(params.get('error_description') || error)}</p><a class="btn btn-primary mt-4" href="settings.html#google">Back to Google settings</a>`;
    enhance();
    return;
  }
  if (!code) {
    $('#callback-root').innerHTML =
      `${i('link-2', 'callback-status')}<h1>Your Google connection starts in Settings.</h1><p>This page receives an authorization code after you grant offline access. Build an OAuth URL in Google settings first.</p><div class="notice mt-6">${i('info')}<span>Register <code>${e(redirectURI())}</code> as your authorized redirect URI.</span></div><a class="btn btn-primary mt-6" href="settings.html#google">Open Google settings →</a>`;
    enhance();
    return;
  }
  $('#callback-root').innerHTML =
    `${i(verified ? 'circle-check' : 'shield-alert', 'callback-status')}<h1>${verified ? 'One step closer.' : 'Check your authorization source.'}</h1><p>${verified ? 'Google returned your authorization code. Exchange it locally to get the offline refresh token used by GitHub Actions.' : 'This tab could not verify the OAuth state. This can happen with a URL generated locally or opened in another tab. Do not exchange a code unless you initiated this authorization yourself.'}</p>${!verified ? `<div class="notice warning mt-4">${i('triangle-alert')}<span>Browser token exchange is disabled for unverified callbacks. Never paste a code supplied by someone else.</span></div>` : ''}<div class="field mt-6"><label for="oauth-code">One-time authorization code</label><textarea id="oauth-code" readonly rows="2">${e(code)}</textarea></div><button class="btn btn-soft btn-sm mt-4" data-copy-target="oauth-code">${i('copy', 'icon-sm')} Copy code</button><hr class="divider"><h3 style="font-size:13px">Recommended: exchange on your own machine</h3><ol><li>Run <code>npm ci</code> in your local checkout.</li><li>Copy <code>.env.example</code> to <code>.env</code> and set your client ID, client secret, and the exact redirect URI.</li><li>Run the command below, then paste the code when prompted.</li><li>Copy the refresh token into the <code>GOOGLE_REFRESH_TOKEN</code> GitHub Secret.</li></ol><div class="code-row"><code id="token-command">node --env-file=.env scripts/get-token.js</code><button class="icon-btn" data-copy-target="token-command" aria-label="Copy token command">${i('copy')}</button></div><p class="tiny muted">Google returns an access token for this session and an offline refresh token for Actions. If no refresh token appears, authorize again with consent.</p>${verified && config.client_secret ? `<details class="mt-6"><summary class="small brand-text" style="cursor:pointer">Advanced: exchange in this trusted browser</summary><div class="notice warning mt-4">${i('triangle-alert')}<span>This uses the client secret stored on this device. Tokens will be visible in browser tools and local storage. Google or browser CORS policies may block it; the local helper is the reliable path.</span></div><button id="browser-exchange" class="btn btn-primary mt-4">Exchange code in browser</button></details>` : ''}<div id="exchanged-tokens"></div><div class="form-actions"><a class="btn btn-primary" href="settings.html#secrets">Continue to GitHub secrets →</a></div>`;
  if ($('#browser-exchange'))
    $('#browser-exchange').onclick = () =>
      busy($('#browser-exchange'), async () => {
        if (!verified) throw new Error('OAuth state could not be verified. Use the local helper.');
        const body = new URLSearchParams({
          code,
          client_id: config.client_id,
          client_secret: config.client_secret,
          redirect_uri: sessionStorage.getItem('rr_oauth_redirect') || redirectURI(),
          grant_type: 'authorization_code',
        });
        const tokens = await requestJSON('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
        saveLocal({
          access_token: tokens.access_token,
          ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
        });
        localStorage.setItem(
          'access_token_expiry',
          String(Date.now() + Math.max(0, Number(tokens.expires_in || 3600) - 60) * 1000),
        );
        sessionStorage.removeItem('rr_oauth_state');
        $('#exchanged-tokens').innerHTML =
          `<div class="notice mt-6">${i('circle-check')}<span>Tokens saved on this device. Copy the refresh token to GitHub Secrets; do not commit it.</span></div><div class="field mt-4"><label for="callback-access">Access token</label><textarea id="callback-access" readonly rows="2">${e(tokens.access_token)}</textarea></div><button class="btn btn-sm mt-4" data-copy-target="callback-access">Copy access token</button>${tokens.refresh_token ? `<div class="field mt-4"><label for="callback-refresh">Refresh token</label><textarea id="callback-refresh" readonly rows="2">${e(tokens.refresh_token)}</textarea></div><button class="btn btn-sm mt-4" data-copy-target="callback-refresh">Copy refresh token</button>` : '<p class="text-red mt-4">Google did not return a refresh token. Reauthorize with consent using the local helper.</p>'}`;
        $('#browser-exchange').hidden = true;
        enhance();
        toast('Google authorization exchanged. Keep your tokens private.');
      });
  enhance();
}
function renderPage() {
  if (page === 'dashboard') renderDashboard();
  if (page === 'business') renderReviewPage();
  if (page === 'settings') renderSettings();
}
function renderLoadError(error) {
  state.connected = false;
  renderBanner();
  if (page === 'settings') {
    renderSettings();
    toast(`Sheet connection needs attention: ${error.message}`, 'error');
    return;
  }
  $('#page-root').innerHTML =
    `<div class="page-heading"><div><h1>${page === 'dashboard' ? 'Overview' : 'Review inbox'}</h1><p>Let’s give your workspace a good foundation.</p></div></div><div class="error-panel">${i('circle-alert')}<div><strong>We couldn’t read your Google Sheet.</strong><p>${e(redact(error.message))}</p></div><a class="btn" href="settings.html#google">Check connection →</a></div><div class="mt-6">${empty('A little setup. A lot of possibilities.', 'Your real business data will appear here once Google and your private sheet are connected.', '<button class="btn btn-soft" data-action="demo">Explore sample workspace</button>')}</div>`;
  $('#page-root').setAttribute('aria-busy', 'false');
  enhance();
}
document.addEventListener('click', async (event) => {
  const reveal = event.target.closest('[data-reveal]');
  if (reveal) {
    event.preventDefault();
    const input = document.getElementById(reveal.dataset.reveal);
    if (input) {
      input.type = input.type === 'password' ? 'text' : 'password';
      reveal.innerHTML = i(input.type === 'password' ? 'eye' : 'eye-off');
      reveal.setAttribute('aria-label', input.type === 'password' ? 'Show value' : 'Hide value');
      icons(reveal);
    }
    return;
  }
  const copy = event.target.closest('[data-copy-target]');
  if (copy) {
    event.preventDefault();
    const target = document.getElementById(copy.dataset.copyTarget);
    if (target) await copyText('value' in target ? target.value : target.textContent, copy);
    return;
  }
  const theme = event.target.closest('[data-theme-choice]');
  if (theme) {
    setTheme(theme.dataset.themeChoice);
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) {
    $$('.dropdown-menu').forEach((menu) => (menu.hidden = true));
    if (!event.target.closest('.global-search')) $('#search-results') && ($('#search-results').hidden = true);
    return;
  }
  const action = button.dataset.action,
    id = button.dataset.id,
    key = button.dataset.key;
  try {
    if (action === 'theme') setTheme();
    if (action === 'demo') {
      event.preventDefault();
      login(true);
    }
    if (action === 'logout') logout();
    if (action === 'exit-demo') {
      event.preventDefault();
      localStorage.setItem('rr_demo', 'false');
      localStorage.removeItem('ai_index');
      location.href = 'settings.html#google';
    }
    if (action === 'close-modal') closeModal();
    if (action === 'help') helpModal();
    if (action === 'workspace') workspaceModal();
    if (action === 'logs') renderLogs();
    if (action === 'notifications') location.href = 'business.html?filter=negative';
    if (action === 'scan') await busy(button, scanManagedBusinesses);
    if (action === 'export-businesses') exportBusinesses();
    if (action === 'business-menu') {
      const menu = button.closest('.business-card').querySelector('.dropdown-menu'),
        open = menu.hidden;
      $$('.dropdown-menu').forEach((m) => (m.hidden = true));
      menu.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
    }
    if (action === 'business-prompt') businessPromptModal(id);
    if (action === 'toggle-auto') await toggleBusiness(id, button);
    if (action === 'delete-business') deleteBusiness(id);
    if (action === 'sync-business')
      await busy(button, async () => {
        const business = businessById(id);
        await syncReviewsForBusiness(business);
        await loadWorkspace();
        renderPage();
        toast(`${business.business_name} ${state.demo ? 'sample reviews' : 'reviews'} synced.`);
      });
    if (action === 'reset-business-filters') {
      state.filter = 'all';
      state.query = '';
      $('#global-search').value = '';
      renderBusinesses();
    }
    if (action === 'reset-review-filters') {
      state.reviewFilter = 'all';
      state.reviewQuery = '';
      state.reviewPage = 1;
      $('#review-search').value = '';
      renderReviewList();
    }
    if (action === 'generate-reply') replyModal(key, true);
    if (action === 'write-reply') replyModal(key, false);
    if (action === 'delete-reply') deleteReviewReply(key);
    if (action === 'sync-reviews') await busy(button, syncPageReviews);
    if (action === 'bulk-reply') bulkReply();
    if (action === 'toggle-key') await toggleKey(id, button);
    if (action === 'delete-key') deleteKey(id);
    if (action === 'toggle-automation') {
      button.disabled = true;
      try {
        const value = bool(!isTrue(setting('automation_enabled', 'TRUE')));
        await store.saveSettings({ automation_enabled: value });
        state.settings.automation_enabled = value;
        renderSettings();
        toast(
          `Scheduled auto-replies ${isTrue(value) ? 'enabled' : 'paused'}${state.demo ? ' in the demo' : ''}.`,
        );
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    }
    if (action === 'mobile-menu') {
      const sidebar = $('.sidebar');
      const open = !sidebar.classList.contains('open');
      sidebar.classList.toggle('open', open);
      sidebar.inert = !open && innerWidth <= 800;
      button.setAttribute('aria-expanded', String(open));
      $('#mobile-nav-overlay')?.remove();
      if (open) {
        const overlay = document.createElement('div');
        overlay.className = 'mobile-overlay';
        overlay.id = 'mobile-nav-overlay';
        overlay.onclick = () => {
          sidebar.classList.remove('open');
          sidebar.inert = innerWidth <= 800;
          overlay.remove();
          button.setAttribute('aria-expanded', 'false');
        };
        document.body.append(overlay);
      }
    }
  } catch (error) {
    handleError(error);
  }
});
document.addEventListener('keydown', (event) => {
  if (
    event.key === '/' &&
    !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) &&
    $('#global-search')
  ) {
    event.preventDefault();
    $('#global-search').focus();
  }
  if (event.key === 'Escape') {
    const sidebar = $('.sidebar');
    sidebar?.classList.remove('open');
    if (sidebar) sidebar.inert = innerWidth <= 800;
    $('#mobile-nav-overlay')?.remove();
    $('#search-results') && ($('#search-results').hidden = true);
  }
});
window.addEventListener('resize', () => {
  const sidebar = $('.sidebar');
  if (sidebar) sidebar.inert = innerWidth <= 800 && !sidebar.classList.contains('open');
  if (innerWidth > 800) $('#mobile-nav-overlay')?.remove();
});
window.addEventListener('hashchange', () => {
  if (page === 'settings') {
    state.settingsTab = location.hash.slice(1) || 'google';
    renderSettings();
    renderShell();
  }
  if (page === 'dashboard') renderShell();
});
window.addEventListener('storage', (event) => {
  if (
    ['auth', 'auth_expiry'].includes(event.key) &&
    ['dashboard', 'business', 'settings'].includes(page) &&
    !validSession(localStorage)
  )
    location.replace('login.html');
});
async function init() {
  icons();
  setTheme(localStorage.getItem('rr_theme') || 'light');
  $$('[data-year]').forEach((node) => (node.textContent = new Date().getFullYear()));
  if (page === 'landing') {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('reveal');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 },
    );
    $$('.feature-card,.how-step,.testimonial').forEach((element) => observer.observe(element));
    const counters = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const target = Number(entry.target.dataset.counter);
          if (!target) {
            counters.unobserve(entry.target);
            continue;
          }
          const start = performance.now();
          const tick = (time) => {
            const progress = Math.min((time - start) / 1000, 1);
            entry.target.textContent = Math.round(target * (1 - (1 - progress) ** 3));
            if (progress < 1) requestAnimationFrame(tick);
          };
          if (matchMedia('(prefers-reduced-motion: reduce)').matches) entry.target.textContent = target;
          else requestAnimationFrame(tick);
          counters.unobserve(entry.target);
        }
      },
      { threshold: 0.6 },
    );
    $$('[data-counter]').forEach((node) => counters.observe(node));
    return;
  }
  if (page === 'login') {
    if (validSession(localStorage)) return;
    if (new URLSearchParams(location.search).get('demo') === 'true') {
      login(true);
      return;
    }
    $('#forgot-password').onclick = () => {
      $('#password-hint').hidden = !$('#password-hint').hidden;
      $('#forgot-password').setAttribute('aria-expanded', String(!$('#password-hint').hidden));
    };
    $('#login-form').onsubmit = (event) => {
      event.preventDefault();
      try {
        if ($('#login-password').value === (localStorage.getItem('dashboard_password') || DEFAULT_PASSWORD)) {
          login(false);
        } else {
          $('#login-error').hidden = false;
          $('#login-error').textContent =
            'That password doesn’t look right. Try again, or view the default password hint.';
          $('#login-password').setAttribute('aria-invalid', 'true');
          $('#login-password').focus();
        }
      } catch {
        $('#login-error').hidden = false;
        $('#login-error').textContent = 'Please enable browser storage to use this personal workspace.';
      }
    };
    return;
  }
  if (page === 'callback') {
    await callbackPage();
    return;
  }
  if (!validSession(localStorage)) {
    location.replace('login.html');
    return;
  }
  setInterval(() => {
    if (!validSession(localStorage)) location.replace('login.html');
  }, 60000);
  renderShell();
  if (page === 'settings' && !state.demo && config.client_id) loadGIS().catch(() => {});
  try {
    await loadWorkspace();
    renderPage();
  } catch (error) {
    renderLoadError(error);
  }
}
// Convenience methods for this trusted browser’s console; Google still authorizes every call.
window.ReplyRaven = Object.freeze({ scanManagedBusinesses, syncReviewsForBusiness, getNextAIKey });
init().catch(handleError);
