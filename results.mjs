import { parsePrintedResponse } from './excitations.mjs';
import { parsePropertyResults } from './properties.mjs';
import { BOHR, molecule, parseXYZ } from './molecules.mjs';
export const number = (text) => Number(String(text).replace(/[dD]/g, 'e'));
const N = '([-+]?\\d*\\.?\\d+(?:[dDeE][-+]?\\d+)?)';
function last(text, pattern) {
  const matches = [...text.matchAll(new RegExp(pattern, 'gi'))];
  return matches.length ? number(matches.at(-1)[1]) : null;
}
export function parseOutput(text, settings = {}) {
  const energies = {};
  for (const [method, pattern] of Object.entries({
    HF: `Final\\s+HF\\s+energy:\\s*${N}`,
    DFT: `Final\\s+(?:DFT|KS(?:-DFT)?)\\s+energy:\\s*${N}`,
    MP2: `(?:Total MP2\\s+energy\\s*[:=]|Final MP2 energy:|@\\s*=\\s*MP2 second order energy\\s*:)\\s*${N}`,
    CASSCF: `Final MCSCF energy:\\s*${N}`,
    CCSD: `Total CCSD\\s+energy\\s*:\\s*${N}`,
  })) {
    const value = last(text, pattern);
    if (value !== null) energies[method] = value;
  }
  const states = [];
  for (const block of text.matchAll(
    /Final CI energies and residuals[^\n]*\n((?:\s*@\s*\d+[^\n]*\n?)+)/g,
  )) {
    const current = [...block[1].matchAll(new RegExp(`@\\s*(\\d+)\\s+${N}\\s+${N}`, 'g'))].map(
      (m) => ({ root: Number(m[1]), energy: number(m[2]), residual: number(m[3]) }),
    );
    if (current.length) states.splice(0, states.length, ...current);
  }
  if (states.length)
    energies.CI =
      states.find((s) => s.root === Number(String(settings.roots ?? '1').split(/[\s,]+/)[0]))
        ?.energy ?? states[0].energy;
  let method = settings.method;
  if (!method)
    method = ['CCSD', 'CASSCF', 'CI', 'MP2', 'DFT', 'HF'].find((m) => energies[m] != null);
  const energy = energies[method] ?? (method === 'SOPPA' ? energies.MP2 : null) ?? null;
  const dipoleAu = last(text, `Total dipole moment \\(a\\.u\\.\\)\\s*=\\s*${N}`),
    dipoleDebye = last(text, `Total dipole moment \\(Debye\\)\\s*=\\s*${N}`);
  const polarizability = Array.from({ length: 3 }, () => Array(3).fill(null)),
    axes = ['X', 'Y', 'Z'];
  for (const m of text.matchAll(
    new RegExp(`-<<\\s*([XYZ])DIPLEN\\s*;\\s*([XYZ])DIPLEN\\s*>>\\s*=\\s*${N}`, 'g'),
  )) {
    const i = axes.indexOf(m[1]),
      j = axes.indexOf(m[2]);
    polarizability[i][j] = polarizability[j][i] = number(m[3]);
  }
  // C1 output includes all tensor components. Symmetry output may omit off-diagonals.
  const scf = [];
  let segment = [], inSCF = false;
  for (const line of text.split('\n')) {
    if (/Iter\s+Total energy\s+Error norm/.test(line)) {
      if (segment.length) scf.push(segment);
      segment = [];
      inSCF = true;
    }
    if (inSCF && /DIIS converged|Converged SCF energy|SCF orbital energy analysis|End of Wave Function|Final (?:HF|DFT|KS)/i.test(line)) {
      if (segment.length) scf.push(segment);
      segment = [];
      inSCF = false;
    }
    const m = inSCF && line.match(new RegExp(`^\\s*@?\\s*(\\d+)\\s+${N}\\s+${N}\\s+${N}`));
    if (m && /^[ @\d.+\-DEde\s]+$/.test(line) && number(m[2]) < 0)
      segment.push({ iteration: Number(m[1]), energy: number(m[2]), error: number(m[3]) });
  }
  if (segment.length) scf.push(segment);
  const issues = [];
  if (/(?:FATAL ERROR|SEVERE ERROR|Reason for quit:|ABORT)/i.test(text))
    issues.push('Dalton reported an error. Inspect the output for its reason.');
  if (
    /(?:SCF|MCSCF|CCSD|CI).{0,40}(?:not converged|failed to converge)|maximum number of.*(?:SCF|CI|CCSD|MCSCF).*iterations.*reached/i.test(
      text,
    )
  )
    issues.push('An iterative calculation did not converge.');
  const geometryGradients = [
    ...text.matchAll(new RegExp(`Norm of gradient\\s*:\\s*${N}`, 'g')),
  ].map((m) => number(m[1]));
  // Read a complete analysis block, never an electronic-only expectation value.
  const dipoleBlocks = [...text.matchAll(/Dipole moment analysis([\s\S]*?)(?=Total dipole moment \(Debye\)[^\n]*|End of Wave Function|$)/g)];
  const dipoleBlock = dipoleBlocks.at(-1)?.[1] ?? '';
  const vector = label => {
    const m = dipoleBlock.match(new RegExp(`^\\s*${label}\\s+${N}\\s+${N}\\s+${N}\\s*$`, 'm'));
    return m ? m.slice(1).map(number) : null;
  };
  const dipoleElectronic = vector('Electronic'), dipoleNuclear = vector('Nuclear');
  const dipoleComponents = vector('Total') ?? (dipoleElectronic && dipoleNuclear ? dipoleElectronic.map((v,i)=>v+dipoleNuclear[i]) : null);
  if (dipoleComponents && dipoleAu != null && Math.abs(Math.hypot(...dipoleComponents)-dipoleAu)>5e-5)
    issues.push('The printed dipole magnitude and total components disagree. Inspect the dipole analysis in the output.');
  const optimizationConverged =
    /optimization (?:has )?converged|geometry (?:optimization )?(?:has )?converged|convergence (?:has been )?reached|equilibrium geometry located/i.test(
      text,
    );
  const intensities = [];
  // Dalton's IR table contains mode, symmetry, frequency, and intensity columns.
  let ir = false;
  for (const line of text.split('\n')) {
    if (/Vibrational Frequencies and IR Intensities/i.test(line)) {
      ir = true;
      continue;
    }
    if (ir && /Normal Coordinates|Zero.point|Thermodynamic|Rotational/i.test(line)) ir = false;
    if (ir) {
      const m = line.match(
        /^\s*(\d+)\s+\S+\s+(-?[\d.]+)(i?)\s+[-\d.Ee+]+\s+([-\d.Ee+]+)\s+[-\d.Ee+]+\s*$/,
      );
      if (m)
        intensities.push({
          mode: Number(m[1]),
          frequency: number(m[2]) * (m[3] ? -1 : 1),
          intensity: number(m[4]),
        });
    }
  }
  return {
    method: method ?? null,
    energy,
    energyUnit: 'Eh',
    energies,
    states,
    dipole: dipoleAu,
    dipoleDebye,
    dipoleComponents,
    dipoleElectronic,
    dipoleNuclear,
    dipoleComponentsUnit: 'a.u.',
    geometryGradients,
    polarizability: polarizability.some((row) => row.some((v) => v !== null))
      ? polarizability
      : null,
    polarizabilityUnit: 'a.u.',
    scf,
    issues,
    optimizationConverged,
    intensities,
    property: parsePropertyResults(text, settings.task),
    response: ['CI','CASSCF'].includes(method) && settings.task === 'excitations' ? parsePrintedResponse(text, settings, energy) : null,
    provenance: 'Parsed from DALTON.OUT',
  };
}
export function sections(text) {
  const entries = [];
  let current;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*\[([^\]]+)\](.*)$/);
    if (match) {
      current = { name: match[1].toUpperCase(), suffix: match[2].trim(), lines: [] };
      entries.push(current);
    } else if (current) current.lines.push(line);
  }
  return entries;
}
export function parseMolden(text) {
  const entries = sections(text),
    find = (name) => entries.find((s) => s.name === name),
    title = find('TITLE')?.lines.join('\n').trim() ?? '';
  const atomsSection = find('ATOMS'),
    scale = /AU/i.test(atomsSection?.suffix ?? '') ? BOHR : 1;
  const atoms = (atomsSection?.lines ?? [])
    .filter((l) => l.trim())
    .map((line) => {
      const p = line.trim().split(/\s+/);
      return {
        id: `result-${p[1]}`,
        symbol: p[0].match(/^[A-Za-z]+/)?.[0],
        x: number(p[3]) * scale,
        y: number(p[4]) * scale,
        z: number(p[5]) * scale,
        atomicNo: Number(p[2]),
      };
    });
  // Labels may be O_1 or carbon C12. Nuclear charge is authoritative.
  const { ELEMENTS } = elementTable;
  for (const a of atoms) a.symbol = ELEMENTS[a.atomicNo] ?? a.symbol;
  const orbitals = [];
  let orbital;
  for (const line of find('MO')?.lines ?? []) {
    let m;
    if ((m = line.match(/^\s*Sym\s*=\s*(.*)/i))) {
      orbital = {
        id: orbitals.length + 1,
        symmetry: m[1].trim(),
        energy: null,
        occupation: 0,
        spin: 'Alpha',
        coefficients: [],
      };
      orbitals.push(orbital);
    } else if (orbital && (m = line.match(/^\s*(Ene|Occup|Spin)\s*=\s*(.*)/i))) {
      const key = { ene: 'energy', occup: 'occupation', spin: 'spin' }[m[1].toLowerCase()];
      orbital[key] = key === 'spin' ? m[2].trim() : number(m[2]);
    } else if (orbital && (m = line.match(new RegExp(`^\\s*(\\d+)\\s+${N}\\s*$`))))
      orbital.coefficients[Number(m[1]) - 1] = number(m[2]);
  }
  const flags = entries.map((s) => s.name),
    sphericalD = flags.some((n) => /5D/.test(n)),
    sphericalF = !flags.some((n) => /10F/.test(n)) && flags.some((n) => /7F/.test(n)),
    sphericalG = flags.includes('9G');
  const shells = [];
  let center = -1,
    shell;
  for (const line of find('GTO')?.lines ?? []) {
    const p = line.trim().split(/\s+/);
    if (/^\d+$/.test(p[0]) && p[1] === '0' && p.length === 2) {
      center = Number(p[0]) - 1;
      shell = null;
    } else if (/^(s|p|d|f|g|sp)$/i.test(p[0])) {
      shell = { center, type: p[0].toLowerCase(), primitives: [] };
      shells.push(shell);
    } else if (shell && p.length >= 2 && p.every((v) => Number.isFinite(number(v))))
      shell.primitives.push(p.map(number));
  }
  const counts = {
      s: 1,
      p: 3,
      d: sphericalD ? 5 : 6,
      f: sphericalF ? 7 : 10,
      g: sphericalG ? 9 : 15,
      sp: 4,
    },
    basisCount = shells.reduce((n, s) => n + counts[s.type], 0);
  for (const o of orbitals) {
    if (o.coefficients.length > basisCount)
      throw new Error('Molden coefficients exceed its basis dimension.');
    o.coefficients = Array.from({ length: basisCount }, (_, i) => o.coefficients[i] ?? 0);
  }
  const energiesMeaningful =
    orbitals.some((o) => Math.abs(o.energy ?? 0) > 1e-10) && !/(MC-SCF|MCSCF|\bCI\b)/i.test(title);
  const occupied = orbitals.filter((o) => o.occupation > 1e-5).sort((a, b) => b.energy - a.energy),
    virtual = orbitals.filter((o) => o.occupation <= 1e-5).sort((a, b) => a.energy - b.energy);
  const frequencies = (find('FREQ')?.lines ?? [])
      .map((l) => l.trim())
      .filter(Boolean)
      .map(number)
      .filter(Number.isFinite),
    modes = [];
  let mode;
  for (const line of find('FR-NORM-COORD')?.lines ?? []) {
    if (/^\s*vibration/i.test(line)) {
      mode = [];
      modes.push(mode);
    } else if (mode) {
      const values = line.trim().split(/\s+/).map(number);
      if (values.length === 3 && values.every(Number.isFinite)) mode.push(values);
    }
  }
  const fr = (find('FR-COORD')?.lines ?? [])
    .filter((l) => l.trim())
    .map((line) => {
      const [symbol, ...c] = line.trim().split(/\s+/);
      return { symbol, x: number(c[0]) * BOHR, y: number(c[1]) * BOHR, z: number(c[2]) * BOHR };
    });
  const trajectory = [];
  const geometry = find('GEOMETRIES');
  if (geometry && /XYZ/i.test(geometry.suffix)) {
    let i = 0;
    while (i < geometry.lines.length) {
      if (!geometry.lines[i].trim()) {
        i++;
        continue;
      }
      const n = Number(geometry.lines[i]);
      if (!Number.isInteger(n) || n < 1) break;
      try {
        trajectory.push(
          parseXYZ(geometry.lines.slice(i, i + n + 2).join('\n'), 'Optimization geometry'),
        );
      } catch {
        break;
      }
      i += n + 2;
    }
  }
  const geoconv = find('GEOCONV')?.lines ?? [];
  let key = '';
  const optimization = { energy: [], maxForce: [], rmsForce: [], maxStep: [], rmsStep: [] };
  for (const l of geoconv) {
    const s = l.trim().toLowerCase();
    if (['energy', 'max-force', 'rms-force', 'max-step', 'rms-step'].includes(s))
      key = {
        energy: 'energy',
        'max-force': 'maxForce',
        'rms-force': 'rmsForce',
        'max-step': 'maxStep',
        'rms-step': 'rmsStep',
      }[s];
    else if (key && s && Number.isFinite(number(s))) optimization[key].push(number(s));
  }
  const convergence = (find('SCFCONV')?.lines ?? [])
    .map((l) => l.trim())
    .filter((l) => l && Number.isFinite(number(l)))
    .map(number);
  const supported =
    !!orbitals.length &&
    !!basisCount &&
    shells.every((s) => s.type !== 'sp') &&
    shells.every((s) => s.center >= 0 && s.center < atoms.length) &&
    atoms.length > 0;
  return {
    title,
    geometry: molecule(atoms, 'Result geometry'),
    shells,
    basisCount,
    flags,
    orbitals,
    energiesMeaningful,
    homo: energiesMeaningful ? occupied[0]?.id : null,
    lumo: energiesMeaningful ? virtual[0]?.id : null,
    frequencies,
    modes,
    vibrationGeometry: fr.length ? molecule(fr, 'Vibration geometry') : null,
    trajectory,
    optimization,
    convergence,
    supported,
    orbitalProvenance: /wave function type\s*:\s*MP2\b/i.test(title)
      ? 'MP2 natural orbitals. Their occupations are correlated; this export has no orbital energies.'
      : /MC-SCF|MCSCF|\bCI\b/i.test(title)
        ? 'Multireference orbitals; occupations are analysis values unless explicitly identified as natural orbitals.'
        : 'HF/DFT reference molecular orbitals',
  };
}
import * as elementTable from './molecules.mjs';
export function phaseFromOutput(text) {
  const matches = [
    ...text.matchAll(
      /Starting in (?:Integral|Wave Function|Response|Property)[^\n]*|Optimization (?:iteration|step)[^\n]*|DIIS converged[^\n]*|CI converged[^\n]*|Final MCSCF energy[^\n]*|Coupled cluster CCSD[^\n]*|Iter\.\s*\d+[^\n]*|Hessian|Vibrational analysis|Browser accepted geometry[^\n]*|Browser excited state[^\n]*/gi,
    ),
  ];
  return matches.at(-1)?.[0]?.replace(/\s+/g, ' ').slice(0, 100) ?? null;
}
export function compatibleRuns(a, b) {
  if (a.settings?.mode === 'expert' || b.settings?.mode === 'expert') return false;
  if (
    a.status !== 'completed' ||
    b.status !== 'completed' ||
    a.results?.energy == null ||
    b.results?.energy == null
  )
    return false;
  const s = a.settings ?? {},
    t = b.settings ?? {};
  const formula = (run) =>
    run.molecule?.atoms
      ?.map((a) => a.symbol)
      .sort()
      .join(',');
  return (
    !!formula(a) &&
    formula(a) === formula(b) &&
    [
      'method',
      'basis',
      'functional',
      'dispersion',
      'environment',
      'charge',
      'multiplicity',
      'frozenCore',
      'activeElectrons',
      'activeOrbitals',
      'inactive',
      'roots',
      'weights',
      'stateAverage',
      'activeIndices',
    ].every((k) => JSON.stringify(s[k]) === JSON.stringify(t[k]))
  );
}
export function csv(rows) {
  return (
    rows
      .map((row) => row.map((v) => `"${String(v ?? '').replaceAll('"', '""')}"`).join(','))
      .join('\n') + '\n'
  );
}
