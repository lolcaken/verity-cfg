/* Mirror config.json into the two legacy files and stamp the publish time.
 *
 *   node sync-deny.js          check + fix, prints what changed
 *   node sync-deny.js --check  check only, exit 1 on drift (for CI)
 *
 * Why this exists: 2.7.3 shipped a denylist edit that only reached
 * config.json. Builds from before 2.6.2 read verity-denylist.json instead, so
 * those copies never saw the name - and a build frozen on an old version is
 * the exact thing that keeps a banned account alive. The two files drifted
 * silently for a day because nothing compared them.
 *
 * The gate is mirrored the same way: config.json's "gate" is the real one, and
 * verity-gate.txt is the copy old builds read.
 *
 * "t" is the timestamp the build checks against VT_CFG_MAX_STALE when the CDN
 * answers: a cached edge copy older than 6h is treated as a miss so a ban
 * lands even if jsdelivr is still serving yesterday's file.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DIR = __dirname;
const CHECK = process.argv.indexOf('--check') !== -1;
const CFG_PATH = path.join(DIR, 'config.json');
const DENY_PATH = path.join(DIR, 'verity-denylist.json');
const GATE_PATH = path.join(DIR, 'verity-gate.txt');

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { throw new Error(p + ' is not valid JSON: ' + e.message); }
};
const writeIfChanged = (p, next) => {
  const prev = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  if (prev === next) return false;
  if (CHECK) return true;
  fs.writeFileSync(p, next, 'utf8');
  return true;
};

let cfg;
try { cfg = readJson(CFG_PATH); }
catch (e) { console.error('FAIL  ' + e.message); process.exit(1); }

/* shape checks: a malformed config that still parses would propagate the same
   way to every copy, and "both files are wrong in the same way" is worse than
   an error here */
const problems = [];
if (typeof cfg.gate !== 'string') problems.push('gate is missing or not a string');
if (!Array.isArray(cfg.deny)) problems.push('deny is not an array');
if (cfg.deny && Array.isArray(cfg.deny)) {
  cfg.deny.forEach((e, i) => {
    if (!e || typeof e !== 'object') { problems.push('deny[' + i + '] is not an object'); return; }
    if (!Number.isFinite(Number(e.id))) problems.push('deny[' + i + '] has no numeric id');
    if (typeof e.uuid !== 'string' || !e.uuid.length) problems.push('deny[' + i + '] has no uuid');
  });
}
if (cfg.ver !== undefined && !/^\d+\.\d+\.\d+$/.test(String(cfg.ver).trim())) problems.push('ver is not MAJOR.MINOR.PATCH');

/* config.ver and the build's own VT_VERSION are one fact written in two
   places, and nothing else ties them together. When they disagree the damage
   is silent and lands on a banned user: config.ver drives the update notice,
   so a build published at 2.7.5 against a config still saying 2.7.4 is never
   told a newer build exists, and the copy that shipped the gate bug keeps
   farming because no notice ever fires. Read the number straight out of the
   source and refuse to publish a mismatched pair. */
try {
  const src = fs.readFileSync(path.join(DIR, '..', 'grain-verity.js'), 'utf8');
  const m = src.match(/const\s+VT_VERSION\s*=\s*'([^']+)'/);
  if (!m) problems.push('could not read VT_VERSION out of grain-verity.js');
  else if (String(cfg.ver).trim() !== m[1]) {
    problems.push('ver=' + cfg.ver + ' but the build is ' + m[1] + ' - set both together, and restamp t');
  }
} catch (e) {
  problems.push('could not read grain-verity.js: ' + e.message);
}

if (problems.length) {
  console.error('FAIL  config.json: ' + problems.join('; '));
  process.exit(1);
}

const touched = [];

/* the two legacy files, rebuilt from the unified config every run */
const denyOut = JSON.stringify({ deny: cfg.deny, notice: cfg.notice || '' }, null, 2) + '\n';
const gateWant = cfg.gate.trim().toLowerCase() === 'yes' ? 'yes\n' : 'no\n';

/* The stamp lives in config.json so the CDN freshness check has something to
   read. It is written when a mirror changed OR when config.json's own content
   changed since it was last committed.

   The second condition is not redundant. `t` is a claim about when this content
   was published, and the CDN guard reads it: a file edited by hand on GitHub
   kept its old stamp, so a config carrying 12:03 content went out asserting it
   was written at 11:52. That is a stamp lying about freshness, which is the
   one thing a freshness stamp must never do - and it is invisible unless
   something compares the file against the commit it came from. */
const lastCommitted = (() => {
  try { return execSync('git show HEAD:config.json', { cwd: DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { return null; }
})();
const cfgSelfDrift = (() => {
  if (lastCommitted === null) return true;          /* no git, or no file yet: stamp */
  const strip = s => { try { const o = JSON.parse(s.replace(/^\uFEFF/, '')); delete o.t; return JSON.stringify(o); } catch (e) { return String(s); } };
  return strip(lastCommitted) !== strip(fs.readFileSync(CFG_PATH, 'utf8'));
})();
const needStamp = (fs.existsSync(DENY_PATH) ? fs.readFileSync(DENY_PATH, 'utf8') : '') !== denyOut ||
  (fs.existsSync(GATE_PATH) ? fs.readFileSync(GATE_PATH, 'utf8') : '') !== gateWant ||
  cfgSelfDrift ||
  typeof cfg.t !== 'string' || !isFinite(Date.parse(cfg.t));
const stamped = needStamp ? Object.assign({}, cfg, { t: new Date().toISOString() }) : cfg;
const cfgOut = JSON.stringify(stamped, null, 2) + '\n';
const cfgChanged = fs.readFileSync(CFG_PATH, 'utf8') !== cfgOut;

/* denylist mirror: deny[] plus the notice, which is all the pre-2.6.2 builds
   ever read from this file */
if (writeIfChanged(DENY_PATH, denyOut)) touched.push('verity-denylist.json');

/* Two files hold the gate and nothing forced them to agree. The failure is
   silent and lands on you: flip gate in config.json on GitHub, leave a stale
   verity-gate.txt behind, and every build that reads the mirror stays switched
   off while the config says on. That reads exactly like a broken kill switch -
   which is what it looked like when it happened. Compare BEFORE writing, or the
   write has already papered over the drift and the check can never fire. */
const gateMirrorWant = cfg.gate.trim().toLowerCase() === 'yes' ? 'yes' : 'no';
const gateMirrorNow = (fs.existsSync(GATE_PATH) ? fs.readFileSync(GATE_PATH, 'utf8') : '').trim().toLowerCase();
if (gateMirrorNow !== gateMirrorWant) {
  if (CHECK) {
    console.error('FAIL  gate mirror is stale: verity-gate.txt="' + gateMirrorNow +
      '" but config.json gate="' + gateMirrorWant + '"');
    console.error('      fix:  node sync-deny.js');
    process.exit(1);
  }
  console.error('warn  gate mirror was stale (verity-gate.txt="' + gateMirrorNow +
    '" vs gate="' + gateMirrorWant + '") - rewriting it below');
}

/* gate mirror: old builds compare this file's whole contents to "yes" */
if (writeIfChanged(GATE_PATH, gateWant)) touched.push('verity-gate.txt');

if (cfgChanged) {
  if (CHECK) touched.push('config.json (t stamp)');
  else { fs.writeFileSync(CFG_PATH, cfgOut, 'utf8'); touched.push('config.json (t stamp)'); }
}

/* read back and compare, so a write that silently did not land is caught here
   rather than by a banned user */
const denyCheck = readJson(DENY_PATH);
const mirrorOk = Array.isArray(denyCheck.deny) && denyCheck.deny.length === cfg.deny.length &&
  denyCheck.deny.every((e, i) => Number(e.id) === Number(cfg.deny[i].id) && String(e.uuid) === String(cfg.deny[i].uuid));
const gateCheck = fs.readFileSync(GATE_PATH, 'utf8').trim().toLowerCase();
const gateOk = gateCheck === (cfg.gate.trim().toLowerCase() === 'yes' ? 'yes' : 'no');

if (!mirrorOk || !gateOk) {
  console.error('FAIL  mirror did not land: denylist=' + mirrorOk + ' gate=' + gateOk);
  process.exit(1);
}

const ids = cfg.deny.map(e => e.id).join(', ');
if (CHECK) {
  if (touched.length) {
    console.error('FAIL  drift vs legacy files: ' + touched.join(', '));
    process.exit(1);
  }
  console.log('ok    config.json and both legacy files agree (' + cfg.deny.length + ' denied: ' + ids + '), gate=' + gateCheck + ', ver=' + (cfg.ver || '-'));
} else {
  console.log((touched.length ? 'fixed ' + touched.join(', ') : 'ok    nothing to do') + ' (' + cfg.deny.length + ' denied: ' + ids + '), gate=' + gateCheck + ', ver=' + (cfg.ver || '-'));
}