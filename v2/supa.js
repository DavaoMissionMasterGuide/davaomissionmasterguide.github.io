/* Master Guide Registry — Supabase connection.
   Gives the pages the same actions the old Google backend had (MG_API.call(action, data)),
   so the screens stay the same. */
(function () {
  const C = window.MG_CONFIG || {};
  const ready = !!(C.SUPABASE_URL && C.SUPABASE_KEY && window.supabase);
  const sb = ready ? window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } }) : null;
  const EMAIL_DOMAIN = '@dmmg.local';
  const BUCKET = 'certs';

  /* ---------- small helpers ---------- */
  const pad = n => String(n).padStart(2, '0');
  const ts = v => { if (!v) return ''; const d = new Date(v); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const one = v => Array.isArray(v) ? v[0] : v;
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
  const dateOrNull = (v, label) => {
    v = String(v || '').trim(); if (!v) return null;
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/), d = m && new Date(+m[1], +m[2] - 1, +m[3]);
    if (!d || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) throw new Error(label + ' is not a valid date ("' + v + '").');
    return v;
  };
  function fail(error, context) {
    const msg = String((error && (error.message || error.error_description)) || error || 'Something went wrong.');
    let nice = msg;
    if (/row-level security|permission denied/i.test(msg)) nice = 'You are not allowed to do that.';
    else if (/foreign key/i.test(msg)) nice = context || 'This item is still in use, so it cannot be removed.';
    else if (/check constraint/i.test(msg)) nice = 'Please check the values you entered.';
    else if (/duplicate key/i.test(msg)) nice = 'That name is already used.';
    else if (/Failed to fetch|NetworkError/i.test(msg)) nice = 'Cannot reach the server. Check your internet connection.';
    else if (/Invalid login credentials/i.test(msg)) nice = 'Wrong username or password.';
    else if (/JWT|session/i.test(msg) && /expired|missing|invalid/i.test(msg)) { const e = new Error('SESSION_EXPIRED'); e.code = 'SESSION_EXPIRED'; throw e; }
    throw new Error(nice);
  }
  const ok = r => { if (r.error) fail(r.error); return r.data; };
  async function all(make) {           // read every row, 1000 at a time
    let out = [], from = 0;
    for (;;) {
      const r = await make().range(from, from + 999);
      if (r.error) fail(r.error);
      out = out.concat(r.data || []);
      if (!r.data || r.data.length < 1000) return out;
      from += 1000;
    }
  }
  function b64ToBlob(data, mime) {
    const bin = atob(data), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  function blobToB64(blob) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(blob); });
  }
  // photos are shrunk before upload (saves the free 1 GB storage); PDFs stay as they are
  async function shrink(blob) {
    if (!/^image\//.test(blob.type) || !window.createImageBitmap) return blob;
    try {
      const img = await createImageBitmap(blob), max = 1800, k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const out = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.78));
      return out && out.size < blob.size ? out : blob;
    } catch (e) { return blob; }
  }
  const safeName = s => String(s || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);
  async function uploadFile(path, file) {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (allowed.indexOf(file.mime) < 0) throw new Error('Certificate must be a PDF, JPG or PNG file.');
    let blob = await shrink(b64ToBlob(file.data, file.mime));
    if (blob.size > 5 * 1024 * 1024) throw new Error('File is too large (maximum 5 MB).');
    const name = blob.type === 'image/jpeg' && file.mime !== 'image/jpeg' ? safeName(file.name).replace(/\.\w+$/, '') + '.jpg' : safeName(file.name);
    const full = path + '/' + Date.now() + '-' + name;
    ok(await sb.storage.from(BUCKET).upload(full, blob, { contentType: blob.type, upsert: false }));
    return { path: full, name: file.name || name };
  }
  async function removeFile(path) { if (path) await sb.storage.from(BUCKET).remove([path]); }
  async function downloadFile(path, name) {
    if (!path) throw new Error('No certificate uploaded yet.');
    const blob = ok(await sb.storage.from(BUCKET).download(path));
    return { name: name || 'certificate', mime: blob.type, data: await blobToB64(blob) };
  }

  /* ---------- shapes the screens expect ---------- */
  const mOut = m => {
    const c = one(m.member_contacts) || {};
    return { id: m.id, fullName: m.full_name, cluster: m.cluster, district: m.district, church: m.church,
      trainingDate: m.training_date || '', investedDate: m.invested_date || '', stageId: m.stage_id, docs: m.docs || [],
      certName: m.cert_name, hasCert: !!m.cert_path, updatedAt: ts(m.updated_at), updatedBy: m.updated_by, phone: c.phone || '', email: c.email || '' };
  };
  const uOut = p => ({ id: p.id, username: p.username, email: '', name: p.name, role: p.role, cluster: p.cluster || '', mustChange: !!p.must_change, memberId: p.member_id || '' });
  const accOut = p => ({ userId: p.id, username: p.username, memberId: p.member_id, active: p.status === 'active' ? 'true' : 'false', lastLogin: ts(p.last_login), email: '' });
  const reqOut = r => ({ id: r.id, type: r.type, userId: r.user_id, username: (one(r.profiles) || {}).username || '', memberId: r.member_id, cluster: r.cluster,
    payload: r.payload || {}, status: r.status, createdAt: ts(r.created_at), decidedBy: r.decided_by, decidedAt: ts(r.decided_at), reply: r.reply });
  const tOut = t => ({ id: t.id, memberId: t.member_id, cluster: t.cluster, trainingId: t.training_id || '', customName: t.custom_name, date: t.date || '', place: t.place,
    notes: t.notes, status: t.status, hasCert: !!t.cert_path, certName: t.cert_name, addedBy: t.added_by, addedAt: ts(t.added_at), verifiedBy: t.verified_by,
    verifiedAt: ts(t.verified_at), reply: t.reply, fullName: (one(t.members) || {}).full_name || '' });
  const pOut = (p, me) => {
    const active = p.kind === 'event' ? (p.event_end || p.event_date || '9999') >= today() : (!p.expires || p.expires >= today());
    return { id: p.id, kind: p.kind, scope: p.scope, title: p.title, body: p.body, eventDate: p.event_date || '', eventEnd: p.event_end || '',
      eventTime: p.event_time, venue: p.venue, link: p.link, pinned: !!p.pinned, expires: p.expires || '', authorName: p.author_name,
      createdAt: ts(p.created_at), updatedAt: ts(p.updated_at), active: active,
      canEdit: me ? (me.role === 'director' || (p.scope !== 'general' && p.scope === me.cluster)) : false };
  };
  const list = async table => ok(await sb.from(table).select('id,name,sort').order('sort'));
  const names = rows => rows.map(r => ({ id: r.id, name: r.name }));

  /* ---------- session ---------- */
  let ME = null;
  async function profile() {
    const s = (await sb.auth.getSession()).data.session;
    if (!s) { ME = null; return null; }
    const p = ok(await sb.from('profiles').select('*').eq('id', s.user.id).maybeSingle());
    ME = p; return p;
  }
  async function requireMe(opts) {
    const p = await profile();
    if (!p) { const e = new Error('SESSION_EXPIRED'); e.code = 'SESSION_EXPIRED'; throw e; }
    if (p.status !== 'active') { await sb.auth.signOut(); throw new Error(p.status === 'pending' ? 'Your account is waiting for approval by your Cluster Coordinator.' : 'This account is disabled. Please contact your Cluster Coordinator.'); }
    if (p.must_change && !(opts && opts.allowMustChange)) { const e = new Error('MUST_CHANGE_PASSWORD'); e.code = 'MUST_CHANGE_PASSWORD'; throw e; }
    return p;
  }
  const isDir = () => ME && ME.role === 'director';

  async function loadMembers(where) {
    const rows = await all(() => { let q = sb.from('members').select('*, member_contacts(phone,email)').order('full_name'); if (where) q = where(q); return q; });
    return rows.map(mOut);
  }
  async function memberAccounts() {
    const rows = await all(() => sb.from('profiles').select('id,username,member_id,status,last_login').eq('role', 'member').not('member_id', 'is', null));
    return rows.map(accOut);
  }
  async function getSettings() { const o = {}; ok(await sb.from('settings').select('*')).forEach(r => o[r.key] = r.value); return o; }

  /* ---------- the actions ---------- */
  const A = {};

  A.login = async d => {
    const username = String(d.username || '').trim().toLowerCase();
    const r = await sb.auth.signInWithPassword({ email: username + EMAIL_DOMAIN, password: String(d.password || '') });
    if (r.error) fail(r.error);
    const p = await profile();
    if (!p) { await sb.auth.signOut(); throw new Error('Account not found.'); }
    if (p.status !== 'active') { await sb.auth.signOut(); throw new Error(p.status === 'pending' ? 'Your account is waiting for approval by your Cluster Coordinator.' : 'This account is disabled. Please contact your Cluster Coordinator.'); }
    sb.rpc('touch_login').then(() => {}, () => {});
    return { token: 'sb', user: uOut(p) };
  };
  A.logout = async () => { await sb.auth.signOut(); ME = null; return {}; };
  A.me = async () => ({ user: uOut(await requireMe({ allowMustChange: true })) });

  // a person the Director prepared signs up with their username (staff)
  A.claimInvite = async d => {
    const u = String(d.username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(u)) throw new Error('Username must be 3–40 characters: letters, numbers, dot, dash or underscore.');
    if (String(d.password || '').length < 8) throw new Error('Password must be at least 8 characters.');
    const inv = ok(await sb.rpc('username_invited', { u: u }));
    if (!inv) throw new Error('This username was not prepared by the Director, or it is already registered. Ask the Director to add it in Accounts.');
    const r = await sb.auth.signUp({ email: u + EMAIL_DOMAIN, password: d.password, options: { data: { username: u, name: clean(d.name, 80) } } });
    if (r.error) fail(r.error);
    if (!r.data.session) { const s = await sb.auth.signInWithPassword({ email: u + EMAIL_DOMAIN, password: d.password }); if (s.error) fail(s.error); }
    const p = await profile();
    return { token: 'sb', user: uOut(p) };
  };

  // a Master Guide asks for an account (needs approval)
  A.signup = async d => {
    const s = d.signup || {};
    const u = String(s.username || '').trim().toLowerCase();
    if (!clean(s.fullName, 120)) throw new Error('Please enter your full name.');
    if (!s.cluster) throw new Error('Please choose your cluster.');
    if (!clean(s.district, 80) || !clean(s.church, 120)) throw new Error('Please enter your district and church.');
    if (!/^[a-z0-9._-]{3,40}$/.test(u)) throw new Error('Username must be 3–40 characters: letters, numbers, dot, dash or underscore (no spaces).');
    if (String(s.password || '').length < 8) throw new Error('Password must be at least 8 characters.');
    if (!ok(await sb.rpc('username_available', { u: u }))) throw new Error('That username is already taken. Please choose another.');
    const r = await sb.auth.signUp({ email: u + EMAIL_DOMAIN, password: s.password, options: { data: {
      username: u, name: clean(s.fullName, 120), cluster: s.cluster, district: clean(s.district, 80), church: clean(s.church, 120),
      phone: clean(s.phone, 40), contactEmail: clean(s.email, 120), note: clean(s.note, 300) } } });
    if (r.error) fail(r.error);
    await sb.auth.signOut();
    return { ok: true };
  };

  A.changePassword = async d => {
    const p = await requireMe({ allowMustChange: true });
    const nw = String(d.newPassword || '');
    if (nw.length < 8) throw new Error('New password must be at least 8 characters.');
    if (!p.must_change) {
      const chk = await sb.auth.signInWithPassword({ email: p.username + EMAIL_DOMAIN, password: String(d.oldPassword || '') });
      if (chk.error) throw new Error('Current password is incorrect.');
    }
    const r = await sb.auth.updateUser({ password: nw });
    if (r.error) fail(r.error);
    ok(await sb.rpc('clear_must_change'));
    return { user: uOut(await profile()) };
  };

  /* ----- public page ----- */
  A.public = async () => {
    const [st, cl, docs, set, posts] = await Promise.all([list('stages'), ok(await sb.from('clusters').select('name').order('sort')), list('documents'), getSettings(),
      ok(await sb.from('active_posts').select('*'))]);
    const members = await all(() => sb.from('public_members').select('*').order('n'));
    const show = set.showDocCount !== 'false';
    return { ok: true, title: set.siteTitle || '', subtitle: set.subtitle || '', showDocCount: show, docsTotal: docs.length, stages: names(st),
      clusters: cl.map(c => c.name), places: [], updated: ts(new Date()),
      members: members.map(m => { const o = { n: m.n, cl: m.cl, di: m.di, ch: m.ch, td: m.td || '', inv: m.inv || '', st: m.st }; if (show) o.dc = m.dc; return o; }),
      posts: posts.map(p => pOut(p)) };
  };
  A.config = async () => {
    const [set, cl] = await Promise.all([getSettings(), ok(await sb.from('clusters').select('name').order('sort'))]);
    return { ok: true, siteTitle: set.siteTitle || '', subtitle: set.subtitle || '', googleClientId: '', clusters: cl.map(c => c.name) };
  };

  /* ----- admin: start ----- */
  A.bootstrap = async () => {
    const p = await requireMe();
    if (p.role === 'member') throw new Error('This action is not available for your account.');
    const [st, docs, tr, cl, set, members, accounts, pr, pt] = await Promise.all([
      list('stages'), list('documents'), list('trainings'), ok(await sb.from('clusters').select('name').order('sort')), getSettings(),
      loadMembers(), memberAccounts(),
      sb.from('requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
      sb.from('person_trainings').select('id', { count: 'exact', head: true }).eq('status', 'pending')]);
    return { user: uOut(p), stages: names(st), documents: names(docs), trainings: names(tr), clusters: cl.map(c => c.name), members: members, places: [],
      memberAccounts: accounts, pendingRequests: (pr.count || 0) + (pt.count || 0),
      settings: p.role === 'director' ? { siteTitle: set.siteTitle || '', subtitle: set.subtitle || '', showDocCount: set.showDocCount !== 'false', googleClientId: '' } : { siteTitle: set.siteTitle || '' } };
  };

  /* ----- members ----- */
  async function memberById(id) { return mOut(ok(await sb.from('members').select('*, member_contacts(phone,email)').eq('id', id).single())); }
  A.saveMember = async d => {
    await requireMe();
    const m = d.member || {};
    const row = { full_name: clean(m.fullName, 120), cluster: m.cluster, district: clean(m.district, 80), church: clean(m.church, 120),
      training_date: dateOrNull(m.trainingDate, 'Date of training'), invested_date: dateOrNull(m.investedDate, 'Date invested'),
      stage_id: m.stageId || null, docs: Array.isArray(m.docs) ? m.docs : [] };
    if (!row.full_name) throw new Error('Full name is required.');
    let id = m.id;
    if (!id) {
      if (!d.force) {
        const dup = ok(await sb.from('members').select('id,church').eq('cluster', row.cluster).ilike('full_name', row.full_name.replace(/[%_]/g, '\\$&')));
        if (dup.length) return { duplicate: true, message: row.full_name + ' already exists in ' + row.cluster + (dup[0].church ? ' (' + dup[0].church + ')' : '') + '.' };
      }
      id = ok(await sb.from('members').insert(row).select('id').single()).id;
    } else {
      ok(await sb.from('members').update(row).eq('id', id).select('id').single());
    }
    if (m.phone !== undefined || m.email !== undefined) {
      ok(await sb.from('member_contacts').upsert({ member_id: id, phone: clean(m.phone, 40), email: clean(m.email, 120) }));
    }
    return { member: await memberById(id) };
  };
  A.deleteMember = async d => {
    await requireMe();
    const m = ok(await sb.from('members').select('cert_path').eq('id', d.id).single());
    const tr = ok(await sb.from('person_trainings').select('cert_path').eq('member_id', d.id));
    const paths = [m.cert_path].concat(tr.map(t => t.cert_path)).filter(Boolean);
    ok(await sb.from('members').delete().eq('id', d.id).select('id').single());
    if (paths.length) await sb.storage.from(BUCKET).remove(paths);
    return {};
  };
  A.importMembers = async d => {
    await requireMe();
    const r = ok(await sb.rpc('import_members', { rows: d.rows || [] }));
    const off = Number(d.lineOffset || 0);
    return { added: r.added, skipped: (r.skipped || []).map(s => ({ line: s.line + off, reason: s.reason })) };
  };
  A.uploadCert = async d => {
    await requireMe();
    const old = ok(await sb.from('members').select('cert_path').eq('id', d.id).single());
    const f = await uploadFile('m/' + d.id, d);
    ok(await sb.from('members').update({ cert_path: f.path, cert_name: f.name }).eq('id', d.id).select('id').single());
    await removeFile(old.cert_path);
    return { member: await memberById(d.id) };
  };
  A.getCert = async d => { const m = ok(await sb.from('members').select('cert_path,cert_name').eq('id', d.id).single()); return downloadFile(m.cert_path, m.cert_name); };
  A.removeCert = async d => {
    const m = ok(await sb.from('members').select('cert_path').eq('id', d.id).single());
    ok(await sb.from('members').update({ cert_path: '', cert_name: '' }).eq('id', d.id).select('id').single());
    await removeFile(m.cert_path);
    return { member: await memberById(d.id) };
  };

  /* ----- stages / documents / trainings / clusters (Director) ----- */
  async function saveList(table, items, inUseMsg) {
    await requireMe();
    items = (items || []).map((x, i) => ({ id: x.id || null, name: clean(x.name, 120), sort: i + 1 }));
    if (items.some(x => !x.name)) throw new Error('Every item needs a name.');
    const seen = {}; items.forEach(x => { const k = norm(x.name); if (seen[k]) throw new Error('"' + x.name + '" is listed twice.'); seen[k] = 1; });
    const current = ok(await sb.from(table).select('id'));
    const keep = items.filter(x => x.id).map(x => x.id);
    const removed = current.filter(c => keep.indexOf(c.id) < 0).map(c => c.id);
    if (removed.length) { const r = await sb.from(table).delete().in('id', removed); if (r.error) fail(r.error, inUseMsg); }
    for (const x of items) {
      if (x.id) ok(await sb.from(table).update({ name: x.name, sort: x.sort }).eq('id', x.id));
      else ok(await sb.from(table).insert({ name: x.name, sort: x.sort }));
    }
    return { items: names(await list(table)) };
  }
  A.saveStages = d => saveList('stages', d.items, 'A stage you removed is still used by some Master Guides. Move them to another stage first.');
  A.saveDocuments = d => saveList('documents', d.items);
  A.saveTrainings = d => saveList('trainings', d.items, 'A training you removed is still used. Rename it instead.');
  A.saveClusters = async d => {
    await requireMe();
    const items = (d.items || []).map((x, i) => ({ old: x.old || '', name: clean(x.name, 80), sort: i + 1 }));
    if (!items.length || items.some(x => !x.name)) throw new Error('Every cluster needs a name.');
    const current = ok(await sb.from('clusters').select('name')).map(c => c.name);
    const kept = items.map(x => x.old).filter(Boolean);
    for (const n of current.filter(n => kept.indexOf(n) < 0)) {
      const r = await sb.from('clusters').delete().eq('name', n);
      if (r.error) fail(r.error, '"' + n + '" still has Master Guides or accounts. Move them first.');
    }
    for (const x of items) {
      if (x.old) ok(await sb.from('clusters').update({ name: x.name, sort: x.sort }).eq('name', x.old));
      else ok(await sb.from('clusters').insert({ name: x.name, sort: x.sort }));
    }
    return { clusters: ok(await sb.from('clusters').select('name').order('sort')).map(c => c.name) };
  };

  /* ----- staff accounts (Director) ----- */
  A.listUsers = async () => {
    await requireMe();
    const [ps, inv] = await Promise.all([ok(await sb.from('profiles').select('*').neq('role', 'member').order('username')), ok(await sb.from('invites').select('*').order('username'))]);
    return { users: ps.map(p => Object.assign(uOut(p), { active: p.status === 'active', lastLogin: ts(p.last_login), hasPassword: true }))
      .concat(inv.map(i => ({ id: 'invite:' + i.username, username: i.username, name: i.name, role: i.role, cluster: i.cluster || '', active: true, invited: true, lastLogin: '' }))) };
  };
  A.saveUser = async d => {
    await requireMe();
    const u = d.user || {};
    const role = u.role === 'director' ? 'director' : 'coordinator';
    const cluster = role === 'coordinator' ? u.cluster : null;
    if (role === 'coordinator' && !cluster) throw new Error('Choose a cluster for this coordinator.');
    if (!u.id || String(u.id).indexOf('invite:') === 0) {
      const username = clean(u.username, 40).toLowerCase();
      if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new Error('Username must be 3–40 characters: letters, numbers, dot, dash or underscore (no spaces).');
      if (!u.id && !ok(await sb.rpc('username_available', { u: username }))) throw new Error('Username "' + username + '" is already taken.');
      ok(await sb.from('invites').upsert({ username: username, name: clean(u.name, 80), role: role, cluster: cluster }));
    } else {
      ok(await sb.rpc('admin_update_account', { uid: u.id, new_status: u.active === false ? 'disabled' : 'active', new_password: u.password || null,
        new_role: role, new_cluster: cluster, new_name: clean(u.name, 80) }));
    }
    return A.listUsers();
  };
  A.deleteUser = async d => {
    await requireMe();
    if (String(d.id).indexOf('invite:') === 0) ok(await sb.from('invites').delete().eq('username', String(d.id).slice(7)));
    else ok(await sb.rpc('admin_delete_account', { uid: d.id }));
    return A.listUsers();
  };
  A.setMemberAccount = async d => {
    await requireMe();
    ok(await sb.rpc('admin_update_account', { uid: d.userId, new_status: d.active === undefined ? null : (d.active ? 'active' : 'disabled'), new_password: d.password || null }));
    const p = ok(await sb.from('profiles').select('id,username,member_id,status,last_login').eq('id', d.userId).single());
    return { account: accOut(p) };
  };

  /* ----- settings & log ----- */
  A.saveSettings = async d => {
    await requireMe();
    const s = d.settings || {};
    ok(await sb.from('settings').upsert([{ key: 'siteTitle', value: clean(s.siteTitle, 100) || 'Davao Mission Master Guides' },
      { key: 'subtitle', value: clean(s.subtitle, 150) }, { key: 'showDocCount', value: s.showDocCount === false ? 'false' : 'true' }]));
    const set = await getSettings();
    return { settings: { siteTitle: set.siteTitle, subtitle: set.subtitle, showDocCount: set.showDocCount !== 'false', googleClientId: '' } };
  };
  A.getLog = async () => {
    await requireMe();
    const NAMES = { 'members insert': 'Add Master Guide', 'members update': 'Edit Master Guide', 'members delete': 'Delete Master Guide',
      'posts insert': 'New post', 'posts update': 'Edit post', 'posts delete': 'Delete post', 'requests insert': 'New request', 'requests update': 'Request decided',
      'person_trainings insert': 'Add training', 'person_trainings update': 'Training verified / changed', 'person_trainings delete': 'Delete training',
      'profiles update': 'Account changed', 'profiles delete': 'Account deleted', 'invites insert': 'Account prepared', 'invites delete': 'Account created / invite removed' };
    return { log: ok(await sb.from('audit_log').select('*').order('id', { ascending: false }).limit(300)).map(l => ({ time: ts(l.at), user: l.actor, action: NAMES[l.action] || l.action, detail: l.detail })) };
  };

  /* ----- requests ----- */
  A.listRequests = async () => {
    await requireMe();
    const [pend, dec, tr] = await Promise.all([
      ok(await sb.from('requests').select('*, profiles(username)').eq('status', 'pending').order('created_at')),
      ok(await sb.from('requests').select('*, profiles(username)').neq('status', 'pending').order('decided_at', { ascending: false }).limit(50)),
      ok(await sb.from('person_trainings').select('*, members(full_name)').eq('status', 'pending').order('added_at'))]);
    return { pending: pend.map(reqOut), decided: dec.map(reqOut), trainings: tr.map(tOut) };
  };
  A.decideRequest = async d => {
    await requireMe();
    ok(await sb.rpc('decide_request', { req: d.id, approve: d.decision === 'approve', link_member: d.memberId || null, reply_text: d.reply || '' }));
    return A.listRequests();
  };

  /* ----- personal trainings ----- */
  const trainingsOf = async memberId => ok(await sb.from('person_trainings').select('*').eq('member_id', memberId).order('date', { ascending: false, nullsFirst: false })).map(tOut);
  function trainingRow(e) {
    const r = { training_id: e.trainingId || null, custom_name: e.trainingId ? '' : clean(e.customName, 120), date: dateOrNull(e.date, 'Date completed'),
      place: clean(e.place, 150), notes: clean(e.notes, 300) };
    if (!r.training_id && !r.custom_name) throw new Error('Choose a training from the list or type its name.');
    return r;
  }
  async function addTraining(memberId, entry, file) {
    const row = Object.assign({ member_id: memberId }, trainingRow(entry || {}));
    if (file && file.data) { const f = await uploadFile('t/' + memberId, file); row.cert_path = f.path; row.cert_name = f.name; }
    const r = await sb.from('person_trainings').insert(row);
    if (r.error) { if (row.cert_path) await removeFile(row.cert_path); fail(r.error); }
  }
  async function deleteTraining(id) {
    const t = ok(await sb.from('person_trainings').select('cert_path,member_id').eq('id', id).single());
    ok(await sb.from('person_trainings').delete().eq('id', id).select('id').single());
    await removeFile(t.cert_path);
    return t.member_id;
  }
  A.listMemberTrainings = async d => { await requireMe(); return { items: await trainingsOf(d.memberId) }; };
  A.saveMemberTraining = async d => { await requireMe(); await addTraining(d.entry.memberId, d.entry, d.file); return { items: await trainingsOf(d.entry.memberId) }; };
  A.deleteMemberTraining = async d => { await requireMe(); const mid = await deleteTraining(d.id); return { items: await trainingsOf(mid) }; };
  A.verifyTraining = async d => {
    await requireMe();
    ok(await sb.rpc('verify_training', { tid: d.id, approve: !!d.approve, reply_text: d.reply || '' }));
    const t = ok(await sb.from('person_trainings').select('member_id').eq('id', d.id).single());
    return { items: await trainingsOf(t.member_id) };
  };
  A.getTrainingCert = async d => { const t = ok(await sb.from('person_trainings').select('cert_path,cert_name').eq('id', d.id).single()); return downloadFile(t.cert_path, t.cert_name); };

  /* ----- bulletin ----- */
  A.listPosts = async () => { const p = await requireMe(); return { posts: ok(await sb.from('posts').select('*').order('updated_at', { ascending: false })).map(x => pOut(x, p)) }; };
  A.savePost = async d => {
    await requireMe();
    const x = d.post || {};
    const row = { kind: x.kind === 'event' ? 'event' : 'announcement', scope: x.scope || 'general', title: clean(x.title, 120),
      body: String(x.body || '').replace(/\r\n/g, '\n').trim().slice(0, 3000), event_date: dateOrNull(x.eventDate, 'Activity date'),
      event_end: dateOrNull(x.eventEnd, 'End date'), event_time: clean(x.eventTime, 60), venue: clean(x.venue, 150), link: clean(x.link, 500),
      pinned: !!x.pinned, expires: dateOrNull(x.expires, 'Show until') };
    if (!row.title) throw new Error('Please enter a title.');
    if (row.link && !/^https?:\/\/\S+$/i.test(row.link)) throw new Error('The link must start with http:// or https://');
    if (row.kind === 'event' && !row.event_date) throw new Error('Please enter the date of the activity.');
    if (row.event_end && row.event_date && row.event_end < row.event_date) throw new Error('The end date is before the start date.');
    if (x.id) ok(await sb.from('posts').update(row).eq('id', x.id).select('id').single());
    else ok(await sb.from('posts').insert(row));
    return A.listPosts();
  };
  A.deletePost = async d => { await requireMe(); ok(await sb.from('posts').delete().eq('id', d.id).select('id').single()); return A.listPosts(); };

  /* ----- My Profile (Master Guide) ----- */
  A.myProfile = async () => {
    const p = await requireMe();
    if (p.role !== 'member') throw new Error('This action is not available for your account.');
    const [mem, st, docs, tr, reqs, posts] = await Promise.all([
      p.member_id ? sb.from('members').select('*, member_contacts(phone,email)').eq('id', p.member_id).maybeSingle() : Promise.resolve({ data: null }),
      list('stages'), list('documents'), list('trainings'),
      ok(await sb.from('requests').select('*').eq('user_id', p.id).eq('type', 'change').order('created_at', { ascending: false }).limit(30)),
      ok(await sb.from('active_posts').select('*').in('scope', ['general', p.cluster]))]);
    if (mem.error) fail(mem.error);
    return { user: uOut(p), member: mem.data ? mOut(mem.data) : null, stages: names(st), documents: names(docs), trainings: names(tr),
      requests: reqs.map(reqOut), myTrainings: p.member_id ? await trainingsOf(p.member_id) : [], posts: posts.map(x => pOut(x)) };
  };
  A.updateContact = async d => {
    const p = await requireMe();
    if (d.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email)) throw new Error('Please enter a valid email (or leave it blank).');
    ok(await sb.from('member_contacts').upsert({ member_id: p.member_id, phone: clean(d.phone, 40), email: clean(d.email, 120) }));
    return { member: await memberById(p.member_id) };
  };
  A.requestChange = async d => {
    await requireMe();
    let value = clean(d.value, d.field === 'other' ? 300 : 120);
    if (d.field === 'trainingDate' || d.field === 'investedDate') value = dateOrNull(value, 'Date') || '';
    if (!value && !clean(d.note, 300)) throw new Error('Please type the correct value or a note.');
    ok(await sb.from('requests').insert({ type: 'change', payload: { field: d.field, value: value, note: clean(d.note, 300) } }));
    return A.myProfile();
  };
  A.myCert = async () => { const p = await requireMe(); const m = ok(await sb.from('members').select('cert_path,cert_name').eq('id', p.member_id).single()); return downloadFile(m.cert_path, m.cert_name); };
  A.addMyTraining = async d => { const p = await requireMe(); if (!p.member_id) throw new Error('Your account is not linked to a Master Guide record yet.'); await addTraining(p.member_id, d.entry, d.file); return { myTrainings: await trainingsOf(p.member_id) }; };
  A.deleteMyTraining = async d => { const p = await requireMe(); await deleteTraining(d.id); return { myTrainings: await trainingsOf(p.member_id) }; };
  A.myTrainingCert = A.getTrainingCert;

  /* ----- backup (Director): every table as CSV ----- */
  A.backup = async () => {
    await requireMe();
    if (!isDir()) throw new Error('Only the Director can download the full backup.');
    const csv = rows => {
      if (!rows.length) return '';
      const cols = Object.keys(rows[0]).filter(k => typeof rows[0][k] !== 'object' || rows[0][k] === null || Array.isArray(rows[0][k]));
      const cell = v => { v = v == null ? '' : Array.isArray(v) ? v.join(';') : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      return [cols.join(',')].concat(rows.map(r => cols.map(c => cell(r[c])).join(','))).join('\r\n');
    };
    const stages = await list('stages'), docs = await list('documents'), tr = await list('trainings');
    const sName = {}; stages.forEach(x => sName[x.id] = x.name); const dName = {}; docs.forEach(x => dName[x.id] = x.name); const tName = {}; tr.forEach(x => tName[x.id] = x.name);
    const members = await all(() => sb.from('members').select('*, member_contacts(phone,email)').order('full_name'));
    const pt = await all(() => sb.from('person_trainings').select('*, members(full_name)').order('added_at'));
    const tables = {
      'master-guides': csv(members.map(m => { const c = one(m.member_contacts) || {}; return { full_name: m.full_name, cluster: m.cluster, district: m.district, church: m.church,
        training_date: m.training_date || '', invested_date: m.invested_date || '', stage: sName[m.stage_id] || '', documents: (m.docs || []).map(d => dName[d] || '').filter(Boolean),
        certificate_file: m.cert_name, phone: c.phone || '', email: c.email || '', updated_at: ts(m.updated_at), updated_by: m.updated_by, id: m.id }; })),
      'trainings': csv(pt.map(t => ({ master_guide: (one(t.members) || {}).full_name || '', training: t.custom_name || tName[t.training_id] || '', date: t.date || '', place: t.place,
        status: t.status, notes: t.notes, certificate_file: t.cert_name, added_by: t.added_by, verified_by: t.verified_by }))),
      'posts': csv(await all(() => sb.from('posts').select('kind,scope,title,body,event_date,event_end,event_time,venue,link,pinned,expires,author_name,created_at'))),
      'accounts': csv(await all(() => sb.from('profiles').select('username,name,role,cluster,status,last_login,created_at'))),
      'lists': csv(stages.map(x => ({ list: 'stage', name: x.name, order: x.sort })).concat(docs.map(x => ({ list: 'document', name: x.name, order: x.sort })), tr.map(x => ({ list: 'training', name: x.name, order: x.sort })),
        ok(await sb.from('clusters').select('name,sort').order('sort')).map(x => ({ list: 'cluster', name: x.name, order: x.sort }))))
    };
    return { tables: tables };
  };

  window.MG_API = {
    ready: ready,
    client: sb,
    async call(action, data) {
      if (!ready) throw new Error('The website is not connected to its database yet (config.js).');
      const fn = A[action];
      if (!fn) throw new Error('Unknown action');
      try { const out = await fn(data || {}); return Object.assign({ ok: true }, out); }
      catch (e) { if (e && e.code) throw e; const er = new Error((e && e.message) || String(e)); throw er; }
    },
    async session() { return ready ? profile() : null; }
  };
})();
