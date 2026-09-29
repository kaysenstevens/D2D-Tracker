#!/usr/bin/env node
// Direct read/write access to the Recruit CRM's cloud data, for AI agents (Muse) and scripts.
//
//   node tools/crm.mjs pull [file]   Download the CRM to a JSON file (default: recruits.json)
//   node tools/crm.mjs push [file]   Upload your edited file back to the CRM
//
// Setup, via environment variables (never commit these):
//   FIREBASE_API_KEY     apiKey from the firebaseConfig the app uses
//   FIREBASE_PROJECT_ID  projectId from the same config
//   CRM_EMAIL            the email you sign in to the app with
//   CRM_PASSWORD         that account's password
//
// push refuses to upload if the CRM changed in the cloud since your pull, so it never
// overwrites edits made in the app. Pull again, redo your edits, and push. A copy of
// the cloud data is saved in backups/ before every push.
// See AGENTS.md for the data format.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

const STAGES = ['prospect', 'reached', 'interview_set', 'interview_had', 'committed', 'licensed', 'dead'];
const SOURCES = ['d2d', 'social', 'referral', 'other'];
const COLLECTION = 'recruit_crm';
// Overridable only so the script can be tested against a local mock server.
const IDENTITY_BASE = process.env.CRM_IDENTITY_BASE || 'https://identitytoolkit.googleapis.com';
const FIRESTORE_BASE = process.env.CRM_FIRESTORE_BASE || 'https://firestore.googleapis.com';

const [cmd, file = 'recruits.json'] = process.argv.slice(2);
const metaFile = join(dirname(file), '.' + basename(file) + '.meta.json');

function env(name) {
  const v = process.env[name];
  if (!v) fail(`Missing ${name}. Set FIREBASE_API_KEY, FIREBASE_PROJECT_ID, CRM_EMAIL and CRM_PASSWORD.`);
  return v;
}
function fail(msg) { console.error('Error: ' + msg); process.exit(1); }

async function signIn() {
  const res = await fetch(`${IDENTITY_BASE}/v1/accounts:signInWithPassword?key=${env('FIREBASE_API_KEY')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env('CRM_EMAIL'), password: env('CRM_PASSWORD'), returnSecureToken: true }),
  });
  const data = await res.json();
  if (!res.ok) fail('Sign-in failed: ' + (data.error?.message || res.status));
  return { token: data.idToken, uid: data.localId };
}

function docUrl(uid) {
  return `${FIRESTORE_BASE}/v1/projects/${env('FIREBASE_PROJECT_ID')}/databases/(default)/documents/${COLLECTION}/${uid}`;
}

async function fetchDoc(auth) {
  const res = await fetch(docUrl(auth.uid), { headers: { Authorization: 'Bearer ' + auth.token } });
  if (res.status === 404) return { state: null, updateTime: null };
  const data = await res.json();
  if (!res.ok) fail('Read failed: ' + (data.error?.message || res.status));
  const raw = data.fields?.state?.stringValue;
  return { state: raw ? JSON.parse(raw) : null, updateTime: data.updateTime };
}

function validate(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.recruits)) fail('File must be an object with a "recruits" array.');
  const ids = new Set();
  s.recruits.forEach((r, i) => {
    const where = `recruits[${i}]${r && r.name ? ' (' + r.name + ')' : ''}`;
    if (!r.id) fail(`${where} has no id. New recruits need a unique id string.`);
    if (ids.has(r.id)) fail(`${where} duplicates id ${r.id}.`);
    ids.add(r.id);
    if (!String(r.name || '').trim()) fail(`${where} has no name.`);
    if (!STAGES.includes(r.stage)) fail(`${where} has invalid stage "${r.stage}". Use one of: ${STAGES.join(', ')}.`);
    if (!['warm', 'cold'].includes(r.temp)) fail(`${where} temp must be "warm" or "cold".`);
    if (r.source && !SOURCES.includes(r.source)) fail(`${where} has invalid source "${r.source}". Use one of: ${SOURCES.join(', ')}.`);
    for (const k of ['createdAt', 'updatedAt', 'lastTouchAt', 'lastReplyAt', 'nextAt', 'interviewAt', 'reviveAt', 'deadAt']) {
      if (r[k] != null && typeof r[k] !== 'number') fail(`${where}.${k} must be a millisecond timestamp number or null.`);
    }
    if (r.touches != null && !Array.isArray(r.touches)) fail(`${where}.touches must be an array.`);
  });
  if (!Array.isArray(s.templates)) fail('"templates" must be an array.');
}

// Stamp updatedAt on recruits that changed, so the app's device merge keeps the new version.
function stampChanges(next, before) {
  const old = new Map((before?.recruits || []).map(r => [r.id, JSON.stringify(r)]));
  const now = Date.now();
  let changed = 0;
  next.recruits.forEach(r => {
    if (old.get(r.id) !== JSON.stringify(r)) {
      r.updatedAt = now;
      r.createdAt = r.createdAt || now;
      r.touches = r.touches || [];
      r.maxStage = Math.max(r.maxStage || 0, r.stage === 'dead' ? 0 : STAGES.indexOf(r.stage));
      changed++;
    }
  });
  // Deleting a recruit must be recorded or another device will bring it back when it syncs.
  const nextIds = new Set(next.recruits.map(r => r.id));
  next.deleted = Array.isArray(next.deleted) ? next.deleted : [];
  const removed = (before?.recruits || []).filter(r => !nextIds.has(r.id));
  removed.forEach(r => { if (!next.deleted.includes(r.id)) next.deleted.push(r.id); });
  return { changed, removed: removed.length };
}

async function pull() {
  const auth = await signIn();
  const { state, updateTime } = await fetchDoc(auth);
  if (!state) fail('No CRM data in the cloud yet. Open the app, sign in to sync, and add a recruit first.');
  writeFileSync(file, JSON.stringify(state, null, 2));
  writeFileSync(metaFile, JSON.stringify({ updateTime, pulled: state }));
  console.log(`Pulled ${state.recruits.length} recruits to ${file}`);
}

async function push() {
  if (!existsSync(file)) fail(`${file} not found. Run pull first.`);
  if (!existsSync(metaFile)) fail(`No pull record for ${file}. Run pull first so push can check for conflicts.`);
  let next;
  try { next = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { fail(`${file} is not valid JSON: ${e.message}`); }
  validate(next);
  const meta = JSON.parse(readFileSync(metaFile, 'utf8'));

  const auth = await signIn();
  const current = await fetchDoc(auth);
  if (current.updateTime !== meta.updateTime) {
    fail('The CRM changed in the app since you pulled. Pull again, reapply your edits, then push.');
  }
  const { changed, removed } = stampChanges(next, meta.pulled);
  if (!changed && !removed && JSON.stringify(next.templates) === JSON.stringify(meta.pulled.templates) &&
      JSON.stringify(next.settings) === JSON.stringify(meta.pulled.settings)) {
    console.log('No changes to push.');
    return;
  }
  mkdirSync('backups', { recursive: true });
  const backup = join('backups', `recruit-crm-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(backup, JSON.stringify(current.state, null, 2));
  const url = docUrl(auth.uid) + '?updateMask.fieldPaths=state&updateMask.fieldPaths=updatedAt' +
    (meta.updateTime ? '&currentDocument.updateTime=' + encodeURIComponent(meta.updateTime) : '');
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { state: { stringValue: JSON.stringify(next) }, updatedAt: { timestampValue: new Date().toISOString() } } }),
  });
  const data = await res.json();
  if (!res.ok) fail('Write failed: ' + (data.error?.message || res.status) + (res.status === 400 || res.status === 409 ? ' (the CRM likely changed; pull again)' : ''));
  writeFileSync(file, JSON.stringify(next, null, 2));
  writeFileSync(metaFile, JSON.stringify({ updateTime: data.updateTime, pulled: next }));
  console.log(`Pushed: ${changed} recruit(s) changed, ${removed} removed. Backup of the previous data: ${backup}`);
}

if (cmd === 'pull') await pull();
else if (cmd === 'push') await push();
else {
  console.log('Usage: node tools/crm.mjs pull [file] | push [file]');
  process.exit(cmd ? 1 : 0);
}
