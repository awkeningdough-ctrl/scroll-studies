const { Pool } = require('pg');
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required (a Postgres connection string).'); process.exit(1); }
const pool = new Pool({ connectionString: url, ssl: /\.render\.com|sslmode=require/.test(url) ? { rejectUnauthorized: false } : false, max: 10 });
const q = (text, params) => pool.query(text, params);

async function init() {
  // v1 of this app used different reposts/comments tables; replace them.
  const old = await q(`select 1 from information_schema.columns where table_name='reposts' and column_name='study_id'`);
  if (old.rowCount) await q('drop table if exists reposts, comments');
  await q(`
    create table if not exists users(id serial primary key, username text unique not null, name text not null, pass_hash text not null, created_at timestamptz default now());
    create table if not exists sessions(token_hash text primary key, user_id int not null references users(id) on delete cascade, expires_at timestamptz not null);
    create table if not exists posts(id serial primary key, user_id int not null references users(id) on delete cascade, title text not null, abstract text not null, body text not null default '', tags text[] not null default '{}', url text, created_at timestamptz default now());
    create table if not exists comments(id serial primary key, post_id int not null references posts(id) on delete cascade, user_id int not null references users(id) on delete cascade, text text not null, created_at timestamptz default now());
    create table if not exists likes(user_id int references users(id) on delete cascade, post_id int references posts(id) on delete cascade, primary key(user_id, post_id));
    create table if not exists reposts(user_id int references users(id) on delete cascade, post_id int references posts(id) on delete cascade, primary key(user_id, post_id));
    create table if not exists comment_likes(user_id int references users(id) on delete cascade, comment_id int references comments(id) on delete cascade, primary key(user_id, comment_id));
    create table if not exists friendships(requester_id int references users(id) on delete cascade, addressee_id int references users(id) on delete cascade, status text not null default 'pending', created_at timestamptz default now(), primary key(requester_id, addressee_id));
    create unique index if not exists friend_pair on friendships(least(requester_id, addressee_id), greatest(requester_id, addressee_id));
    create index if not exists posts_user on posts(user_id);
    create index if not exists comments_post on comments(post_id);
  `);
  const n = await q('select count(*)::int n from posts');
  if (!n.rows[0].n) { // curated starter studies from an unloginable system account
    const u = await q(`insert into users(username,name,pass_hash) values('scrollstudies','Scroll Studies','!') on conflict(username) do update set name=excluded.name returning id`);
    for (const s of require('./studies.json')) {
      const body = `Key points\n${s.pts.map(p => '• ' + p).join('\n')}\n\n${s.a}, ${s.v} ${s.y}`;
      const tags = s.tags.map(t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
      await q('insert into posts(user_id,title,abstract,body,tags) values($1,$2,$3,$4,$5)', [u.rows[0].id, s.t, s.abs, body, tags]);
    }
  }
}
module.exports = { q, init };
