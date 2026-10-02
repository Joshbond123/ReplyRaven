const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const icon = (name, classes = '') =>
  `<i data-lucide="${name}" class="icon ${classes}" aria-hidden="true"></i>`;
const page = document.body.dataset.page;
const base = String(window.REPLYRAVEN_CONFIG?.apiBase || '').replace(/\/$/, '');
const params = new URLSearchParams(location.search);
let state = {
  settings: null,
  stats: null,
  businesses: [],
  keys: [],
  business: null,
  reviews: [],
  unread: 0,
  tab: location.hash.slice(1) || 'google',
  businessPage: 1,
  reviewPage: 1,
  businessQuery: params.get('q') || '',
  businessFilter: 'all',
  reviewQuery: '',
  reviewFilter: params.get('filter') || 'all',
  businessId: params.get('id') || '',
  activity: [],
  notificationList: [],
  deliveries: [],
};
let closeCleanup = null,
  returnFocus = null,
  pollTimer = null,
  discovered = [],
  selectedLocations = [],
  modelTimer = null,
  modelController = null,
  modelSequence = 0;
const brand =
  '<a class="logo" href="dashboard.html" aria-label="ReplyRaven overview"><img src="assets/raven.svg" alt="" width="40" height="40"><span>Reply<span>Raven</span></span></a>';
const sessionToken = () => sessionStorage.getItem('rr_session') || '';
async function api(path, options = {}) {
  if (!base) throw new Error('The backend endpoint has not been configured.');
  const response = await fetch(`${base}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${sessionToken()}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    signal: options.signal || AbortSignal.timeout(90000),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('The backend returned an unreadable response.');
  }
  if (!response.ok) {
    if (result.code === 'unauthorized') {
      logout(false);
      throw new Error('Your session expired. Sign in again.');
    }
    const error = new Error(result.error || 'The operation could not be completed.');
    error.code = result.code;
    error.status = response.status;
    throw error;
  }
  return result;
}
function icons() {
  window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } });
}
function toast(message, kind = 'success') {
  const node = document.createElement('div');
  node.className = `toast toast-${kind}`;
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  node.innerHTML = `${icon(kind === 'error' ? 'circle-alert' : 'circle-check')}<span>${esc(message)}</span><button class="icon-btn" aria-label="Dismiss notification">${icon('x')}</button>`;
  $('#toast-stack')?.append(node);
  node.querySelector('button').onclick = () => node.remove();
  icons();
  setTimeout(() => node.remove(), 7000);
}
function theme(value) {
  document.documentElement.classList.toggle('dark', value === 'dark');
  try {
    localStorage.setItem('theme', value);
  } catch {}
  for (const button of $$('[data-action="theme"]')) {
    button.innerHTML = icon(value === 'dark' ? 'sun' : 'moon');
    button.setAttribute('aria-label', value === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  }
  icons();
}
function logout(redirect = true) {
  clearInterval(pollTimer);
  sessionStorage.removeItem('rr_session');
  sessionStorage.removeItem('rr_session_expiry');
  if (redirect) location.assign('login.html');
  else location.replace('login.html');
}
function relative(time) {
  if (!time) return 'Not yet';
  const difference = Date.now() - Number(time);
  if (difference < 60000) return 'Just now';
  if (difference < 3600000) return `${Math.floor(difference / 60000)}m ago`;
  if (difference < 86400000) return `${Math.floor(difference / 3600000)}h ago`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(Number(time)),
  );
}
function date(time) {
  return time
    ? new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(
        new Date(Number(time)),
      )
    : '—';
}
function money(amount, currency) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'NGN',
      maximumFractionDigits: 2,
    }).format(Number(amount) || 0);
  } catch {
    return `${currency} ${Number(amount).toLocaleString()}`;
  }
}
function stars(value) {
  const count = Math.max(0, Math.min(5, Number(value) || 0));
  return `<span class="stars" aria-label="${count} out of 5 stars">${Array.from({ length: 5 }, (_, index) => `<span style="opacity:${index < count ? 1 : 0.22}">${icon('star', 'icon-sm')}</span>`).join('')}</span>`;
}
function field(
  name,
  label,
  {
    type = 'text',
    value = '',
    placeholder = '',
    hint = '',
    required = false,
    options = null,
    full = false,
    readonly = false,
  } = {},
) {
  return `<div class="field ${full ? 'full' : ''}"><label for="${name}">${label}</label>${options ? `<select id="${name}" name="${name}" ${required ? 'required' : ''}>${options.map(([id, text]) => `<option value="${esc(id)}" ${String(value) === String(id) ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select>` : `<input id="${name}" name="${name}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${required ? 'required' : ''} ${readonly ? 'readonly' : ''} ${type === 'password' ? 'autocomplete="new-password"' : ''}>`}${hint ? `<p class="field-hint">${hint}</p>` : ''}</div>`;
}
function checkbox(name, label, checked = false, hint = '') {
  return `<div class="billing-option"><input type="checkbox" id="${name}" name="${name}" ${checked ? 'checked' : ''}><div><label for="${name}">${label}</label>${hint ? `<p class="tiny muted">${hint}</p>` : ''}</div></div>`;
}
function toggle(action, id, on, label) {
  return `<button type="button" class="switch" role="switch" aria-checked="${Boolean(on)}" aria-label="${esc(label)}" data-action="${action}" data-id="${esc(id)}"></button>`;
}
function formValues(form) {
  const result = Object.fromEntries(new FormData(form));
  for (const input of $$('input[type="checkbox"]', form)) result[input.name] = input.checked;
  return result;
}
function setBusy(button, busy) {
  if (!button) return;
  if (busy) {
    button.dataset.savedContent = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `${icon('loader-circle', 'spin')}<span>Working…</span>`;
  } else {
    button.disabled = false;
    if (button.dataset.savedContent) button.innerHTML = button.dataset.savedContent;
    delete button.dataset.savedContent;
  }
  icons();
}
function modal(title, content, footer = '', wide = false) {
  closeModal();
  returnFocus = document.activeElement;
  $('#modal-root').innerHTML =
    `<div class="modal-overlay"><section class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="dialog-heading" tabindex="-1"><header class="modal-header"><h2 id="dialog-heading">${esc(title)}</h2><button class="icon-btn" data-action="close-modal" aria-label="Close dialog">${icon('x')}</button></header><div class="modal-body">${content}</div>${footer ? `<footer class="modal-footer">${footer}</footer>` : ''}</section></div>`;
  document.body.style.overflow = 'hidden';
  icons();
  const trap = (event) => {
    if (event.key === 'Escape') closeModal();
    if (event.key === 'Tab') {
      const elements = $$(
        'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]',
        $('.modal'),
      ).filter((node) => !node.hidden && node.getClientRects().length);
      if (!elements.length) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && document.activeElement === elements[0]) {
        event.preventDefault();
        elements.at(-1).focus();
      } else if (!event.shiftKey && document.activeElement === elements.at(-1)) {
        event.preventDefault();
        elements[0].focus();
      }
    }
  };
  document.addEventListener('keydown', trap);
  closeCleanup = () => document.removeEventListener('keydown', trap);
  $('.modal-overlay').addEventListener('click', (event) => {
    if (event.target.classList.contains('modal-overlay')) closeModal();
  });
  setTimeout(() => $('.modal input, .modal button')?.focus(), 40);
}
function closeModal() {
  closeCleanup?.();
  closeCleanup = null;
  $('#modal-root').innerHTML = '';
  document.body.style.overflow = '';
  if (returnFocus?.isConnected) returnFocus.focus();
  returnFocus = null;
}
function empty(title, description, action = 'scan', label = 'Add your first business') {
  return `<div class="panel empty-state"><img src="assets/empty.svg" alt=""><h2>${esc(title)}</h2><p>${esc(description)}</p>${action ? `<button class="btn btn-primary" data-action="${action}">${icon('plus')} ${esc(label)}</button>` : ''}</div>`;
}
function heading(title, subtitle, actions = '') {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div><div class="page-heading-actions">${actions}</div></div>`;
}
function pager(current, total, type) {
  return `<div class="pager"><span>Page ${current} of ${total}</span><div class="flex gap-2"><button class="btn btn-sm" data-action="${type}-page" data-page="${current - 1}" ${current <= 1 ? 'disabled' : ''}>${icon('chevron-left', 'icon-sm')} Previous</button><button class="btn btn-sm" data-action="${type}-page" data-page="${current + 1}" ${current >= total ? 'disabled' : ''}>Next ${icon('chevron-right', 'icon-sm')}</button></div></div>`;
}
function paymentBadge(biz) {
  if (!biz.billing_enabled) return '<span class="badge">Billing guardrails off</span>';
  if (!biz.billing_allowed)
    return `<span class="badge badge-red">${biz.payment_status === 'cancelled' ? 'Cancelled' : 'Payment overdue'}</span>`;
  if (biz.payment_status === 'trial') {
    const days = Math.max(0, Math.ceil((biz.trial_ends_at - Date.now()) / 86400000));
    return `<span class="badge badge-amber">Trial ends in ${days} ${days === 1 ? 'day' : 'days'}</span>`;
  }
  return '<span class="badge badge-green">Active</span>';
}
function navItem(href, name, glyph, active, badge = '') {
  return `<a class="nav-item ${active ? 'active' : ''}" href="${href}" ${active ? 'aria-current="page"' : ''}>${icon(glyph)}<span>${name}</span>${badge !== '' ? `<span class="nav-count">${esc(badge)}</span>` : ''}</a>`;
}
function shell() {
  const name = state.settings?.account?.workspace_name || 'ReplyRaven';
  $('#sidebar-root').innerHTML =
    `<aside class="sidebar">${brand}<div class="workspace-select"><span class="avatar">${icon('building-2')}</span><div><strong>${esc(name)}</strong><small>Business workspace</small></div></div><div class="nav-label">WORKSPACE</div><nav class="sidebar-nav">${navItem('dashboard.html', 'Overview', 'layout-dashboard', page === 'dashboard')}${navItem('dashboard.html#businesses', 'Businesses', 'building-2', false, state.stats?.businesses ?? 0)}${navItem('business.html?all=1', 'Review inbox', 'messages-square', page === 'business' && !state.businessId, state.stats?.unreplied ?? 0)}${navItem('settings.html#automation', 'Automation', 'zap', page === 'settings' && state.tab === 'automation')}${navItem('settings.html#ai', 'AI keys', 'key-round', page === 'settings' && state.tab === 'ai')}${navItem('notifications.html', 'Notifications', 'bell', page === 'notifications', state.unread || '')}</nav><div class="sidebar-spacer"></div><div class="owner-note"><strong>Your voice. Your controls.</strong><p>Brand-aware replies with clear billing and connection guardrails.</p></div>${navItem('settings.html#google', 'Settings', 'settings-2', page === 'settings' && state.tab !== 'ai' && state.tab !== 'automation')}<footer class="sidebar-footer"><span class="avatar">${esc(name[0] || 'R')}</span><div><strong>${esc(name)}</strong><small>Owner workspace</small></div><button class="icon-btn" data-action="logout" aria-label="Sign out">${icon('log-out')}</button></footer></aside><button class="sidebar-backdrop" data-action="close-sidebar" aria-label="Close navigation" hidden></button>`;
  const title =
    {
      dashboard: 'Overview',
      business: state.business?.name || 'Review inbox',
      settings: 'Settings',
      notifications: 'Notifications',
    }[page] || 'Workspace';
  $('#topbar-root').innerHTML =
    `<header class="topbar"><div class="flex items-center gap-3"><button class="icon-btn mobile-menu" data-action="sidebar" aria-label="Open navigation">${icon('menu')}</button><div class="breadcrumb"><span>Workspace</span>${icon('chevron-right', 'icon-sm')}<strong>${esc(title)}</strong></div></div><div class="topbar-actions"><form id="global-search" class="global-search"><label class="sr-only" for="global-query">Search businesses</label>${icon('search', 'icon-sm')}<input id="global-query" placeholder="Search businesses…" value="${esc(state.businessQuery)}"><kbd>/</kbd></form><a class="icon-btn notification-btn" href="notifications.html" aria-label="Open notifications">${icon('bell')}${state.unread ? '<span class="notification-dot"></span>' : ''}</a><button class="icon-btn" data-action="theme" aria-label="Switch color theme">${icon(document.documentElement.classList.contains('dark') ? 'sun' : 'moon')}</button><button class="btn btn-primary scan-btn" data-action="scan">${icon('scan-line')}<span>Add business</span></button></div></header>`;
  $('.sidebar').inert = innerWidth <= 800;
  $('#connection-banner').innerHTML = !state.settings?.google?.connected
    ? `<div class="notice connection-banner">${icon('link-2')}<span><strong>Connect Google to get started.</strong> Your credentials are stored in your private backend.</span><a class="btn btn-sm" href="settings.html#google">Connect Google ${icon('arrow-right', 'icon-sm')}</a></div>`
    : state.settings.google.expired
      ? `<div class="notice warning connection-banner">${icon('alert-triangle')}<span>Your Google connection needs to be renewed.</span><button class="btn btn-sm" data-action="reconnect">Reconnect now</button></div>`
      : '';
  icons();
}
function sidebar(open) {
  $('.sidebar')?.classList.toggle('open', open);
  if ($('.sidebar')) $('.sidebar').inert = !open && innerWidth <= 800;
  const backdrop = $('.sidebar-backdrop');
  if (backdrop) backdrop.hidden = !open;
}
function businessCard(biz) {
  const voice =
    {
      pending: 'Learning queued',
      learning: 'Learning brand voice',
      ready: 'Brand voice ready',
      failed: 'Learning needs attention',
    }[biz.voice_status] || 'Brand voice pending';
  return `<article class="panel business-card"><div class="business-card-top"><span class="business-symbol" style="background:var(--brand-soft);color:var(--brand)">${icon('building-2')}</span><div class="title-wrap"><h3 class="business-name" title="${esc(biz.name)}">${esc(biz.name)}</h3>${paymentBadge(biz)}</div><button class="icon-btn text-red" data-action="remove-business" data-id="${esc(biz.id)}" aria-label="Remove ${esc(biz.name)}">${icon('trash-2', 'icon-sm')}</button></div><p class="address">${icon('map-pin', 'icon-sm')}<span>${esc(biz.address || 'Google Business Profile')}</span></p><div class="business-rating"><strong>${biz.average_rating ? Number(biz.average_rating).toFixed(1) : '—'}</strong>${stars(Math.round(biz.average_rating))}<span>${Number(biz.review_count).toLocaleString()} reviews</span><span class="badge ${biz.unreplied ? 'badge-red' : ''}">${biz.unreplied || 0} unreplied</span></div><div class="auto-toggle-row"><span>${icon('sparkles', 'icon-sm')} Auto-reply · 4–5 stars</span>${toggle('toggle-business', biz.id, biz.auto_reply, `Enable auto-reply for ${biz.name}`)}</div><div class="voice-preview"><div class="between"><span class="mini-metric">${icon(biz.voice_status === 'ready' ? 'fingerprint' : 'loader-circle', biz.voice_status === 'learning' ? 'spin' : 'icon-sm')} ${esc(voice)}</span><button class="plain-link tiny" data-action="view-voice" data-id="${esc(biz.id)}">View what AI learned</button></div>${biz.voice_error ? `<p class="tiny event-error mt-4">${esc(biz.voice_error)}</p>` : ''}</div><footer class="business-card-footer"><span class="last-sync">${icon('clock-3', 'icon-sm')} ${biz.sync_run ? 'Syncing…' : relative(biz.last_sync)}</span><div class="flex gap-2"><button class="icon-btn" data-action="sync-business" data-id="${esc(biz.id)}" aria-label="Sync ${esc(biz.name)}">${icon('refresh-cw', 'icon-sm')}</button><a class="btn btn-sm" href="business.html?id=${encodeURIComponent(biz.id)}">View reviews ${icon('arrow-up-right', 'icon-sm')}</a></div></footer></article>`;
}
async function loadBusinessList() {
  const result = await api(
    `/businesses?page=${state.businessPage}&q=${encodeURIComponent(state.businessQuery)}&filter=${state.businessFilter}`,
  );
  state.businesses = result.businesses;
  const root = $('#business-list');
  if (root)
    root.innerHTML = state.businesses.length
      ? `<div class="business-grid">${state.businesses.map(businessCard).join('')}</div>${pager(result.page, result.pages, 'business')}`
      : empty(
          state.businessQuery || state.businessFilter !== 'all'
            ? 'No matching businesses'
            : 'Add your first business',
          state.businessQuery
            ? 'Try a different search.'
            : 'Connect your Google account, then add a business to learn its brand voice.',
        );
  icons();
}
function renderDashboard() {
  const stats = state.stats || {};
  $('#page-root').innerHTML =
    heading(
      'Overview',
      'Your reputation, thoughtfully managed.',
      `<span class="date-pill">${icon('calendar-days', 'icon-sm')} ${date(Date.now())}</span>`,
    ) +
    `<div class="stats-grid">${[
      ['Total businesses', stats.businesses, 'building-2', 'Your connected locations'],
      ['Total reviews', stats.reviews, 'messages-square', 'Across synchronized profiles'],
      ['Unreplied', stats.unreplied, 'message-square-more', 'A conversation waiting to happen'],
      ['Auto-replied today', stats.auto_today, 'sparkles', 'New 4–5 star reviews · UTC'],
    ]
      .map(
        ([label, value, glyph, note], index) =>
          `<article class="panel stat-card"><div class="stat-top"><span>${label}</span><span class="stat-icon ${index === 2 ? 'red' : index === 3 ? 'green' : ''}">${icon(glyph)}</span></div><strong class="stat-value ${index === 2 ? 'red' : index === 3 ? 'green' : ''}">${Number(value || 0).toLocaleString()}</strong><p class="stat-note">${note}</p></article>`,
      )
      .join(
        '',
      )}</div><section class="panel status-strip" style="padding:20px"><span class="stat-icon">${icon('zap')}</span><div style="flex:1"><strong>${state.settings.automation.enabled ? 'Your co-pilot is on.' : 'You’re in control. Automation is paused.'}</strong><p class="small muted">Checks every ${state.settings.automation.interval} minutes · ${state.settings.automation.delay_min}–${state.settings.automation.delay_max} minute reply delay · Business opt-in required.</p></div><a class="btn btn-soft btn-sm" href="settings.html#automation">Manage automation ${icon('arrow-up-right', 'icon-sm')}</a></section><section id="businesses"><div class="between mb-4"><h2>Your businesses</h2><button class="btn btn-primary btn-sm" data-action="scan">${icon('plus', 'icon-sm')} Add business</button></div><div class="filter-bar"><div class="tabs"><button class="tab ${state.businessFilter === 'all' ? 'active' : ''}" data-action="business-filter" data-filter="all">All businesses</button><button class="tab ${state.businessFilter === 'auto' ? 'active' : ''}" data-action="business-filter" data-filter="auto">Auto-reply on</button><button class="tab ${state.businessFilter === 'overdue' ? 'active' : ''}" data-action="business-filter" data-filter="overdue">Payment overdue</button></div><div class="search-wrapper">${icon('search', 'icon-sm')}<label class="sr-only" for="business-search">Search businesses</label><input id="business-search" class="search-input" placeholder="Find a business…" value="${esc(state.businessQuery)}"></div></div><div id="business-list"><div class="skeleton" style="height:200px"></div></div></section><section class="panel mt-6" style="padding:24px"><div class="between"><h2>Recent activity</h2><button class="plain-link tiny" data-action="view-logs">View activity ${icon('arrow-up-right', 'icon-sm')}</button></div><div class="activity-grid">${state.activity.length ? state.activity.map((event) => `<div class="activity-item"><span class="stat-icon ${event.level === 'error' ? 'red' : 'green'}">${icon(event.level === 'error' ? 'circle-alert' : 'check-check')}</span><div><strong>${esc(event.action.replace(/_/g, ' '))}</strong><p>${esc(event.message)}</p></div><time class="tiny muted">${relative(event.created_at)}</time></div>`).join('') : '<p class="muted-callout mt-4">Your business activity will appear here after your first connection and sync.</p>'}</div></section>`;
  icons();
}
function billingForm(biz = {}, adding = false) {
  return `<div class="form-grid">${field('name', 'Business name', { value: biz.name, required: true })}${field('google_location_id', 'Google Business ID', { value: biz.google_location_id, readonly: true })}${field(
    'payment_method',
    'Payment method',
    {
      value: biz.payment_method || 'transfer',
      options: [
        ['cash', 'Cash'],
        ['transfer', 'Transfer'],
        ['stripe', 'Stripe'],
        ['paypal', 'PayPal'],
      ],
    },
  )}${field('cycle', 'Subscription period', {
    value: biz.cycle || 'monthly',
    options: [
      ['monthly', 'Monthly'],
      ['yearly', 'Yearly'],
      ['custom', 'Custom'],
    ],
  })}${field('amount', 'Subscription amount', { value: biz.amount || '', placeholder: 'Enter amount' })}${field(
    'currency',
    'Currency',
    {
      value: biz.currency || 'NGN',
      options: [
        ['NGN', 'NGN · Nigerian naira'],
        ['USD', 'USD · US dollar'],
        ['GBP', 'GBP · British pound'],
        ['EUR', 'EUR · Euro'],
      ],
    },
  )}${field('custom_days', 'Custom period · days', { type: 'number', value: biz.custom_days || 30 })}${!adding ? field('next_due_at', 'Next due date', { type: 'date', value: biz.next_due_at ? new Date(biz.next_due_at).toISOString().slice(0, 10) : '' }) : ''}</div>${checkbox('trial_enabled', 'Enable a seven-day trial', biz.trial_enabled, 'The trial starts when this business is added. Automatic replies pause when it ends.')}${checkbox('subscription_enabled', 'Enable subscription billing', biz.subscription_enabled, 'Automatic replies pause if payment is overdue. Mark as Paid clears the billing pause.')}${checkbox('auto_reply', 'Enable automatic replies for this business', biz.auto_reply, 'Only new, unreplied 4–5 star reviews are eligible by default.')}<p class="muted-callout">Payment methods record how you received funds. This form does not charge a card or collect money automatically.</p>`;
}
function paymentInput(form) {
  const values = formValues(form);
  values.billing_enabled = values.trial_enabled || values.subscription_enabled;
  if (values.next_due_at) values.next_due_at = new Date(`${values.next_due_at}T23:59:59`).getTime();
  return values;
}
function businessHeader(biz) {
  return (
    heading(
      esc(biz.name),
      `${esc(biz.address || 'Google Business Profile')} · Google ID ${esc(biz.google_location_id)}`,
      `<button class="btn" data-action="sync-business" data-id="${biz.id}">${icon('refresh-cw')} Sync reviews</button><button class="btn btn-primary" data-action="view-voice" data-id="${biz.id}">${icon('fingerprint')} View what AI learned</button>`,
    ) +
    `<div class="status-strip">${paymentBadge(biz)}<span class="badge ${biz.auto_reply && biz.billing_allowed ? 'badge-green' : ''}">${biz.auto_reply && biz.billing_allowed ? 'Auto-reply enabled' : 'Automatic replies paused'}</span><span class="badge">${biz.voice_status === 'ready' ? 'Brand voice ready' : biz.voice_status === 'failed' ? 'Brand learning needs attention' : 'Learning brand voice'}</span><span class="tiny muted">Last sync: ${biz.sync_run ? 'In progress' : date(biz.last_sync)}</span></div><div class="cloud-tabs"><button class="${location.hash !== '#payments' ? 'active' : ''}" data-action="business-tab" data-tab="reviews">Reviews</button><button class="${location.hash === '#payments' ? 'active' : ''}" data-action="business-tab" data-tab="payments">Payments & settings</button></div>`
  );
}
function reviewCard(row) {
  const replied = row.reply !== null;
  return `<article class="panel review-card" style="padding:23px;margin-bottom:15px"><div class="between"><div class="flex items-center gap-3"><span class="avatar">${esc((row.reviewer || 'G')[0])}</span><div><h3>${esc(row.reviewer)}</h3><div class="flex items-center gap-2">${stars(row.rating)}<span class="tiny muted">${date(row.created_at)}</span></div></div></div><span class="badge ${replied ? 'badge-green' : row.rating <= 3 ? 'badge-red' : row.reply_state === 'scheduled' ? 'badge-purple' : ''}">${replied ? (row.reply_source === 'ai' ? 'AI replied' : 'Replied') : row.reply_state === 'scheduled' ? 'Reply scheduled' : row.reply_state === 'uncertain' ? 'Check Google before retrying' : row.reply_state === 'failed' ? 'Needs attention' : row.rating <= 3 ? 'Needs your care' : 'Unreplied'}</span></div><p class="reply-comment mt-4">${row.comment ? esc(row.comment) : '<span class="muted">The customer left a rating without a comment.</span>'}</p>${!state.businessId ? `<a class="tiny brand-text mt-4" href="business.html?id=${row.business_id}">${esc(row.business_name)}</a>` : ''}${replied ? `<div class="review-reply"><div class="between"><strong class="tiny">Your owner reply</strong><span class="tiny muted">${date(row.replied_at)}</span></div><p class="mt-4">${esc(row.reply)}</p></div>` : ''}<footer class="between mt-4"><span class="tiny muted">${row.historical ? 'Previous review' : 'Detected ' + relative(row.detected_at)}${row.eligible_at && !replied ? ` · Eligible after ${new Date(row.eligible_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</span><div class="flex gap-2"><button class="icon-btn" data-action="share-review" data-id="${row.id}" aria-label="Share review on WhatsApp">${icon('share-2', 'icon-sm')}</button>${row.reply_state === 'uncertain' ? `<button class="btn btn-sm" data-action="verify-reply" data-id="${row.id}">${icon('shield-check', 'icon-sm')} Verify Google result</button>` : replied ? `<button class="btn btn-sm text-red" data-action="delete-reply" data-id="${row.id}">${icon('trash-2', 'icon-sm')} Delete owner reply</button>` : `<button class="btn btn-sm" data-action="manual-reply" data-id="${row.id}">${icon('pencil-line', 'icon-sm')} Reply</button><button class="btn btn-primary btn-sm" data-action="draft-reply" data-id="${row.id}">${icon('sparkles', 'icon-sm')} Generate AI reply</button>`}</div></footer></article>`;
}
function reviewFilters() {
  return `<div class="filter-bar"><div class="tabs">${[
    ['all', 'All reviews'],
    ['unreplied', 'Unreplied'],
    ['low', '1–3 stars'],
    ['high', '4–5 stars'],
    ['auto', 'AI replied'],
  ]
    .map(
      ([filter, label]) =>
        `<button class="tab ${state.reviewFilter === filter ? 'active' : ''}" data-action="review-filter" data-filter="${filter}">${label}</button>`,
    )
    .join(
      '',
    )}</div><div class="search-wrapper">${icon('search', 'icon-sm')}<label class="sr-only" for="review-search">Search reviews</label><input id="review-search" class="search-input" value="${esc(state.reviewQuery)}" placeholder="Find a review…"></div></div>`;
}
async function loadReviewList() {
  const result = await api(
    `/reviews?page=${state.reviewPage}&filter=${state.reviewFilter}&q=${encodeURIComponent(state.reviewQuery)}${state.businessId ? `&business_id=${state.businessId}` : ''}`,
  );
  state.reviews = result.reviews;
  $('#review-list').innerHTML = state.reviews.length
    ? state.reviews.map(reviewCard).join('') + pager(result.page, result.pages, 'review')
    : empty(
        'No reviews here yet',
        state.businessId
          ? 'Sync this business to bring in its Google reviews.'
          : 'Your connected business reviews will appear here.',
        state.businessId ? 'sync-current' : null,
        'Sync reviews',
      );
  icons();
}
async function renderBusiness() {
  if (!state.businessId) {
    $('#page-root').innerHTML =
      heading('Review inbox', 'Every voice, across all your businesses.') +
      reviewFilters() +
      '<div id="review-list"></div>';
    await loadReviewList();
    shell();
    return;
  }
  const result = await api(`/businesses/${state.businessId}`);
  state.business = result.business;
  const biz = state.business;
  $('#page-root').innerHTML =
    businessHeader(biz) +
    (location.hash === '#payments'
      ? `<section class="panel settings-section" style="padding:26px"><div class="between"><div><h2>Payment & subscription</h2><p class="panel-subtitle">Your rules, applied to this business only.</p></div><button class="btn btn-primary" data-action="mark-paid" data-id="${biz.id}">${icon('badge-check')} Mark as Paid</button></div><div class="payment-summary"><div><span class="tiny muted">Current period</span><strong>${esc(biz.payment_status[0].toUpperCase() + biz.payment_status.slice(1))}</strong></div><div><span class="tiny muted">Subscription amount</span><strong>${money(biz.amount, biz.currency)}</strong></div><div><span class="tiny muted">${biz.payment_status === 'trial' ? 'Trial ends' : 'Next payment due'}</span><strong>${date(biz.payment_status === 'trial' ? biz.trial_ends_at : biz.next_due_at)}</strong></div></div><form id="business-settings-form">${billingForm(biz)}<div class="form-actions"><button class="btn btn-primary" type="submit">${icon('save')} Save business settings</button></div></form><div class="form-section"><h3>Payment history</h3><div class="table-wrap"><table><thead><tr><th>Received</th><th>Amount</th><th>Method</th><th>Next due</th></tr></thead><tbody>${result.payments.map((payment) => `<tr><td>${date(payment.paid_at)}</td><td>${money(payment.amount, payment.currency)}</td><td>${esc(payment.method)}</td><td>${date(payment.due_at)}</td></tr>`).join('') || '<tr><td colspan="4">No payments recorded.</td></tr>'}</tbody></table></div></div></section>`
      : `<section class="panel status-strip" style="padding:20px"><div style="flex:1"><strong>Previous reviews are optional.</strong><p class="small muted">Choose how many previous unreplied 4–5 star reviews to schedule. Already replied reviews are excluded.</p></div><button class="btn btn-soft btn-sm" data-action="backfill" data-id="${biz.id}">${icon('history')} Reply to previous reviews</button></section>${reviewFilters()}<div id="review-list"></div>`);
  if (location.hash !== '#payments') await loadReviewList();
  icons();
  shell();
}
function settingsTabs() {
  return `<nav class="cloud-tabs" aria-label="Settings sections">${[
    ['google', 'Google connection', 'link-2'],
    ['ai', 'AI keys', 'key-round'],
    ['automation', 'Automation', 'zap'],
    ['account', 'Account', 'user-round'],
  ]
    .map(
      ([tab, label, glyph]) =>
        `<a class="${state.tab === tab ? 'active' : ''}" href="settings.html#${tab}">${icon(glyph, 'icon-sm')} ${label}</a>`,
    )
    .join('')}<a href="notifications.html">${icon('bell', 'icon-sm')} Notifications</a></nav>`;
}
function googleSettings() {
  const google = state.settings.google;
  return `<section class="panel settings-tab-panel" style="padding:27px"><h2>Good conversations start with a connection.</h2><p class="panel-subtitle">Google credentials are kept in your encrypted Cloudflare backend, never browser storage.</p><div class="connection-status-card"><div class="between"><strong>${google.expired ? 'Reconnect Google' : google.connected ? 'Google is connected' : 'Not connected'}</strong><span class="badge ${google.connected && !google.expired ? 'badge-green' : 'badge-amber'}">${google.connected && !google.expired ? 'Connected' : 'Action needed'}</span></div><p class="small muted mt-4">${google.expires_at ? `Connection renewal expected by ${date(google.expires_at)}. ${Math.max(0, Math.ceil((google.expires_at - Date.now()) / 86400000))} days remaining.` : 'Save a refresh token to start the connection reminder schedule.'}</p></div><form id="google-settings-form"><div class="form-grid">${field('client_id', 'Google Client ID', { value: google.client_id, placeholder: 'Enter your Google Client ID', required: true, full: true })}${field('client_secret', 'Google Client Secret', { type: 'password', placeholder: google.client_secret_saved ? 'Saved securely — leave unchanged' : 'Enter your Google Client Secret', full: true })}${field('refresh_token', 'Refresh Token', { type: 'password', placeholder: google.refresh_token_saved ? 'Saved securely — paste a new token to renew' : 'Enter your Refresh Token', full: true })}</div><div class="form-actions"><button class="btn btn-primary" type="submit">${icon('save')} Save Google connection</button><button class="btn" type="button" data-action="reconnect">${icon('refresh-cw')} Reconnect now</button></div></form><div class="notice warning mt-6">${icon('clock-3')}<span>For a restricted Google OAuth app, offline tokens typically need renewal after seven days. ReplyRaven schedules a day-six reminder from the recorded connection date. Google can revoke access sooner.</span></div><div class="form-section"><h3>Reconnect through OAuth Playground</h3><p class="muted-callout mt-4">Open Playground, choose its settings gear, and enable “Use your own OAuth credentials.” Enter your client ID and secret there. Authorize <code>business.manage</code>, exchange the authorization code, then save the new refresh token above. No secret is included in the reconnect URL.</p></div></section>`;
}
function keyRows() {
  return (
    state.keys
      .map(
        (key) =>
          `<tr><td><span class="provider-badge ${esc(key.provider)}">${esc(key.provider)}</span></td><td><code>••••••••${esc(key.suffix)}</code><br><span class="tiny muted">${esc(key.model)}</span></td><td><span class="badge ${key.health === 'active' ? 'badge-green' : key.health === 'invalid' ? 'badge-red' : 'badge-amber'}"><span class="health-dot"></span>${key.health === 'active' ? 'Active' : key.health === 'invalid' ? 'Invalid' : 'Rate Limited'}</span>${key.error ? `<p class="tiny muted mt-4">${esc(key.error)}</p>` : ''}</td><td>${toggle('toggle-key', key.id, key.enabled, `Enable ${key.provider} key`)}</td><td>${Number(key.request_count).toLocaleString()}<br><span class="tiny muted">${relative(key.last_used)}</span></td><td><div class="provider-actions"><button class="icon-btn" data-action="key-health" data-id="${key.id}" aria-label="Recheck key health">${icon('refresh-cw', 'icon-sm')}</button><button class="icon-btn text-red" data-action="delete-key" data-id="${key.id}" aria-label="Delete key">${icon('trash-2', 'icon-sm')}</button></div></td></tr>`,
      )
      .join('') ||
    '<tr><td colspan="6" style="text-align:center;padding:25px">Add your first API key to power brand learning and replies.</td></tr>'
  );
}
function aiSettings() {
  return `<section class="panel settings-tab-panel" style="padding:27px"><h2>A little intelligence. Your brand’s personality.</h2><p class="panel-subtitle">Paste a key to fetch the models it can use. Requests rotate through active keys, with failover on rate limits.</p><form id="ai-key-form"><div class="form-grid">${field(
    'provider',
    'Provider',
    {
      value: 'openai',
      options: [
        ['openai', 'OpenAI'],
        ['anthropic', 'Anthropic'],
        ['gemini', 'Gemini'],
        ['groq', 'Groq'],
      ],
    },
  )}${field('api_key', 'API Key', { type: 'password', placeholder: 'Paste your provider API key', required: true })}${state.settings.capabilities.stored_providers?.length ? checkbox('use_saved_key', 'Use this provider’s key already stored in Cloudflare', false, 'The key stays on the server; only its available models are returned.') : ''}<div class="field full"><label for="ai-model">Available model</label><select id="ai-model" name="model" required disabled><option value="">Paste an API key to load available models</option></select><p id="models-status" class="models-status" role="status"></p></div></div><div class="form-actions"><button id="add-ai-key" class="btn btn-primary" type="submit" disabled>${icon('plus')} Add API key</button><span class="tiny muted">Keys are encrypted on the server.</span></div></form><div class="table-wrap mt-6"><table class="keys-table"><thead><tr><th>Provider</th><th>Key / model</th><th>Health</th><th>Enabled</th><th>Requests / last used</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody id="key-rows">${keyRows()}</tbody></table></div><div class="notice mt-6">${icon('repeat-2')}<span>Each attempted generation advances round-robin rotation. Rate-limited keys cool down before rejoining; invalid keys stay out until you recheck or replace them.</span></div></section>`;
}
function automationSettings() {
  const settings = state.settings.automation;
  return `<section class="panel settings-tab-panel" style="padding:27px"><div class="between"><div><h2>Your reputation, on your terms.</h2><p class="panel-subtitle">Automatic replies run in your backend, even when this workspace is closed.</p></div><span class="badge ${settings.enabled ? 'badge-green' : 'badge-amber'}">${settings.enabled ? 'Enabled' : 'Paused'}</span></div><form id="automation-form">${checkbox('enabled', 'Enable automatic review replies', settings.enabled, 'Each business also needs its own auto-reply switch enabled.')}<div class="form-grid mt-6">${field(
    'interval',
    'Check interval',
    {
      value: settings.interval,
      options: [
        ['15', 'Every 15 minutes'],
        ['30', 'Every 30 minutes'],
        ['60', 'Every hour'],
        ['120', 'Every 2 hours'],
        ['360', 'Every 6 hours'],
      ],
    },
  )}<div></div>${field('delay_min', 'Minimum reply delay · minutes', { type: 'number', value: settings.delay_min, required: true })}${field('delay_max', 'Maximum reply delay · minutes', { type: 'number', value: settings.delay_max, required: true })}</div><p class="muted-callout mt-4">A random delay between 5 and 30 minutes starts when a new review is detected. Only unreplied 4–5 star reviews qualify. A ready brand voice and valid billing period are required.</p><div class="form-actions"><button class="btn btn-primary" type="submit">${icon('save')} Save automation</button><button class="btn" type="button" data-action="run-now">${icon('refresh-cw')} Check for due work now</button></div></form><div class="notice mt-6">${icon('shield-check')}<span>Google is checked before generation and again before posting. Owner replies already present are reconciled and skipped. Uncertain post results stay blocked until checked.</span></div></section>`;
}
function accountSettings() {
  return `<section class="panel settings-tab-panel" style="padding:27px"><h2>Make this workspace yours.</h2><p class="panel-subtitle">Your owner password is verified by the backend, not by browser preferences.</p><form id="account-form"><div class="form-grid">${field('workspace_name', 'Workspace name', { value: state.settings.account.workspace_name || 'ReplyRaven', full: true })}${field('current_password', 'Current password', { type: 'password', placeholder: 'Required only when changing password' })}${field('new_password', 'New password', { type: 'password', placeholder: 'At least 12 characters' })}</div><div class="form-actions"><button class="btn btn-primary" type="submit">${icon('save')} Save account</button></div></form><div class="form-section"><h3>Appearance</h3><p class="muted-callout mt-4">Saved on this device. No Google token or API key is stored here.</p><div class="form-actions"><button class="btn" data-action="choose-theme" data-theme="light">${icon('sun')} Light</button><button class="btn" data-action="choose-theme" data-theme="dark">${icon('moon')} Dark</button></div></div></section>`;
}
async function renderSettings() {
  if (!['google', 'ai', 'automation', 'account'].includes(state.tab)) state.tab = 'google';
  if (state.tab === 'ai') state.keys = (await api('/ai/keys')).keys;
  $('#page-root').innerHTML =
    heading('Settings', 'A connected workspace. A voice that feels like you.') +
    settingsTabs() +
    `<div class="settings-section">${{ google: googleSettings, ai: aiSettings, automation: automationSettings, account: accountSettings }[state.tab]()}</div>`;
  icons();
  shell();
}
const eventLabels = [
  [
    'google_expiry',
    'Google connection expiring / expired',
    'A day-six renewal reminder and an alert if Google revokes access.',
  ],
  ['trial_ending', 'Business trial ending', 'Two days before, one day before, and when the trial expires.'],
  ['monthly_due', 'Monthly payment due', 'Three days before, one day before, and on the due day.'],
  ['yearly_due', 'Yearly payment due', 'Three days before, one day before, and on the due day.'],
  [
    'reply_failed',
    'Automatic reply failed',
    'An operation needs attention. Existing replies are not overwritten.',
  ],
  ['reply_success', 'Review replied successfully', 'A new owner reply was accepted by Google.'],
];
function notificationSettings() {
  const prefs = state.settings.notifications;
  return `<section class="panel" style="padding:25px"><h2>Stay in the loop.</h2><p class="panel-subtitle">Choose the events and delivery channels that matter to you.</p><form id="notification-settings-form">${checkbox('enabled', 'Enable notifications', prefs.enabled)}<div class="form-section"><h3>Delivery channels</h3>${checkbox('email', 'Email notifications', prefs.email, state.settings.capabilities.email ? 'Your configured sender is ready.' : 'A verified sender and email provider must be configured first.')}${field('email_address', 'Notification email', { type: 'email', value: prefs.email_address, placeholder: 'Enter your notification email' })}${checkbox('browser', 'Browser notifications', prefs.browser, 'This browser needs notification permission. Delivery also depends on the browser push service.')}${checkbox('in_app', 'In-app notifications', prefs.in_app, 'Stored durably in your private notification inbox.')}</div><div class="form-section"><h3>Events</h3>${eventLabels.map(([name, label, hint]) => checkbox(name, label, prefs[name], hint)).join('')}</div><div class="form-actions"><button class="btn btn-primary" type="submit">${icon('save')} Save notification preferences</button><button class="btn" type="button" data-action="notification-confirmation">${icon('send')} Send confirmation</button></div></form><div class="notice mt-6">${icon('layers-3')}<span>Notifications use a durable outbox, deduplication, queue retries, and delivery records. Provider outages or revoked browser permission can delay delivery; pending notifications are retained.</span></div></section>`;
}
async function renderNotifications() {
  const data = await api('/notifications');
  state.notificationList = data.notifications;
  state.deliveries = data.deliveries;
  $('#page-root').innerHTML =
    heading(
      'Notifications',
      'The important things, without the noise.',
      `<button class="btn btn-sm" data-action="read-notifications">${icon('check-check')} Mark all as read</button>`,
    ) +
    `<div class="notify-grid"><div>${notificationSettings()}</div><div><section class="panel" style="padding:25px"><div class="between"><h2>Your inbox</h2><span class="badge">${state.notificationList.filter((row) => !row.read_at).length} unread</span></div><div class="mt-4">${state.notificationList.length ? state.notificationList.map((row) => `<article class="notification-row ${row.read_at ? '' : 'unread'}"><span class="stat-icon ${row.kind === 'reply_failed' ? 'red' : ''}">${icon(row.kind === 'reply_success' ? 'check-check' : row.kind === 'reply_failed' ? 'circle-alert' : 'bell')}</span><div class="event-text"><h3>${esc(row.title)}</h3><p>${esc(row.body)}</p><div class="between mt-4"><time class="tiny muted">${relative(row.created_at)}</time><a class="plain-link tiny" href="${esc(row.href)}">Open ${icon('arrow-up-right', 'icon-sm')}</a></div></div></article>`).join('') : '<div class="notification-empty">' + icon('bell-off') + '<p class="muted-callout mt-4">You’re all caught up. Alerts and reply updates will appear here.</p></div>'}</div></section><section class="panel mt-6" style="padding:25px"><div class="between"><h2>Delivery status</h2><button class="plain-link tiny" data-action="retry-notifications">Retry delayed</button></div><div class="mt-4">${state.deliveries.map((row) => `<div class="job-status"><div><strong class="tiny">${esc(row.title)}</strong><p>${esc(row.channel)} · ${row.state === 'sent' ? 'Accepted by provider' : esc(row.state)}</p>${row.error ? `<p class="event-error">${esc(row.error)}</p>` : ''}</div><span class="badge ${row.state === 'sent' ? 'badge-green' : 'badge-amber'}">${esc(row.state)}</span></div>`).join('') || '<p class="muted-callout">Delivery records appear when an enabled channel receives a notification.</p>'}</div></section></div></div>`;
  icons();
}
async function fetchModels() {
  const form = $('#ai-key-form');
  if (!form) return;
  const key = form.elements.api_key.value.trim(),
    useSaved = Boolean(form.elements.use_saved_key?.checked),
    provider = form.elements.provider.value,
    select = $('#ai-model'),
    status = $('#models-status');
  const sequence = ++modelSequence;
  modelController?.abort();
  select.disabled = true;
  $('#add-ai-key').disabled = true;
  select.innerHTML = '<option value="">Loading available models…</option>';
  if (key.length < 8 && !useSaved) {
    select.innerHTML = '<option value="">Paste an API key to load available models</option>';
    status.textContent = '';
    return;
  }
  status.textContent = 'Fetching models available to this key…';
  modelController = new AbortController();
  try {
    const result = await api('/ai/models', {
      method: 'POST',
      body: { provider, api_key: key, use_saved_key: useSaved },
      signal: modelController.signal,
    });
    if (sequence !== modelSequence) return;
    select.innerHTML = result.models.length
      ? '<option value="">Choose an available model</option>' +
        result.models.map((model) => `<option value="${esc(model.id)}">${esc(model.name)}</option>`).join('')
      : '<option value="">No compatible models returned</option>';
    select.disabled = !result.models.length;
    status.textContent = result.models.length
      ? `${result.models.length} models available. Choose one to continue.`
      : 'The provider did not return a compatible text model.';
  } catch (error) {
    if (error.name === 'AbortError' || sequence !== modelSequence) return;
    status.textContent = error.message;
    select.innerHTML = '<option value="">Could not load models</option>';
  }
}
async function connectBrowser() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window))
    throw new Error('This browser does not support push notifications.');
  if (!state.settings.vapid_public_key) throw new Error('Browser signing keys are not configured.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted')
    throw new Error(
      'Allow browser notifications to enable this channel. Email and in-app channels remain available.',
    );
  const registration = await navigator.serviceWorker.register('service-worker.js', { scope: './' });
  await navigator.serviceWorker.ready;
  const key = state.settings.vapid_public_key.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(key), (char) => char.charCodeAt(0));
  const subscription =
    (await registration.pushManager.getSubscription()) ||
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes }));
  await api('/notifications/subscribe', { method: 'POST', body: subscription.toJSON() });
}
async function viewVoice(id) {
  let biz = state.business?.id === id ? state.business : state.businesses.find((row) => row.id === id);
  if (!biz) biz = (await api(`/businesses/${id}`)).business;
  const voice = biz.voice_profile || {},
    sources = biz.voice_sources || {};
  modal(
    'View what AI learned',
    `<div class="between"><strong>${esc(biz.name)}</strong><span class="badge ${biz.voice_status === 'ready' ? 'badge-green' : biz.voice_status === 'failed' ? 'badge-red' : 'badge-amber'}">${esc(biz.voice_status)}</span></div>${biz.voice_status !== 'ready' ? `<div class="notice mt-4">${icon('fingerprint')}<span>${biz.voice_error ? esc(biz.voice_error) : 'Brand learning is queued or in progress. You can also write and save your brand voice below.'}</span></div>` : ''}<div class="source-list"><span class="badge">Google profile ${sources.google_profile ? 'read' : 'pending'}</span><span class="badge">Website ${esc(sources.website_status || 'pending')}</span><span class="badge">${Number(sources.review_count) || 0} recent reviews read</span></div><form id="voice-form" data-id="${id}"><div class="learned-grid">${['summary', 'tone', 'language', 'audience', 'reply_style', 'sign_off'].map((name) => `<div class="field ${['summary', 'reply_style'].includes(name) ? 'full' : ''}"><label for="voice-${name}">${{ summary: 'Brand summary', tone: 'Tone', language: 'Language', audience: 'Audience', reply_style: 'Reply style', sign_off: 'Sign-off' }[name]}</label><textarea id="voice-${name}" name="${name}" rows="${name === 'summary' || name === 'reply_style' ? 3 : 2}" ${['summary', 'tone', 'reply_style'].includes(name) ? 'required' : ''}>${esc(voice[name] || '')}</textarea></div>`).join('')}<div class="field"><label for="voice-facts">Known facts · one per line</label><textarea id="voice-facts" name="facts" rows="4">${esc((voice.facts || []).join('\n'))}</textarea></div><div class="field"><label for="voice-avoid">Avoid · one per line</label><textarea id="voice-avoid" name="avoid" rows="4">${esc((voice.avoid || []).join('\n'))}</textarea></div>${field('max_words', 'Reply word limit', { type: 'number', value: voice.max_words || 100 })}</div><div class="form-actions"><button class="btn btn-primary" type="submit">${icon('save')} Save brand voice</button><button class="btn" type="button" data-action="relearn" data-id="${id}">${icon('refresh-cw')} Learn again</button></div></form>`,
    '',
    true,
  );
}
async function scan() {
  if (!state.settings?.google?.connected) {
    location.assign('settings.html#google');
    return;
  }
  modal(
    'Find your Google businesses',
    `<div class="inline-progress">${icon('loader-circle', 'spin')} Fetching businesses you can manage…</div>`,
  );
  discovered = [];
  let cursor = null,
    errors = [];
  const ids = new Set();
  do {
    const result = await api('/businesses/discover', { method: 'POST', body: { cursor } });
    for (const location of result.locations)
      if (!ids.has(location.google_location_id)) {
        discovered.push(location);
        ids.add(location.google_location_id);
      }
    errors.push(...result.errors);
    cursor = result.cursor;
  } while (cursor);
  if (!$('.modal')) return;
  if (!discovered.length) {
    modal(
      'Your Google businesses',
      empty(
        'No new businesses found',
        'Accessible businesses already added are excluded. Check your Google manager permissions if a location is missing.',
        null,
      ),
      '<button class="btn" data-action="close-modal">Close</button>',
    );
    return;
  }
  modal(
    'Choose businesses to add',
    `<p class="muted-callout mb-4">Each selected business gets its own brand voice and payment settings. No previous review is replied to unless you opt in.</p><form id="scan-form">${discovered.map((biz, index) => `<label class="scan-location"><input type="checkbox" name="location" value="${index}"><div><strong>${esc(biz.name)}</strong><p>${esc(biz.address || 'Google Business Profile')}</p><p>Google ID ${esc(biz.google_location_id)}</p></div></label>`).join('')}${errors.length ? `<div class="notice warning">Some accounts could not be read. ${errors.map((error) => esc(error.message)).join(' ')}</div>` : ''}<div class="form-actions"><button class="btn btn-primary" type="submit">Continue with selected ${icon('arrow-right')}</button><button class="btn" type="button" data-action="close-modal">Cancel</button></div></form>`,
    '',
    true,
  );
}
function addNextBusiness() {
  const biz = selectedLocations[0];
  if (!biz) {
    closeModal();
    toast('Businesses added. Brand learning and review sync are queued.');
    refresh();
    return;
  }
  modal(
    `Add ${biz.name}`,
    `<form id="add-business-form" data-account="${esc(biz.google_account_id)}">${billingForm(biz, true)}<div class="form-section"><h3>Previous reviews · optional</h3>${checkbox('include_previous', 'Reply to previous unreplied reviews', false, 'Only unreplied 4–5 star reviews qualify. Already replied reviews are skipped.')}${field('previous_count', 'Number of previous reviews', { type: 'number', value: 20 })}</div><div class="form-actions"><button class="btn btn-primary" type="submit">${icon('plus')} Add business${selectedLocations.length > 1 ? ` (${selectedLocations.length} remaining)` : ''}</button><button class="btn" type="button" data-action="close-modal">Cancel</button></div></form>`,
    '',
    true,
  );
  if ($('#previous_count')) {
    $('#previous_count').disabled = true;
    $('#previous_count').min = '1';
    $('#previous_count').max = '1000';
  }
}
async function openReply(row, generate) {
  modal(
    generate ? 'Generate a brand-aware reply' : 'Write an owner reply',
    `<div class="review-context">${stars(row.rating)}<p class="reply-comment mt-4">${esc(row.comment || 'Rating-only review')}</p></div><form id="reply-form" data-id="${row.id}"><div class="field mt-6"><label for="reply-comment">Your reply</label><textarea id="reply-comment" name="comment" rows="7" maxlength="4096" required>${generate ? '' : ''}</textarea></div><div id="reply-status" class="models-status" role="status"></div><div class="form-actions"><button id="post-reply" class="btn btn-primary" type="submit" ${generate ? 'disabled' : ''}>${icon('send')} Post to Google</button><button class="btn" type="button" data-action="close-modal">Cancel</button></div><p class="muted-callout mt-4">Google is checked again before posting. An existing owner reply will not be replaced.</p></form>`,
    '',
    true,
  );
  if (generate) {
    $('#reply-status').innerHTML = `${icon('loader-circle', 'spin')} Writing in this business’s voice…`;
    try {
      const result = await api(`/reviews/${row.id}/draft`, { method: 'POST', body: {} });
      if ($('#reply-comment')) {
        $('#reply-comment').value = result.draft;
        $('#post-reply').disabled = false;
        $('#reply-status').textContent = 'Review and edit your reply before posting.';
      }
    } catch (error) {
      if ($('#reply-status')) $('#reply-status').textContent = error.message;
    }
  }
}
async function refresh() {
  const response = await api('/state');
  state = { ...state, ...response };
  if (page === 'dashboard') {
    shell();
    renderDashboard();
    await loadBusinessList();
  } else if (page === 'business') await renderBusiness();
  else if (page === 'settings') await renderSettings();
  else if (page === 'notifications') {
    shell();
    await renderNotifications();
  }
  $('#page-root')?.setAttribute('aria-busy', 'false');
  icons();
}
function findReview(id) {
  const row = state.reviews.find((item) => item.id === id);
  if (!row) throw new Error('Refresh the review list before continuing.');
  return row;
}
function confirmation(title, description, action, id, label = 'Confirm') {
  modal(
    title,
    `<p class="muted-callout">${esc(description)}</p>`,
    `<button class="btn" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="${action}" data-id="${esc(id)}">${esc(label)}</button>`,
  );
}
async function action(button) {
  const name = button.dataset.action,
    id = button.dataset.id;
  if (name === 'theme') {
    theme(document.documentElement.classList.contains('dark') ? 'light' : 'dark');
    return;
  }
  if (name === 'choose-theme') {
    theme(button.dataset.theme);
    return;
  }
  if (name === 'logout') {
    logout();
    return;
  }
  if (name === 'close-modal') {
    closeModal();
    return;
  }
  if (name === 'sidebar') {
    sidebar(true);
    return;
  }
  if (name === 'close-sidebar') {
    sidebar(false);
    return;
  }
  if (name === 'scan') {
    await scan();
    return;
  }
  if (name === 'sync-business' || name === 'sync-current') {
    await api(`/businesses/${id || state.businessId}/sync`, { method: 'POST', body: {} });
    toast('Review sync queued. The workspace will update when it completes.');
    return;
  }
  if (name === 'toggle-business') {
    const biz = state.businesses.find((row) => row.id === id) || state.business;
    await api(`/businesses/${id}`, { method: 'PUT', body: { auto_reply: !biz.auto_reply } });
    await refresh();
    return;
  }
  if (name === 'view-voice') {
    await viewVoice(id);
    return;
  }
  if (name === 'relearn') {
    await api(`/businesses/${id}/voice`, { method: 'POST', body: {} });
    closeModal();
    toast('Brand learning queued.');
    await refresh();
    return;
  }
  if (name === 'business-filter') {
    state.businessFilter = button.dataset.filter;
    state.businessPage = 1;
    renderDashboard();
    await loadBusinessList();
    return;
  }
  if (name === 'business-page') {
    state.businessPage = Number(button.dataset.page);
    await loadBusinessList();
    return;
  }
  if (name === 'review-filter') {
    state.reviewFilter = button.dataset.filter;
    state.reviewPage = 1;
    $$('[data-action="review-filter"]').forEach((node) => node.classList.toggle('active', node === button));
    await loadReviewList();
    return;
  }
  if (name === 'review-page') {
    state.reviewPage = Number(button.dataset.page);
    await loadReviewList();
    $('#review-list')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }
  if (name === 'business-tab') {
    location.hash = button.dataset.tab === 'payments' ? 'payments' : 'reviews';
    return;
  }
  if (name === 'remove-business') {
    confirmation(
      'Remove this business?',
      'This removes the business from ReplyRaven, not from Google. Its existing Google owner replies will not be changed.',
      'confirm-remove-business',
      id,
      'Remove business',
    );
    return;
  }
  if (name === 'confirm-remove-business') {
    await api(`/businesses/${id}`, { method: 'DELETE' });
    closeModal();
    toast('Business removed from ReplyRaven.');
    await refresh();
    return;
  }
  if (name === 'backfill') {
    modal(
      'Reply to previous unreplied reviews',
      `<p class="muted-callout">This is optional. Only unreplied 4–5 star reviews qualify; Google is checked before any post. Master automation, business opt-in, billing, and brand voice guardrails still apply.</p><form id="backfill-form" data-id="${id}"><div class="mt-6">${field('limit', 'How many previous reviews?', { type: 'number', value: 20, required: true })}</div><div class="form-actions"><button class="btn btn-primary" type="submit">${icon('history')} Schedule previous reviews</button><button class="btn" type="button" data-action="close-modal">Cancel</button></div></form>`,
    );
    return;
  }
  if (name === 'mark-paid') {
    const biz = state.business?.id === id ? state.business : state.businesses.find((row) => row.id === id);
    modal(
      'Mark payment received',
      `<p class="muted-callout">Record funds you have already received. This clears the billing pause but does not enable a business or master automation that you switched off.</p><form id="payment-form" data-id="${id}"><div class="form-grid mt-6">${field('amount', 'Amount received', { value: biz.amount, required: true })}${field('currency', 'Currency', { value: biz.currency, readonly: true })}${field(
        'payment_method',
        'Payment method',
        {
          value: biz.payment_method,
          options: [
            ['cash', 'Cash'],
            ['transfer', 'Transfer'],
            ['stripe', 'Stripe'],
            ['paypal', 'PayPal'],
          ],
        },
      )}${field('note', 'Payment note', { placeholder: 'Optional reference' })}</div><div class="form-actions"><button class="btn btn-primary" type="submit">${icon('badge-check')} Mark as Paid</button><button class="btn" type="button" data-action="close-modal">Cancel</button></div></form>`,
    );
    return;
  }
  if (name === 'verify-reply' || name === 'confirm-no-reply') {
    const result = await api(`/reviews/${id}/reconcile`, {
      method: 'POST',
      body: { confirm_no_reply: name === 'confirm-no-reply' },
    });
    if (result.has_reply) {
      closeModal();
      toast('Google confirms an existing owner reply. Nothing was changed.');
      await loadReviewList();
      return;
    }
    if (name === 'confirm-no-reply') {
      closeModal();
      toast('Verification recorded. Automatic re-posting stays off; you may deliberately write a new reply.');
      await loadReviewList();
      return;
    }
    confirmation(
      'Verify the previous Google write',
      'Google currently reports no owner reply. Check the review on Google and allow time for the prior operation to settle. Confirm only if you have verified that no reply was posted. Automatic retries remain disabled.',
      'confirm-no-reply',
      id,
      'I confirmed there is no reply',
    );
    return;
  }
  if (name === 'draft-reply' || name === 'manual-reply') {
    await openReply(findReview(id), name === 'draft-reply');
    return;
  }
  if (name === 'delete-reply') {
    const row = findReview(id);
    confirmation(
      'Delete this owner reply?',
      'Only the owner reply will be deleted. The customer review remains on Google. Automatic posting for this previously replied review stays disabled.',
      'confirm-delete-reply',
      row.id,
      'Delete owner reply',
    );
    return;
  }
  if (name === 'confirm-delete-reply') {
    const row = findReview(id);
    await api(`/reviews/${id}/reply`, {
      method: 'DELETE',
      body: { confirmed: true, expected_reply: row.reply },
    });
    closeModal();
    toast('Owner reply deleted.');
    await loadReviewList();
    return;
  }
  if (name === 'share-review') {
    const row = findReview(id),
      text = `${row.business_name || state.business?.name || 'Google review'}\n${row.rating}/5 stars\n${row.reviewer}: ${row.comment || 'Rating-only review'}\n${new URL(`business.html?id=${row.business_id}`, location.href)}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
    return;
  }
  if (name === 'toggle-key') {
    const key = state.keys.find((row) => row.id === id);
    await api(`/ai/keys/${id}`, { method: 'PUT', body: { enabled: !key.enabled } });
    await renderSettings();
    return;
  }
  if (name === 'delete-key') {
    confirmation(
      'Delete this API key?',
      'The encrypted key will be removed from ReplyRaven. This does not revoke it at the provider.',
      'confirm-delete-key',
      id,
      'Delete key',
    );
    return;
  }
  if (name === 'confirm-delete-key') {
    await api(`/ai/keys/${id}`, { method: 'DELETE' });
    closeModal();
    await renderSettings();
    toast('API key removed.');
    return;
  }
  if (name === 'key-health') {
    await api(`/ai/keys/${id}/health`, { method: 'POST', body: {} });
    toast('Key accepted by the provider.');
    await renderSettings();
    return;
  }
  if (name === 'reconnect') {
    const result = await api('/google/playground');
    window.open(result.url, '_blank', 'noopener,noreferrer');
    toast(
      'In Playground settings, use your own client ID and secret, then save the new refresh token here.',
      'info',
    );
    return;
  }
  if (name === 'run-now') {
    await api('/automation/run', { method: 'POST', body: {} });
    toast('Due work queued in the backend.');
    return;
  }
  if (name === 'read-notifications') {
    await api('/notifications/read', { method: 'POST', body: {} });
    await refresh();
    return;
  }
  if (name === 'notification-confirmation') {
    await api('/notifications/confirmation', { method: 'POST', body: {} });
    toast('Confirmation queued for your enabled notification channels.');
    return;
  }
  if (name === 'retry-notifications') {
    await api('/notifications/retry', { method: 'POST', body: {} });
    toast('Pending delivery retries queued.');
    return;
  }
  if (name === 'view-logs') {
    const result = await api('/logs');
    modal(
      'Workspace activity',
      `<p class="muted-callout">Recent operations and background jobs, with provider errors kept free of credentials.</p><div class="mt-4">${result.jobs.map((job) => `<div class="job-status"><div><strong class="tiny">${esc(job.kind)}</strong><p>${esc(job.error || 'Background operation queued.')}</p></div><span class="badge ${job.state === 'failed' ? 'badge-red' : ''}">${esc(job.state)}</span></div>`).join('')}</div><div class="form-section">${result.logs.map((event) => `<div class="job-status"><div><strong class="tiny">${esc(event.action.replace(/_/g, ' '))}</strong><p>${esc(event.message)}</p></div><time class="tiny muted">${relative(event.created_at)}</time></div>`).join('') || '<p class="muted-callout">No activity recorded yet.</p>'}</div>`,
      '<button class="btn" data-action="close-modal">Close</button>',
      true,
    );
    return;
  }
}
document.addEventListener('click', async (event) => {
  const reveal = event.target.closest('[data-reveal]');
  if (reveal) {
    const input = $(`#${reveal.dataset.reveal}`);
    input.type = input.type === 'password' ? 'text' : 'password';
    reveal.setAttribute('aria-label', input.type === 'password' ? 'Show password' : 'Hide password');
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  event.preventDefault();
  const busy = !['theme', 'choose-theme', 'close-modal', 'sidebar', 'close-sidebar', 'business-tab'].includes(
    button.dataset.action,
  );
  if (busy) setBusy(button, true);
  try {
    await action(button);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    if (busy && button.isConnected) setBusy(button, false);
  }
});
document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  event.preventDefault();
  const button = $('button[type="submit"]', form);
  setBusy(button, true);
  try {
    if (form.id === 'login-form') {
      const response = await api('/auth/login', {
        method: 'POST',
        body: { password: form.elements.password.value },
      });
      sessionStorage.setItem('rr_session', response.token);
      sessionStorage.setItem('rr_session_expiry', String(response.expires_at));
      location.replace('dashboard.html');
      return;
    }
    if (form.id === 'global-search') {
      location.assign(`dashboard.html?q=${encodeURIComponent($('#global-query').value)}`);
      return;
    }
    if (form.id === 'scan-form') {
      selectedLocations = [...new FormData(form).getAll('location')]
        .map((index) => discovered[Number(index)])
        .filter(Boolean);
      if (!selectedLocations.length) throw new Error('Select at least one business.');
      addNextBusiness();
      return;
    }
    if (form.id === 'add-business-form') {
      const values = paymentInput(form);
      values.google_account_id = form.dataset.account;
      await api('/businesses', { method: 'POST', body: values });
      selectedLocations.shift();
      addNextBusiness();
      return;
    }
    if (form.id === 'google-settings-form') {
      await api('/settings/google', { method: 'PUT', body: formValues(form) });
      toast('Google connection validated and saved securely.');
      await refresh();
      return;
    }
    if (form.id === 'ai-key-form') {
      await api('/ai/keys', { method: 'POST', body: formValues(form) });
      toast('API key encrypted and saved.');
      await renderSettings();
      return;
    }
    if (form.id === 'automation-form') {
      const response = await api('/settings/automation', { method: 'PUT', body: formValues(form) });
      state.settings.automation = response.automation;
      toast('Automation settings saved.');
      await renderSettings();
      return;
    }
    if (form.id === 'account-form') {
      const result = await api('/settings/account', { method: 'PUT', body: formValues(form) });
      if (result.reauthenticate) {
        toast('Password changed. Sign in with your new password.');
        logout();
        return;
      }
      toast('Account settings saved.');
      await refresh();
      return;
    }
    if (form.id === 'business-settings-form') {
      await api(`/businesses/${state.businessId}`, { method: 'PUT', body: paymentInput(form) });
      toast('Business settings saved.');
      await renderBusiness();
      return;
    }
    if (form.id === 'voice-form') {
      const values = formValues(form);
      values.facts = values.facts
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean);
      values.avoid = values.avoid
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean);
      await api(`/businesses/${form.dataset.id}/voice`, { method: 'PUT', body: { voice: values } });
      closeModal();
      toast('Brand voice saved.');
      await refresh();
      return;
    }
    if (form.id === 'backfill-form') {
      await api(`/businesses/${form.dataset.id}/backfill`, {
        method: 'POST',
        body: { limit: Number(form.elements.limit.value), confirmed: true },
      });
      closeModal();
      toast('Previous eligible reviews queued with a natural delay.');
      return;
    }
    if (form.id === 'payment-form') {
      await api(`/businesses/${form.dataset.id}/mark-paid`, { method: 'POST', body: formValues(form) });
      closeModal();
      toast('Payment recorded. The billing pause is cleared.');
      await refresh();
      return;
    }
    if (form.id === 'reply-form') {
      await api(`/reviews/${form.dataset.id}/reply`, {
        method: 'POST',
        body: { comment: form.elements.comment.value },
      });
      closeModal();
      toast('Owner reply posted to Google.');
      await loadReviewList();
      return;
    }
    if (form.id === 'notification-settings-form') {
      const values = formValues(form);
      if (values.browser) await connectBrowser();
      const response = await api('/settings/notifications', { method: 'PUT', body: values });
      state.settings.notifications = response.notifications;
      toast('Notification preferences saved.');
      await renderNotifications();
      return;
    }
  } catch (error) {
    if (form.id === 'login-form') {
      $('#login-error').hidden = false;
      $('#login-error').textContent = error.message;
    } else toast(error.message, 'error');
  } finally {
    if (button?.isConnected) setBusy(button, false);
  }
});
let searchTimer;
document.addEventListener('input', (event) => {
  const target = event.target;
  if (target.id === 'business-search') {
    state.businessQuery = target.value;
    state.businessPage = 1;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadBusinessList().catch((error) => toast(error.message, 'error')), 300);
  }
  if (target.id === 'review-search') {
    state.reviewQuery = target.value;
    state.reviewPage = 1;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadReviewList().catch((error) => toast(error.message, 'error')), 300);
  }
  if (target.id === 'api_key' && target.closest('#ai-key-form')) {
    clearTimeout(modelTimer);
    modelTimer = setTimeout(fetchModels, 450);
  }
});
document.addEventListener('change', (event) => {
  const target = event.target;
  if (target.id === 'provider' && target.closest('#ai-key-form')) fetchModels();
  if (target.name === 'use_saved_key' && target.closest('#ai-key-form')) {
    const input = $('#api_key');
    input.required = !target.checked;
    input.disabled = target.checked;
    fetchModels();
  }
  if (target.id === 'ai-model') $('#add-ai-key').disabled = !target.value;
  if (target.name === 'include_previous' && $('#previous_count'))
    $('#previous_count').disabled = !target.checked;
});
window.addEventListener('hashchange', () => {
  if (page === 'settings') {
    state.tab = location.hash.slice(1) || 'google';
    renderSettings().catch((error) => toast(error.message, 'error'));
  }
  if (page === 'business') renderBusiness().catch((error) => toast(error.message, 'error'));
});
window.addEventListener('resize', () => {
  if ($('.sidebar')) $('.sidebar').inert = innerWidth <= 800 && !$('.sidebar').classList.contains('open');
});
document.addEventListener('keydown', (event) => {
  if (
    event.key === '/' &&
    !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) &&
    !$('.modal')
  ) {
    const search = $('#global-query');
    if (search) {
      event.preventDefault();
      search.focus();
    }
  }
  if (event.key === 'Escape') sidebar(false);
});
function clearPreviousBrowserCredentials() {
  try {
    const config = localStorage.getItem('rr_config');
    if (config) {
      let values;
      try {
        values = JSON.parse(config);
      } catch {
        values = {};
      }
      for (const key of Object.keys(values || {})) if (key !== 'theme') localStorage.removeItem(key);
      for (const key of ['auth', 'auth_expiry', 'dashboard_password', 'access_token_expiry', 'ai_index'])
        localStorage.removeItem(key);
    }
    for (const key of Object.keys(localStorage)) if (key.startsWith('rr_')) localStorage.removeItem(key);
  } catch {}
}
async function initialize() {
  clearPreviousBrowserCredentials();
  theme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  if ($('#footer-year')) $('#footer-year').textContent = String(new Date().getFullYear());
  if (page === 'landing') {
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches)
      import('https://cdn.jsdelivr.net/npm/framer-motion@11.18.2/+esm')
        .then((motion) =>
          motion.animate('.hero-content,.hero-visual', { opacity: [0, 1], y: [15, 0] }, { duration: 0.65 }),
        )
        .catch(() => {});
    icons();
    return;
  }
  if (page === 'login') {
    if (!base) {
      $('#login-error').hidden = false;
      $('#login-error').textContent = 'The backend endpoint has not been configured.';
    }
    icons();
    return;
  }
  if (!sessionToken()) {
    location.replace('login.html');
    return;
  }
  if (!state.businessId && params.get('locationId')) {
    const found = await api(`/businesses?q=${encodeURIComponent(params.get('locationId'))}`);
    state.businessId =
      found.businesses.find((row) => row.google_location_id === params.get('locationId'))?.id || '';
  }
  await refresh();
  pollTimer = setInterval(async () => {
    try {
      if (
        document.hidden ||
        $('.modal') ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
      )
        return;
      if (page === 'dashboard') {
        const summary = await api('/state');
        const result = await api(
          '/businesses?page=' +
            state.businessPage +
            '&q=' +
            encodeURIComponent(state.businessQuery) +
            '&filter=' +
            state.businessFilter,
        );
        if (
          JSON.stringify(summary.stats) !== JSON.stringify(state.stats) ||
          JSON.stringify(result.businesses) !== JSON.stringify(state.businesses) ||
          summary.unread !== state.unread
        )
          await refresh();
      } else if (page === 'business' && location.hash !== '#payments') {
        if (state.businessId) {
          const result = await api(`/businesses/${state.businessId}`);
          if (
            JSON.stringify(result.business) !== JSON.stringify(state.business) ||
            JSON.stringify(result.reviews.reviews) !== JSON.stringify(state.reviews)
          )
            await renderBusiness();
        } else await loadReviewList();
      } else if (page === 'notifications') {
        const result = await api('/notifications');
        if (
          JSON.stringify(result.notifications) !== JSON.stringify(state.notificationList) ||
          JSON.stringify(result.deliveries) !== JSON.stringify(state.deliveries)
        )
          await renderNotifications();
      }
    } catch {}
  }, 10000);
}
initialize().catch((error) => {
  const root = $('#page-root');
  if (root) {
    root.setAttribute('aria-busy', 'false');
    root.innerHTML = `<section class="panel app-error" style="padding:30px"><span class="stat-icon red">${icon('cloud-off')}</span><h1 class="api-error-heading mt-4">The workspace could not be loaded.</h1><p class="panel-subtitle">${esc(error.message)}</p><div class="form-actions"><button class="btn btn-primary" onclick="location.reload()">${icon('refresh-cw')} Retry</button><button class="btn" data-action="logout">Sign out</button></div></section>`;
  } else toast(error.message, 'error');
  icons();
});
window.addEventListener('load', icons);
