const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const { q, init } = require('./db');

const app = express();
const PROD = process.env.NODE_ENV === 'production';
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const w = f => (req, res, next) => Promise.resolve(f(req, res, next)).catch(e => { console.error(e); bad(res, 'Something went wrong. Please try again.', 500); });
const clean = (s, max) => String(s ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim().slice(0, max);
const like = s => '%' + clean(s, 80).replace(/[\\%_]/g, '\\$&') + '%';
const getToken = req => { const m = (req.headers.cookie || '').match(/(?:^|;\s*)sid=([a-f0-9]{64})/); return m && m[1]; };

const hits = new Map();
const limit = (name, max, ms) => (req, res, next) => {
  const k = name + req.ip, now = Date.now();
  const a = (hits.get(k) || []).filter(t => now - t < ms);
  if (a.length >= max) return bad(res, 'Too many attempts. Please wait a few minutes and try again.', 429);
  a.push(now); hits.set(k, a); next();
};
setInterval(() => { const n = Date.now(); for (const [k, a] of hits) if (!a.some(t => n - t < 36e5)) hits.delete(k); }, 6e5).unref();

async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await q('delete from sessions where expires_at < now()');
  await q(`insert into sessions values($1,$2, now() + interval '14 days')`, [sha(token), userId]);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 14 * 864e5, path: '/' });
}

// ---------- session + CSRF (same-origin check on every write) ----------
app.use(w(async (req, res, next) => {
  req.user = null;
  const t = getToken(req);
  if (t) {
    const r = await q('select u.id,u.username,u.name from sessions s join users u on u.id=s.user_id where s.token_hash=$1 and s.expires_at>now()', [sha(t)]);
    req.user = r.rows[0] || null;
  }
  if (req.method !== 'GET' && req.headers.origin) {
    let same = false;
    try { same = new URL(req.headers.origin).host === req.headers.host; } catch {}
    if (!same) return bad(res, 'Blocked cross-site request.', 403);
  }
  next();
}));
const need = (req, res, next) => (req.user ? next() : bad(res, 'Please log in to do that.', 401));
const writes = limit('write', 60, 6e4);

// ---------- accounts ----------
const DUMMY = bcrypt.hashSync('not-a-real-password', 12); // keeps login timing the same for unknown users

app.post('/api/signup', limit('signup', 5, 36e5), w(async (req, res) => {
  const username = clean(req.body.username, 20).toLowerCase();
  const name = clean(req.body.name, 40) || username;
  const pw = String(req.body.password ?? '');
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return bad(res, 'Username must be 3–20 characters: letters, numbers or underscores.');
  if (pw.length < 8 || pw.length > 72) return bad(res, 'Password must be 8–72 characters.');
  if (pw.toLowerCase().includes(username)) return bad(res, 'Your password should not contain your username.');
  const hash = await bcrypt.hash(pw, 12);
  const r = await q('insert into users(username,name,pass_hash) values($1,$2,$3) on conflict(username) do nothing returning id,username,name', [username, name, hash]);
  if (!r.rows[0]) return bad(res, 'That username is taken. Please try another.', 409);
  await startSession(res, r.rows[0].id);
  res.status(201).json(r.rows[0]);
}));

app.post('/api/login', limit('login', 10, 9e5), w(async (req, res) => {
  const username = clean(req.body.username, 20).toLowerCase();
  const pw = String(req.body.password ?? '').slice(0, 72);
  const u = (await q('select id,username,name,pass_hash from users where username=$1', [username])).rows[0];
  const ok = await bcrypt.compare(pw, u ? u.pass_hash : DUMMY);
  if (!u || !ok) return bad(res, 'Wrong username or password.', 401);
  await startSession(res, u.id);
  res.json({ id: u.id, username: u.username, name: u.name });
}));

app.post('/api/logout', w(async (req, res) => {
  const t = getToken(req);
  if (t) await q('delete from sessions where token_hash=$1', [sha(t)]);
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
}));

app.get('/api/me', (req, res) => res.json(req.user));

// ---------- posts ----------
const FR = `select case when requester_id=$1 then addressee_id else requester_id end from friendships where status='accepted' and (requester_id=$1 or addressee_id=$1)`;

app.get('/api/posts', w(async (req, res) => {
  const p = [req.user ? req.user.id : 0], where = [];
  const add = v => (p.push(v), '$' + p.length);
  const { scope } = req.query;
  if (scope === 'friends' || scope === 'mine') {
    if (!req.user) return bad(res, 'Log in to see this feed.', 401);
    where.push(scope === 'mine' ? 'p.user_id=$1' : `(p.user_id=$1 or p.user_id in (${FR}) or p.id in (select post_id from reposts where user_id in (${FR})))`);
  }
  if (req.query.u) where.push('u.username=' + add(clean(req.query.u, 20).toLowerCase()));
  if (req.query.tag) where.push(add(clean(req.query.tag, 24).toLowerCase()) + ' = any(p.tags)');
  if (req.query.q) { const s = add(like(req.query.q)); where.push(`(p.title ilike ${s} or p.abstract ilike ${s} or array_to_string(p.tags,' ') ilike ${s})`); }
  if (+req.query.before > 0) where.push('p.id<' + add(+req.query.before));
  const r = await q(`
    select p.id,p.title,p.abstract,p.body,p.tags,p.url,p.created_at,u.username,u.name,
      (select count(*)::int from likes where post_id=p.id) likes,
      (select count(*)::int from reposts where post_id=p.id) reposts,
      (select count(*)::int from comments where post_id=p.id) comments,
      exists(select 1 from likes where post_id=p.id and user_id=$1) liked,
      exists(select 1 from reposts where post_id=p.id and user_id=$1) reposted
    from posts p join users u on u.id=p.user_id
    ${where.length ? 'where ' + where.join(' and ') : ''}
    order by p.id desc limit 21`, p);
  res.json({ posts: r.rows.slice(0, 20), more: r.rows.length > 20 });
}));

app.post('/api/posts', need, writes, w(async (req, res) => {
  const title = clean(req.body.title, 200), abstract = clean(req.body.abstract, 1200), body = clean(req.body.body, 8000);
  let url = clean(req.body.url, 500) || null;
  if (!title || !abstract) return bad(res, 'A title and an abstract are required.');
  if (url) {
    try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) throw 0; url = u.href; }
    catch { return bad(res, 'The source link must start with http:// or https://'); }
  }
  const tags = [...new Set(String(req.body.tags ?? '').toLowerCase().split(',').map(t => t.trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24)).filter(Boolean))].slice(0, 5);
  const r = await q('insert into posts(user_id,title,abstract,body,tags,url) values($1,$2,$3,$4,$5,$6) returning id', [req.user.id, title, abstract, body, tags, url]);
  res.status(201).json({ id: r.rows[0].id });
}));

app.delete('/api/posts/:id', need, w(async (req, res) => {
  const r = await q('delete from posts where id=$1 and user_id=$2', [+req.params.id || 0, req.user.id]);
  r.rowCount ? res.json({ ok: true }) : bad(res, 'Study not found, or it is not yours.', 404);
}));

// like / repost toggles (table and column names are fixed in code, never user input)
const toggle = (table, col, parent) => [need, writes, w(async (req, res) => {
  const id = +req.params.id || 0;
  if (!(await q(`select 1 from ${parent} where id=$1`, [id])).rowCount) return bad(res, 'Not found.', 404);
  const d = await q(`delete from ${table} where user_id=$1 and ${col}=$2`, [req.user.id, id]);
  if (!d.rowCount) await q(`insert into ${table}(user_id,${col}) values($1,$2) on conflict do nothing`, [req.user.id, id]);
  const c = await q(`select count(*)::int n from ${table} where ${col}=$1`, [id]);
  res.json({ on: !d.rowCount, count: c.rows[0].n });
})];
app.post('/api/posts/:id/like', ...toggle('likes', 'post_id', 'posts'));
app.post('/api/posts/:id/repost', ...toggle('reposts', 'post_id', 'posts'));
app.post('/api/comments/:id/like', ...toggle('comment_likes', 'comment_id', 'comments'));

// ---------- comments ----------
app.get('/api/posts/:id/comments', w(async (req, res) => {
  const r = await q(`
    select c.id,c.text,c.created_at,u.username,u.name,
      (select count(*)::int from comment_likes where comment_id=c.id) likes,
      exists(select 1 from comment_likes where comment_id=c.id and user_id=$2) liked
    from comments c join users u on u.id=c.user_id where c.post_id=$1 order by c.id limit 300`,
    [+req.params.id || 0, req.user ? req.user.id : 0]);
  res.json(r.rows);
}));

app.post('/api/posts/:id/comments', need, writes, w(async (req, res) => {
  const id = +req.params.id || 0, text = clean(req.body.text, 500);
  if (!text) return bad(res, 'Write something before posting.');
  if (!(await q('select 1 from posts where id=$1', [id])).rowCount) return bad(res, 'Study not found.', 404);
  const r = await q('insert into comments(post_id,user_id,text) values($1,$2,$3) returning id,text,created_at', [id, req.user.id, text]);
  res.status(201).json({ ...r.rows[0], username: req.user.username, name: req.user.name, likes: 0, liked: false });
}));

// authors can delete their comments; the study's owner can moderate comments on it
app.delete('/api/comments/:id', need, w(async (req, res) => {
  const r = await q('delete from comments c using posts p where c.id=$1 and p.id=c.post_id and (c.user_id=$2 or p.user_id=$2)', [+req.params.id || 0, req.user.id]);
  r.rowCount ? res.json({ ok: true }) : bad(res, 'Comment not found, or you cannot delete it.', 404);
}));

// ---------- people & friends ----------
app.get('/api/users', need, w(async (req, res) => {
  const r = await q(`
    select u.username,u.name,
      (select case when f.status='accepted' then 'friend' when f.requester_id=$1::int then 'sent' else 'incoming' end from friendships f
        where least(f.requester_id,f.addressee_id)=least($1::int,u.id) and greatest(f.requester_id,f.addressee_id)=greatest($1::int,u.id)) rel
    from users u where u.id<>$1::int and u.pass_hash<>'!' and (u.username ilike $2 or u.name ilike $2) order by u.username limit 10`,
    [req.user.id, like(req.query.q)]);
  res.json(r.rows);
}));

app.get('/api/friends', need, w(async (req, res) => {
  const r = await q(`
    select u.username,u.name,f.status,(f.requester_id=$1) as mine from friendships f
    join users u on u.id = case when f.requester_id=$1 then f.addressee_id else f.requester_id end
    where f.requester_id=$1 or f.addressee_id=$1 order by u.username`, [req.user.id]);
  res.json({
    friends: r.rows.filter(x => x.status === 'accepted'),
    incoming: r.rows.filter(x => x.status === 'pending' && !x.mine),
    outgoing: r.rows.filter(x => x.status === 'pending' && x.mine),
  });
}));

const target = async req => (await q('select id from users where username=$1', [clean(req.params.username, 20).toLowerCase()])).rows[0];

// send a request; if they already asked you, this accepts it
app.post('/api/friends/:username', need, writes, w(async (req, res) => {
  const t = await target(req);
  if (!t) return bad(res, 'Person not found.', 404);
  if (t.id === req.user.id) return bad(res, "You can't add yourself.");
  const a = await q(`update friendships set status='accepted' where requester_id=$1 and addressee_id=$2 and status='pending'`, [t.id, req.user.id]);
  if (!a.rowCount) await q('insert into friendships(requester_id,addressee_id) values($1,$2) on conflict do nothing', [req.user.id, t.id]);
  res.json({ ok: true });
}));

// remove a friend, decline a request, or cancel one you sent
app.delete('/api/friends/:username', need, w(async (req, res) => {
  const t = await target(req);
  if (!t) return bad(res, 'Person not found.', 404);
  await q('delete from friendships where (requester_id=$1 and addressee_id=$2) or (requester_id=$2 and addressee_id=$1)', [req.user.id, t.id]);
  res.json({ ok: true });
}));

app.use((err, req, res, next) => bad(res, 'That request could not be read.', 400));

init().then(() => app.listen(process.env.PORT || 3000, () => console.log('Scroll Studies running')))
  .catch(e => { console.error(e); process.exit(1); });
