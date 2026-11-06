import { propertyResultHTML } from './properties.mjs';
import { ensureIsolation } from './isolation.mjs';
import { executionWorker, mpiAvailability, validateExecution, memoryEstimate } from './mpi/execution.mjs';
document.body.inert = true;
await ensureIsolation();
import { safeName, validateJob } from './runtime.mjs';
import {
  BOHR,
  ELEMENTS,
  uid,
  example,
  parseXYZ,
  toXYZ,
  parseDaltonMolecule,
  validateMolecule,
  fingerprint,
  measurement,
  molecule,
} from './molecules.mjs';
import {
  METHODS,
  FUNCTIONALS,
  PROPERTY_TASKS,
  settingsFromInput,
  taskAvailable,
  DISPERSION_FUNCTIONALS,
  TASKS,
  defaults,
  generateInput,
  validateCalculation,
  orbitalPermutation,
} from './calculations.mjs';
import {
  createProject,
  migrateSession,
  loadSession,
  saveSession,
  projectJSON,
  importProject,
} from './projects.mjs';
import { parseOutput, parseMolden, phaseFromOutput, compatibleRuns, csv } from './results.mjs';
import { MolecularViewer } from './viewer.mjs';
import { linePlot, spectrum, xyPlot } from './plots.mjs';
import { coordinate, resultGeometry } from './geometry.mjs';
import { studyWorkspace } from './study-ui.mjs';
import { parseResponse, EV, HC } from './excitations.mjs';
import { excitationResults } from './excitation-ui.mjs';
const $ = (id) => document.getElementById(id),
  enc = new TextEncoder(),
  dec = new TextDecoder(),
  clone = (value) => structuredClone(value);
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
let session,
  manifest,
  mpiManifest,
  stage = 'molecule',
  worker = null,
  startupController = null,
  busy = false,
  studyRunning = false,
  liveCompletion = null,
  saveTimer,
  clockTimer,
  started,
  phase = '',
  liveRun = null,
  liveOutputTail = '',
  sketcher = null,
  chemWorker = null,
  chemTimer,
  molden = null,
  selectedOrbital = null,
  nameAction = 'new',
  sdfRecords = [],
  animation = null,
  viewerVersion = 0;
const p = () => session.projects.find((p) => p.id === session.activeProject),
  currentRun = () => p().runs.find((r) => r.id === p().activeRun);
const term = new window.Terminal({
  fontSize: 11,
  lineHeight: 1.3,
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  scrollback: 4000,
  convertEol: true,
  theme: { background: '#132e2b', foreground: '#c5d8c3', cursor: '#8dbe94' },
});
term.open($('terminal'));
function fit() {
  if ($('terminal').clientWidth)
    term.resize(
      Math.max(20, Math.floor(($('terminal').clientWidth - 36) / 6.8)),
      Math.max(4, Math.floor(($('terminal').clientHeight - 16) / 15)),
    );
}
new ResizeObserver(fit).observe($('terminal'));
const log = (text, error = false) => term.write(error ? `\x1b[31m${text}\x1b[0m` : text);
function notice(text, error = false) {
  $('notice').hidden = !text;
  $('notice').textContent = text;
  $('notice').dataset.error = String(error);
}
function guard(fn) {
  return (...args) =>
    Promise.resolve()
      .then(() => fn(...args))
      .catch((e) => {
        console.error('Workspace action failed', e);
        const message = e?.message ?? String(e);
        notice(message, true);
        log(`\n${message}\n`, true);
      });
}
const viewer = new MolecularViewer($('viewer'), (index) => {
  if (animation) stopAnimation();
  const atoms = displayedAtoms;
  if (!atoms?.[index]) return;
  const previous = picks.findIndex(a => a.id === atoms[index].id);
  if (previous >= 0) picks = picks.slice(0, previous + 1);
  else picks.push(atoms[index]);
  if (picks.length > 4) picks = [atoms[index]];
  notice(
    picks.length > 1
      ? picks.length === 4
        ? `Dihedral: ${coordinate(
            { atoms: picks },
            picks.map((a) => a.id),
          ).toFixed(3)}°`
        : measurement(picks)
      : `Selected ${atoms[index].symbol}${index + 1}. Click another atom to measure.`,
  );
  if (picks.every(a => p().molecule.atoms.some(b => b.id === a.id))) {
    ['a', 'b', 'c', 'd'].forEach((key, i) => {
      const idx = p().molecule.atoms.findIndex((a) => a.id === picks[i]?.id);
      $('measure-' + key).value = idx < 0 ? '' : String(idx);
    });
    updateMeasurement();
  }
});
let picks = [];
let measurementIds = [];
let displayedAtoms = [];
viewer.ready.catch((e) => {
  $('viewer').replaceChildren(
    Object.assign(document.createElement('div'), {
      className: 'viewer-placeholder',
      textContent: e.message + ' Coordinates and results remain available.',
    }),
  );
});
function download(name, data, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type })),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function save() {
  clearTimeout(saveTimer);
  session.updated = new Date().toISOString();
  return saveSession(session)
    .then(() => {
      $('save-state').textContent = 'Saved locally';
    })
    .catch(() => {
      $('save-state').textContent = 'Storage unavailable — download your project';
      notice(
        'Browser storage is full or unavailable. Download your project to keep this work.',
        true,
      );
    });
}
function scheduleSave() {
  if (!session) return;
  p().updated = new Date().toISOString();
  $('save-state').textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}
function messages(id, errors = [], warnings = []) {
  $(id).innerHTML = [
    ...errors.map((s) => `<p class="error">${escape(s)}</p>`),
    ...warnings.map((s) => `<p class="warning">${escape(s)}</p>`),
  ].join('');
}
function setStage(next) {
  stopAnimation();
  if (next === 'studies') next = 'calculation';
  stage = next;
  document.querySelector('.stage-layout').dataset.activeStage = stage;
  $('calculation-preview').hidden = stage !== 'calculation';
  for (const key of ['molecule', 'calculation', 'results', 'studies']) {
    $(`stage-${key}`).hidden = key !== stage;
    const button = document.querySelector(`[data-stage="${key}"]`);
    if (button) {
      if (key === stage) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    }
  }
  picks = [];
  if (stage === 'results') { renderResults(); document.querySelector('.content-pane').scrollTop = 0; }
  else if (stage === 'studies') {
    studiesUI.render();
    refreshViewer();
  } else if (stage === 'calculation') {
    renderCalculation();
    studiesUI.render();
    refreshViewer();
  } else {
    renderMolecule();
    refreshViewer();
  }
}
function renderProjects() {
  const sel = $('projects');
  sel.replaceChildren(...session.projects.map((project) => new Option(project.name, project.id)));
  sel.value = p().id;
}
function renderHistory() {
  const nav = $('runs');
  nav.replaceChildren();
  for (const r of [...p().runs].reverse()) {
    if (r.purpose === 'coordinate' && r.status === 'completed') continue;
    const b = document.createElement('button');
    b.classList.toggle('active', r.id === p().activeRun);
    const title = document.createElement('span');
    title.textContent = r.name;
    const detail = document.createElement('small');
    detail.textContent = `${r.status} · ${new Date(r.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    b.append(title, detail);
    b.onclick = () => {
      p().activeRun = r.id;
      renderHistory();
      setStage('results');
      scheduleSave();
    };
    nav.append(b);
  }
  if (!p().runs.length) nav.textContent = 'No calculations yet.';
  renderFiles();
}
function renderAll() {
  renderProjects();
  renderHistory();
  renderMolecule();
  renderCalculation();
  studiesUI.render();
  setStage(stage);
}
function moleculeChanged(next) {
  studiesUI?.clearPreview();
  stopAnimation();
  const project = p();
  project.calculation.mode = 'guided';
  project.undo.push(clone(project.molecule));
  project.undo = project.undo.slice(-10);
  project.molecule = next;
  if (project.calculation.mode === 'expert') {
    project.calculation.mode = 'guided';
    notice('Using guided settings for the edited structure. Your expert input copy is saved.');
  }
  project.prepared = null;
  project.calculation.activeIndices = [];
  molden = null;
  selectedOrbital = null;
  $('download-cube').disabled = true;
  renderMolecule();
  renderCalculation();
  studiesUI.render();
  refreshViewer();
  scheduleSave();
}
function renderMolecule() {
  const mol = p().molecule,
    s = p().calculation,
    units = $('coordinate-units').value,
    scale = units === 'bohr' ? 1 / BOHR : 1;
  $('molecule-title').textContent = mol.name;
  $('undo-molecule').disabled = !p().undo.length;
  const check = validateMolecule(mol, s.charge, s.multiplicity);
  const counts = new Map();
  for (const a of mol.atoms) counts.set(a.symbol, (counts.get(a.symbol) ?? 0) + 1);
  const symbols = [...counts.keys()].sort();
  if (counts.has('C'))
    symbols.sort(
      (a, b) =>
        (a === 'C' ? -2 : a === 'H' ? -1 : 0) - (b === 'C' ? -2 : b === 'H' ? -1 : 0) ||
        a.localeCompare(b),
    );
  const formula = symbols
    .map((symbol) => symbol + (counts.get(symbol) > 1 ? counts.get(symbol) : ''))
    .join('');
  $('molecule-facts').innerHTML =
    `<span><b>${escape(formula)}</b>Formula</span><span><b>${mol.atoms.length}</b>Atoms</span><span><b>${check.electrons}</b>Electrons</span>`;
  $('coordinates').innerHTML = mol.atoms
    .map(
      (a, i) =>
        `<tr><td>${escape(a.symbol)}${i + 1}</td>${['x', 'y', 'z'].map((key) => `<td><input type="number" step="any" data-atom="${i}" data-coordinate="${key}" aria-label="${escape(a.symbol)}${i + 1} ${key} in ${units}" value="${(a[key] * scale).toFixed(6)}"></td>`).join('')}</tr>`,
    )
    .join('');
  $('xyz-input').value = toXYZ(mol, units);
  for (const key of ['a', 'b', 'c', 'd']) {
    const sel = $(`measure-${key}`);
    sel.replaceChildren(
      new Option(
        key === 'c' ? 'No third atom' : key === 'd' ? 'No fourth atom' : 'Choose atom',
        '',
      ),
      ...mol.atoms.map((a, i) => new Option(`${a.symbol}${i + 1}`, String(i))),
    );
    const saved = measurementIds[['a', 'b', 'c', 'd'].indexOf(key)];
    const index = mol.atoms.findIndex((a) => a.id === saved);
    sel.value = index < 0 ? '' : String(index);
  }
  if (mol.atoms.length > 1 && !measurementIds.length) {
    $('measure-a').value = '0';
    $('measure-b').value = '1';
  }
  updateMeasurement();
  messages('geometry-checks', check.errors, check.warnings);
}
function updateMeasurement() {
  const ids = ['a', 'b', 'c', 'd']
    .map((k) => $(`measure-${k}`).value)
    .filter((v) => v !== '')
    .map((i) => p().molecule.atoms[Number(i)]?.id);
  measurementIds = ids;
  try {
    const value = coordinate(p().molecule, ids);
    $('measurement').textContent =
      `${ids.length === 2 ? 'Distance' : ids.length === 3 ? 'Angle' : 'Dihedral'}: ${value.toFixed(4)} ${ids.length === 2 ? 'Å' : '°'}`;
    $('coordinate-target').value = value.toFixed(4);
  } catch (error) {
    $('measurement').textContent = error.message;
  }
}
function renderCalculation() {
  const s = p().calculation;
  for (const [key] of Object.entries(defaults())) {
    const el = $(key);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!s[key];
    else if (key !== 'method' && key !== 'task' && key !== 'basis') el.value = String(s[key]);
  }
  $('method').replaceChildren(
    new Option('SCF', 'SCF'),
    ...Object.entries(METHODS)
      .filter(([key]) => !['HF', 'DFT'].includes(key))
      .map(([key, m]) => new Option(m.label, key)),
  );
  $('method').value = ['HF', 'DFT'].includes(s.method) ? 'SCF' : s.method;
  $('functional').replaceChildren(new Option('HF · Hartree–Fock','HF'));
  for (const family of [...new Set(FUNCTIONALS.map(f=>f[2]))]) {
    const group=document.createElement('optgroup');group.label=family;
    for(const [name,label] of FUNCTIONALS.filter(f=>f[2]===family)) group.append(new Option(label,name));
    $('functional').append(group);
  }
  $('functional').value = s.method === 'HF' ? 'HF' : s.functional;
  $('task').replaceChildren(
    ...Object.entries(TASKS).map(([key, label]) => {
      const o = new Option(label, key);
      o.disabled = !taskAvailable(s,key);
      if (s.method === 'CI' && ['nmrShielding','magnetizability','opticalRotation'].includes(key)) o.title = 'This magnetic property path is unavailable for fixed-orbital CAS-CI in this Dalton version. Use SCF or CASSCF.';
      return o;
    }),
  );
  $('task').value = s.task;
  const catalog = manifest?.basisSets?.filter((b) => !b.auxiliary) ?? [
    { name: 'STO-3G' },
    { name: 'def2-SVP' },
  ];
  $('basis').replaceChildren(...catalog.map((b) => new Option(b.name, b.name)));
  if (!catalog.some((b) => b.name === s.basis)) $('basis').add(new Option(s.basis, s.basis));
  $('basis').value = s.basis;
  $('guided-panel').hidden = false;
  $('functional-field').hidden = !['HF', 'DFT'].includes(s.method);
  $('calculation-preview').hidden = stage !== 'calculation';
  $('stage-studies').hidden = stage !== 'calculation';
  $('dal-preview').readOnly = busy || studyRunning;
  $('mol-preview').readOnly = busy || studyRunning;
  $('dispersion-field').hidden = s.method !== 'DFT' || !DISPERSION_FUNCTIONALS.has(s.functional);
  $('pcm-precision-field').hidden = s.environment !== 'water' || s.task !== 'optimize';
  $('excitation-fields').hidden = !['excitations', 'excitedOptimize', 'twoPhoton'].includes(s.task);
  $('target-state-field').hidden = s.task !== 'excitedOptimize';
  $('response-frequency-field').hidden = !['opticalRotation','hyperpolarizability','secondHyperpolarizability'].includes(s.task);
  $('response-frequency-hint').textContent = s.responseFrequency > 0 ? `${(s.responseFrequency*EV).toFixed(4)} eV · ${(HC/(s.responseFrequency*EV)).toFixed(1)} nm` : 'Static field';
  $('property-note').textContent = PROPERTY_TASKS[s.task] ? 'Property tensors are reported in Dalton’s result coordinate frame. Inspect the full output above for conventions and individual contributions.' : '';
  $('cas-panel').hidden = !METHODS[s.method].multireference;
  $('average-field').hidden = s.method !== 'CASSCF';
  $('stateAverage').disabled = true;
  $('average-field').title =
    'This Dalton version parses .MCAVER but does not implement weighted orbital optimization.';
  $('weights-field').hidden = !s.stateAverage;
  $('steps-field').hidden = !['optimize', 'excitedOptimize'].includes(s.task);
  $('frozen-field').hidden = !['MP2', 'CCSD'].includes(s.method);
  $('capability-note').textContent = METHODS[s.method].multireference
    ? 'Guided active spaces use C1 symmetry. Roots share the selected spin; their identities can change with geometry.'
    : 'HF/DFT energy and geometry tasks support restricted high-spin references. Excitations use singlet CIS (HF) or TDA-DFT. All guided calculations use C1 symmetry.';
  const check = validateCalculation(p().molecule, s, p().prepared);
  if (p().prepared?.orbitals == null && s.activeIndices.length)
    check.errors.push('Prepare reference orbitals again for their formatted coefficients.');
  messages('calculation-checks', check.errors, check.warnings);
  $('cas-estimate').textContent =
    check.determinants == null
      ? ''
      : `Estimated determinant count before spin adaptation: ${check.determinants.toLocaleString()}`;
  try {
    const input = generateInput(p().molecule, s, p().prepared);
    $('dal-preview').value = s.mode === 'expert' ? p().expert.dal : input.dal;
    $('mol-preview').value = s.mode === 'expert' ? p().expert.mol : input.mol;
    $('input-edit-state').textContent = s.mode === 'expert' ? 'Edited input will run as shown. Changing a setting replaces these edits.' : 'Changing a setting regenerates this input.';
  } catch {
    $('dal-preview').value = s.mode === 'expert' ? p().expert.dal : '';
    $('mol-preview').value = s.mode === 'expert' ? p().expert.mol : '';
    $('input-edit-state').textContent = 'Resolve the settings above, or edit the input directly.';
  }
  $('prepare-orbitals').disabled = busy || s.multiplicity !== 1;
  $('prepared-status').textContent =
    s.multiplicity !== 1
      ? 'Reference preparation is currently available for singlets; use expert input for restricted open-shell starting orbitals.'
      : p().prepared
        ? 'Reference ready. Select active orbitals below. Unselected orbitals fill the inactive and virtual spaces.'
        : 'Prepare HF orbitals to select them visually. Without a selection, Dalton uses its default orbital ordering.';
  renderActiveOrbitals();
  const executionError = renderExecution();
  $('run').disabled =
    busy || studyRunning || !manifest || !!executionError || (s.mode !== 'expert' && check.errors.length > 0);
}
function getMolden(run) {
  const file = run?.artifacts.find((a) => a.name === 'molden.inp');
  if (!file) return null;
  const data = parseMolden(dec.decode(file.data));
  data.geometry = resultGeometry(run, data);
  for (const frame of data.trajectory)
    if (frame.atoms.length === data.geometry.atoms.length)
      frame.atoms.forEach((a, i) => (a.id = data.geometry.atoms[i].id));
  const trace = run.artifacts.find((a) => a.name === 'DALTON.ESOPT.jsonl');
  if (trace) {
    try {
      const text = dec.decode(trace.data),
        records = [...text.matchAll(/\{[\s\S]*?\}/g)].map((m) => JSON.parse(m[0]));
      data.trajectory = records.map((r, i) => ({
        name: 'Excited geometry ' + (i + 1),
        atoms: data.geometry.atoms.map((a, j) => ({
          ...a,
          x: r.coordinatesBohr[j][0] * BOHR,
          y: r.coordinatesBohr[j][1] * BOHR,
          z: r.coordinatesBohr[j][2] * BOHR,
        })),
      }));
      data.optimization.energy = records.map((r) => r.energy);
      data.excitedTrace = records;
    } catch (error) {
      console.error('Excited-state trace', error);
    }
  }
  return data;
}
function preparedRun() {
  return p().runs.find((r) => r.id === p().prepared?.runId);
}
function renderActiveOrbitals() {
  const el = $('active-orbitals');
  el.replaceChildren();
  const run = preparedRun();
  if (!run || p().prepared.fingerprint !== fingerprint(p().molecule, p().calculation)) return;
  let data;
  try {
    data = getMolden(run);
  } catch {
    return;
  }
  if (!data) return;
  const list = document.createElement('div');
  list.className = 'orbital-selection';
  for (const o of data.orbitals) {
    const label = document.createElement('label'),
      input = document.createElement('input'),
      text = document.createElement('span'),
      button = document.createElement('button');
    input.type = 'checkbox';
    input.checked = p().calculation.activeIndices.includes(o.id);
    input.disabled = busy;
    input.setAttribute('aria-label', `Active orbital ${o.id}`);
    input.onchange = () => {
      const set = new Set(p().calculation.activeIndices);
      input.checked ? set.add(o.id) : set.delete(o.id);
      p().calculation.activeIndices = [...set].sort((a, b) => a - b);
      renderCalculation();
      scheduleSave();
    };
    text.textContent = `MO ${o.id} · occ ${o.occupation.toFixed(2)}${o.energy == null ? '' : ` · ${o.energy.toFixed(4)} Eh`}`;
    button.textContent = 'View';
    button.className = 'text-button';
    button.type = 'button';
    button.onclick = guard(async () => {
      await showMolden(run);
      await selectOrbital(o.id);
    });
    label.append(input, text, button);
    list.append(label);
  }
  el.append(list);
}
async function refreshViewer() {
  const version = ++viewerVersion;
  $('orbital-controls').hidden = true;
  molden = null;
  selectedOrbital = null;
  await viewer.structure(toXYZ(p().molecule), fingerprint(p().molecule, p().calculation));
  if (version !== viewerVersion) return;
  displayedAtoms = p().molecule.atoms;
  picks = [];
  viewer.representation($('representation').value === 'space', $('atom-labels').checked);
  $('viewer-title').textContent = p().molecule.name;
  $('viewer-caption').textContent =
    'Drag to rotate · scroll to zoom · click up to four atoms to measure';
  $('show-dipole').checked = false;
  $('show-dipole').disabled = true;
  viewer.dipole(null);
}
async function showMolden(run) {
  const version = ++viewerVersion,
    data = getMolden(run);
  if (!data) throw new Error('This run did not export a Molden file.');
  molden = data;
  data.activeSpace = METHODS[run.settings?.method]?.multireference && Number.isInteger(run.settings.inactive) && Number.isInteger(run.settings.activeOrbitals)
    ? { inactive: run.settings.inactive, active: run.settings.activeOrbitals }
    : null;
  selectedOrbital = null;
  $('viewer-title').textContent = `${run.settings?.method ?? 'Dalton'} · result geometry`;
  const artifact = run.artifacts.find((a) => a.name === 'molden.inp');
  const hasUnsupportedShells = data.shells.some(
    (shell) => !['s', 'p', 'd', 'f'].includes(shell.type),
  );
  const native = hasUnsupportedShells ? run.artifacts.find((a) => a.name === 'DALTON.AOP') : null;
  $('download-cube').hidden = !native;
  $('cube-quality-field').hidden = !native;
  $('download-cube').disabled = true;
  const available =
    data.supported &&
    (!hasUnsupportedShells || !!native) &&
    data.basisCount <= 400 &&
    data.geometry.atoms.length <= 100 &&
    artifact.data.length <= 8 * 1024 ** 2;
  if (available)
    await viewer.orbitals(
      dec.decode(artifact.data),
      run.id,
      native ? dec.decode(native.data) : null,
      data.geometry,
    );
  else await viewer.structure(toXYZ(data.geometry), `${run.id}-geometry`);
  if (version !== viewerVersion) return;
  displayedAtoms = data.geometry.atoms;
  picks = [];
  $('show-dipole').checked = false;
  $('show-dipole').disabled = !run.results?.dipoleComponents;
  viewer.dipole(null);
  viewer.representation($('representation').value === 'space', $('atom-labels').checked);
  $('orbital-controls').hidden = !data.orbitals.length;
  $('orbital-provenance').textContent =
    `${data.orbitalProvenance}${native && available ? ' Higher angular momentum surfaces use cube grids generated locally from Dalton’s native normalized AO polynomials.' : available ? '' : hasUnsupportedShells ? ' Rerun this calculation to export native orbital data for higher angular momentum surfaces.' : ' Surface rendering unavailable for this file or its size; the orbital table and raw file remain available.'}`;
  $('show-homo').disabled = !available || !data.homo;
  $('show-lumo').disabled = !available || !data.lumo;
  data.renderable = available;
  const study = p().studies.find((st) => st.id === run.studyId);
  $('orbital-range').value = study?.options.orbitalRange ?? '';
  const h = data.orbitals.find((o) => o.id === data.homo),
    l = data.orbitals.find((o) => o.id === data.lumo);
  $('orbital-gap').textContent =
    h && l
      ? `HOMO–LUMO orbital gap: ${((l.energy - h.energy) * EV).toFixed(4)} eV (orbital-energy difference)`
      : '';
  $('viewer-caption').textContent =
    'Result coordinates and orbital numbering come from Dalton. Red and blue indicate opposite orbital phases.';
  renderOrbitalTable();
  renderOrbitalDiagram();
}
function renderOrbitalTable() {
  if (!molden) return;
  const q = $('orbital-filter').value.trim().toLowerCase(),
    sort = $('orbital-sort').value;
  const range = $('orbital-range').value.trim().toUpperCase();
  const resolve = (value) => {
    const m = value.match(/^(HOMO|LUMO)([+-]\d+)?$/);
    return m ? (m[1] === 'HOMO' ? molden.homo : molden.lumo) + Number(m[2] ?? 0) : Number(value);
  };
  const pair = range.split(':').map(resolve);
  const inRange = (o) =>
    !range || (pair.every(Number.isFinite) && o.id >= pair[0] && o.id <= (pair[1] ?? pair[0]));
  const list = molden.orbitals.filter(
    (o) => inRange(o) && `${o.id} ${o.symmetry}`.toLowerCase().includes(q),
  );
  if (sort === 'energy' && molden.energiesMeaningful) list.sort((a, b) => a.energy - b.energy);
  else if (sort === 'occupation') list.sort((a, b) => b.occupation - a.occupation);
  $('orbitals').innerHTML = list
    .slice(0, 200)
    .map(
      (o) =>
        `<tr class="${o.id === selectedOrbital ? 'selected' : ''}"><td><button data-orbital="${o.id}" ${!molden.renderable ? 'disabled' : ''}>${o.id}</button></td><td>${escape(o.symmetry)}</td><td>${molden.activeSpace ? (o.id <= molden.activeSpace.inactive ? 'Inactive' : o.id <= molden.activeSpace.inactive + molden.activeSpace.active ? 'Active' : 'Virtual') : '—'}</td><td>${o.occupation.toFixed(4)}</td><td>${molden.energiesMeaningful && o.energy != null ? o.energy.toFixed(6) : '—'}</td></tr>`,
    )
    .join('');
  if (list.length > 200)
    $('orbitals').insertAdjacentHTML(
      'beforeend',
      '<tr><td colspan="5">Showing 200 orbitals. Filter by index to find others.</td></tr>',
    );
}
function renderOrbitalDiagram() {
  const el = $('orbital-diagram');
  if (!molden?.orbitals.length) { el.replaceChildren(); return; }
  const energies = molden.energiesMeaningful;
  const homo = molden.orbitals.find(o => o.id === molden.homo);
  const levels = energies
    ? molden.orbitals.filter(o => o.energy != null && Math.abs(o.energy - (homo?.energy ?? 0)) < 1).slice(-40)
    : molden.orbitals.slice(0,40);
  if (!levels.length) { el.replaceChildren(); return; }
  const values = levels.map(o => energies ? o.energy : o.occupation);
  const low = Math.min(...values), high = Math.max(...values), span = high-low || 1;
  el.innerHTML = `<div class="hint">${energies ? 'Frontier levels / Eh' : 'Reported occupations'}</div><svg viewBox="0 0 190 300" role="group" aria-label="${energies ? 'Orbital energy levels' : 'Orbital occupations'}">${levels.map((o,i) => {
    const y=274-(values[i]-low)/span*245, selected=o.id===selectedOrbital;
    return `<g data-orbital="${o.id}" role="button" tabindex="${molden.renderable ? 0 : -1}" aria-label="Show orbital ${o.id}" aria-pressed="${selected}"><title>MO ${o.id}: ${values[i].toFixed(5)} ${energies ? 'Eh' : 'electrons'}</title><rect x="47" y="${y-5}" width="115" height="10" fill="transparent"/><line x1="55" x2="155" y1="${y}" y2="${y}" stroke="${selected ? '#d23030' : o.occupation>0 ? '#23765e' : '#4569ad'}" stroke-width="${selected ? 4 : 2}"/></g>`;
  }).join('')}<text x="1" y="30" font-size="10" fill="#465b50">${high.toFixed(2)}</text><text x="1" y="278" font-size="10" fill="#465b50">${low.toFixed(2)}</text></svg>`;
}
async function selectOrbital(index) {
  if (!molden?.renderable) throw new Error('Surface rendering is unavailable for this result.');
  const version = viewerVersion;
  $('viewer-caption').textContent = `Generating MO ${index} surface…`;
  const shown = await viewer.showOrbital(
    Number(index),
    Number($('isovalue').value),
    Number($('opacity').value),
    $('cube-quality').value,
  );
  if (version !== viewerVersion || shown === false) return;
  selectedOrbital = Number(index);
  $('download-cube').disabled = !viewer.cubeCache;
  renderOrbitalTable();
  renderOrbitalDiagram();
  $('viewer-caption').textContent =
    `MO ${index} · opposite phases in red / blue · isovalue ${$('isovalue').value} a.u.${viewer.cubeCache?.maxBoundary >= Number($('isovalue').value) ? ' The surface reaches the grid edge; its outer extent is clipped.' : ''}`;
}
function stopAnimation() {
  if (animation) {
    cancelAnimationFrame(animation.frame);
    animation = null;
  }
  viewer.stop().catch(() => {});
}
function animateMode(run, index) {
  stopAnimation();
  const data = getMolden(run),
    base = data.vibrationGeometry ?? data.geometry,
    mode = data.modes[index];
  if (!mode || mode.length !== base.atoms.length)
    throw new Error('No matching displacement vectors were exported for this mode.');
  $('orbital-controls').hidden = true;
  molden = data;
  const max = Math.max(...mode.map((v) => Math.hypot(...v)), 1e-10),
    token = { frame: 0, time: performance.now() };
  animation = token;
  // Throttle to 12 frames/s; each frame is a small XYZ update, never a calculation.
  let last = 0;
  const tick = async (time) => {
    if (animation !== token) return;
    if (time - last > 80) {
      last = time;
      const factor = (0.25 * Math.sin((time - token.time) / 350)) / max;
      const atoms = base.atoms.map((a, i) => ({
        ...a,
        x: a.x + mode[i][0] * factor,
        y: a.y + mode[i][1] * factor,
        z: a.z + mode[i][2] * factor,
      }));
      await viewer.structure(toXYZ(molecule(atoms, 'Normal mode')), `mode-${run.id}-${time}`, {
        preserve: true,
      });
      displayedAtoms = atoms;
      viewer.representation($('representation').value === 'space', $('atom-labels').checked);
    }
    if (animation === token) token.frame = requestAnimationFrame(tick);
  };
  token.frame = requestAnimationFrame(tick);
  $('viewer-caption').textContent =
    `Mode ${index + 1} · ${data.frequencies[index]?.toFixed(2)} cm⁻¹ · displacement amplitude is illustrative`;
}
function artifact(run, name) {
  return run.artifacts.find((a) => a.name === name);
}
function outputArtifact(run) {
  return artifact(run, 'DALTON.OUT') ?? artifact(run, 'DALTON.OUTPUT-TAIL.txt');
}
function renderResults() {
  const run = currentRun(),
    el = $('results-content');
  if (!run) {
    el.innerHTML =
      '<p class="intro">Run a calculation to explore energies, molecular orbitals, and other properties here.</p>';
    refreshViewer().catch(() => {});
    return;
  }
  const r = run.results ?? {},
    s = run.settings ?? {};
  let data;
  try {
    data = getMolden(run);
  } catch (e) {
    notice(e.message, true);
  }
  if (!busy && outputArtifact(run)) {
    $('output-title').textContent = run.name + ' · ' + outputArtifact(run).name;
    const raw=dec.decode(outputArtifact(run).data);
    term.reset();
    log((raw.length>2*1024**2 ? 'Showing the last 2 MiB; download the complete output.\n' : '')+raw.slice(-2*1024**2));
    $('terminal-drawer').open = true;
    fit();
  }
  const isMR = METHODS[s.method]?.multireference;
  $('results-title').textContent = run.name;
  el.innerHTML = `<p class="intro">${escape(run.status)} · ${escape(run.created ? new Date(run.created).toLocaleString() : '')}<br>${escape(r.method ?? s.method ?? 'Expert input')} ${escape(s.method === 'DFT' ? s.functional : '')} / ${escape(s.basis ?? 'See input')} · ${((run.elapsedMs ?? 0) / 1000).toFixed(2)} s · ${run.execution?.effectiveProcesses ?? 1} ${(run.execution?.effectiveProcesses ?? 1) > 1 ? 'MPI processes' : 'process'}</p>${run.failure ? `<p class="error">${escape(run.failure)}</p>` : ''}${s.environment === 'water' ? `<p class="hint">PCM water · atomic-sphere cavity${s.task === 'optimize' ? ` · Force norm criterion ${s.pcmPrecision === 'strict' ? '1e-4' : '1e-3'} a.u.` : ''}</p>` : ''}${(r.issues ?? []).map((t) => `<p class="warning">${escape(t)}</p>`).join('')}${run.omitted?.length ? `<p class="warning">Artifacts omitted because of export limits: ${run.omitted.map((f) => escape(f.name)).join(', ')}.</p>` : ''}<div class="metric-grid"><div class="metric"><small>${s.task === 'excitedOptimize' ? 'Excited-state total' : escape(r.method ?? s.method ?? '')} energy / Eh</small><b>${r.energy == null ? 'Unavailable' : r.energy.toFixed(10)}</b></div><div class="metric"><small>Total molecular dipole${s.method === 'CCSD' ? ' (HF reference)' : ['excitations', 'excitedOptimize'].includes(s.task) ? ' (ground-state reference)' : ''} / Debye</small><b>${r.dipoleDebye == null ? 'Unavailable' : r.dipoleDebye.toFixed(5)}</b></div></div><div class="result-actions"><button id="clone-run" class="outline">Edit & rerun</button><button id="raw-output" class="outline" ${!outputArtifact(run) ? 'disabled' : ''}>Download output${artifact(run, 'DALTON.OUT') ? '' : ' tail'}</button><button id="run-inputs" class="outline">Download inputs</button><button id="export-results" class="outline">Results CSV</button><button id="delete-run" class="text-button">Delete run</button></div>`;
  if (run.execution?.ranks?.length) {
    const total = run.execution.ranks.reduce((sum, rank) => sum + (rank.wasmMemoryBytes ?? 0), 0);
    el.insertAdjacentHTML('beforeend', `<details><summary>MPI process diagnostics · ${(total / 1024 ** 3).toFixed(2)} GiB of WASM heaps</summary><pre>${escape(JSON.stringify(run.execution.ranks, null, 2))}</pre>${(run.rankLogs ?? []).map(log => `<details><summary>Rank ${log.rank} output tail</summary><pre>${escape(log.text)}</pre></details>`).join('')}</details>`);
  }
  if (run.status === 'running')
    el.insertAdjacentHTML('beforeend', '<p class="hint">Calculation in progress. Live output appears above.</p>');
  if (r.method === 'CI' && r.states?.length)
    el.insertAdjacentHTML(
      'beforeend',
      `<h2>CI state energies</h2><div class="table-scroll"><table><thead><tr><th>Root</th><th>Energy / Eh</th><th>Residual</th></tr></thead><tbody>${r.states.map((v) => `<tr><td>${v.root}</td><td>${v.energy.toFixed(10)}</td><td>${v.residual.toExponential(2)}</td></tr>`).join('')}</tbody></table></div>`,
    );
  if (r.dipoleComponents)
    el.insertAdjacentHTML(
      'beforeend',
      `<p class="hint">Reported dipole components in Dalton's result frame / a.u.: x ${r.dipoleComponents[0].toFixed(6)}, y ${r.dipoleComponents[1].toFixed(6)}, z ${r.dipoleComponents[2].toFixed(6)}.</p>`,
    );
  if (r.dipoleElectronic && r.dipoleNuclear) el.insertAdjacentHTML('beforeend',
    `<details><summary>Dipole contributions · electronic + nuclear</summary><table><thead><tr><th>Contribution / a.u.</th><th>x</th><th>y</th><th>z</th></tr></thead><tbody>${[['Electronic',r.dipoleElectronic],['Nuclear',r.dipoleNuclear],['Total',r.dipoleComponents]].map(([name,values])=>`<tr><th>${name}</th>${values.map(v=>`<td>${v.toFixed(6)}</td>`).join('')}</tr>`).join('')}</tbody></table><p class="hint">The vector follows the physical dipole convention, from negative toward positive charge. ${s.charge ? 'A charged molecule’s dipole depends on the coordinate origin.' : ''}</p></details>`);
  const conv = r.scf?.at(-1)?.map((v) => v.energy) ?? data?.convergence ?? [];
  if (conv.length)
    el.insertAdjacentHTML(
      'beforeend',
      `<h2>${isMR ? 'Wave function' : 'SCF'} convergence</h2>${linePlot(conv, 'Iteration energy / Eh')}<button id="convergence-csv" class="text-button">Download convergence (CSV)</button>`,
    );
  if (data?.trajectory.length) {
    el.insertAdjacentHTML(
      'beforeend',
      `<h2>Geometry optimization</h2><p class="${r.optimizationConverged ? 'success' : 'warning'}">${r.optimizationConverged ? 'Dalton reports a converged geometry.' : 'Check convergence in the output before using this as a stationary geometry.'}</p>${linePlot(data.optimization.energy, 'Geometry step energy / Eh')}${linePlot(r.geometryGradients ?? [], 'Geometry gradient norm / a.u.')}<div class="trajectory-controls"><label class="field">Geometry step <input id="trajectory-step" type="range" min="0" max="${data.trajectory.length - 1}" value="${data.trajectory.length - 1}"></label><p id="trajectory-label" class="hint"></p><button id="use-geometry" class="outline">Use this geometry</button><button id="trajectory-csv" class="text-button">Download trajectory XYZ</button></div>`,
    );
  }
  if (data?.frequencies.length) {
    const intensities = data.frequencies.map(
      (_, i) => r.intensities?.find((m) => m.mode === i + 1)?.intensity,
    );
    el.insertAdjacentHTML(
      'beforeend',
      `<h2>Harmonic vibrations</h2>${data.frequencies.some((f) => f < -20) ? '<p class="warning">Imaginary frequencies detected. Inspect the modes and geometry convergence.</p>' : ''}${spectrum(data.frequencies, intensities)}<div class="vibration-controls"><p class="hint">Click a mode to animate it. Negative values denote imaginary frequencies.</p><div class="table-scroll"><table class="mode-table"><thead><tr><th>Mode</th><th>Frequency / cm⁻¹</th><th>IR intensity</th></tr></thead><tbody>${data.frequencies.map((f, i) => `<tr><td><button data-mode="${i}" ${!data.modes[i] ? 'disabled' : ''}>${i + 1} ▶</button></td><td>${f.toFixed(2)}</td><td>${intensities[i]?.toFixed(4) ?? '—'}</td></tr>`).join('')}</tbody></table></div><button id="stop-vibration" class="outline">Stop animation</button><button id="frequencies-csv" class="text-button">Download frequencies (CSV)</button></div>`,
    );
  }
  if (data?.excitedTrace?.length)
    el.insertAdjacentHTML(
      'beforeend',
      `<h2>Excited-state tracking</h2><p class="hint">Character correlation of the sampled nonlocal transition density against the previous accepted geometry (subspace projection for degenerate states). Numerical displacements use the same reference. Degenerate manifolds may rotate internally.</p><table><thead><tr><th>Geometry</th><th>Selected root</th><th>Character correlation</th><th>Gradient norm / a.u.</th></tr></thead><tbody>${data.excitedTrace.map((t) => `<tr><td>${t.step}</td><td>${t.state}</td><td>${t.trackingScore.toFixed(5)}</td><td>${t.gradientNorm.toExponential(3)}</td></tr>`).join('')}</tbody></table>`,
    );
  if (r.polarizability)
    el.insertAdjacentHTML(
      'beforeend',
      `<h2>Static polarizability / a.u.</h2><p class="hint">Tensor in Dalton's result coordinate frame. Blank components were not reported.</p><table><thead><tr><th></th><th>x</th><th>y</th><th>z</th></tr></thead><tbody>${r.polarizability.map((row, i) => `<tr><th>${'xyz'[i]}</th>${row.map((v) => `<td>${v == null ? '—' : v.toFixed(6)}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
    );
  el.insertAdjacentHTML('beforeend', propertyResultHTML(r.property, escape));
  if ($('property-csv')) $('property-csv').onclick = () => {
    const property=r.property, rows=[['Property',property.label]];
    if(property.columns) rows.push(property.columns.map(([,label])=>label),...property.rows.map(row=>property.columns.map(([key])=>row[key])));
    if(property.tensor?.length===3) rows.push([],['Tensor / a.u.','x','y','z'],...property.tensor.map((row,i)=>['xyz'[i],...row]));
    if(property.task==='nmrShielding') for(const row of property.rows) rows.push([],[row.atom+' shielding tensor / ppm','x','y','z'],...row.tensor.map((values,i)=>['xyz'[i],...values]));
    download(property.task+'.csv',csv(rows));
  }

  excitationResults(run, {
    element: el,
    $,
    escape,
    download,
    save,
    guard,
    async showOrbital(id) {
      await showMolden(run);
      await selectOrbital(id);
    },
  });
  const comparisons = p().runs.filter((other) => other.id !== run.id && compatibleRuns(run, other));
  if (comparisons.length)
    el.insertAdjacentHTML(
      'beforeend',
      `<h2>Comparable runs</h2><p class="hint">Same composition, method, basis, charge, spin, and correlation settings. Differences are relative to this run.</p><table><thead><tr><th>Run</th><th>ΔE / Eh</th></tr></thead><tbody>${comparisons.map((other) => `<tr><td>${escape(other.name)}</td><td>${(other.results.energy - r.energy).toFixed(8)}</td></tr>`).join('')}</tbody></table>`,
    );
  el.insertAdjacentHTML(
    'beforeend',
    `<details><summary>Inputs and provenance</summary><p class="hint">Engine ${escape(run.engine?.revision?.slice(0, 12) ?? 'unknown')} · ${escape(run.engine?.preset ?? 'unknown')}<br>WASM SHA256: ${escape(run.engine?.wasmSha256 ?? 'unknown')}</p><pre>${escape(run.input.dal)}</pre><pre>${escape(run.input.mol)}</pre></details>`,
  );
  $('clone-run').onclick = guard(() => {
    if (busy || studyRunning)
      throw new Error('Wait for the current calculation or cancel it first.');
    if (run.molecule) moleculeChanged(clone(run.molecule));
    p().calculation = { ...defaults(), ...clone(s) };
    p().calculation.activeIndices = [];
    p().prepared = null;
    if (s.mode === 'expert')
      p().expert = {
        name: run.name,
        dal: run.input.dal,
        mol: run.input.mol,
        extraFiles: clone(run.input.extraFiles ?? {}),
      };
    renderCalculation();
    setStage('calculation');
    scheduleSave();
    notice(
      'Created an editable calculation from this run. The original inputs and results are preserved.',
    );
  });
  $('raw-output').onclick = () => download(outputArtifact(run).name, outputArtifact(run).data);
  $('run-inputs').onclick = () => downloadInputs(run.input);
  $('export-results').onclick = () =>
    download(
      'results.csv',
      csv([
        ['Observable', 'Value', 'Unit'],
        ['Method', r.method, ''],
        ['Energy', r.energy, 'Eh'],
        ['Dipole magnitude', r.dipoleDebye, 'Debye'],
        ...(r.states ?? []).map((v) => [`Root ${v.root}`, v.energy, 'Eh']),
        ...(r.polarizability ?? []).flatMap((row, i) =>
          row.map((v, j) => [`Polarizability ${'xyz'[i]}${'xyz'[j]}`, v, 'a.u.']),
        ),
      ]),
    );
  const studyUsed = p().studies.some(
    (st) =>
      st.steps.some((s) => s.runId === run.id || s.preflightRunId === run.id) ||
      st.options.sourceRunId === run.id,
  );
  $('delete-run').disabled = busy || studyRunning || studyUsed;
  if (studyUsed) $('delete-run').title = 'This run is a source for a saved study.';
  $('delete-run').onclick = () => {
    p().runs = p().runs.filter((v) => v.id !== run.id);
    if (p().prepared?.runId === run.id) {
      p().prepared = null;
      p().calculation.activeIndices = [];
    }
    p().activeRun = p().runs.at(-1)?.id ?? null;
    stopAnimation();
    renderHistory();
    renderResults();
    scheduleSave();
  };
  if ($('convergence-csv'))
    $('convergence-csv').onclick = () =>
      download(
        'convergence.csv',
        csv([['Iteration', 'Energy / Eh'], ...conv.map((v, i) => [i + 1, v])]),
      );
  if (data?.geometry.atoms.length) {
    const use = document.createElement('button');
    use.className = 'outline';
    use.textContent = 'Use result geometry';
    use.onclick = () => {
      const next = clone(data.geometry);
      next.name = run.molecule?.name ?? 'Result geometry';
      next.source = s.task === 'optimize' && r.optimizationConverged ? 'optimized' : 'result';
      moleculeChanged(next);
      setStage('molecule');
      notice('Result geometry copied to the molecule workspace.');
    };
    el.querySelector('.result-actions').append(use);
  }
  if ($('trajectory-step')) {
    const update = guard(async () => {
      stopAnimation();
      const i = Number($('trajectory-step').value),
        mol = data.trajectory[i];
      $('trajectory-label').textContent = `Step ${i + 1} of ${data.trajectory.length}`;
      $('orbital-controls').hidden = true;
      await viewer.structure(toXYZ(mol), `${run.id}-step-${i}`);
      displayedAtoms = mol.atoms;
      picks = [];
      $('viewer-caption').textContent = `Optimization step ${i + 1}`;
    });
    $('trajectory-step').oninput = update;
    $('trajectory-label').textContent =
      `Step ${data.trajectory.length} of ${data.trajectory.length}`;
    $('use-geometry').onclick = () => {
      const next = clone(data.trajectory[Number($('trajectory-step').value)]);
      next.name = run.molecule?.name ?? 'Optimized geometry';
      next.source = r.optimizationConverged ? 'optimized' : 'trajectory';
      moleculeChanged(next);
      setStage('molecule');
      notice('Selected result geometry copied to the molecule workspace.');
    };
    $('trajectory-csv').onclick = () =>
      download('trajectory.xyz', data.trajectory.map((m) => toXYZ(m)).join(''));
  }
  if ($('stop-vibration')) {
    $('stop-vibration').onclick = guard(async () => {
      stopAnimation();
      await showMolden(run);
    });
    $('frequencies-csv').onclick = () =>
      download(
        'frequencies.csv',
        csv([
          ['Mode', 'Frequency / cm^-1', 'IR intensity (Dalton output)'],
          ...data.frequencies.map((v, i) => [
            i + 1,
            v,
            r.intensities?.find((m) => m.mode === i + 1)?.intensity ?? '',
          ]),
        ]),
      );
  }
  if (data)
    showMolden(run).catch((e) => {
      console.error('Result viewer failed', e);
      notice(e.message, true);
    });
  else {
    refreshViewer().catch(() => {});
    $('viewer-caption').textContent = 'No Molden visualization was exported for this run.';
  }
  renderFiles();
}
function downloadInputs(input) {
  download('calculation.dal', input.dal);
  setTimeout(() => download('molecule.mol', input.mol), 100);
  Object.entries(input.extraFiles ?? {}).forEach(([name, text], i) =>
    setTimeout(() => download(name, text), 200 + i * 100),
  );
}
function setBusy(value) {
  busy = value;
  if (value) $('status').textContent = 'Checking inputs…';
  for (const id of [
    'projects',
    'new-project',
    'delete-project',
    'upload',
    'rename-project',
    'prepare-orbitals',
    'open-sketch',
    'from-smiles',
    'undo-molecule',
    'processes',
    'memory',
  ])
    $(id).disabled = value || studyRunning;
  $('cancel').disabled = !value;
  for (const el of $('guided-panel').querySelectorAll('input,select'))
    el.disabled = value || studyRunning;
  for (const id of ['create-course', 'create-study', 'save-structure', 'preview-coordinate'])
    $(id).disabled = value || studyRunning;
  renderCalculation();
}
function renderExecution() {
  const count = Number($('processes').value || 1), unavailable = mpiAvailability(mpiManifest);
  for (const option of $('processes').options) if (Number(option.value)>1) option.disabled = !!unavailable;
  let executionError = null;
  if (count > 1) try { validateExecution(count, p().calculation, mpiManifest); } catch (error) { executionError = error.message; }
  $('mpi-serial').hidden = !executionError;
  $('mpi-info').textContent = executionError ?? unavailable ?? `Ranks run on this computer. The count includes Dalton's master rank; some kernels use the remaining ranks for calculation.`;
  const total = memoryEstimate(count, Number($('memory').value));
  $('mpi-memory').textContent = count > 1 ? `Estimated group memory: ${(total / 1024 ** 3).toFixed(2)} GiB, plus scratch and visualizations. Each process has its own work memory.${count > (navigator.hardwareConcurrency ?? 1) ? ' More processes than reported logical processors may slow the calculation.' : ''}` : '';
  return executionError;
}
function finish() {
  startupController = null;
  clearInterval(clockTimer);
  worker?.terminate();
  worker = null;
  liveRun = null;
  setBusy(false);
}
async function runCalculation(purpose = 'calculation', override = {}) {
  if (busy || (studyRunning && !override.studyId))
    throw new Error('A calculation or study is already running.');
  stopAnimation();
  notice('');
  const project = p(),
    calcMol = override.molecule ?? project.molecule,
    s = clone({ ...defaults(), ...(override.settings ?? project.calculation) });
  let input;
  if (purpose === 'prepare') {
    if (s.multiplicity !== 1)
      throw new Error('Reference preparation currently requires a singlet.');
    s.method = 'HF';
    s.task = 'energy';
    s.mode = 'guided';
    s.activeIndices = [];
    input = generateInput(calcMol, s);
  } else if (override.input) input = override.input;
  else if (s.mode === 'expert')
    input = {
      dal: project.expert.dal,
      mol: project.expert.mol,
      extraFiles: project.expert.extraFiles ?? {},
    };
  else input = generateInput(calcMol, s, project.prepared);
  if (!input.dal.trim() || !input.mol.trim())
    throw new Error('Provide both Dalton and molecule input.');
  setBusy(true);
  const controller = new AbortController();
  startupController = controller;
  try {
    if (s.mode !== 'expert') await checkBasis(calcMol, s.basis, controller.signal);
    controller.signal.throwIfAborted();
    const files = Object.fromEntries(
      project.files.filter(([, f]) => !f.result).map(([name, f]) => [name, f.data]),
    );
    files['calculation.dal'] = enc.encode(input.dal);
    files['molecule.mol'] = enc.encode(input.mol);
    for (const [name, text] of Object.entries(input.extraFiles ?? {}))
      files[name] = enc.encode(text);
    if (s.activeIndices.length && !project.prepared?.orbitals)
      throw new Error(
        'Prepare reference orbitals again to obtain their formatted starting coefficients.',
      );
    if (['optimize', 'excitedOptimize'].includes(s.task) && Number($('memory').value) < 32000000) {
      $('memory').value = '32000000';
      session.memory = '32000000';
      notice('Geometry optimization uses 256 MB of Dalton work memory.');
    }
    const job = {
      dal: 'calculation.dal',
      mol: 'molecule.mol',
      workspaceWords: Number($('memory').value),
      processes: Number(override.processes ?? $('processes').value),
      files,
    };
    job.executionProfile = validateExecution(job.processes, s, mpiManifest);
    if (job.processes > 1 && /\.RMA-MD/i.test(input.dal)) throw new Error('Remote-memory mode requires serial execution in this browser release.');
    validateJob(job);
    const run = {
      id: uid(),
      name:
        override.name ??
        (purpose === 'prepare'
          ? 'HF orbital reference'
          : s.mode === 'expert'
            ? project.expert.name
            : `${s.method === 'DFT' ? s.functional : METHODS[s.method].label} · ${TASKS[s.task]}`),
      studyId: override.studyId,
      stepId: override.stepId,
      purpose,
      created: new Date().toISOString(),
      status: 'running',
      settings: s.mode === 'expert' ? settingsFromInput(input.dal,input.mol) : s,
      molecule: clone(calcMol),
      atomOrder: input.atomOrder,
      input: clone(input),
      artifacts: [],
      omitted: [],
      engine: clone(job.processes > 1 ? mpiManifest : manifest),
      execution: { requestedProcesses: job.processes, effectiveProcesses: job.processes, workspaceWords: job.workspaceWords },
      results: null,
      atomIds: [...new Set(calcMol.atoms.map((a) => a.symbol))].flatMap((symbol) =>
        calcMol.atoms.filter((a) => a.symbol === symbol).map((a) => a.id),
      ),
    };
    // Starting-orbital provenance is kept even when its large artifact is later deleted.
    if (s.activeIndices.length)
      run.startingOrbitals = {
        runId: project.prepared.runId,
        permutation: orbitalPermutation(s, project.prepared.orbitalCount),
      };
    project.runs.push(run);
    project.activeRun = run.id;
    liveRun = run;
    setBusy(true);
    started = performance.now();
    phase = 'Loading Dalton';
    renderHistory();
    if (purpose !== 'prepare' && !override.studyId) setStage('results');
    await save();
    term.reset();
    $('terminal-drawer').open = true;
    $('output-title').textContent = run.name + ' · live output';
    document.querySelector('.content-pane').scrollTop = 0;
    fit();
    log(`\n\x1b[32m› ${run.name}\x1b[0m\n`);
    $('status').textContent = 'Loading Dalton…';
    clockTimer = setInterval(() => {
      $('status').textContent = `${phase}${job.processes > 1 ? ` · ${job.processes} MPI processes` : ''} · ${((performance.now() - started) / 1000).toFixed(1)} s`;
    }, 300);
    let tail = '';
    liveOutputTail = '';
    worker = executionWorker(job.processes);
    startupController = null;
    let settle;
    const completion = new Promise((resolve) => {
      settle = resolve;
      liveCompletion = resolve;
    });
    const failed = (message) => {
      run.status = 'failed';
      run.failure = message;
      run.elapsedMs = performance.now() - started;
      log(`\n${message}\n`, true);
      settle(run);
      liveCompletion = null;
      finish();
      $('status').textContent = 'Failed';
      renderHistory();
      if (stage === 'results') renderResults();
      scheduleSave();
      notice(message, true);
    };
    worker.onmessage = ({ data }) => {
      if (data.type === 'cancelled') {
        if (run.status !== 'cancelled') return;
        run.rankLogs = data.rankLogs ?? run.rankLogs ?? [];
        run.execution.ranks = data.ranks ?? [];
        const root = run.rankLogs.find(log => log.rank === 0)?.text;
        if (root) run.artifacts = [{ name: 'DALTON.OUTPUT-TAIL.txt', data: enc.encode(root) }];
        if (stage === 'results' && currentRun()?.id === run.id) renderResults();
        scheduleSave();
        return;
      }
      if (run.status === 'cancelled') return;
      if (data.type === 'output') {
        liveOutputTail = (liveOutputTail + data.text).slice(-262144);
        log(data.text, data.source === 'stderr');
        tail = (tail + data.text).slice(-20000);
        const found = phaseFromOutput(tail);
        if (found) phase = found;
      } else if (data.type === 'status') phase = data.text;
      else if (data.type === 'error') failed(data.text);
      else if (data.type === 'done') {
        try {
          const result = data.result;
          run.status = result.exitCode ? 'failed' : 'completed';
          run.elapsedMs = result.elapsedMs;
          run.artifacts = result.outputs;
          run.omitted = result.omitted;
          run.execution = { ...run.execution, ...result.execution };
          run.rankLogs = result.rankLogs ?? [];
          run.scratchBytes = result.scratchBytes;
          run.fileStorageBytes = result.fileStorageBytes;
          run.wasmMemoryBytes = result.wasmMemoryBytes;
          run.timings = result.timings;
          run.failure =
            result.failure ??
            (result.exitCode
              ? 'Dalton reported a failure. Open the terminal or output for details.'
              : null);
          const text = outputArtifact(run)
            ? dec.decode(outputArtifact(run).data)
            : (result.outputTail ?? '');
          run.results = parseOutput(text, run.settings);
          if (run.results.issues.length) {
            run.status = 'failed';
            run.failure = run.failure ?? run.results.issues.join(' ');
          }
          if (['optimize', 'excitedOptimize'].includes(s.task) && purpose !== 'coordinate') {
            const m = getMolden(run);
            if (m?.optimization.energy.length) run.results.energy = m.optimization.energy.at(-1);
            if (run.status === 'completed' && !run.results.optimizationConverged) {
              run.status = 'unconverged';
              run.failure = override.studyId
                ? 'Geometry optimization reached its limits. Resume the study to continue from its last geometry.'
                : 'Geometry optimization did not converge within its limits. Increase maximum steps and retry.';
            }
          }
          const response = artifact(run, 'DALTON.RESPONSE.json');
          if (response)
            try {
              run.results.response = parseResponse(dec.decode(response.data));
            } catch (error) {
              run.results.issues.push(error.message);
            }
          if (purpose === 'prepare' && run.status === 'completed') {
            try {
              const data = getMolden(run);
              if (data?.orbitals.length && artifact(run, 'DALTON.MOPUN'))
                project.prepared = {
                  runId: run.id,
                  orbitalCount: data.orbitals.length,
                  fingerprint: fingerprint(project.molecule, project.calculation),
                  orbitals: dec.decode(artifact(run, 'DALTON.MOPUN').data),
                };
              else run.failure = 'Reference finished but did not export reusable orbitals.';
            } catch (e) {
              run.failure = e.message;
            }
          }
          settle(run);
          liveCompletion = null;
          finish();
          $('output-title').textContent = run.name + ' · ' + (outputArtifact(run)?.name ?? 'output');
          $('status').textContent =
            `${run.status === 'completed' ? 'Completed' : 'Failed'} · ${(run.elapsedMs / 1000).toFixed(2)} s`;
          $('result-summary').textContent =
            `${(run.scratchBytes / 1024 ** 2).toFixed(1)} MB scratch · ${run.artifacts.length} artifacts`;
          renderHistory();
          renderCalculation();
          if (purpose === 'prepare') {
            setStage('calculation');
            showMolden(run).catch((e) => notice(e.message, true));
            notice(
              run.failure ??
                'Reference orbitals are ready. Inspect and select the active space below.',
              !!run.failure,
            );
          } else if (!override.studyId) {
            setStage('results');
            if (run.failure) notice(run.failure, true);
          }
          scheduleSave();
          log(`\n${run.status} · ${(run.elapsedMs / 1000).toFixed(2)} s\n`);
        } catch (error) {
          failed('Could not read calculation results: ' + error.message);
        }
      }
    };
    worker.onerror = (event) => failed(event.message);
    worker.postMessage(job);
    return await completion;
  } catch (error) {
    if (error.name === 'AbortError') {
      finish();
      $('status').textContent = 'Cancelled';
      return;
    }
    if (liveRun) {
      liveRun.status = 'failed';
      liveRun.failure = error.message;
      renderHistory();
    }
    finish();
    scheduleSave();
    throw error;
  }
}
function cancel() {
  studiesUI.stop();
  if (!worker) {
    if (startupController) {
      startupController.abort();
      finish();
      $('status').textContent = 'Cancelled';
      notice('Startup cancelled. Inputs are preserved.');
    }
    return;
  }
  const run = liveRun;
  liveCompletion?.(run);
  liveCompletion = null;
  run.status = 'cancelled';
  run.elapsedMs = performance.now() - started;
  run.failure = 'Cancelled. Inputs and available output are preserved; incomplete scratch files were discarded.';
  if (liveOutputTail) run.artifacts = [{ name: 'DALTON.OUTPUT-TAIL.txt', data: enc.encode(liveOutputTail) }];
  finish();
  $('status').textContent = 'Cancelled';
  renderHistory();
  if (stage === 'results') renderResults();
  scheduleSave();
  log('\nCalculation cancelled.\n');
}
const basisCache = new Map();
async function checkBasis(mol, basis, signal) {
  if (!manifest.basis.includes(basis))
    throw new Error(`Basis ${basis} is not in this browser build.`);
  if (!basisCache.has(basis)) {
    const response = await fetch(
      new URL(`./assets/basis/${encodeURIComponent(basis)}`, import.meta.url),
      { signal },
    );
    if (!response.ok) throw new Error(`Could not load ${basis}.`);
    const basisText = await response.text();
    basisCache.set(
      basis,
      new Set([...basisText.matchAll(/^a\s+(\d+)\s*$/gim)].map((m) => Number(m[1]))),
    );
  }
  const supported = basisCache.get(basis),
    missing = [...new Set(mol.atoms.map((a) => a.symbol))].filter(
      (symbol) => !supported.has(ELEMENTS.indexOf(symbol)),
    );
  if (missing.length)
    throw new Error(
      `${basis} has no bundled basis for ${missing.join(', ')}. Choose another basis or use expert input with your own basis file.`,
    );
}
async function generate3D(text, format) {
  if (chemWorker) throw new Error('3D generation is already in progress.');
  notice('Generating a starting geometry locally…');
  $('from-smiles').disabled = true;
  $('generate-sketch').disabled = true;
  const project = p();
  chemWorker = new Worker(new URL('./chemistry-worker.mjs', import.meta.url), { type: 'module' });
  const cleanup = () => {
    clearTimeout(chemTimer);
    chemWorker?.terminate();
    chemWorker = null;
    $('from-smiles').disabled = busy;
    $('generate-sketch').disabled = false;
  };
  chemTimer = setTimeout(() => {
    cleanup();
    notice(
      '3D generation exceeded 30 seconds. Try a simpler structure or import coordinates.',
      true,
    );
  }, 30000);
  chemWorker.onmessage = guard(({ data }) => {
    cleanup();
    if (data.error) throw new Error(data.error);
    if (p().id !== project.id) return;
    moleculeChanged(data.molecule);
    p().calculation.charge = data.molecule.charge ?? 0;
    renderCalculation();
    setStage('molecule');
    $('sketch-dialog').close();
    notice(`Starting geometry generated. ${data.cleanup}.`);
  });
  chemWorker.onerror = (e) => {
    cleanup();
    notice(e.message, true);
  };
  chemWorker.postMessage({
    text,
    format,
    cleanup: $('cleanup').checked,
    name: format === 'smiles' ? 'Molecule from SMILES' : 'Drawn molecule',
  });
}
async function openSketch() {
  if (busy) return;
  $('sketch-dialog').showModal();
  if (!sketcher) {
    const frame = document.createElement('iframe');
    frame.title = 'Ketcher molecule editor';
    frame.src = new URL('./vendor/ketcher/index.html', import.meta.url).href;
    $('sketch-editor').replaceChildren(frame);
    sketcher = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener('message', ready); reject(new Error('The molecule editor did not initialize. Reload to retry.')); }, 60000);
      function ready(event) {
        if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.eventType !== 'init') return;
        clearTimeout(timer); window.removeEventListener('message', ready);
        resolve(frame.contentWindow.ketcher);
      }
      window.addEventListener('message', ready);
    }).catch(error => { sketcher = null; throw error; });
  }
  const input = p().molecule.molfile || $('smiles').value.trim();
  if (input) await sketcher.setMolecule(input);
}
async function importStructure(text, name) {
  if (/^BASIS\s*\n/i.test(text)) {
    const mol = parseDaltonMolecule(text, name);
    moleculeChanged(mol);
    p().calculation.basis = mol.basis;
    p().calculation.charge = mol.charge;
    renderCalculation();
    setStage('molecule');
    return;
  }
  if (/^\s*\d+\s*\n/.test(text)) {
    moleculeChanged(parseXYZ(text, name));
    setStage('molecule');
    return;
  }
  const OCL = await import('./vendor/openchemlib.mjs');
  const mol = OCL.Molecule.fromMolfile(text),
    atoms = Array.from({ length: mol.getAllAtoms() }, (_, i) => ({
      symbol: ELEMENTS[mol.getAtomicNo(i)],
      x: mol.getAtomX(i),
      y: mol.getAtomY(i),
      z: mol.getAtomZ(i),
    }));
  if (!atoms.length) throw new Error('No atoms found in the imported structure.');
  const result = molecule(atoms, name);
  result.molfile = mol.toMolfile();
  result.source = 'imported';
  moleculeChanged(result);
  p().calculation.charge = Array.from({ length: mol.getAllAtoms() }, (_, i) =>
    mol.getAtomCharge(i),
  ).reduce((a, b) => a + b, 0);
  renderCalculation();
  setStage('molecule');
  if (atoms.every((a) => a.z === 0))
    notice(
      'Imported coordinates are planar. If this is a 2D drawing, open Draw molecule and Generate 3D before running.',
    );
}
async function importFiles(list) {
  if (busy) throw new Error('Wait for the current run before importing.');
  for (const file of list) {
    if (file.size > 190 * 1024 ** 2) throw new Error('File exceeds the project import limit.');
    const text = await file.text();
    if (file.name.endsWith('.json')) {
      const imported = importProject(text);
      session.projects.push(imported);
      session.activeProject = imported.id;
      renderAll();
    } else if (/\.dal$/i.test(file.name)) {
      p().expert.dal = text;
      p().expert.name = file.name;
      p().calculation.mode = 'expert';
      renderCalculation();
      setStage('calculation');
    } else if (/\.smi(?:les)?$/i.test(file.name))
      await generate3D(text.trim().split(/\s+/)[0], 'smiles');
    else if (/\.sdf$/i.test(file.name)) {
      sdfRecords = text.split(/\$\$\$\$\r?\n?/).filter((s) => s.trim());
      if (sdfRecords.length === 1) await importStructure(sdfRecords[0], file.name);
      else {
        $('sdf-record').replaceChildren(
          ...sdfRecords.map(
            (record, i) =>
              new Option(
                `${i + 1} · ${record.trimStart().split('\n')[0] || 'Structure'}`,
                String(i),
              ),
          ),
        );
        $('sdf-dialog').showModal();
      }
    } else if (
      /\.xyz$/i.test(file.name) ||
      (/\.mol$/i.test(file.name) &&
        (!/^BASIS\s*\n/i.test(text) || p().calculation.mode !== 'expert'))
    )
      await importStructure(text, file.name.replace(/\.[^.]+$/, ''));
    else if (/^BASIS\s*\n/i.test(text) && p().calculation.mode === 'expert') {
      p().expert.mol = text;
      renderCalculation();
      setStage('calculation');
    } else {
      const name = safeName(file.name);
      if (file.size > 32 * 1024 ** 2)
        throw new Error('Individual extra files must be smaller than 32 MB.');
      if (p().files.some(([n]) => n === name)) throw new Error(`${name} already exists.`);
      p().files.push([name, { data: new Uint8Array(await file.arrayBuffer()), result: false }]);
      renderFiles();
    }
  }
  scheduleSave();
}
function renderFiles() {
  const select = $('file-select'),
    previous = select.value;
  select.replaceChildren(new Option('Inspect a workspace or result file…', ''));
  for (const [name] of p().files) select.add(new Option(name, `file:${name}`));
  for (const a of currentRun()?.artifacts ?? [])
    select.add(new Option(a.name, `artifact:${a.name}`));
  if ([...select.options].some((o) => o.value === previous)) select.value = previous;
}
function selectedFile() {
  const [type, ...parts] = $('file-select').value.split(':'),
    name = parts.join(':');
  return type === 'file'
    ? { name, ...new Map(p().files).get(name) }
    : currentRun()?.artifacts.find((a) => a.name === name);
}
async function command(text) {
  log(`\n\x1b[32mdalton › ${text}\x1b[0m\n`);
  const [cmd, ...args] = text.trim().split(/\s+/);
  if (!cmd) return;
  if (cmd === 'help')
    log(
      'run / dalton   Run current guided or expert calculation\ncancel         Stop calculation\nls             List extra files and selected run artifacts\nbasis          List bundled bases\ncat FILE       Print a selected run artifact or extra file\ndownload FILE  Save an artifact or extra file\nclear          Clear terminal\n',
    );
  else if (cmd === 'run' || cmd === 'dalton') await runCalculation();
  else if (cmd === 'cancel') cancel();
  else if (cmd === 'clear') term.clear();
  else if (cmd === 'basis')
    log(
      (manifest?.basisSets ?? [])
        .map((b) => `${b.name}${b.auxiliary ? ' (guess basis)' : ''}`)
        .join('\n') + '\n',
    );
  else if (cmd === 'ls')
    log(
      [...p().files.map(([n]) => n), ...(currentRun()?.artifacts ?? []).map((a) => a.name)].join(
        '\n',
      ) + '\n',
    );
  else if (['cat', 'download'].includes(cmd)) {
    const file =
      currentRun()?.artifacts.find((a) => a.name === args[0]) ?? new Map(p().files).get(args[0]);
    if (!file) throw new Error('No such file.');
    if (cmd === 'download') download(args[0], file.data);
    else if (file.data.length > 2 * 1024 ** 2 || file.data.subarray(0, 8192).includes(0))
      throw new Error('Download binary or large files.');
    else log(dec.decode(file.data) + '\n');
  } else throw new Error(`Unknown command ${cmd}. Type help.`);
}
// Events are delegated for generated tables; user-provided content is always text.
for (const b of document.querySelectorAll('[data-stage]'))
  b.onclick = () => setStage(b.dataset.stage);
for (const b of document.querySelectorAll('[data-example]'))
  b.onclick = () => {
    if (busy) {
      notice('Wait for the running calculation or cancel it first.', true);
      return;
    }
    moleculeChanged(example(b.dataset.example));
    p().calculation = {
      ...defaults(),
      method: b.dataset.example === 'hydrogen' ? 'CASSCF' : 'HF',
      basis: 'STO-3G',
    };
    renderCalculation();
    setStage('molecule');
    notice('Example loaded. Your previous calculation results remain in history.');
  };
$('projects').onchange = () => {
  stopAnimation();
  session.activeProject = $('projects').value;
  renderAll();
  scheduleSave();
};
$('new-project').onclick = () => {
  nameAction = 'new';
  $('name-title').textContent = 'New project';
  $('project-name').value = 'Untitled project';
  $('name-dialog').showModal();
};
$('rename-project').onclick = () => {
  nameAction = 'rename';
  $('name-title').textContent = 'Rename project';
  $('project-name').value = p().name;
  $('name-dialog').showModal();
};
$('name-dialog').addEventListener('close', () => {
  if ($('name-dialog').returnValue !== 'save') return;
  const name = $('project-name').value.trim();
  if (!name) return;
  if (nameAction === 'new') {
    const project = createProject(name);
    session.projects.push(project);
    session.activeProject = project.id;
  } else p().name = name;
  renderAll();
  scheduleSave();
});
$('delete-project').onclick = () => $('delete-dialog').showModal();
$('keep-project').onclick = () => $('delete-dialog').close();
$('confirm-delete').onclick = () => {
  const id = p().id;
  session.projects = session.projects.filter((v) => v.id !== id);
  if (!session.projects.length) session.projects.push(createProject());
  session.activeProject = session.projects[0].id;
  $('delete-dialog').close();
  renderAll();
  scheduleSave();
};
$('export-project').onclick = guard(async () => {
  await save();
  download(
    `${p().name.replace(/[^A-Za-z0-9_-]/g, '-') || 'dalton'}-project.json`,
    projectJSON(p()),
    'application/json',
  );
});
$('upload').onclick = () => {
  $('upload-input').value = '';
  $('upload-input').click();
};
$('upload-input').onchange = guard(() => importFiles([...$('upload-input').files]));
$('coordinate-units').onchange = renderMolecule;
$('coordinates').onchange = guard((event) => {
  const el = event.target;
  if (!el.dataset.coordinate) return;
  if (busy) throw new Error('Geometry cannot be edited during a calculation.');
  const next = clone(p().molecule),
    value = Number(el.value);
  if (!el.value.trim() || !Number.isFinite(value))
    throw new Error('Coordinates must be finite numbers.');
  next.atoms[Number(el.dataset.atom)][el.dataset.coordinate] =
    value * ($('coordinate-units').value === 'bohr' ? BOHR : 1);
  delete next.molfile;
  next.source = 'coordinates';
  moleculeChanged(next);
});
$('apply-xyz').onclick = guard(() => {
  if (busy) throw new Error('Wait for the running calculation.');
  moleculeChanged(parseXYZ($('xyz-input').value, p().molecule.name, $('coordinate-units').value));
});
$('undo-molecule').onclick = () => {
  const previous = p().undo.pop();
  if (!previous) return;
  p().molecule = previous;
  p().prepared = null;
  p().calculation.activeIndices = [];
  renderMolecule();
  renderCalculation();
  refreshViewer().catch(() => {});
  scheduleSave();
};
document.querySelector('.content-pane').prepend($('terminal-drawer'));
$('stage-calculation').append($('stage-studies'));
const studiesUI = studyWorkspace({
  $,
  p,
  escape,
  save,
  notice,
  moleculeChanged,
  setStage,
  runCalculation,
  cancel,
  download,
  guard,
  refreshViewer,
  updateMeasurement,
  lock(value) {
    studyRunning = value;
    setBusy(busy);
  },
  async showGeometry(mol) {
    displayedAtoms = mol.atoms;
    await viewer.structure(toXYZ(mol), 'preview-' + uid());
  },
});
$('export-xyz').onclick = () => download('molecule.xyz', toXYZ(p().molecule));
for (const id of ['measure-a', 'measure-b', 'measure-c', 'measure-d'])
  $(id).onchange = updateMeasurement;
$('from-smiles').onclick = guard(() => generate3D($('smiles').value.trim(), 'smiles'));
$('smiles').onkeydown = (e) => {
  if (e.key === 'Enter') $('from-smiles').click();
};
$('open-sketch').onclick = guard(openSketch);
$('close-sketch').onclick = () => $('sketch-dialog').close();
$('generate-sketch').onclick = guard(async () => {
  if (!sketcher) throw new Error('Wait for the molecule editor to load.');
  return generate3D(await sketcher.getMolfile('v2000'), 'molfile');
});
$('to-calculation').onclick = () => setStage('calculation');
$('help').onclick = () => $('help-dialog').showModal();
$('close-help').onclick = () => $('help-dialog').close();
$('choose-sdf').onclick = guard(async () => {
  await importStructure(sdfRecords[Number($('sdf-record').value)], 'Imported SDF structure');
  $('sdf-dialog').close();
  sdfRecords = [];
});
$('cancel-sdf').onclick = () => $('sdf-dialog').close();
const numeric = new Set([
  'responseFrequency',
  'excitedStates',
  'targetState',
  'charge',
  'multiplicity',
  'maxSteps',
  'frozenCore',
  'activeElectrons',
  'activeOrbitals',
  'inactive',
]);
for (const key of Object.keys(defaults())) {
  const el = $(key);
  if (!el || ['mode', 'activeIndices'].includes(key)) continue;
  el.onchange = () => {
    const s = p().calculation;
    s.mode = 'guided';
    if (key === 'method' && el.value === 'SCF') {
      s.method = $('functional').value === 'HF' ? 'HF' : 'DFT';
    } else if (key === 'functional') {
      s.method = el.value === 'HF' ? 'HF' : 'DFT';
      if (el.value !== 'HF') s.functional = el.value;
    } else {
      s[key] = el.type === 'checkbox' ? el.checked : numeric.has(key) ? Number(el.value) : el.value;
    }
    if (key === 'method' || key === 'functional') {
      if (s.method !== 'DFT' || !DISPERSION_FUNCTIONALS.has(s.functional)) s.dispersion = 'none';
      s.task = taskAvailable(s,s.task) ? s.task : METHODS[s.method].tasks[0];
      if (s.method !== 'CASSCF') s.stateAverage = false;
      const electrons = validateMolecule(p().molecule, s.charge, s.multiplicity).electrons;
      if (
        METHODS[s.method].multireference &&
        Number.isInteger((electrons - s.activeElectrons) / 2) &&
        electrons >= s.activeElectrons
      )
        s.inactive = (electrons - s.activeElectrons) / 2;
    }
    if (['basis', 'charge', 'multiplicity'].includes(key)) {
      p().prepared = null;
      s.activeIndices = [];
    }
    if (key === 'task' && s.task === 'opticalRotation' && !s.responseFrequency) s.responseFrequency = HC / (589.3 * EV);
    if (key === 'activeOrbitals') s.activeIndices = [];
    if (key === 'activeElectrons') {
      const remaining =
        validateMolecule(p().molecule, s.charge, s.multiplicity).electrons - s.activeElectrons;
      if (remaining >= 0 && remaining % 2 === 0) s.inactive = remaining / 2;
    }
    if (['optimize', 'excitedOptimize'].includes(s.task) && Number($('memory').value) < 32000000) {
      $('memory').value = '32000000';
      session.memory = '32000000';
    }
    renderCalculation();
    scheduleSave();
  };
}
function resetInput() {
  p().calculation.mode = 'guided';
  renderCalculation();
  scheduleSave();
}
$('reset-input').onclick = resetInput;
for (const id of ['dal-preview', 'mol-preview']) $(id).oninput = () => {
  let extraFiles=p().expert.extraFiles ?? {};
  if (p().calculation.mode !== 'expert') { try { extraFiles=generateInput(p().molecule,p().calculation,p().prepared).extraFiles; } catch {} }
  p().expert = {name: 'Edited Dalton input', dal: $('dal-preview').value, mol: $('mol-preview').value, extraFiles};
  p().calculation.mode = 'expert';
  $('input-edit-state').textContent = 'Edited input will run as shown. Changing a setting replaces these edits.';
  const error = renderExecution();
  $('run').disabled = busy || studyRunning || !manifest || !!error;
  scheduleSave();
};
$('download-inputs').onclick = guard(() => downloadInputs({dal: $('dal-preview').value, mol: $('mol-preview').value, extraFiles: p().calculation.mode === 'expert' ? p().expert.extraFiles : generateInput(p().molecule,p().calculation,p().prepared).extraFiles}));
$('memory').onchange = () => {
  renderExecution();
  session.memory = $('memory').value;
  scheduleSave();
};
$('run').onclick = guard(() => runCalculation());
$('cancel').onclick = cancel;
$('prepare-orbitals').onclick = guard(() => runCalculation('prepare'));
$('representation').onchange = $('atom-labels').onchange = guard(() =>
  viewer.representation($('representation').value === 'space', $('atom-labels').checked),
);
$('reset-view').onclick = guard(() => viewer.reset());
$('viewer-png').onclick = guard(async () => {
  const a = document.createElement('a');
  a.href = await viewer.png();
  a.download = 'dalton-molecule.png';
  a.click();
});
$('orbitals').onclick = guard((e) => {
  const b = e.target.closest('[data-orbital]');
  if (b) return selectOrbital(Number(b.dataset.orbital));
});
$('orbital-diagram').onclick = guard(event => {
  const level=event.target.closest('[data-orbital]');
  if (level && molden?.renderable) return selectOrbital(Number(level.dataset.orbital));
});
$('orbital-diagram').onkeydown = event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.target.closest('[data-orbital]')?.dispatchEvent(new MouseEvent('click', {bubbles:true})); }
};
$('orbital-filter').oninput =
  $('orbital-range').oninput =
  $('orbital-sort').onchange =
    renderOrbitalTable;
$('orbital-jump').onclick = guard(() => {
  const text = $('orbital-relative').value.trim().toUpperCase(),
    m = text.match(/^(HOMO|LUMO)([+-]\d+)?$/);
  const id = m ? (m[1] === 'HOMO' ? molden.homo : molden.lumo) + Number(m[2] ?? 0) : Number(text);
  return selectOrbital(id);
});
$('show-dipole').onchange = guard(() => {
  const r = currentRun(),
    vec = r?.results?.dipoleComponents;
  if (!$('show-dipole').checked) return viewer.dipole(null);
  if (!vec || !molden) throw new Error('Load a result with dipole components.');
  const atoms = molden.geometry.atoms,
    center = ['x', 'y', 'z'].map((k) => atoms.reduce((s, a) => s + a[k], 0) / atoms.length);
  return viewer.dipole(vec, center);
});
$('show-homo').onclick = guard(() => selectOrbital(molden.homo));
$('show-lumo').onclick = guard(() => selectOrbital(molden.lumo));
$('hide-orbital').onclick = guard(async () => {
  await viewer.hideOrbital();
  selectedOrbital = null;
  $('download-cube').disabled = true;
  renderOrbitalTable();
});
$('download-cube').onclick = guard(() => {
  if (!selectedOrbital || viewer.cubeCache?.orbital !== selectedOrbital)
    throw new Error('Select an orbital surface first.');
  download(`mo-${selectedOrbital}.cube`, viewer.cubeCache.cube);
});
for (const id of ['isovalue', 'opacity', 'cube-quality'])
  $(id).onchange = guard(() => {
    if (selectedOrbital) return selectOrbital(selectedOrbital);
  });
$('export-orbitals').onclick = () => {
  if (!molden) return;
  download(
    'orbitals.csv',
    csv([
      ['MO', 'Symmetry', 'Spin', 'Occupation', 'Energy / Eh (if meaningful)', 'Provenance'],
      ...molden.orbitals.map((o) => [
        o.id,
        o.symmetry,
        o.spin,
        o.occupation,
        molden.energiesMeaningful ? o.energy : '',
        molden.orbitalProvenance,
      ]),
    ]),
  );
};
$('results-content').onclick = guard((e) => {
  const b = e.target.closest('[data-mode]');
  if (b) animateMode(currentRun(), Number(b.dataset.mode));
});
$('terminal-drawer').addEventListener('toggle', fit);
$('clear-terminal').onclick = () => term.clear();
$('basis-list').onclick = guard(() => {
  $('terminal-drawer').open = true;
  return command('basis');
});
$('send-command').onclick = guard(async () => {
  const text = $('command').value;
  $('command').value = '';
  await command(text);
});
$('command').onkeydown = (e) => {
  if (e.key === 'Enter') $('send-command').click();
};
term.onData((data) => {
  $('command').focus();
  if (data === '\r') $('send-command').click();
  else if (data === '\x7f') $('command').value = $('command').value.slice(0, -1);
  else if (!/[\x00-\x1f]/.test(data)) $('command').value += data;
});
$('file-select').onchange = () => {
  const file = selectedFile();
  $('file-preview').hidden = !file;
  if (file)
    $('file-preview').textContent =
      file.data.length > 2 * 1024 ** 2 || file.data.subarray(0, 8192).includes(0)
        ? 'Binary or large artifact. Download to inspect.'
        : dec.decode(file.data);
};
$('download-file').onclick = guard(() => {
  const file = selectedFile();
  if (!file) throw new Error('Select a file first.');
  download(file.name, file.data);
});
window.addEventListener('beforeunload', (event) => {
  if (busy || studyRunning) {
    event.preventDefault();
    event.returnValue = '';
  }
});
try {
  session = await loadSession();
} catch {
  session = migrateSession();
  notice('Browser storage is unavailable. Download your project to save work.', true);
}
$('memory').value = session.memory ?? '16000000';
for (let count=2; count<=8; count++) $('processes').add(new Option(String(count), String(count)));
$('processes').value = String(session.processes ?? 1);
$('processes').onchange = () => { session.processes = Number($('processes').value); renderCalculation(); scheduleSave(); };
$('mpi-serial').onclick = () => { $('processes').value = '1'; session.processes = 1; renderCalculation(); scheduleSave(); };
try {
  const response = await fetch(new URL('./assets/manifest.json', import.meta.url));
  if (!response.ok) throw new Error('Missing build');
  manifest = await response.json();
  if (manifest.mpi) mpiManifest = manifest;
  else {
    const legacy=await fetch(new URL('./assets/mpi/manifest.json',import.meta.url));
    if(legacy.ok) mpiManifest=await legacy.json();
  }
  if ((manifest.maxWorkspaceWords ?? 64000000) >= 128000000)
    $('memory').add(new Option('1 GB', '128000000'));
  const preferredMemory = session.memory ?? '16000000';
  $('memory').value =
    Array.from($('memory').options).some((o) => o.value === preferredMemory) &&
    Number(preferredMemory) <= (manifest.maxWorkspaceWords ?? 64000000)
      ? preferredMemory
      : '16000000';
  $('build-info').textContent = `${manifest.preset} · ${manifest.revision.slice(0, 9)}`;
  $('basis-list').textContent =
    `${manifest.basisSets.filter((b) => !b.auxiliary).length} basis sets`;
} catch {
  $('build-info').textContent = 'WASM assets missing';
  notice('Build the WASM assets before running calculations.', true);
}
renderAll();
document.body.inert = false;
log(
  'DALTON / molecular workspace\n\nCalculations and molecular data stay in this browser.\nType help for terminal commands.\n',
);
if (navigator.storage?.estimate)
  navigator.storage
    .estimate()
    .then(({ usage, quota }) => {
      $('storage-info').textContent =
        `Browser storage: ${(usage / 1024 ** 2).toFixed(1)} MB used${quota ? ` of ${(quota / 1024 ** 3).toFixed(1)} GB` : ''}. Download a copy to keep your work.`;
    })
    .catch(() => {});
