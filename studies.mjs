import { uid, parseXYZ } from './molecules.mjs';
import { defaults, generateInput, validateCalculation } from './calculations.mjs';
import { coordinate, editCoordinate, scanValues, resultGeometry } from './geometry.mjs';
import { parseMolden } from './results.mjs';
export const UNITS = { hartreeToKJMol: 2625.5, hartreeToEV: 27.2114 };
export const STUDY_TYPES = {
  basis: 'Compare basis sets',
  conformers: 'Compare conformers / structures',
  spin: 'Compare spin states',
  scan: 'Rigid and relaxed coordinate scan',
  solvent: 'Gas phase and PCM water',
  ionization: 'Vertical and adiabatic ionization',
  affinity: 'Electron affinity',
  orbitals: 'Optimize and explore orbitals',
  uvvis: 'Excitations and excited-state geometry',
};
const texts = {
  formaldehyde:
    '4\nFormaldehyde starting geometry\nC 0 0 0\nO 0 0 1.21\nH 0 .94 -.58\nH 0 -.94 -.58',
  nitrogen: '2\nNitrogen starting geometry\nN 0 0 -.56\nN 0 0 .56',
  oxygen: '2\nOxygen starting geometry\nO 0 0 -.63\nO 0 0 .63',
  fluorine: '1\nFluorine atom\nF 0 0 0',
  acid: '8\nAcetic acid starting geometry\nC 0 0 0\nO 1.21 0 0\nO -.65 1.15 0\nH -.08 1.92 0\nC -.76 -1.30 0\nH -1.83 -1.14 0\nH -.48 -1.90 .89\nH -.48 -1.90 -.89',
  cis: '6\ncis-1,2-dichloroethene starting geometry\nC -.67 0 0\nC .67 0 0\nCl -1.50 1.45 0\nCl 1.50 1.45 0\nH -1.20 -.94 0\nH 1.20 -.94 0',
  trans:
    '6\ntrans-1,2-dichloroethene starting geometry\nC -.67 0 0\nC .67 0 0\nCl -1.50 1.45 0\nCl 1.50 -1.45 0\nH -1.20 -.94 0\nH 1.20 .94 0',
  acetone:
    '10\nAcetone starting geometry\nC 0 0 0\nO 0 1.22 0\nC -1.30 -.75 0\nC 1.30 -.75 0\nH -2.16 -.08 0\nH -1.35 -1.38 .89\nH -1.35 -1.38 -.89\nH 2.16 -.08 0\nH 1.35 -1.38 .89\nH 1.35 -1.38 -.89',
  water: '3\nWater starting geometry\nO 0 0 0\nH 0 .75716 .58626\nH 0 -.75716 .58626',
};
export const courseMolecule = (key) => parseXYZ(texts[key], texts[key]?.split('\n')[1]);
export const COURSE_PRESETS = {
  co2n: {
    label: 'CØ2 · N₂ orbitals and bond length',
    molecule: 'nitrogen',
    kind: 'orbitals',
    settings: { method: 'HF', basis: 'STO-3G' },
    range: 'HOMO-6:LUMO+2',
  },
  co2ion: {
    label: 'CØ2 · N₂⁺ open-shell bond length',
    molecule: 'nitrogen',
    kind: 'orbitals',
    settings: { method: 'HF', basis: 'STO-3G', charge: 1, multiplicity: 2 },
  },
  co2o: {
    label: 'CØ2 · O₂ singlet and triplet',
    molecule: 'oxygen',
    kind: 'spin',
    settings: { method: 'DFT', functional: 'CAM-B3LYP', dispersion: 'd3bj', basis: '6-31+G*' },
  },
  co3basis: {
    label: 'CØ3 · Acetic acid basis comparison',
    molecule: 'acid',
    kind: 'basis',
    settings: { method: 'DFT', dispersion: 'd3', basis: '6-31G*' },
  },
  co3conf: {
    label: 'CØ3 · Acetic acid conformers',
    molecule: 'acid',
    kind: 'conformers',
    coordinate: ['a2', 'a1', 'a3', 'a4'],
    settings: { method: 'DFT', dispersion: 'd3', basis: '6-31G*' },
  },
  co3scan: {
    label: 'CØ3 · Acetic acid torsion scans',
    molecule: 'acid',
    kind: 'scan',
    coordinate: ['a2', 'a1', 'a3', 'a4'],
    settings: { method: 'DFT', dispersion: 'd3', basis: '6-31G*' },
  },
  co4: {
    label: 'CØ4 · Cis/trans solvent effects',
    molecule: 'cis',
    other: 'trans',
    kind: 'solvent',
    settings: { method: 'DFT', dispersion: 'd3', basis: '6-31G*' },
  },
  co5ip: {
    label: 'CØ5 · Water ionization energies',
    molecule: 'water',
    kind: 'ionization',
    settings: { method: 'DFT', dispersion: 'd3', basis: '6-31+G*' },
  },
  co5ea: {
    label: 'CØ5 · Fluorine electron affinity',
    molecule: 'fluorine',
    kind: 'affinity',
    settings: { method: 'DFT', dispersion: 'd3', basis: '6-31+G*', multiplicity: 2 },
  },
  co6n: {
    label: 'CØ6 · N₂ CIS excitations (KE554)',
    molecule: 'nitrogen',
    kind: 'uvvis',
    settings: { method: 'HF', basis: 'STO-3G', excitedStates: 4 },
    range: 'HOMO-6:LUMO+2',
  },
  co6a: {
    label: 'CØ6 · Acetone UV/vis (KE554)',
    molecule: 'acetone',
    kind: 'uvvis',
    settings: {
      method: 'DFT',
      functional: 'CAM-B3LYP',
      dispersion: 'd3bj',
      basis: '6-31+G*',
      excitedStates: 4,
    },
    range: 'HOMO-4:LUMO+4',
  },
};
export function courseMeasurements(key) {
  const items = {
    nitrogen: [['N–N', ['a1', 'a2']]],
    oxygen: [['O–O', ['a1', 'a2']]],
    water: [
      ['O–H', ['a1', 'a2']],
      ['H–O–H', ['a2', 'a1', 'a3']],
    ],
    acid: [
      ['C=O', ['a1', 'a2']],
      ['C–O', ['a1', 'a3']],
      ['O=C–O–H', ['a2', 'a1', 'a3', 'a4']],
    ],
    cis: [
      ['C=C', ['a1', 'a2']],
      ['C–Cl', ['a1', 'a3']],
    ],
    trans: [
      ['C=C', ['a1', 'a2']],
      ['C–Cl', ['a1', 'a3']],
    ],
    acetone: [
      ['C=O', ['a1', 'a2']],
      ['C–C', ['a1', 'a3']],
    ],
  };
  return (items[key] ?? []).map(([name, ids]) => ({ name, ids }));
}
export function createStudy(kind, mol, settings, options = {}) {
  if (!STUDY_TYPES[kind]) throw new Error('Choose a study type.');
  if (['conformers', 'solvent'].includes(kind) && options.otherMolecule) {
    const composition = (molecule) =>
      molecule.atoms
        .map((a) => a.symbol)
        .sort()
        .join(',');
    if (composition(mol) !== composition(options.otherMolecule))
      throw new Error(
        'Choose two structures with the same chemical composition for this comparison.',
      );
  }
  const s = { ...defaults(), ...structuredClone(settings), mode: 'guided', activeIndices: [] };
  const study = {
    id: uid(),
    kind,
    name: options.name ?? STUDY_TYPES[kind],
    created: new Date().toISOString(),
    status: 'ready',
    molecule: structuredClone(mol),
    options: structuredClone(options),
    steps: [],
    notes: '',
    measurements: structuredClone(options.measurements ?? []),
  };
  const add = (id, name, task, patch = {}, extra = {}) =>
    study.steps.push(
      structuredClone({
        id,
        name,
        settings: { ...s, task, ...patch },
        status: 'pending',
        ...extra,
      }),
    );
  const source = options.sourceRunId;
  const initial = source ? { sourceRunId: source } : {};
  if (kind === 'basis')
    for (const [i, basis] of (options.bases ?? [s.basis, '6-311G*']).entries())
      add('basis' + i, basis + ' at fixed geometry', 'energy', { basis }, initial);
  if (kind === 'orbitals') {
    add('opt', 'Optimize structure', 'optimize', {}, initial);
    add('mos', 'Orbitals at optimized geometry', 'energy', {}, { geometryFrom: 'opt' });
  }
  if (kind === 'spin')
    for (const m of [1, 3])
      add(
        'spin' + m,
        m === 1 ? 'Closed-shell singlet approximation' : 'Restricted triplet',
        'optimize',
        { multiplicity: m },
        initial,
      );
  if (kind === 'conformers') {
    add('a', 'Optimize conformer A', 'optimize', {}, initial);
    if (options.otherMolecule)
      add('b', 'Optimize structure B', 'optimize', {}, { molecule: options.otherMolecule });
    else {
      if (options.coordinate?.length !== 4)
        throw new Error(
          'Choose the four atoms defining the conformer torsion, or another saved structure.',
        );
      add(
        'b',
        'Rotate torsion and optimize conformer B',
        'optimize',
        {},
        {
          geometryFrom: 'a',
          transform: { ids: options.coordinate, value: options.conformerAngle ?? 180 },
        },
      );
    }
  }
  if (kind === 'scan') {
    const ids = options.coordinate;
    if (![2, 3, 4].includes(ids?.length))
      throw new Error('Choose the atoms defining a bond, angle, or dihedral scan.');
    coordinate(mol, ids);
    if (options.optimizeStart !== false)
      add('start', 'Optimize common starting structure', 'optimize', {}, initial);
    const origin = options.optimizeStart !== false ? { geometryFrom: 'start' } : initial;
    for (const [i, value] of scanValues(
      options.start ?? 0,
      options.end ?? 180,
      options.step ?? 30,
    ).entries()) {
      const extra = { ...origin, transform: { ids, value }, scanValue: value };
      if (options.scanMode !== 'relaxed') add(
        'rigid' + i,
        `Rigid · ${value}${ids.length === 2 ? ' Å' : '°'}`,
        'energy',
        {},
        { ...extra, scanMode: 'rigid' },
      );
      if (options.relaxed !== false)
        add(
          'relaxed' + i,
          `Relaxed · ${value}${ids.length === 2 ? ' Å' : '°'}`,
          'optimize',
          {},
          { ...extra, scanMode: 'relaxed', constraint: ids },
        );
    }
  }
  if (kind === 'solvent') {
    if (!options.otherMolecule)
      throw new Error('Choose a second saved structure for the solvent comparison.');
    for (const [role, molecule] of [
      ['a', mol],
      ['b', options.otherMolecule],
    ]) {
      add(
        role + 'gas',
        `${role.toUpperCase()} · gas optimization`,
        'optimize',
        { environment: 'gas' },
        { molecule },
      );
      add(
        role + 'pcmsp',
        `${role.toUpperCase()} · PCM at gas geometry`,
        'energy',
        { environment: 'water' },
        { geometryFrom: role + 'gas' },
      );
      add(
        role + 'pcmopt',
        `${role.toUpperCase()} · PCM optimization`,
        'optimize',
        { environment: 'water' },
        { geometryFrom: role + 'gas' },
      );
    }
  }
  if (kind === 'ionization') {
    add('neutral', 'Optimize neutral reference', 'optimize', {}, initial);
    const ion = { charge: s.charge + 1, multiplicity: options.ionMultiplicity ?? 2 };
    add('vertical', 'Cation at neutral geometry', 'energy', ion, { geometryFrom: 'neutral' });
    add('adiabatic', 'Optimize cation', 'optimize', ion, { geometryFrom: 'neutral' });
  }
  if (kind === 'affinity') {
    add('neutral', 'Reference species', 'energy', {}, initial);
    add(
      'anion',
      'Electron-attached species',
      'energy',
      { charge: s.charge - 1, multiplicity: options.ionMultiplicity ?? 1 },
      initial,
    );
  }
  if (kind === 'uvvis') {
    add('ground', 'Optimize ground state', 'optimize', {}, initial);
    add(
      'excitation',
      'Vertical singlet excitations',
      'excitations',
      {},
      { geometryFrom: 'ground' },
    );
    add(
      'excited',
      'Optimize selected excited state',
      'excitedOptimize',
      {},
      { geometryFrom: 'ground', optional: true },
    );
  }
  for (const step of study.steps) {
    const check = validateCalculation(step.molecule ?? mol, step.settings);
    if (check.errors.length) throw new Error(step.name + ': ' + check.errors.join(' '));
  }
  return study;
}
export function geometryForStep(study, step, runs) {
  let mol = structuredClone(step.molecule ?? study.molecule);
  const runId =
    step.resumeRunId ??
    (step.geometryFrom
      ? study.steps.find((s) => s.id === step.geometryFrom)?.runId
      : step.sourceRunId);
  if ((step.geometryFrom || step.sourceRunId) && !runId)
    throw new Error('Complete the source geometry calculation first.');
  if (runId) {
    const run = runs.find((r) => r.id === runId);
    if (
      !run ||
      (run.status !== 'completed' && !(step.resumeRunId === runId && run.status === 'unconverged'))
    )
      throw new Error('The source geometry calculation must have completed successfully.');
    const file = run.artifacts.find((a) => a.name === 'molden.inp');
    if (!file) throw new Error('The source run has no usable geometry.');
    mol = resultGeometry(run, parseMolden(new TextDecoder().decode(file.data)));
    if (run.molecule?.bonds) mol.bonds = structuredClone(run.molecule.bonds);
  }
  if (step.transform) mol = editCoordinate(mol, step.transform.ids, step.transform.value);
  return mol;
}
export function studyInput(study, step, mol, constraintIndex = null) {
  const input = generateInput(mol, step.settings);
  if (step.constraint) {
    input.dal = input.dal.replace(
      '*OPTIMIZE\n',
      '*OPTIMIZE\n.NOAUX\n.BAKER\n' +
        (constraintIndex === null ? '.FINDRE\n' : `.CONSTRAINT\n1\n${constraintIndex}\n`),
    );
  }
  return input;
}
// FNDRED prints primitive torsions as atom indices. Resolve them each time;
// their numbers can change after a geometry edit or connectivity change.
export function constraintCoordinate(text, orderedIds, ids) {
  const target = ids.map((id) => orderedIds.indexOf(id) + 1);
  if (target.some((i) => !i))
    throw new Error('Constraint atoms are missing from the serialized molecule.');
  const count = ids.length;
  for (const line of text.split('\n')) {
    const match = line.match(
      /^\s*(\d+)\s+(?:Regular\s+)?(bond|angle|dihedral angle|torsion)\s+(.*)$/i,
    );
    if (!match) continue;
    if ((/bond/i.test(match[2]) ? 2 : /dihedral|torsion/i.test(match[2]) ? 4 : 3) !== count)
      continue;
    const nums = [...match[3].matchAll(/\b\d+\b/g)].map((m) => Number(m[0])).slice(0, count);
    if (
      nums.length === count &&
      (nums.every((n, i) => n === target[i]) || nums.every((n, i) => n === target[count - 1 - i]))
    )
      return Number(match[1]);
  }
  throw new Error(
    'Dalton did not identify the selected internal coordinate. Choose atoms along connected bonds.',
  );
}
export function analyzeStudy(study, runs) {
  const get = (id) => {
    const step = study.steps.find((s) => s.id === id),
      r = runs.find((r) => r.id === step?.runId);
    return step?.status === 'completed' &&
      r?.status === 'completed' &&
      Number.isFinite(r.results?.energy)
      ? r
      : null;
  };
  const values = [];
  const delta = (name, a, b, formula, unit = 'kJ/mol') => {
    const x = get(a),
      y = get(b);
    if (!x || !y) return;
    const eh = x.results.energy - y.results.energy;
    values.push({
      name,
      value: eh * (unit === 'eV' ? UNITS.hartreeToEV : UNITS.hartreeToKJMol),
      hartree: eh,
      unit,
      formula,
      sources: [x.id, y.id],
    });
  };
  if (study.kind === 'basis')
    for (const step of study.steps.slice(1))
      delta(
        `Basis energy change · ${step.settings.basis}`,
        step.id,
        study.steps[0].id,
        'E(basis) − E(first basis), at the same geometry',
      );
  if (study.kind === 'conformers') delta('Conformer B − A', 'b', 'a', 'E(B) − E(A)');
  if (study.kind === 'spin')
    delta(
      'Triplet − closed-shell singlet',
      'spin3',
      'spin1',
      'E(triplet) − E(closed-shell singlet)',
    );
  if (study.kind === 'ionization') {
    delta('Vertical ionization energy', 'vertical', 'neutral', 'E₊(R₀) − E₀(R₀)', 'eV');
    delta(
      'Electronic adiabatic ionization energy',
      'adiabatic',
      'neutral',
      'E₊(R₊) − E₀(R₀)',
      'eV',
    );
    const r = get('neutral'),
      file = r?.artifacts.find((a) => a.name === 'molden.inp');
    if (file) {
      const m = parseMolden(new TextDecoder().decode(file.data)),
        h = m.orbitals.find((o) => o.id === m.homo);
      if (h?.energy != null)
        values.push({
          name: r.settings.method === 'HF' ? 'Koopmans estimate' : 'Koopmans-like HOMO estimate',
          value: -h.energy * UNITS.hartreeToEV,
          unit: 'eV',
          formula: '−ε(HOMO) × 27.2114',
          sources: [r.id],
        });
    }
  }
  if (study.kind === 'affinity')
    delta(
      'Electron affinity',
      'neutral',
      'anion',
      'E(reference) − E(electron-attached species)',
      'eV',
    );
  if (study.kind === 'solvent')
    for (const role of ['a', 'b']) {
      delta(
        `${role.toUpperCase()} · fixed-geometry solvent effect`,
        role + 'pcmsp',
        role + 'gas',
        'E_PCM(R_gas) − E_gas(R_gas)',
      );
      delta(
        `${role.toUpperCase()} · solvent geometry relaxation`,
        role + 'pcmopt',
        role + 'pcmsp',
        'E_PCM(R_PCM) − E_PCM(R_gas)',
      );
    }
  if (study.kind === 'solvent') {
    delta('B − A · gas phase', 'bgas', 'agas', 'E_B,gas(R_B,gas) − E_A,gas(R_A,gas)');
    delta(
      'B − A · PCM at gas geometries',
      'bpcmsp',
      'apcmsp',
      'E_B,PCM(R_B,gas) − E_A,PCM(R_A,gas)',
    );
    delta('B − A · relaxed in PCM', 'bpcmopt', 'apcmopt', 'E_B,PCM(R_B,PCM) − E_A,PCM(R_A,PCM)');
  }
  if (study.kind === 'uvvis') {
    const r = get('excitation'),
      root =
        r?.results?.response?.states?.[
          study.steps.find((s) => s.id === 'excited').settings.targetState - 1
        ];
    if (root)
      values.push({
        name: 'Vertical excitation energy · selected state',
        value: root.ev,
        unit: 'eV',
        formula: 'ω at the optimized ground-state geometry',
        sources: [r.id],
      });
    delta(
      'Electronic adiabatic excitation energy',
      'excited',
      'ground',
      'E_excited(R_excited) − E_ground(R_ground); no zero-point correction',
      'eV',
    );
  }
  const scan = [];
  if (study.kind === 'scan')
    for (const mode of ['rigid', 'relaxed']) {
      const points = study.steps
        .filter((s) => s.scanMode === mode)
        .map((s) => {
          const r = get(s.id);
          return {
            angle: s.scanValue,
            energy: r?.results.energy ?? null,
            runId: r?.id,
            status: s.status,
            actual: s.actualCoordinate ?? null,
          };
        });
      if (!points.length) continue;
      scan.push({ mode, points });
      if (points.every((p) => p.energy != null)) {
        const first = points[0],
          last = points.at(-1),
          peak = points.reduce((a, b) => (a.energy > b.energy ? a : b));
        values.push({
          name: `${mode} sampled forward barrier`,
          value: (peak.energy - first.energy) * UNITS.hartreeToKJMol,
          unit: 'kJ/mol',
          formula:
            'max E(scan grid) − E(first point); sampled barrier, not a transition-state search',
          sources: [peak.runId, first.runId],
        });
        values.push({
          name: `${mode} sampled reverse barrier`,
          value: (peak.energy - last.energy) * UNITS.hartreeToKJMol,
          unit: 'kJ/mol',
          formula: 'max E(scan grid) − E(last point); sampled barrier',
          sources: [peak.runId, last.runId],
        });
      }
    }
  const geometries = [];
  for (const step of study.steps) {
    const r = get(step.id),
      file = r?.artifacts?.find((a) => a.name === 'molden.inp');
    if (!file || !study.measurements?.length) continue;
    try {
      const mol = resultGeometry(r, parseMolden(new TextDecoder().decode(file.data)));
      geometries.push({
        name: step.name,
        runId: r.id,
        values: study.measurements.map((m) => ({
          name: m.name,
          unit: m.ids.length === 2 ? 'Å' : '°',
          value: coordinate(mol, m.ids),
        })),
      });
    } catch {}
  }
  return { values, scan, geometries };
}
