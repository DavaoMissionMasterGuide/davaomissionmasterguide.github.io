/**
 * Davao Mission — Master Guide Registry
 * Backend for Google Apps Script (stores data in this Google Sheet, certificates in a private Drive folder).
 *
 * HOW TO USE (short version — see README for full steps):
 *   1. Open your Google Sheet → Extensions → Apps Script → paste this whole file → Save.
 *   2. Choose the function "setup" at the top and press Run (allow the permissions).
 *   3. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone → Deploy.
 *   4. Copy the Web app URL (ends with /exec) into config.js of the website.
 *
 * First login:  username "director"   password "ChangeMe123"  (you will be asked to change it).
 */

const SESSION_SECONDS = 6 * 60 * 60;          // a login lasts up to 6 hours of inactivity
const MAX_CERT_BYTES = 5 * 1024 * 1024;       // 5 MB per certificate
const ALLOWED_CERT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const DEFAULT_PASSWORD = 'ChangeMe123';
const PUBLIC_CACHE_SECONDS = 600;             // public page data is cached 10 minutes (cleared on every change)

const SHEETS = {
  Members:   ['id', 'fullName', 'cluster', 'district', 'church', 'trainingDate', 'investedDate', 'stageId', 'docs', 'certFileId', 'certName', 'updatedAt', 'updatedBy'],
  Stages:    ['id', 'name', 'order'],
  Documents: ['id', 'name', 'order'],
  Clusters:  ['name'],
  Users:     ['id', 'username', 'email', 'name', 'role', 'cluster', 'salt', 'hash', 'active', 'mustChange', 'createdAt', 'lastLogin'],
  Settings:  ['key', 'value'],
  Log:       ['time', 'user', 'action', 'detail'],
  Places:    ['type', 'cluster', 'district', 'church', 'lat', 'lng', 'address', 'updatedAt', 'updatedBy']
};

const READ_ONLY = ['me', 'bootstrap', 'getCert', 'listUsers', 'getLog'];

const ACTIONS = {
  me: (u) => ({ user: pubUser_(u) }),
  logout: (u, r) => { CacheService.getScriptCache().remove('s_' + r.token); return {}; },
  changePassword: changePassword_,
  bootstrap: bootstrap_,
  saveMember: saveMember_,
  deleteMember: deleteMember_,
  importMembers: importMembers_,
  uploadCert: uploadCert_,
  getCert: getCert_,
  removeCert: removeCert_,
  saveStages: (u, r) => saveList_(u, r, 'Stages'),
  saveDocuments: (u, r) => saveList_(u, r, 'Documents'),
  saveClusters: saveClusters_,
  listUsers: listUsers_,
  saveUser: saveUser_,
  deleteUser: deleteUser_,
  saveSettings: saveSettings_,
  getLog: getLog_,
  savePlace: savePlace_,
  deletePlace: deletePlace_
};

/* ============================== SETUP ============================== */

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Open this script from your Google Sheet (Extensions → Apps Script), then run setup again.');

  Object.keys(SHEETS).forEach(name => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  });
  const blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);

  if (!readAll_('Stages').length) {
    writeAll_('Stages', ['Enrolled', 'In Training', 'Requirements Complete', 'Approved for Investiture', 'Invested']
      .map((n, i) => ({ id: newId_('S'), name: n, order: i + 1 })));
  }
  if (!readAll_('Documents').length) {
    writeAll_('Documents', ['Application Form', "Pastor's Recommendation", 'Pathfinder / AY Class Record', 'Training Attendance', 'Practicum Requirements', 'Medical Certificate']
      .map((n, i) => ({ id: newId_('D'), name: n, order: i + 1 })));
  }
  if (!readAll_('Clusters').length) {
    writeAll_('Clusters', [{ name: 'Cluster 1' }, { name: 'Cluster 2' }, { name: 'Cluster 3' }]);
  }

  const s = getSettings_();
  if (!s.siteTitle) setSetting_('siteTitle', 'Davao Mission Master Guides');
  if (!s.subtitle) setSetting_('subtitle', 'Master Guide Progress & Investiture Registry');
  if (!s.showDocCount) setSetting_('showDocCount', 'true');
  if (s.googleClientId === undefined) setSetting_('googleClientId', '');
  certFolder_();

  if (!readAll_('Users').length) {
    const salt = Utilities.getUuid();
    appendRows_('Users', [{
      id: newId_('U'), username: 'director', email: '', name: 'Master Guide Director', role: 'director', cluster: '',
      salt: salt, hash: hash_(DEFAULT_PASSWORD, salt), active: 'true', mustChange: 'true', createdAt: nowStr_(), lastLogin: ''
    }]);
  }
  cacheClear_();
  Logger.log('Setup complete. Now Deploy → New deployment → Web app. First login: director / ' + DEFAULT_PASSWORD);
}

/* ============================== WEB ENTRY POINTS ============================== */

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'public';
  try {
    if (action === 'public') {
      let s = cacheGet_('pub');
      if (!s) { s = JSON.stringify(publicData_()); cachePut_('pub', s, PUBLIC_CACHE_SECONDS); }
      return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON);
    }
    if (action === 'config') {
      const st = getSettings_();
      return json_({ ok: true, siteTitle: st.siteTitle || '', subtitle: st.subtitle || '', googleClientId: st.googleClientId || '' });
    }
    return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (_) { return json_({ ok: false, error: 'Bad request' }); }
  try {
    const a = req.action;
    if (a === 'login') return json_(login_(req));
    if (a === 'loginGoogle') return json_(loginGoogle_(req));
    const user = auth_(req.token);
    if (!user) return json_({ ok: false, error: 'SESSION_EXPIRED' });
    if (user.mustChange === 'true' && ['changePassword', 'me', 'logout'].indexOf(a) < 0) {
      return json_({ ok: false, error: 'MUST_CHANGE_PASSWORD' });
    }
    const fn = ACTIONS[a];
    if (!fn) throw new Error('Unknown action');
    const out = fn(user, req) || {};
    if (READ_ONLY.indexOf(a) < 0) cacheClear_();
    return json_(Object.assign({ ok: true }, out));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ============================== PUBLIC DATA ============================== */

function publicData_() {
  const s = getSettings_();
  const stages = sortedList_('Stages');
  const docs = readAll_('Documents');
  const docIds = {};
  docs.forEach(d => docIds[d.id] = true);
  const showDocs = s.showDocCount !== 'false';
  const members = readAll_('Members').map(m => {
    const o = { n: m.fullName, cl: m.cluster, di: m.district, ch: m.church, td: m.trainingDate, inv: m.investedDate, st: m.stageId };
    if (showDocs) o.dc = m.docs ? m.docs.split(',').filter(id => docIds[id]).length : 0;
    return o;
  });
  return {
    ok: true, title: s.siteTitle || '', subtitle: s.subtitle || '', showDocCount: showDocs, docsTotal: docs.length,
    stages: stages, clusters: readAll_('Clusters').map(c => c.name), members: members,
    places: readAll_('Places').map(p => ({ t: p.type, cl: p.cluster, di: p.district, ch: p.church, lat: Number(p.lat), lng: Number(p.lng) })),
    updated: nowStr_()
  };
}

/* ============================== AUTH ============================== */

function hash_(pw, salt) {
  let h = salt + '|' + pw;
  for (let i = 0; i < 300; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8));
  }
  return h;
}

function auth_(token) {
  if (!token) return null;
  const c = CacheService.getScriptCache();
  const id = c.get('s_' + token);
  if (!id) return null;
  const u = readAll_('Users').find(x => x.id === id);
  if (!u || u.active !== 'true') return null;
  c.put('s_' + token, id, SESSION_SECONDS);
  return u;
}

function startSession_(u) {
  withLock_(() => {
    const row = readAll_('Users').find(x => x.id === u.id);
    if (row) { row.lastLogin = nowStr_(); updateRow_('Users', row._row, row); }
  });
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('s_' + token, u.id, SESSION_SECONDS);
  log_(u, 'Sign in', '');
  return { ok: true, token: token, user: pubUser_(u) };
}

function login_(r) {
  const username = String(r.username || '').trim().toLowerCase();
  const pw = String(r.password || '');
  const c = CacheService.getScriptCache();
  const fk = 'f_' + username;
  const fails = Number(c.get(fk) || 0);
  if (fails >= 5) throw new Error('Too many failed attempts. Please wait 10 minutes and try again.');
  const u = readAll_('Users').find(x => x.username.toLowerCase() === username);
  if (!u || u.active !== 'true' || !u.hash || hash_(pw, u.salt) !== u.hash) {
    c.put(fk, String(fails + 1), 600);
    throw new Error('Wrong username or password.');
  }
  c.remove(fk);
  return startSession_(u);
}

function loginGoogle_(r) {
  const clientId = getSettings_().googleClientId;
  if (!clientId) throw new Error('Google sign-in is not set up yet.');
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(r.credential || ''), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Google sign-in failed. Please try again.');
  const info = JSON.parse(res.getContentText());
  if (info.aud !== clientId || String(info.email_verified) !== 'true' || !/accounts\.google\.com$/.test(String(info.iss || ''))) {
    throw new Error('Google sign-in could not be verified.');
  }
  const email = String(info.email || '').toLowerCase();
  const u = readAll_('Users').find(x => x.email && x.email.toLowerCase() === email);
  if (!u || u.active !== 'true') throw new Error(email + ' is not registered. Ask the Master Guide Director to add this Gmail to your account.');
  return startSession_(u);
}

function changePassword_(u, r) {
  const nw = String(r.newPassword || '');
  if (nw.length < 8) throw new Error('New password must be at least 8 characters.');
  if (nw === DEFAULT_PASSWORD) throw new Error('Please choose a different password.');
  return withLock_(() => {
    const me = readAll_('Users').find(x => x.id === u.id);
    if (me.hash && me.mustChange !== 'true' && hash_(String(r.oldPassword || ''), me.salt) !== me.hash) {
      throw new Error('Current password is incorrect.');
    }
    me.salt = Utilities.getUuid();
    me.hash = hash_(nw, me.salt);
    me.mustChange = 'false';
    updateRow_('Users', me._row, me);
    log_(u, 'Change password', '');
    return { user: pubUser_(me) };
  });
}

function pubUser_(u) {
  return { id: u.id, username: u.username, email: u.email, name: u.name, role: u.role, cluster: u.cluster, mustChange: u.mustChange === 'true' };
}
function isDir_(u) { return u.role === 'director'; }
function requireDir_(u) { if (!isDir_(u)) throw new Error('Only the Master Guide Director can do this.'); }
function canEdit_(u, rec) { return isDir_(u) || rec.cluster === u.cluster; }

/* ============================== MEMBERS ============================== */

function memberOut_(m) {
  return {
    id: m.id, fullName: m.fullName, cluster: m.cluster, district: m.district, church: m.church,
    trainingDate: m.trainingDate, investedDate: m.investedDate, stageId: m.stageId,
    docs: m.docs ? String(m.docs).split(',').filter(Boolean) : [],
    certName: m.certName, hasCert: !!m.certFileId, updatedAt: m.updatedAt, updatedBy: m.updatedBy
  };
}

function bootstrap_(u) {
  const s = getSettings_();
  const members = readAll_('Members').filter(m => isDir_(u) || m.cluster === u.cluster).map(memberOut_);
  return {
    user: pubUser_(u),
    stages: sortedList_('Stages'),
    documents: sortedList_('Documents'),
    clusters: readAll_('Clusters').map(c => c.name),
    members: members,
    places: placesFor_(u),
    settings: isDir_(u)
      ? { siteTitle: s.siteTitle || '', subtitle: s.subtitle || '', showDocCount: s.showDocCount !== 'false', googleClientId: s.googleClientId || '' }
      : { siteTitle: s.siteTitle || '' }
  };
}

function saveMember_(u, r) {
  const m = r.member || {};
  const fullName = clean_(m.fullName, 120);
  if (!fullName) throw new Error('Full name is required.');
  const cluster = clean_(m.cluster, 80);
  if (readAll_('Clusters').map(c => c.name).indexOf(cluster) < 0) throw new Error('Please choose a valid cluster.');
  if (!isDir_(u) && cluster !== u.cluster) throw new Error('You can only manage Master Guides in ' + u.cluster + '.');
  const stages = sortedList_('Stages');
  const stageId = stages.some(s => s.id === m.stageId) ? m.stageId : (stages[0] ? stages[0].id : '');
  const docIds = readAll_('Documents').map(d => d.id);
  const docs = (Array.isArray(m.docs) ? m.docs : []).filter(id => docIds.indexOf(id) >= 0);
  const td = date_(m.trainingDate, 'Date of training');
  const inv = date_(m.investedDate, 'Date invested');

  return withLock_(() => {
    const all = readAll_('Members');
    let existing = null;
    if (m.id) {
      existing = all.find(x => x.id === m.id);
      if (!existing) throw new Error('Record not found (it may have been deleted).');
      if (!canEdit_(u, existing)) throw new Error('You can only manage Master Guides in ' + u.cluster + '.');
    } else if (!r.force) {
      const dup = all.find(x => x.cluster === cluster && norm_(x.fullName) === norm_(fullName));
      if (dup) return { duplicate: true, message: fullName + ' already exists in ' + cluster + (dup.church ? ' (' + dup.church + ')' : '') + '.' };
    }
    const rec = {
      id: existing ? existing.id : newId_('MG'), fullName: fullName, cluster: cluster,
      district: clean_(m.district, 80), church: clean_(m.church, 120), trainingDate: td, investedDate: inv,
      stageId: stageId, docs: docs.join(','),
      certFileId: existing ? existing.certFileId : '', certName: existing ? existing.certName : '',
      updatedAt: nowStr_(), updatedBy: u.username
    };
    if (existing) updateRow_('Members', existing._row, rec); else appendRows_('Members', [rec]);
    log_(u, existing ? 'Edit Master Guide' : 'Add Master Guide', fullName + ' (' + cluster + ')');
    return { member: memberOut_(rec) };
  });
}

function deleteMember_(u, r) {
  return withLock_(() => {
    const m = readAll_('Members').find(x => x.id === r.id);
    if (!m) throw new Error('Record not found.');
    if (!canEdit_(u, m)) throw new Error('You can only manage Master Guides in ' + u.cluster + '.');
    if (m.certFileId) { try { DriveApp.getFileById(m.certFileId).setTrashed(true); } catch (_) {} }
    sheet_('Members').deleteRow(m._row);
    log_(u, 'Delete Master Guide', m.fullName + ' (' + m.cluster + ')');
    return {};
  });
}

function importMembers_(u, r) {
  const rows = Array.isArray(r.rows) ? r.rows : [];
  if (!rows.length) throw new Error('Nothing to import.');
  if (rows.length > 2000) throw new Error('Import at most 2,000 rows at a time.');
  const clusterByNorm = {};
  readAll_('Clusters').forEach(c => clusterByNorm[norm_(c.name)] = c.name);
  const stages = sortedList_('Stages');
  const stageByNorm = {};
  stages.forEach(s => stageByNorm[norm_(s.name)] = s.id);
  const offset = Number(r.lineOffset || 0);

  return withLock_(() => {
    const seen = {};
    readAll_('Members').forEach(x => seen[norm_(x.cluster) + '|' + norm_(x.fullName)] = true);
    const add = [], skipped = [];
    rows.forEach((row, i) => {
      const line = offset + i + 1;
      const fullName = clean_(row.fullName, 120);
      if (!fullName) { skipped.push({ line: line, reason: 'No name' }); return; }
      let cluster = clusterByNorm[norm_(row.cluster)] || '';
      if (!isDir_(u)) {
        if (clean_(row.cluster, 80) && cluster !== u.cluster) { skipped.push({ line: line, reason: 'Not your cluster' }); return; }
        cluster = u.cluster;
      }
      if (!cluster) { skipped.push({ line: line, reason: 'Unknown cluster "' + clean_(row.cluster, 80) + '"' }); return; }
      let td, inv;
      try { td = date_(row.trainingDate, 'Date of training'); inv = date_(row.investedDate, 'Date invested'); }
      catch (e) { skipped.push({ line: line, reason: e.message }); return; }
      const key = norm_(cluster) + '|' + norm_(fullName);
      if (seen[key]) { skipped.push({ line: line, reason: 'Already exists' }); return; }
      seen[key] = true;
      let stageId = stageByNorm[norm_(row.stage)];
      if (!stageId) stageId = stages.length ? (inv ? stages[stages.length - 1].id : stages[0].id) : '';
      add.push({
        id: newId_('MG'), fullName: fullName, cluster: cluster, district: clean_(row.district, 80), church: clean_(row.church, 120),
        trainingDate: td, investedDate: inv, stageId: stageId, docs: '', certFileId: '', certName: '',
        updatedAt: nowStr_(), updatedBy: u.username
      });
    });
    appendRows_('Members', add);
    if (add.length) log_(u, 'Import', add.length + ' Master Guide(s) added');
    return { added: add.length, skipped: skipped };
  });
}

/* ============================== CERTIFICATES ============================== */

function certFolder_() {
  const id = getSettings_().certFolderId;
  if (id) { try { return DriveApp.getFolderById(id); } catch (_) {} }
  const f = DriveApp.createFolder('Master Guide Certificates (private)');
  setSetting_('certFolderId', f.getId());
  return f;
}

function uploadCert_(u, r) {
  const mime = String(r.mime || '');
  if (ALLOWED_CERT_TYPES.indexOf(mime) < 0) throw new Error('Certificate must be a PDF, JPG or PNG file.');
  const bytes = Utilities.base64Decode(String(r.data || ''));
  if (!bytes.length) throw new Error('The file is empty.');
  if (bytes.length > MAX_CERT_BYTES) throw new Error('File is too large (maximum 5 MB).');
  return withLock_(() => {
    const m = readAll_('Members').find(x => x.id === r.id);
    if (!m) throw new Error('Record not found.');
    if (!canEdit_(u, m)) throw new Error('You can only manage Master Guides in ' + u.cluster + '.');
    const name = clean_(r.name, 100) || 'certificate';
    const file = certFolder_().createFile(Utilities.newBlob(bytes, mime, m.fullName.replace(/[\\\/:*?"<>|]+/g, '') + ' - ' + name));
    if (m.certFileId) { try { DriveApp.getFileById(m.certFileId).setTrashed(true); } catch (_) {} }
    m.certFileId = file.getId();
    m.certName = name;
    m.updatedAt = nowStr_();
    m.updatedBy = u.username;
    updateRow_('Members', m._row, m);
    log_(u, 'Upload certificate', m.fullName);
    return { member: memberOut_(m) };
  });
}

function getCert_(u, r) {
  const m = readAll_('Members').find(x => x.id === r.id);
  if (!m || !m.certFileId) throw new Error('No certificate uploaded.');
  if (!canEdit_(u, m)) throw new Error('You can only view certificates in ' + u.cluster + '.');
  const blob = DriveApp.getFileById(m.certFileId).getBlob();
  return { name: m.certName, mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}

function removeCert_(u, r) {
  return withLock_(() => {
    const m = readAll_('Members').find(x => x.id === r.id);
    if (!m) throw new Error('Record not found.');
    if (!canEdit_(u, m)) throw new Error('You can only manage Master Guides in ' + u.cluster + '.');
    if (m.certFileId) { try { DriveApp.getFileById(m.certFileId).setTrashed(true); } catch (_) {} }
    m.certFileId = '';
    m.certName = '';
    m.updatedAt = nowStr_();
    m.updatedBy = u.username;
    updateRow_('Members', m._row, m);
    log_(u, 'Remove certificate', m.fullName);
    return { member: memberOut_(m) };
  });
}

/* ============================== STAGES / DOCUMENTS / CLUSTERS ============================== */

function saveList_(u, r, name) {
  requireDir_(u);
  const label = name === 'Stages' ? 'stage' : 'document';
  const items = (Array.isArray(r.items) ? r.items : []).map(x => ({ id: String(x.id || ''), name: clean_(x.name, 80) }));
  if (items.some(x => !x.name)) throw new Error('Every ' + label + ' needs a name.');
  if (name === 'Stages' && !items.length) throw new Error('Keep at least one stage.');
  const seenNames = {};
  items.forEach(x => { const k = norm_(x.name); if (seenNames[k]) throw new Error('"' + x.name + '" is listed twice.'); seenNames[k] = true; });

  return withLock_(() => {
    const old = readAll_(name);
    const oldIds = {};
    old.forEach(o => oldIds[o.id] = true);
    items.forEach(x => { if (!x.id || !oldIds[x.id]) x.id = newId_(name === 'Stages' ? 'S' : 'D'); });
    if (name === 'Stages') {
      const keep = {};
      items.forEach(x => keep[x.id] = true);
      const removed = old.filter(o => !keep[o.id]);
      if (removed.length) {
        const members = readAll_('Members');
        const used = removed.map(s => ({ s: s, n: members.filter(m => m.stageId === s.id).length })).filter(x => x.n);
        if (used.length) {
          throw new Error('Cannot delete: ' + used.map(x => '"' + x.s.name + '" is used by ' + x.n + ' Master Guide(s)').join('; ') + '. Move them to another stage first.');
        }
      }
    }
    writeAll_(name, items.map((x, i) => ({ id: x.id, name: x.name, order: i + 1 })));
    log_(u, 'Update ' + name.toLowerCase(), items.map(x => x.name).join(', '));
    return { items: sortedList_(name) };
  });
}

function saveClusters_(u, r) {
  requireDir_(u);
  const items = (Array.isArray(r.items) ? r.items : []).map(x => ({ old: String(x.old || ''), name: clean_(x.name, 80) }));
  if (items.some(x => !x.name)) throw new Error('Every cluster needs a name.');
  if (!items.length) throw new Error('Keep at least one cluster.');
  const seenNames = {};
  items.forEach(x => { const k = norm_(x.name); if (seenNames[k]) throw new Error('"' + x.name + '" is listed twice.'); seenNames[k] = true; });

  return withLock_(() => {
    const oldNames = readAll_('Clusters').map(c => c.name);
    const kept = {};
    items.forEach(x => { if (x.old) kept[x.old] = true; });
    const removed = oldNames.filter(n => !kept[n]);
    if (removed.length) {
      const members = readAll_('Members'), users = readAll_('Users');
      const used = removed.map(n => ({ n: n, m: members.filter(x => x.cluster === n).length, u: users.filter(x => x.cluster === n).length })).filter(x => x.m || x.u);
      if (used.length) {
        throw new Error('Cannot delete: ' + used.map(x => '"' + x.n + '" has ' + x.m + ' Master Guide(s) and ' + x.u + ' account(s)').join('; ') + '. Move them first.');
      }
    }
    const renames = {};
    items.forEach(x => { if (x.old && x.old !== x.name && oldNames.indexOf(x.old) >= 0) renames[x.old] = x.name; });
    if (Object.keys(renames).length) {
      renameColumn_('Members', 'cluster', renames);
      renameColumn_('Users', 'cluster', renames);
      renameColumn_('Places', 'cluster', renames);
    }
    writeAll_('Clusters', items.map(x => ({ name: x.name })));
    log_(u, 'Update clusters', items.map(x => x.name).join(', '));
    return { clusters: items.map(x => x.name) };
  });
}

function renameColumn_(sheetName, col, map) {
  const sh = sheet_(sheetName);
  const last = sh.getLastRow();
  if (last < 2) return;
  const c = SHEETS[sheetName].indexOf(col) + 1;
  const range = sh.getRange(2, c, last - 1, 1);
  const vals = range.getValues().map(r => [map[cell_(r[0])] !== undefined ? map[cell_(r[0])] : cell_(r[0])]);
  range.setNumberFormat('@').setValues(vals.map(r => [safe_(r[0])]));
}

/* ============================== ACCOUNTS ============================== */

function listUsers_(u) {
  requireDir_(u);
  return {
    users: readAll_('Users').map(x => Object.assign(pubUser_(x), { active: x.active === 'true', lastLogin: x.lastLogin, hasPassword: !!x.hash }))
  };
}

function saveUser_(u, r) {
  requireDir_(u);
  const d = r.user || {};
  const username = clean_(d.username, 40).toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new Error('Username must be 3–40 characters: letters, numbers, dot, dash or underscore (no spaces).');
  const email = clean_(d.email, 120).toLowerCase();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Please enter a valid Gmail address (or leave it blank).');
  const role = d.role === 'director' ? 'director' : 'coordinator';
  const cluster = role === 'coordinator' ? clean_(d.cluster, 80) : '';
  if (role === 'coordinator' && readAll_('Clusters').map(c => c.name).indexOf(cluster) < 0) throw new Error('Choose a cluster for this coordinator.');
  const active = d.active !== false;
  const pw = String(d.password || '');
  if (pw && pw.length < 8) throw new Error('Password must be at least 8 characters.');

  return withLock_(() => {
    const all = readAll_('Users');
    const existing = d.id ? all.find(x => x.id === d.id) : null;
    if (d.id && !existing) throw new Error('Account not found.');
    const myId = existing ? existing.id : '';
    if (all.some(x => x.id !== myId && x.username.toLowerCase() === username)) throw new Error('Username "' + username + '" is already taken.');
    if (email && all.some(x => x.id !== myId && x.email && x.email.toLowerCase() === email)) throw new Error(email + ' is already used by another account.');
    if (!existing && !pw && !email) throw new Error('Give this account a password, a Gmail address, or both.');
    if (existing && existing.id === u.id && !active) throw new Error('You cannot deactivate your own account.');
    if (existing && existing.role === 'director' && existing.active === 'true' && (role !== 'director' || !active)) {
      const others = all.filter(x => x.id !== existing.id && x.role === 'director' && x.active === 'true').length;
      if (!others) throw new Error('There must always be at least one active Director.');
    }
    const rec = {
      id: existing ? existing.id : newId_('U'), username: username, email: email, name: clean_(d.name, 80) || username,
      role: role, cluster: cluster, salt: existing ? existing.salt : '', hash: existing ? existing.hash : '',
      active: String(active), mustChange: existing ? existing.mustChange : 'false',
      createdAt: existing ? existing.createdAt : nowStr_(), lastLogin: existing ? existing.lastLogin : ''
    };
    if (pw) {
      rec.salt = Utilities.getUuid();
      rec.hash = hash_(pw, rec.salt);
      rec.mustChange = rec.id === u.id ? 'false' : 'true';
    }
    if (existing) updateRow_('Users', existing._row, rec); else appendRows_('Users', [rec]);
    log_(u, existing ? 'Edit account' : 'Add account', username + ' (' + role + (cluster ? ', ' + cluster : '') + ')');
    return listUsers_(u);
  });
}

function deleteUser_(u, r) {
  requireDir_(u);
  return withLock_(() => {
    const all = readAll_('Users');
    const x = all.find(y => y.id === r.id);
    if (!x) throw new Error('Account not found.');
    if (x.id === u.id) throw new Error('You cannot delete your own account.');
    if (x.role === 'director' && x.active === 'true' && !all.some(y => y.id !== x.id && y.role === 'director' && y.active === 'true')) {
      throw new Error('There must always be at least one active Director.');
    }
    sheet_('Users').deleteRow(x._row);
    log_(u, 'Delete account', x.username);
    return listUsers_(u);
  });
}

/* ============================== MAP PINS ============================== */

function placesFor_(u) {
  return readAll_('Places').filter(p => isDir_(u) || p.cluster === u.cluster)
    .map(p => ({ type: p.type, cluster: p.cluster, district: p.district, church: p.church, lat: Number(p.lat), lng: Number(p.lng), address: p.address }));
}

function placeKey_(u, p) {
  const type = ['cluster', 'district', 'church'].indexOf(p.type) >= 0 ? p.type : '';
  if (!type) throw new Error('Unknown place type.');
  const cluster = clean_(p.cluster, 80);
  const district = type !== 'cluster' ? clean_(p.district, 80) : '';
  const church = type === 'church' ? clean_(p.church, 120) : '';
  if (!cluster || (type !== 'cluster' && !district) || (type === 'church' && !church)) throw new Error('This place is missing its cluster, district or church name.');
  if (!isDir_(u) && cluster !== u.cluster) throw new Error('You can only set map pins in ' + u.cluster + '.');
  return { type: type, cluster: cluster, district: district, church: church };
}

function savePlace_(u, r) {
  const p = r.place || {};
  const k = placeKey_(u, p);
  const lat = Number(p.lat), lng = Number(p.lng);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error('Invalid map location.');
  return withLock_(() => {
    const ex = readAll_('Places').find(x => x.type === k.type && x.cluster === k.cluster && x.district === k.district && x.church === k.church);
    const rec = Object.assign({}, k, { lat: lat.toFixed(6), lng: lng.toFixed(6), address: clean_(p.address, 200), updatedAt: nowStr_(), updatedBy: u.username });
    if (ex) updateRow_('Places', ex._row, rec); else appendRows_('Places', [rec]);
    log_(u, 'Set map pin', [k.church, k.district, k.cluster].filter(Boolean).join(', '));
    return { places: placesFor_(u) };
  });
}

function deletePlace_(u, r) {
  const k = placeKey_(u, r.place || {});
  return withLock_(() => {
    const ex = readAll_('Places').find(x => x.type === k.type && x.cluster === k.cluster && x.district === k.district && x.church === k.church);
    if (ex) { sheet_('Places').deleteRow(ex._row); log_(u, 'Remove map pin', [k.church, k.district, k.cluster].filter(Boolean).join(', ')); }
    return { places: placesFor_(u) };
  });
}

/* ============================== SETTINGS & LOG ============================== */

function saveSettings_(u, r) {
  requireDir_(u);
  const s = r.settings || {};
  const cid = clean_(s.googleClientId, 200);
  if (cid && !/\.apps\.googleusercontent\.com$/.test(cid)) throw new Error('The Google Client ID should end with .apps.googleusercontent.com');
  withLock_(() => {
    setSetting_('siteTitle', clean_(s.siteTitle, 100) || 'Davao Mission Master Guides');
    setSetting_('subtitle', clean_(s.subtitle, 150));
    setSetting_('showDocCount', s.showDocCount === false ? 'false' : 'true');
    setSetting_('googleClientId', cid);
  });
  log_(u, 'Update settings', '');
  return { settings: bootstrap_(u).settings };
}

function getLog_(u) {
  requireDir_(u);
  const sh = sheet_('Log');
  const last = sh.getLastRow();
  if (last < 2) return { log: [] };
  const start = Math.max(2, last - 299);
  const vals = sh.getRange(start, 1, last - start + 1, SHEETS.Log.length).getValues();
  return { log: vals.reverse().map(r => ({ time: cell_(r[0]), user: cell_(r[1]), action: cell_(r[2]), detail: cell_(r[3]) })) };
}

function log_(u, action, detail) {
  try { appendRows_('Log', [{ time: nowStr_(), user: u.username, action: action, detail: clean_(detail, 300) }]); } catch (_) {}
}

function getSettings_() {
  const o = {};
  readAll_('Settings').forEach(r => o[r.key] = r.value);
  return o;
}

function setSetting_(k, v) {
  const r = readAll_('Settings').find(x => x.key === k);
  if (r) updateRow_('Settings', r._row, { key: k, value: v });
  else appendRows_('Settings', [{ key: k, value: v }]);
}

/* ============================== SHEET HELPERS ============================== */

function sheet_(n) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let s = ss.getSheetByName(n);
  if (!s && SHEETS[n] && n !== 'Members' && n !== 'Users') {   // add newer sheets automatically after an update
    s = ss.insertSheet(n);
    s.getRange(1, 1, 1, SHEETS[n].length).setValues([SHEETS[n]]).setFontWeight('bold');
    s.setFrozenRows(1);
  }
  if (!s) throw new Error('Missing sheet "' + n + '". Please run setup() first.');
  return s;
}

function cell_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^'[=+\-@]/.test(s)) s = s.slice(1);
  return s;
}

function safe_(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;   // stop text from being treated as a formula
}

function readAll_(n) {
  const sh = sheet_(n);
  const last = sh.getLastRow();
  const cols = SHEETS[n];
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, cols.length).getValues()
    .map((r, i) => { const o = { _row: i + 2 }; cols.forEach((c, j) => o[c] = cell_(r[j])); return o; })
    .filter(o => o[cols[0]] !== '');
}

function toRow_(n, o) { return SHEETS[n].map(c => safe_(o[c])); }

function appendRows_(n, objs) {
  if (!objs.length) return;
  const sh = sheet_(n);
  const start = sh.getLastRow() + 1;
  const need = start + objs.length - 1 - sh.getMaxRows();
  if (need > 0) sh.insertRowsAfter(sh.getMaxRows(), need);
  sh.getRange(start, 1, objs.length, SHEETS[n].length).setNumberFormat('@').setValues(objs.map(o => toRow_(n, o)));
}

function updateRow_(n, row, o) {
  sheet_(n).getRange(row, 1, 1, SHEETS[n].length).setNumberFormat('@').setValues([toRow_(n, o)]);
}

function writeAll_(n, objs) {
  const sh = sheet_(n);
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, SHEETS[n].length).clearContent();
  appendRows_(n, objs);
}

function sortedList_(n) {
  return readAll_(n).sort((a, b) => Number(a.order) - Number(b.order)).map(x => ({ id: x.id, name: x.name }));
}

/* ============================== SMALL UTILITIES ============================== */

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function tz_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return (ss && ss.getSpreadsheetTimeZone()) || Session.getScriptTimeZone() || 'Asia/Manila';
}
function nowStr_() { return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm'); }
function newId_(p) { return p + Utilities.getUuid().replace(/-/g, '').slice(0, 10); }
function norm_(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function clean_(v, max) { return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }

function date_(v, label) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(new Date(s + 'T00:00:00').getTime())) throw new Error(label + ' is not a valid date ("' + s + '").');
  return s;
}

/* Public data cache (split into pieces because one cache entry holds max 100 KB) */
function cachePut_(key, str, ttl) {
  const size = 45000, parts = {}, n = Math.ceil(str.length / size) || 1;
  for (let i = 0; i < n; i++) parts[key + '_' + i] = str.substr(i * size, size);
  parts[key + '_n'] = String(n);
  try { CacheService.getScriptCache().putAll(parts, ttl); } catch (_) {}
}
function cacheGet_(key) {
  const c = CacheService.getScriptCache();
  const n = Number(c.get(key + '_n') || 0);
  if (!n) return null;
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(key + '_' + i);
  const got = c.getAll(keys);
  let s = '';
  for (let i = 0; i < keys.length; i++) { if (got[keys[i]] == null) return null; s += got[keys[i]]; }
  return s;
}
function cacheClear_() { CacheService.getScriptCache().remove('pub_n'); }
