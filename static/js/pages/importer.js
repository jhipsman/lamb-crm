/*
 Document importer: point it at a folder (or .zip) of client/prospect documents and it
 sorts them into accounts and the document checklist.

 Runs entirely in the browser and only reads file/folder NAMES (and dates) — file
 contents are never opened, copied or uploaded. A .zip is read from its directory
 listing at the end of the file, so even very large zips scan in seconds.
*/
'use strict';

const IMP = {
  scan: null,      // { source, accounts: [...], files: [...] }
  result: null,
  options: { docs: true, lossRuns: true, policies: true, note: true },
};

// ------------------------------------------------------------------ reading sources

const JUNK_RE = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini|\.git)(\/|$)|(^|\/)(~\$|\._)/i;

async function readZipEntries(file) {
  const tailLen = Math.min(file.size, 65557);
  const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error(`“${file.name}” doesn’t look like a .zip file.`);
  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);
  if (cdOffset === 0xFFFFFFFF || cdSize === 0xFFFFFFFF || count === 0xFFFF) {  // ZIP64
    const loc = eocd - 20;
    if (loc < 0 || tail.getUint32(loc, true) !== 0x07064b50) throw new Error('Unsupported zip format.');
    const z64 = Number(tail.getBigUint64(loc + 8, true));
    const z = new DataView(await file.slice(z64, z64 + 56).arrayBuffer());
    if (z.getUint32(0, true) !== 0x06064b50) throw new Error('Unsupported zip format.');
    count = Number(z.getBigUint64(32, true));
    cdSize = Number(z.getBigUint64(40, true));
    cdOffset = Number(z.getBigUint64(48, true));
  }
  const buf = await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer();
  const cd = new DataView(buf);
  const utf8 = new TextDecoder('utf-8');
  const legacy = new TextDecoder('windows-1252');
  const out = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const flags = cd.getUint16(p + 8, true);
    const time = cd.getUint16(p + 12, true), dt = cd.getUint16(p + 14, true);
    const size = cd.getUint32(p + 24, true);
    const nlen = cd.getUint16(p + 28, true), xlen = cd.getUint16(p + 30, true), clen = cd.getUint16(p + 32, true);
    const nameBytes = new Uint8Array(buf, p + 46, nlen);
    const path = ((flags & 0x800) ? utf8 : legacy).decode(nameBytes).replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    if (path.endsWith('/')) continue;
    const y = ((dt >> 9) & 0x7f) + 1980, mo = (dt >> 5) & 0xf, d = dt & 0x1f;
    void time;
    out.push({ path, size: size === 0xFFFFFFFF ? null : size,
      modified: mo && d ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null });
  }
  return out;
}

function fileDate(f) { return f.lastModified ? toISO(new Date(f.lastModified)) : null; }

function readFileList(files) {
  return Array.from(files).map(f => ({ path: (f.webkitRelativePath || f.name).replace(/\\/g, '/'), size: f.size, modified: fileDate(f) }));
}

async function readDropped(dt) {
  const items = Array.from(dt.items || []).map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (items.length === 1 && items[0].isFile && /\.zip$/i.test(items[0].name)) {
    return { source: items[0].name, entries: await readZipEntries(dt.files[0]) };
  }
  const out = [];
  const fileOf = entry => new Promise((res, rej) => entry.file(res, rej));
  const readAll = reader => new Promise((res, rej) => {
    const acc = [];
    const next = () => reader.readEntries(batch => { if (!batch.length) res(acc); else { acc.push(...batch); next(); } }, rej);
    next();
  });
  async function walk(entry) {
    if (entry.isFile) {
      const f = await fileOf(entry);
      out.push({ path: entry.fullPath.replace(/^\//, ''), size: f.size, modified: fileDate(f) });
    } else if (entry.isDirectory) {
      for (const child of await readAll(entry.createReader())) await walk(child);
    }
  }
  for (const it of items) await walk(it);
  return { source: items.length === 1 ? items[0].name : `${items.length} items`, entries: out };
}

// ------------------------------------------------------------------ classification

const CHECKLIST_DOC_TYPES = [
  'ACORD 125', 'ACORD 126', 'ACORD 127', 'ACORD 130', 'ACORD 137', 'ACORD 140', 'ACORD 141',
  'Supplemental App', 'Application', 'Loss Runs', 'State Survey + POC', 'Operating License',
  'Driver List', 'Vehicle Schedule', 'MVRs', 'SOV', 'Experience Mod Worksheet', 'Payroll by Class',
  'Bylaws', 'Board List', 'Financial Statements', 'Abuse & Molestation Questionnaire', 'Underlying Schedules',
];
const OTHER_DOC_TYPES = ['Dec Page / Policy', 'Quote / Proposal', 'Binder', 'BOR Letter', 'Certificate',
  'Invoice / Billing', 'Endorsement', 'Correspondence', 'Other'];
const ALL_DOC_TYPES = [...CHECKLIST_DOC_TYPES, ...OTHER_DOC_TYPES];

// Order matters: first match wins.
const TYPE_RULES = [
  [/\bacord\s*125\b|\b125\s*acord\b/, 'ACORD 125'],
  [/\bacord\s*126\b|\b126\s*acord\b/, 'ACORD 126'],
  [/\bacord\s*127\b|\b127\s*acord\b/, 'ACORD 127'],
  [/\bacord\s*130\b|\b130\s*acord\b/, 'ACORD 130'],
  [/\bacord\s*137\b|\b137\s*acord\b/, 'ACORD 137'],
  [/\bacord\s*140\b|\b140\s*acord\b/, 'ACORD 140'],
  [/\bacord\s*141\b|\b141\s*acord\b/, 'ACORD 141'],
  [/\bloss\s*runs?\b|\blossruns?\b|\blrs?\b|\bloss (history|summary|report|experience)\b|\bclaims? (history|report|summary)\b|\bcurrently valued\b|\bvalued as of\b/, 'Loss Runs'],
  [/\bmvrs?\b|\bmotor vehicle (record|report)s?\b|\bdriving records?\b/, 'MVRs'],
  [/\bdrivers? (list|schedule|roster)\b|\bdriver info\b|\blist of drivers\b|\bdrivers?'?s? licen[cs]es?\b/, 'Driver List'],
  [/\bvehicles? (list|schedule)\b|\bauto schedule\b|\bvehicle info\b|\bfleet (list|schedule)\b|\bschedule of (vehicles|autos)\b/, 'Vehicle Schedule'],
  [/\bsov\b|\bstatement of values\b|\bschedule of values\b|\bproperty schedule\b|\blocation schedule\b|\bschedule of locations\b/, 'SOV'],
  [/\b(experience|exp|ex)\s*mod\b|\bxmod\b|\bemr\b|\bmod worksheet\b|\brating worksheet\b/, 'Experience Mod Worksheet'],
  [/\bpayroll\b/, 'Payroll by Class'],
  [/\bby\s*-?laws\b/, 'Bylaws'],
  [/\bboard (list|of directors|roster|members)\b|\bdirectors list\b|\btrustees\b/, 'Board List'],
  [/\bfinancials?\b|\bfinancial statements?\b|\baudited\b|\b990\b|\bbalance sheet\b|\bprofit (and|&) loss\b|\bp ?& ?l\b|\bbudget\b/, 'Financial Statements'],
  [/\babuse\b|\bmolestation\b|\bsexual (misconduct|abuse)\b|\bsam (app|questionnaire|supp)/, 'Abuse & Molestation Questionnaire'],
  [/\bpremium audit\b|\baudit\b/, 'Invoice / Billing'],
  [/\bunderlying\b/, 'Underlying Schedules'],
  [/\bsurvey\b|\bplan of correction\b|\bpoc\b|\bstatement of deficienc|\binspection report\b/, 'State Survey + POC'],
  [/\b(?<!drivers? |driver's )licen[cs]e\b|\blicensure\b|\bcertificate of operation\b/, 'Operating License'],
  [/\bsupp(lemental)?\b|\bsupplement\b/, 'Supplemental App'],
  [/\bbor\b|\bbroker of record\b|\baor\b|\bagent of record\b/, 'BOR Letter'],
  [/\bbinders?\b/, 'Binder'],
  [/\bquotes?\b|\bquotation\b|\bproposals?\b|\bindication\b|\boptions\b/, 'Quote / Proposal'],
  [/\bdecs?\b|\bdeclarations?\b|\bdec page\b|\bpolicy\b|\bpol\b|\bforms? schedule\b|\bschedule of forms\b/, 'Dec Page / Policy'],
  [/\bendorsements?\b|\bendts?\b|\bchange request\b/, 'Endorsement'],
  [/\bcois?\b|\bcertificates? of (insurance|liability)\b|\bcert\b/, 'Certificate'],
  [/\binvoices?\b|\bbills?\b|\bbilling\b|\bstatement\b|\bpremium finance\b|\bpfa\b/, 'Invoice / Billing'],
  [/\bapp(lication)?s?\b/, 'Application'],
  [/\bemails?\b|\bletters?\b|\bcorrespondence\b|\bmemo\b|\bnotes?\b/, 'Correspondence'],
];

const LINE_RULES = [
  [/\babuse\b|\bmolestation\b|\bsexual misconduct\b|\bsam\b|\ba ?& ?m\b/, 'Abuse & Molestation'],
  [/\bworkers'? comp(ensation)?\b|\bwork comp\b|\bwc\b|\bwcomp\b|\bpayroll\b|\b(experience|exp|ex) mod\b|\bacord 130\b/, 'WC'],
  [/\bd ?& ?o\b|\bd and o\b|\bdirectors (and|&) officers\b|\bmanagement liability\b|\bmgmt liab/, 'D&O'],
  [/\bepli?\b|\bemployment practices\b/, 'EPL'],
  [/\bfiduciary\b/, 'Fiduciary'],
  [/\bcyber\b|\bprivacy\b|\bnetwork security\b|\bdata breach\b/, 'Cyber'],
  [/\bcrime\b|\bfidelity\b|\bemployee dishonesty\b|\bacord 141\b/, 'Crime'],
  [/\bumbrella\b|\bexcess\b|\bumb\b|\bxs\b|\bunderlying\b/, 'Excess/Umbrella'],
  [/\bcommercial auto\b|\bbusiness auto\b|\bauto\b|\bbap\b|\bvehicles?\b|\bdrivers?\b|\bmvrs?\b|\bfleet\b|\bacord 12[7]\b|\bacord 137\b/, 'Auto'],
  [/\binland marine\b|\bequipment floater\b|\bim\b/, 'Inland Marine'],
  [/\bbonds?\b|\bsurety\b/, 'Bonds'],
  [/\bprofessional liability\b|\bprofessional\b|\be ?& ?o\b|\berrors (and|&) omissions\b|\bmalpractice\b|\bmed mal\b/, 'Professional Liability'],
  [/\bgeneral liability\b|\bgl\b|\bcgl\b|\bliability\b|\bacord 126\b/, 'GL'],
  [/\bproperty\b|\bbuildings?\b|\bsov\b|\bstatement of values\b|\bacord 140\b/, 'Property'],
  [/\bpackage\b|\bcpp\b|\bpkg\b/, 'GL'],
];

// Forms that only ever belong to one line.
const TYPE_FIXED_LINE = {
  'ACORD 126': 'GL', 'ACORD 127': 'Auto', 'ACORD 130': 'WC', 'ACORD 137': 'Auto', 'ACORD 140': 'Property', 'ACORD 141': 'Crime',
  'MVRs': 'Auto', 'Experience Mod Worksheet': 'WC', 'Payroll by Class': 'WC',
  'Abuse & Molestation Questionnaire': 'Abuse & Molestation', 'Underlying Schedules': 'Excess/Umbrella',
};
// Line to use when the file name doesn't say (matches the checklist templates).
const TYPE_DEFAULT_LINE = {
  'ACORD 125': 'GL', 'Supplemental App': 'GL', 'State Survey + POC': 'GL', 'Operating License': 'GL',
  'Driver List': 'Auto', 'Vehicle Schedule': 'Auto', 'SOV': 'Property',
  'Bylaws': 'D&O', 'Board List': 'D&O', 'Financial Statements': 'D&O',
};

const CARRIER_ALIASES = {
  'phly': 'Philadelphia', 'philadelphia': 'Philadelphia', 'phila': 'Philadelphia', 'hartford': 'Hartford', 'the hartford': 'Hartford',
  'church mutual': 'Church Mutual', 'cmic': 'Church Mutual', 'guideone': 'GuideOne', 'guide one': 'GuideOne',
  'brotherhood': 'Brotherhood Mutual', 'glatfelter': 'Glatfelter', 'vfis': 'Glatfelter', 'great american': 'Great American',
  'gaic': 'Great American', 'memic': 'MEMIC', 'amtrust': 'AmTrust', 'progressive': 'Progressive', 'chubb': 'Chubb',
  'travelers': 'Travelers', 'cna': 'CNA', 'usli': 'USLI', 'hanover': 'Hanover',
};

const GROUP_RE = /^(\d+\s*[-.)]?\s*)?(active |current |former |lost |old |closed |inactive )?(clients?|prospects?|leads?|targets?|pipeline|book( of business)?|renewals?|lost( business| accounts)?|former|inactive|archived?|closed|won|accounts|customers|insureds)$/i;
function groupStatus(name) {
  const n = name.toLowerCase();
  if (/prospect|lead|target|pipeline/.test(n)) return 'Prospect';
  if (/lost|former|inactive|archive|closed|old/.test(n)) return 'Lost';
  if (/client|book|renewal|won|customer|insured|current|active/.test(n)) return 'Active Client';
  return null;
}

function norm(s) {
  return s.toLowerCase().replace(/\.[a-z0-9]{1,5}$/, '').replace(/[_\-.,()[\]{}+#]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function normName(s) {
  return (s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|inc|incorporated|llc|corp|corporation|co|ltd|dba)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
function cleanAccountName(folder) {
  return folder.replace(/[_]+/g, ' ').replace(/^\s*\d+\s*[-.)]\s*/, '')
    .replace(/\s*[-–(]?\s*(20\d{2}(\s*[-–]\s*(20)?\d{2})?)\s*\)?\s*$/, '').replace(/\s+/g, ' ').trim();
}

function parseDates(rawName) {
  const s = rawName.toLowerCase().replace(/_/g, ' ');
  let m;
  const out = { date: null, term: null };
  const valid = (y, mo, d) => mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 1990 && y <= 2100;
  if ((m = s.match(/\b(20\d{2})[-_. ](\d{1,2})[-_. ](\d{1,2})\b/)) && valid(+m[1], +m[2], +m[3])) out.date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  else if ((m = s.match(/\b(\d{1,2})[-_. ](\d{1,2})[-_. ](20\d{2})\b/)) && valid(+m[3], +m[1], +m[2])) out.date = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  if ((m = s.match(/\b(20\d{2})\s*(?:-|–|to|_)\s*(?:20)?(\d{2})\b/)) && (+m[2] === (+m[1] + 1) % 100 || +m[2] === (+m[1] + 3) % 100)) {
    out.term = `${m[1]}-${2000 + +m[2]}`;
  } else if ((m = s.match(/\b(20\d{2})\b/))) out.term = m[1];
  return out;
}

function detectCarrier(text) {
  const known = (S.lookups.carriers || []).map(c => [c.toLowerCase(), c]);
  for (const [k, v] of known) if (k.length > 2 && new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)) return v;
  for (const [k, v] of Object.entries(CARRIER_ALIASES)) if (new RegExp(`\\b${k}\\b`).test(text)) return v;
  return null;
}

function classify(fileName, subPath) {
  const name = norm(fileName);
  const folders = norm(subPath || '');
  const both = `${folders} ${name}`.trim();
  let type = null;
  for (const [re, t] of TYPE_RULES) if (re.test(name)) { type = t; break; }
  if (!type) for (const [re, t] of TYPE_RULES) if (re.test(folders)) { type = t; break; }
  type = type || 'Other';
  let line = null;
  for (const [re, l] of LINE_RULES) if (re.test(name)) { line = l; break; }
  if (!line) for (const [re, l] of LINE_RULES) if (re.test(folders)) { line = l; break; }
  if (TYPE_FIXED_LINE[type]) line = TYPE_FIXED_LINE[type];
  else if (!line && TYPE_DEFAULT_LINE[type]) line = TYPE_DEFAULT_LINE[type];
  const dates = parseDates(fileName);
  return { type, line, carrier: detectCarrier(both), term: dates.term, nameDate: dates.date };
}

function checklistName(type, line) {
  if (type === 'Loss Runs') return ['Cyber', 'Crime'].includes(line) ? 'Loss Runs' : 'Loss Runs (5yr)';
  return type;
}

// ------------------------------------------------------------------ build the plan

// Folder names that are sub-organization inside an account rather than an account.
const SUBFOLDER_RE = /^(\d+\s*[-.)]?\s*)?((19|20)\d{2}([-–\s]+((19|20)?\d{2}))?(\s+\w+)?|renewals?|policies|policy|quotes?|proposals?|apps?|applications?|submissions?|marketing|claims?|loss runs?|certs?|certificates?|cois?|correspondence|emails?|misc|other|old|archive|billing|invoices?|endorsements?|underwriting|uw|forms|photos|pictures|docs|documents|binders?|audits?|financials?|bor|notes)$/i;
function looksLikeSubfolder(name) {
  const n = norm(name);
  return SUBFOLDER_RE.test(name.trim()) || LINE_RULES.some(([re]) => re.test(n) && n.split(' ').length <= 3);
}

function buildPlan(source, entries, accounts) {
  entries = entries.filter(e => !JUNK_RE.test(e.path));
  const parts = entries.map(e => e.path.split('/').filter(Boolean));
  const dirs = parts.map(p => p.slice(0, -1));

  // 1. Shared wrapper folders (e.g. "Book of Business/") — the longest common folder prefix.
  let lcp = 0;
  if (dirs.length) {
    const minLen = Math.min(...dirs.map(d => d.length));
    while (lcp < minLen && dirs.every(d => d[lcp] === dirs[0][lcp])) lcp++;
  }
  // 2. Where does the account folder sit for each file, given a prefix length?
  const locate = (d, start) => {
    let i = start, hint = null;
    while (i < d.length && GROUP_RE.test(d[i])) { hint = groupStatus(d[i]) || hint; i++; }
    return { index: i < d.length ? i : -1, hint };
  };
  // 3. If the would-be accounts are mostly "WC", "Auto", "2024 Renewal"... we're inside one account: back up.
  while (lcp > 0) {
    const names = new Set();
    dirs.forEach(d => { const { index } = locate(d, lcp); if (index >= 0) names.add(d[index]); });
    const list = Array.from(names);
    if (list.length === 0 || list.filter(looksLikeSubfolder).length > list.length / 2) lcp--;
    else break;
  }
  let rootHint = null;
  for (let i = 0; i < lcp; i++) if (GROUP_RE.test(dirs[0][i])) rootHint = groupStatus(dirs[0][i]) || rootHint;

  const byNorm = {};
  accounts.forEach(a => { byNorm[normName(a.named_insured)] = a; if (a.dba) byNorm[normName(a.dba)] = byNorm[normName(a.dba)] || a; });
  const findMatch = (name) => {
    const n = normName(name);
    if (!n) return null;
    if (byNorm[n]) return byNorm[n];
    if (n.length >= 8) return accounts.find(a => { const m = normName(a.named_insured); return m.length >= 8 && (m.startsWith(n) || n.startsWith(m)); }) || null;
    return null;
  };

  const accts = new Map();
  const files = [];
  entries.forEach((e, i) => {
    const p = parts[i], d = dirs[i];
    const { index, hint: h } = locate(d, lcp);
    const hint = h || rootHint;
    const folder = index >= 0 ? d[index] : null;
    const rest = index >= 0 ? p.slice(index + 1) : [p[p.length - 1]];
    const key = folder ? folder : '(loose files)';
    if (!accts.has(key)) {
      const name = folder ? cleanAccountName(folder) : '';
      const match = folder ? findMatch(name) : null;
      accts.set(key, { key, folder: folder || '(files not in a folder)', name, include: !!folder, matchId: match ? match.id : null,
        status: hint || 'Prospect', files: [] });
    }
    const fileName = rest[rest.length - 1];
    const c = classify(fileName, rest.slice(0, -1).join(' '));
    const f = Object.assign({ path: e.path, fileName, subPath: rest.slice(0, -1).join('/'), size: e.size, modified: e.modified,
      include: true, account: key }, c);
    f.date = c.nameDate || e.modified || null;
    accts.get(key).files.push(f);
    files.push(f);
  });
  return { source, accounts: Array.from(accts.values()), files };
}

function acctStats(a) {
  const inc = a.files.filter(f => f.include);
  return {
    files: inc.length,
    checklist: inc.filter(f => CHECKLIST_DOC_TYPES.includes(f.type)).length,
    decs: inc.filter(f => f.type === 'Dec Page / Policy').length,
    lines: Array.from(new Set(inc.map(f => f.line).filter(Boolean))).sort(),
    other: inc.filter(f => f.type === 'Other').length,
  };
}

// ------------------------------------------------------------------ import

async function bulk(fn) { return window.LocalAPI ? LocalAPI.withDeferredSave(fn) : fn(); }

function newest(files) { return files.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0]; }

async function runImport(progress) {
  const plan = IMP.scan;
  const opt = IMP.options;
  const res = { created: 0, matched: 0, docs: 0, docsUpdated: 0, lossRuns: 0, policies: 0, notes: 0, accountIds: [] };
  const todo = plan.accounts.filter(a => a.include && (a.matchId || a.name.trim()) && a.files.some(f => f.include));
  await bulk(async () => {
    let i = 0;
    for (const a of todo) {
      i++;
      progress(`Importing ${i} of ${todo.length}: ${a.name || a.folder}`);
      await new Promise(r => setTimeout(r));
      let accountId = a.matchId, accountStatus = null;
      if (accountId) {
        res.matched++;
        accountStatus = (await R.get('accounts', accountId)).status;
      } else {
        const row = await R.create('accounts', { named_insured: a.name.trim(), status: a.status, add_to_pipeline: a.status === 'Prospect' });
        accountId = row.id; accountStatus = a.status; res.created++;
      }
      res.accountIds.push(accountId);
      const files = a.files.filter(f => f.include);

      if (opt.docs) {
        const existing = await R.list('documents', { account_id: accountId });
        const groups = {};
        for (const f of files.filter(f => CHECKLIST_DOC_TYPES.includes(f.type))) {
          const name = checklistName(f.type, f.line);
          const k = `${f.line || ''}|${name}`;
          (groups[k] = groups[k] || { name, line: f.line, files: [] }).files.push(f);
        }
        for (const g of Object.values(groups)) {
          const latest = newest(g.files);
          const notes = 'Imported from: ' + g.files.map(f => f.path).join('; ');
          const doc = existing.find(d => (d.line || null) === (g.line || null) && d.name === g.name);
          if (doc) {
            if (doc.status !== 'Received') {
              await R.update('documents', doc.id, { status: 'Received', date_received: latest.date || todayISO(), notes: [doc.notes, notes].filter(Boolean).join('\n') });
              res.docsUpdated++;
            }
          } else {
            await R.create('documents', { account_id: accountId, line: g.line, name: g.name, status: 'Received', date_received: latest.date || todayISO(), notes });
            res.docs++;
          }
        }
      }

      if (opt.lossRuns) {
        const groups = {};
        for (const f of files.filter(f => f.type === 'Loss Runs')) {
          const k = `${f.line || ''}|${f.carrier || ''}`;
          (groups[k] = groups[k] || []).push(f);
        }
        for (const g of Object.values(groups)) {
          const latest = newest(g);
          const d = latest.date || todayISO();
          await R.create('loss_runs', { account_id: accountId, carrier: latest.carrier, line: latest.line, date_requested: d, date_received: d,
            status: 'Received', notes: 'Imported from: ' + g.map(f => f.path).join('; ') });
          res.lossRuns++;
        }
      }

      if (opt.policies) {
        const have = new Set((await R.list('policies', { account_id: accountId })).map(p => p.line));
        const byLine = {};
        for (const f of files.filter(f => ['Dec Page / Policy', 'Binder'].includes(f.type) && f.line)) (byLine[f.line] = byLine[f.line] || []).push(f);
        const isClient = ['Active Client', 'BOR Won'].includes(accountStatus);
        for (const [line, fs] of Object.entries(byLine)) {
          if (have.has(line)) continue;
          const latest = fs.slice().sort((x, y) => (y.term || y.date || '').localeCompare(x.term || x.date || ''))[0];
          await R.create('policies', { account_id: accountId, line, carrier: latest.carrier, status: isClient ? 'Bound' : 'Not Yet Marketed',
            aor_status: isClient ? 'AOR' : 'Not AOR',
            notes: `Placeholder created from document import${latest.term ? ` (term ${latest.term})` : ''} — confirm dates, premium and policy number.\nSource: ${latest.path}` });
          res.policies++;
        }
      }

      if (opt.note && files.length) {
        const byType = {};
        files.forEach(f => { (byType[f.type] = byType[f.type] || []).push(f); });
        const body = [`Document index — ${files.length} file${files.length === 1 ? '' : 's'} imported from ${plan.source}`, '']
          .concat(Object.keys(byType).sort().flatMap(t => [`${t}:`, ...byType[t].map(f => `  • ${f.path}${f.date ? ` (${fmtDate(f.date)})` : ''}`), '']))
          .join('\n').trim();
        await R.create('notes', { account_id: accountId, body });
        res.notes++;
      }
    }
  });
  invalidateAccounts();
  return res;
}

function exportFileList() {
  const plan = IMP.scan;
  const byKey = Object.fromEntries(plan.accounts.map(a => [a.key, a]));
  const names = Object.fromEntries((S.accounts || []).map(a => [a.id, a.named_insured]));
  downloadCSV('Document import file list',
    ['Path', 'Folder', 'Account', 'Existing account match', 'Status if new', 'Document type', 'Checklist item', 'Line', 'Carrier', 'Term', 'Date', 'Size (KB)', 'Included'],
    plan.files.map(f => {
      const a = byKey[f.account];
      return [f.path, a.folder, a.name, a.matchId ? names[a.matchId] || a.matchId : '', a.matchId ? '' : a.status, f.type,
        CHECKLIST_DOC_TYPES.includes(f.type) ? checklistName(f.type, f.line) : '', f.line || '', f.carrier || '', f.term || '',
        f.date ? fmtDate(f.date) : '', f.size != null ? Math.round(f.size / 1024) : '', a.include && f.include ? 'Yes' : 'No'];
    }));
}

// ------------------------------------------------------------------ UI

route('/import', async (main) => {
  const accounts = await accountsCache(true);
  clear(main).append(pageHead('Import Documents',
    IMP.scan && !IMP.result ? h('button', { class: 'btn', onclick: () => { IMP.scan = null; refreshRoute(); } }, 'Start over') : null));
  if (IMP.result) return renderImportResult(main);
  if (!IMP.scan) return renderImportStart(main, accounts);
  renderImportReview(main, accounts);
});

function renderImportStart(main, accounts) {
  const status = h('div', { class: 'muted', style: { marginTop: '10px' } });
  const handle = async (fn) => {
    status.textContent = 'Reading file names…';
    try {
      const { source, entries } = await fn();
      if (!entries.length) { status.textContent = 'No files found.'; return; }
      IMP.scan = buildPlan(source, entries, accounts);
      IMP.result = null;
      refreshRoute();
    } catch (e) { status.textContent = ''; toast(e.message, true); }
  };
  const folderInput = h('input', { type: 'file', class: 'hidden', webkitdirectory: true, directory: true, multiple: true,
    onchange: (e) => handle(async () => {
      const files = e.target.files;
      const root = files.length ? (files[0].webkitRelativePath || '').split('/')[0] : '';
      return { source: root || 'folder', entries: readFileList(files) };
    }) });
  const zipInput = h('input', { type: 'file', class: 'hidden', accept: '.zip',
    onchange: (e) => { const f = e.target.files[0]; if (f) handle(async () => ({ source: f.name, entries: await readZipEntries(f) })); } });
  const drop = h('div', { class: 'dropzone',
    ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
    ondragleave: () => drop.classList.remove('over'),
    ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); handle(() => readDropped(e.dataTransfer)); } },
    h('div', { class: 'big' }, '⇣'),
    h('div', null, h('strong', null, 'Drop your folder or .zip here')),
    h('div', { class: 'toolbar', style: { justifyContent: 'center', marginTop: '10px' } },
      h('button', { class: 'btn btn-primary', onclick: () => zipInput.click() }, 'Choose .zip file…'),
      h('button', { class: 'btn', onclick: () => folderInput.click() }, 'Choose folder…')),
    folderInput, zipInput, status);

  main.append(
    h('div', { class: 'panel', style: { maxWidth: '860px' } },
      h('p', null, 'Point this at your client and prospect folders. It sorts them into accounts and fills in the document checklist, ',
        h('strong', null, 'using only the file and folder names'), ' — files are never opened, copied or uploaded, and nothing leaves this computer. ',
        'Large zips are fine: only the zip’s table of contents is read.'),
      drop,
      h('h3', { style: { marginTop: '18px' } }, 'How it sorts'),
      h('ul', { class: 'muted' },
        h('li', null, 'Each top-level folder becomes one account (matched to an existing account when the name matches).'),
        h('li', null, 'Group folders like “Clients”, “Prospects” or “Lost” set the status of the accounts inside them.'),
        h('li', null, 'File names like “ACORD 130”, “Loss Runs 2024”, “SOV”, “Driver List”, “Board List” mark those checklist items Received (dated from the file).'),
        h('li', null, 'Line of coverage comes from the file name or a subfolder (e.g. “WC”, “Auto”, “D&O”); carriers from the Settings carrier list.'),
        h('li', null, 'Dec pages create policy placeholders per line; every file is listed in a searchable note on its account.'),
        h('li', null, 'You review everything before anything is saved.'))));
}

function renderImportReview(main, accounts) {
  const plan = IMP.scan;
  const inc = plan.accounts.filter(a => a.include);
  const incFiles = inc.flatMap(a => a.files.filter(f => f.include));
  const acctOptions = accounts.map(a => ({ value: a.id, label: a.named_insured }));
  const opt = IMP.options;
  const optBox = (key, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: opt[key], onchange: (e) => { opt[key] = e.target.checked; } }), label);
  const progressEl = h('span', { class: 'muted' });
  const importBtn = h('button', { class: 'btn btn-primary', onclick: async () => {
    const todo = plan.accounts.filter(a => a.include && (a.matchId || a.name.trim()));
    const newCount = todo.filter(a => !a.matchId).length;
    if (!todo.length) { toast('Nothing selected to import', true); return; }
    if (!await confirmDialog(`Import ${todo.length} account${todo.length === 1 ? '' : 's'} (${newCount} new, ${todo.length - newCount} existing)? Download a backup first if you want an easy undo.`, 'Import')) return;
    importBtn.disabled = true;
    try {
      IMP.result = await runImport(msg => { progressEl.textContent = msg; });
      await loadLookups();
      refreshRoute();
    } catch (e) { toast(e.message, true); importBtn.disabled = false; progressEl.textContent = ''; }
  } }, `Import ${inc.length} account${inc.length === 1 ? '' : 's'}`);

  main.append(
    h('p', { class: 'muted' }, `Source: ${plan.source} — ${plan.files.length} files in ${plan.accounts.length} folders. Review below; nothing is saved until you click Import.`),
    h('div', { class: 'cards' },
      stat('Accounts', inc.length, `${inc.filter(a => !a.matchId).length} new · ${inc.filter(a => a.matchId).length} existing`),
      stat('Files', incFiles.length),
      stat('Checklist Docs', incFiles.filter(f => CHECKLIST_DOC_TYPES.includes(f.type)).length, 'will be marked Received'),
      stat('Loss Runs', incFiles.filter(f => f.type === 'Loss Runs').length),
      stat('Dec Pages / Policies', incFiles.filter(f => f.type === 'Dec Page / Policy').length),
      stat('Unrecognized', incFiles.filter(f => f.type === 'Other').length, 'listed in the account note', { cls: 'text' })),
    h('div', { class: 'panel', style: { marginBottom: '14px' } },
      h('div', { class: 'toolbar', style: { marginBottom: 0 } },
        optBox('docs', 'Mark checklist documents Received'), optBox('lossRuns', 'Add loss runs to the tracker'),
        optBox('policies', 'Create policy placeholders from dec pages'), optBox('note', 'Add a file index note to each account'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: exportFileList }, '⤓ Export file list (CSV)'), importBtn, progressEl)),
    DataTable({
      name: 'Import accounts', rows: plan.accounts, defaultSort: { key: 'folder', dir: 1 },
      rowClass: a => a.include ? '' : 'row-done',
      columns: [
        { key: 'include', label: '✓', sortable: false, filter: false, export: false,
          render: a => h('input', { type: 'checkbox', checked: a.include, onchange: (e) => { a.include = e.target.checked; refreshRoute(); } }) },
        { key: 'folder', label: 'Folder' },
        { key: 'name', label: 'Account name', render: a => a.matchId ? h('span', { class: 'muted' }, '—') :
          h('input', { type: 'text', class: 'inline', value: a.name, style: { minWidth: '220px' }, placeholder: 'Name for new account',
            onchange: (e) => { a.name = e.target.value; if (a.name.trim() && !a.include) { a.include = true; refreshRoute(); } } }) },
        { key: 'matchId', label: 'Existing account', value: a => a.matchId ? (accounts.find(x => x.id === a.matchId) || {}).named_insured : '',
          render: a => h('select', { class: 'inline', style: { maxWidth: '240px' }, onchange: (e) => { a.matchId = e.target.value ? Number(e.target.value) : null; refreshRoute(); } },
            h('option', { value: '' }, '+ Create new'), acctOptions.map(o => h('option', { value: o.value, selected: o.value === a.matchId }, o.label))) },
        { key: 'status', label: 'Status (new)', filterOptions: L().account_statuses, render: a => a.matchId ? '' :
          h('select', { class: 'inline', onchange: (e) => { a.status = e.target.value; } }, L().account_statuses.map(s => h('option', { value: s, selected: s === a.status }, s))) },
        { key: 'files', label: 'Files', type: 'number', value: a => acctStats(a).files },
        { key: 'checklist', label: 'Checklist Docs', type: 'number', value: a => acctStats(a).checklist },
        { key: 'decs', label: 'Dec Pages', type: 'number', value: a => acctStats(a).decs },
        { key: 'lines', label: 'Lines Found', value: a => acctStats(a).lines.join(', ') },
        { key: 'review', label: '', sortable: false, filter: false, export: false, render: a => h('button', { class: 'btn btn-sm', onclick: () => reviewFiles(a) }, 'Review files') },
      ],
    }));
}

function reviewFiles(a) {
  const lines = L().lines;
  openModal({
    title: `${a.name || a.folder} — ${a.files.length} files`, wide: true,
    body: DataTable({
      name: `Files - ${a.folder}`, rows: a.files, defaultSort: { key: 'fileName', dir: 1 },
      columns: [
        { key: 'include', label: '✓', sortable: false, filter: false, export: false,
          render: f => h('input', { type: 'checkbox', checked: f.include, onchange: (e) => { f.include = e.target.checked; } }) },
        { key: 'fileName', label: 'File', render: f => h('span', null, f.fileName, f.subPath ? h('div', { class: 'muted small' }, f.subPath) : null) },
        { key: 'type', label: 'Type', filterOptions: ALL_DOC_TYPES, exportValue: f => f.type,
          render: f => h('select', { class: 'inline', onchange: (e) => { f.type = e.target.value; if (TYPE_FIXED_LINE[f.type]) f.line = TYPE_FIXED_LINE[f.type]; } },
            ALL_DOC_TYPES.map(t => h('option', { value: t, selected: t === f.type }, t))) },
        { key: 'line', label: 'Line', filterOptions: lines, exportValue: f => f.line,
          render: f => h('select', { class: 'inline', onchange: (e) => { f.line = e.target.value || null; } },
            h('option', { value: '' }, '—'), lines.map(l => h('option', { value: l, selected: l === f.line }, l))) },
        { key: 'carrier', label: 'Carrier' },
        { key: 'term', label: 'Term' },
        { key: 'date', label: 'Date', type: 'date' },
      ],
    }),
    actions: ['spacer', { label: 'Done', class: 'btn-primary', onclick: m => m.close() }],
    onClose: () => refreshRoute(),
  });
}

function renderImportResult(main) {
  const r = IMP.result;
  main.append(
    h('div', { class: 'panel', style: { maxWidth: '760px' } },
      h('h2', null, '✓ Import complete'),
      h('div', { class: 'cards' },
        stat('Accounts Created', r.created), stat('Existing Updated', r.matched), stat('Checklist Docs Added', r.docs, r.docsUpdated ? `${r.docsUpdated} existing marked Received` : ''),
        stat('Loss Runs', r.lossRuns), stat('Policy Placeholders', r.policies), stat('File Index Notes', r.notes)),
      r.policies ? h('p', { class: 'muted' }, 'Policy placeholders have no dates or premium yet — open each account’s Portfolio to fill them in so they show on the renewal calendar.') : null,
      h('div', { class: 'toolbar' },
        h('a', { class: 'btn btn-primary', href: '#/accounts' }, 'Go to Accounts'),
        h('a', { class: 'btn', href: '#/documents?show=Received' }, 'See imported documents'),
        h('button', { class: 'btn', onclick: () => { IMP.scan = null; IMP.result = null; refreshRoute(); } }, 'Import more'))));
}
