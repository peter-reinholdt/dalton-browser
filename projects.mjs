import { uid, example, parseDaltonMolecule } from './molecules.mjs';
import { defaults } from './calculations.mjs';
import { safeName } from './runtime.mjs';
import { fingerprint } from './molecules.mjs';
import { parseMolden } from './results.mjs';
const MAX_BYTES = 128 * 1024 ** 2;
export function createProject(name = 'Untitled project', mol = example('water')) {
  return {
    id: uid(),
    name,
    molecule: mol,
    calculation: defaults(),
    files: [],
    runs: [],
    structures: [],
    measurements: [],
    studies: [],
    activeStudy: null,
    activeRun: null,
    prepared: null,
    expert: { dal: '', mol: '', name: 'Expert calculation' },
    undo: [],
    updated: new Date().toISOString(),
  };
}
export function migrateSession(session) {
  if (session?.version === 2 && Array.isArray(session.projects)) { session.processes ??= 1; return session; }
  const p = createProject(session?.files?.length ? 'Imported browser session' : 'Water project');
  if (session?.files?.length) {
    p.files = session.files;
    const map = new Map(p.files),
      name = session.mol ?? [...map.keys()].find((n) => n.endsWith('.mol'));
    if (map.get(name))
      try {
        p.molecule = parseDaltonMolecule(new TextDecoder().decode(map.get(name).data));
        p.calculation.basis = p.molecule.basis;
        p.calculation.charge = p.molecule.charge;
      } catch {}
    const dal = session.dal ?? [...map.keys()].find((n) => n.toLowerCase().endsWith('.dal'));
    p.expert = {
      name: 'Migrated expert calculation',
      dal: new TextDecoder().decode(map.get(dal)?.data ?? new Uint8Array()),
      mol: new TextDecoder().decode(map.get(name)?.data ?? new Uint8Array()),
    };
    p.calculation.mode = 'expert';
  }
  return { version: 2, projects: [p], activeProject: p.id, memory: session?.memory ?? '16000000', processes: 1 };
}
export function recoverRuns(session) {
  for (const p of session.projects) {
    p.calculation = { ...defaults(), ...p.calculation };
    p.structures ??= [];
    p.measurements ??= [];
    p.studies ??= [];
    p.activeStudy ??= null;
    for (const study of p.studies) {
      if (study.status === 'running') study.status = 'interrupted';
      for (const step of study.steps) if (step.status === 'running') step.status = 'interrupted';
    }
    for (const r of p.runs)
      if (r.status === 'running') {
        r.status = 'interrupted';
        r.failure = 'The browser was closed or reloaded during this run.';
      }
  }
  return session;
}
let database;
function db() {
  return (database ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('dalton-workspace', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('sessions');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}
export async function loadSession() {
  const d = await db();
  const value = await new Promise((resolve, reject) => {
    const r = d.transaction('sessions').objectStore('sessions').get('current');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return recoverRuns(migrateSession(value));
}
export async function saveSession(session) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('sessions', 'readwrite');
    t.objectStore('sessions').put(session, 'current');
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('Storage transaction aborted'));
  });
}
export function projectJSON(project) {
  let bytes = 0;
  const json = JSON.stringify(
    { format: 'dalton-browser-v2', project },
    (_key, v) => {
      if (v instanceof Uint8Array) {
        bytes += v.length;
        if (bytes > MAX_BYTES)
          throw new Error(
            'Project artifacts exceed the portable 128 MB limit. Download individual artifacts and remove old runs before exporting.',
          );
        let text = '';
        for (let i = 0; i < v.length; i += 32768)
          text += String.fromCharCode(...v.subarray(i, i + 32768));
        return { $bytes: btoa(text) };
      }
      return v;
    },
    2,
  );
  if (json.length > 190 * 1024 ** 2)
    throw new Error(
      'Project metadata exceeds the portable download limit. Remove old runs before exporting.',
    );
  return json;
}
export function importProject(text) {
  if (text.length > 190 * 1024 ** 2) throw new Error('Project is too large to import.');
  let bytes = 0;
  const parsed = JSON.parse(text, (key, v) => {
    if (['__proto__', 'constructor', 'prototype'].includes(key))
      throw new Error('Invalid project key.');
    if (v && typeof v === 'object' && Object.hasOwn(v, '$bytes')) {
      if (typeof v.$bytes !== 'string' || v.$bytes.length > 45 * 1024 ** 2)
        throw new Error('Invalid artifact.');
      const data = Uint8Array.from(atob(v.$bytes), (c) => c.charCodeAt(0));
      bytes += data.length;
      if (bytes > MAX_BYTES) throw new Error('Project artifacts exceed 128 MB.');
      return data;
    }
    return v;
  });
  if (parsed.format === 'dalton-browser-v1') {
    const names = new Set();
    const files = (parsed.files ?? []).map((entry) => {
      const name = safeName(entry.name);
      if (names.has(name)) throw new Error('Duplicate file name.');
      names.add(name);
      if (typeof entry.base64 !== 'string' || entry.base64.length > 45 * 1024 ** 2)
        throw new Error('Invalid artifact.');
      const data = Uint8Array.from(atob(entry.base64), (c) => c.charCodeAt(0));
      bytes += data.length;
      if (bytes > MAX_BYTES) throw new Error('Project exceeds 128 MB.');
      return [name, { data, result: !!entry.result }];
    });
    return migrateSession({ files }).projects[0];
  }
  if (parsed.format !== 'dalton-browser-v2' || !parsed.project)
    throw new Error('Not a Web Dalton project.');
  const p = parsed.project;
  if (
    typeof p.name !== 'string' ||
    !Array.isArray(p.molecule?.atoms) ||
    p.molecule.atoms.length > 10000 ||
    !Array.isArray(p.runs) ||
    !Array.isArray(p.files) ||
    !p.calculation ||
    typeof p.expert?.dal !== 'string' ||
    typeof p.expert?.mol !== 'string'
  )
    throw new Error('Invalid project structure.');
  for (const [name, f] of p.files) {
    safeName(name);
    if (!(f.data instanceof Uint8Array)) throw new Error('Invalid file data.');
  }
  for (const r of p.runs) {
    if (!Array.isArray(r.artifacts) || typeof r.id !== 'string' || !r.input)
      throw new Error('Invalid run record.');
    for (const a of r.artifacts) {
      safeName(a.name);
      if (!(a.data instanceof Uint8Array)) throw new Error('Invalid run artifact.');
    }
  }
  if (
    p.studies &&
    (!Array.isArray(p.studies) ||
      p.studies.some(
        (st) =>
          typeof st.id !== 'string' ||
          !Array.isArray(st.steps) ||
          !st.molecule?.atoms ||
          st.steps.some((s) => s.runId && !p.runs.some((r) => r.id === s.runId)),
      ))
  )
    throw new Error('Invalid study references.');
  if (
    p.structures &&
    (!Array.isArray(p.structures) ||
      p.structures.some((s) => !s.molecule?.atoms || typeof s.name !== 'string'))
  )
    throw new Error('Invalid saved structures.');
  if (
    p.measurements &&
    (!Array.isArray(p.measurements) ||
      p.measurements.some(
        (m) =>
          typeof m.name !== 'string' ||
          typeof m.moleculeId !== 'string' ||
          !Array.isArray(m.ids) ||
          ![2, 3, 4].includes(m.ids.length) ||
          m.ids.some((id) => typeof id !== 'string'),
      ))
  )
    throw new Error('Invalid saved measurements.');
  p.id = uid();
  p.undo = [];
  p.calculation = { ...defaults(), ...p.calculation };
  const ref = p.runs.find((r) => r.id === p.prepared?.runId),
    mo = ref?.artifacts.find((a) => a.name === 'molden.inp'),
    punch = ref?.artifacts.find((a) => a.name === 'DALTON.MOPUN');
  if (mo && punch && p.prepared.fingerprint === fingerprint(p.molecule, p.calculation))
    p.prepared = {
      runId: ref.id,
      orbitalCount: parseMolden(new TextDecoder().decode(mo.data)).orbitals.length,
      fingerprint: p.prepared.fingerprint,
      orbitals: new TextDecoder().decode(punch.data),
    };
  else {
    p.prepared = null;
    p.calculation.activeIndices = [];
  }
  return recoverRuns({ projects: [p] }).projects[0];
}
