'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || 'Something went wrong. Please try again.'); e.status = r.status; throw e; }
  return d;
}
let me = null, posts = [], more = false, scope = 'all', F = { q: '', tag: '', u: '' };
let cur = null, CM = null, mode = '', focusC = false, FR = { friends: [], incoming: [], outgoing: [] };

let theme = null; try { theme = localStorage.getItem('theme'); } catch {}
const applyTheme = () => { if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme; };
const isDark = () => theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
applyTheme();
const ago = t => { const m = Math.floor((Date.now() - new Date(t)) / 6e4); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.floor(m / 60) + ' h ago' : m < 10080 ? Math.floor(m / 1440) + ' d ago' : new Date(t).toLocaleDateString(); };
const toast = m => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3500); };
const needLogin = note => { if (me) return false; authModal('login', note || 'Log in or create an account to do that.'); return true; };

function show(html, keep) {
  const y = $('#ov').scrollTop; $('#ov').className = mode === 'post' ? 'page' : '';
  $('#sheet').innerHTML = html; $('#ov').hidden = false; document.body.style.overflow = 'hidden';
  $('#ov').scrollTop = keep ? y : 0;
}
let pushed = false;
function closeM() {
  if (pushed) { pushed = false; history.back(); return; }
  $('#ov').hidden = true; document.body.style.overflow = ''; cur = null; mode = '';
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

// ---------- feed ----------
const bar = p => `<div class="acts">
  <button class="btn" data-act="cm" data-id="${p.id}">Comment ${p.comments}</button>
  <button class="btn ${p.reposted ? 'on' : ''}" data-act="rp" data-id="${p.id}" aria-pressed="${p.reposted}">${p.reposted ? 'Reposted' : 'Repost'} ${p.reposts}</button>
  <button class="btn ${p.liked ? 'on' : ''}" data-act="lk" data-id="${p.id}" aria-pressed="${p.liked}">${p.liked ? 'Liked' : 'Like'} ${p.likes}</button>
  ${me && me.username === p.username ? `<button class="btn del" data-act="del" data-id="${p.id}">Delete</button>` : ''}</div>`;
const tagsOf = p => p.tags.length ? `<div class="tags">${p.tags.map(t => `<button class="tag" data-act="tag" data-t="${esc(t)}">#${esc(t)}</button>`).join('')}</div>` : '';
const byline = p => `<div class="meta"><a href="#" data-act="user" data-u="${esc(p.username)}">${esc(p.name)}</a> @${esc(p.username)} · ${ago(p.created_at)}</div>`;

function renderNav() {
  $('#nav').innerHTML = me
    ? `<button class="ghost" data-act="people">Friends${FR.incoming.length ? ` <span class="badge">${FR.incoming.length}</span>` : ''}</button><button class="primary" data-act="compose">Share a study</button><button class="ghost" data-act="logout" title="Log out of @${esc(me.username)}">Log out</button>`
    : `<button class="ghost" data-act="login">Log in</button><button class="primary" data-act="signup">Create account</button>`;
  $('#nav').insertAdjacentHTML('afterbegin', `<button class="ghost" data-act="theme">${isDark() ? 'Light mode' : 'Dark mode'}</button>`);
  $('#hero').innerHTML = me ? '' : `<div class="hero"><h1>Read studies the way you read your feed.</h1><p>Short summaries, full detail when you want it, and people who discuss the research. Create a free account to share studies, add friends and join the conversation.</p></div>`;
}
function renderFeed() {
  const tabs = [['all', 'Everyone'], ...(me ? [['friends', 'Friends'], ['mine', 'My studies']] : [])];
  $('#tabs').innerHTML = `<div class="seg">${tabs.map(([k, l]) => `<button class="${scope === k ? 'on' : ''}" data-act="scope" data-s="${k}">${l}</button>`).join('')}</div>`;
  const ch = []; if (F.tag) ch.push(['tag', '#' + F.tag]); if (F.u) ch.push(['u', '@' + F.u]); if (F.q) ch.push(['q', '“' + F.q + '”']);
  $('#chips').innerHTML = ch.map(([k, l]) => `<button class="chip" data-act="clear" data-k="${k}">${esc(l)} ×</button>`).join('');
  $('#feed').innerHTML = posts.length ? posts.map(p => `<article class="card" tabindex="0" data-act="open" data-id="${p.id}">${byline(p)}<h2>${esc(p.title)}</h2><p class="abs">${esc(p.abstract)}</p>${tagsOf(p)}${bar(p)}</article>`).join('')
    : `<p class="note">${scope === 'friends' ? 'Nothing here yet. Add friends and their studies will show up in this feed.' : F.q || F.tag || F.u ? 'No studies match. Try a different search.' : 'No studies yet. Be the first to share one.'}</p>`;
  $('#more').innerHTML = more ? '<button class="ghost" data-act="more">Show more studies</button>' : '';
  if (cur) renderModal();
}
async function load(append) {
  const p = new URLSearchParams({ scope });
  for (const k in F) if (F[k]) p.set(k, F[k]);
  if (append && posts.length) p.set('before', posts[posts.length - 1].id);
  try { const d = await api('GET', '/api/posts?' + p); posts = append ? posts.concat(d.posts) : d.posts; more = d.more; }
  catch (e) { if (e.status === 401) { scope = 'all'; return load(); } toast(e.message); }
  renderFeed();
}
async function refreshFriends() { if (!me) return; try { FR = await api('GET', '/api/friends'); } catch {} renderNav(); }

// ---------- study modal ----------
function renderModal() {
  const p = posts.find(x => x.id === cur);
  if (!p || mode !== 'post') return;
  const keep = $('#ci') ? $('#ci').value : '';
  const list = CM === null ? '<p class="note">Loading comments…</p>' : CM.length ? CM.map(c => `<div class="cm"><div class="meta"><b>${esc(c.name)}</b> @${esc(c.username)} · ${ago(c.created_at)}</div><p>${esc(c.text)}</p>
    <button class="btn ${c.liked ? 'on' : ''}" data-act="clk" data-id="${c.id}">${c.liked ? 'Liked' : 'Like'} ${c.likes}</button>${me && (me.username === c.username || me.username === p.username) ? `<button class="btn del" data-act="cdel" data-id="${c.id}">Delete</button>` : ''}</div>`).join('') : '<p class="note">No comments yet. Start the discussion.</p>';
  const form = me ? '<form id="cf" class="new"><input id="ci" maxlength="500" placeholder="Add to the discussion" aria-label="Comment"><button class="primary">Post</button></form>'
    : '<p class="note"><button class="link" data-act="login">Log in</button> or <button class="link" data-act="signup">create an account</button> to join the discussion.</p>';
  show(`<button class="back" data-act="close">← All studies</button>${byline(p)}<h2>${esc(p.title)}</h2>${tagsOf(p)}
    <h3>Abstract</h3><p class="pre">${esc(p.abstract)}</p>${p.body ? `<h3>Details</h3><p class="pre">${esc(p.body)}</p>` : ''}
    ${p.url ? `<p><a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">Read the original source</a></p>` : ''}${bar(p)}
    <h3>Comments (${p.comments})</h3>${list}${form}`, true);
  if ($('#ci')) { $('#ci').value = keep; if (focusC) { focusC = false; $('#ci').focus(); } }
}
async function openPost(id, focus) {
  cur = id; mode = 'post'; CM = null; focusC = !!focus; if (!pushed) { history.pushState(null, '', '#/study/' + id); pushed = true; } renderModal();
  try { CM = await api('GET', `/api/posts/${id}/comments`); } catch (e) { CM = []; toast(e.message); }
  if (cur === id) renderModal();
}

// ---------- account / compose / friends modals ----------
function authModal(tab = 'login', note = '') {
  mode = 'auth'; const su = tab === 'signup';
  show(`<button class="x" data-act="close" aria-label="Close">×</button><h2>${su ? 'Create your account' : 'Welcome back'}</h2>${note ? `<p class="note">${esc(note)}</p>` : ''}
  <div class="seg"><button class="${su ? '' : 'on'}" data-act="auth-tab" data-t="login">Log in</button><button class="${su ? 'on' : ''}" data-act="auth-tab" data-t="signup">Sign up</button></div>
  <form id="af" data-tab="${tab}" novalidate>
    ${su ? '<label>Display name<input name="name" maxlength="40" autocomplete="name"></label>' : ''}
    <label>Username<input name="username" maxlength="20" autocomplete="username" autocapitalize="none" spellcheck="false" required>${su ? '<small>3–20 letters, numbers or underscores</small>' : ''}</label>
    <label>Password<input name="password" type="password" maxlength="72" autocomplete="${su ? 'new-password' : 'current-password'}" required>${su ? '<small>At least 8 characters</small>' : ''}</label>
    <p class="err" id="err" role="alert"></p><button class="primary" type="submit">${su ? 'Create account' : 'Log in'}</button></form>`);
  $('#af input').focus();
}
function composeModal() {
  if (needLogin('Log in to share a study.')) return;
  mode = 'compose';
  show(`<button class="x" data-act="close" aria-label="Close">×</button><h2>Share a study</h2>
  <form id="pf" novalidate>
    <label>Title<input name="title" maxlength="200" required></label>
    <label>Abstract<textarea name="abstract" rows="4" maxlength="1200" required></textarea><small>This is what people see in the feed. A few sentences works best.</small></label>
    <label>Details (optional)<textarea name="body" rows="6" maxlength="8000"></textarea><small>Methods, findings, limitations. Shown when someone opens the study.</small></label>
    <label>Tags (optional)<input name="tags" placeholder="vision, biology, 3d"><small>Up to 5, separated by commas</small></label>
    <label>Source link (optional)<input name="url" type="url" placeholder="https://"></label>
    <p class="err" id="err" role="alert"></p><button class="primary" type="submit">Publish study</button></form>`);
  $('#pf input').focus();
}
async function people(qv = '') {
  mode = 'people'; await refreshFriends();
  const row = (u, btns) => `<div class="row"><div><b>${esc(u.name)}</b> <span class="mute">@${esc(u.username)}</span></div><div>${btns}</div></div>`;
  const d = u => `data-u="${esc(u.username)}"`;
  show(`<button class="x" data-act="close" aria-label="Close">×</button><h2>Friends</h2>
  ${FR.incoming.length ? `<h3>Requests for you</h3>${FR.incoming.map(u => row(u, `<button class="primary sm" data-act="fa" ${d(u)}>Accept</button><button class="ghost sm" data-act="fr" ${d(u)}>Decline</button>`)).join('')}` : ''}
  <h3>Find people</h3><input id="ps" type="search" placeholder="Search by name or username" value="${esc(qv)}" aria-label="Search people"><div id="pres"></div>
  <h3>Your friends (${FR.friends.length})</h3>${FR.friends.map(u => row(u, `<button class="ghost sm" data-act="user" ${d(u)}>View studies</button><button class="ghost sm" data-act="fr" ${d(u)}>Remove</button>`)).join('') || '<p class="note">No friends yet. Search above to find people.</p>'}
  ${FR.outgoing.length ? `<h3>Requests you sent</h3>${FR.outgoing.map(u => row(u, `<button class="ghost sm" data-act="fr" ${d(u)}>Cancel</button>`)).join('')}` : ''}`);
  if (qv) psearch(qv);
}
async function psearch(v) {
  if (!v.trim()) { $('#pres').innerHTML = ''; return; }
  try {
    const r = await api('GET', '/api/users?q=' + encodeURIComponent(v));
    if (!$('#pres')) return;
    $('#pres').innerHTML = r.map(u => `<div class="row"><div><b>${esc(u.name)}</b> <span class="mute">@${esc(u.username)}</span></div><div>${
      u.rel === 'friend' ? '<span class="mute">Friends</span>' : u.rel === 'sent' ? `<button class="ghost sm" data-act="fr" data-u="${esc(u.username)}">Cancel request</button>`
      : `<button class="primary sm" data-act="fa" data-u="${esc(u.username)}">${u.rel === 'incoming' ? 'Accept' : 'Add friend'}</button>`}</div></div>`).join('') || '<p class="note">No one found.</p>';
  } catch (e) { toast(e.message); }
}

// ---------- actions ----------
async function tog(id, kind) {
  if (needLogin()) return;
  const p = posts.find(x => x.id === id), k = kind === 'lk' ? ['likes', 'liked', 'like'] : ['reposts', 'reposted', 'repost'];
  try { const d = await api('POST', `/api/posts/${id}/${k[2]}`); p[k[1]] = d.on; p[k[0]] = d.count; renderFeed(); } catch (e) { toast(e.message); }
}
function afterAuth(u) { me = u; closeM(); renderNav(); refreshFriends(); load(); toast('Welcome, ' + u.name + '.'); }

document.addEventListener('click', async e => {
  if (e.target.id === 'ov') return closeM();
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act, id = +b.dataset.id, u = b.dataset.u;
  if (b.tagName === 'A') e.preventDefault();
  try {
    if (a === 'open') openPost(id);
    else if (a === 'cm') openPost(id, true);
    else if (a === 'rp' || a === 'lk') await tog(id, a);
    else if (a === 'del') {
      if (!confirm('Delete this study? Its comments will be removed too.')) return;
      await api('DELETE', '/api/posts/' + id); posts = posts.filter(p => p.id !== id); if (cur === id) closeM(); renderFeed(); toast('Study deleted.');
    }
    else if (a === 'clk') {
      if (needLogin()) return;
      const d = await api('POST', `/api/comments/${id}/like`), c = CM.find(x => x.id === id); c.liked = d.on; c.likes = d.count; renderModal();
    }
    else if (a === 'cdel') {
      if (!confirm('Delete this comment?')) return;
      await api('DELETE', '/api/comments/' + id); CM = CM.filter(c => c.id !== id); posts.find(p => p.id === cur).comments--; renderFeed();
    }
    else if (a === 'user') { F.u = u; scope = 'all'; closeM(); load(); }
    else if (a === 'tag') { F.tag = b.dataset.t; closeM(); load(); }
    else if (a === 'scope') { scope = b.dataset.s; load(); }
    else if (a === 'clear') { F[b.dataset.k] = ''; if (b.dataset.k === 'q') $('#search').value = ''; load(); }
    else if (a === 'more') load(true);
    else if (a === 'login' || a === 'signup') authModal(a);
    else if (a === 'auth-tab') authModal(b.dataset.t);
    else if (a === 'logout') { await api('POST', '/api/logout'); me = null; FR = { friends: [], incoming: [], outgoing: [] }; scope = 'all'; closeM(); renderNav(); load(); toast('You are logged out.'); }
    else if (a === 'compose') composeModal();
    else if (a === 'people') people();
    else if (a === 'fa') { await api('POST', '/api/friends/' + u); people($('#ps') ? $('#ps').value : ''); }
    else if (a === 'fr') { await api('DELETE', '/api/friends/' + u); people($('#ps') ? $('#ps').value : ''); }
    else if (a === 'theme') { theme = isDark() ? 'light' : 'dark'; try { localStorage.setItem('theme', theme); } catch {} applyTheme(); renderNav(); }
    else if (a === 'close') closeM();
  } catch (err) { toast(err.message); }
});

document.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, d = Object.fromEntries(new FormData(f)), btn = f.querySelector('button.primary'), err = m => { const x = $('#err'); if (x) x.textContent = m; };
  btn.disabled = true;
  try {
    if (f.id === 'af') {
      const su = f.dataset.tab === 'signup'; d.username = (d.username || '').trim().toLowerCase();
      if (!/^[a-z0-9_]{3,20}$/.test(d.username)) return err('Username must be 3–20 characters: letters, numbers or underscores.');
      if (su && (d.password || '').length < 8) return err('Password must be at least 8 characters.');
      if (!d.password) return err('Please enter your password.');
      afterAuth(await api('POST', su ? '/api/signup' : '/api/login', d));
    } else if (f.id === 'pf') {
      if (!d.title.trim() || !d.abstract.trim()) return err('Please add a title and an abstract.');
      await api('POST', '/api/posts', d); closeM(); F = { q: '', tag: '', u: '' }; $('#search').value = ''; scope = 'all'; await load(); toast('Your study is published.');
    } else if (f.id === 'cf') {
      const text = $('#ci').value.trim(); if (!text) return;
      const c = await api('POST', `/api/posts/${cur}/comments`, { text }); CM.push(c); posts.find(p => p.id === cur).comments++; $('#ci').value = ''; renderFeed(); $('#ci').focus();
    }
  } catch (ex) { f.id === 'cf' ? toast(ex.message) : err(ex.message); }
  finally { btn.disabled = false; }
});

let t1, t2;
$('#search').addEventListener('input', e => { clearTimeout(t1); t1 = setTimeout(() => { F.q = e.target.value.trim(); load(); }, 300); });
document.addEventListener('input', e => { if (e.target.id === 'ps') { clearTimeout(t2); const v = e.target.value; t2 = setTimeout(() => psearch(v), 300); } });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#ov').hidden) closeM();
  else if (e.key === 'Enter' && e.target.classList.contains('card')) openPost(+e.target.dataset.id);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && me) refreshFriends(); });

window.addEventListener('popstate', () => { if (!$('#ov').hidden && mode === 'post') { pushed = false; closeM(); } });
(async () => {
  try { me = await api('GET', '/api/me'); } catch {}
  renderNav(); refreshFriends(); await load();
  const m = location.hash.match(/^#\/study\/(\d+)/);
  if (m && posts.some(p => p.id === +m[1])) openPost(+m[1]); else if (location.hash) history.replaceState(null, '', location.pathname);
})();
