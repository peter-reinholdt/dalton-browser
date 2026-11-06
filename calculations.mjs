import { FUNCTIONALS, PROPERTY_TASKS, propertyInput } from './properties.mjs';
export { FUNCTIONALS, PROPERTY_TASKS } from './properties.mjs';
import { validateMolecule, toDaltonMolecule, fingerprint } from './molecules.mjs';
export const METHODS = {
  HF: {
    label: 'Hartree–Fock',
    tasks: [
      'energy',
      'optimize',
      'frequencies',
      'polarizability',
      'excitations',
      'excitedOptimize',
    ],
  },
  DFT: {
    label: 'Density functional theory',
    tasks: [
      'energy',
      'optimize',
      'frequencies',
      'polarizability',
      'excitations',
      'excitedOptimize',
    ],
  },
  MP2: { label: 'MP2', tasks: ['energy'] },
  CCSD: { label: 'CCSD', tasks: ['energy'] },
  SOPPA: { label: 'SOPPA', tasks: ['polarizability'] },
  CASSCF: { label: 'CASSCF', tasks: ['energy'], multireference: true },
  CI: { label: 'CAS-CI', tasks: ['energy'], multireference: true },
};
export const TASKS = {
  energy: 'Single-point energy',
  scan: 'Coordinate scan',
  optimize: 'Geometry optimization',
  frequencies: 'Harmonic frequencies',
  polarizability: 'Static polarizability',
  excitations: 'Electronic excitations / UV–vis',
  excitedOptimize: 'Excited-state geometry optimization',
};
for (const method of Object.values(METHODS))
  if (method.tasks.includes('energy')) method.tasks.push('scan');
for (const method of ['HF','DFT','CASSCF','CI']) {
  METHODS[method].tasks.push(...Object.keys(PROPERTY_TASKS));
  if (['CASSCF','CI'].includes(method)) METHODS[method].tasks.push('polarizability','excitations');
}
METHODS.CI.tasks = METHODS.CI.tasks.filter(task => !['nmrShielding','magnetizability','opticalRotation'].includes(task));
Object.assign(TASKS,Object.fromEntries(Object.entries(PROPERTY_TASKS).map(([key,p])=>[key,p.label])));
export const DISPERSION_FUNCTIONALS = new Set(['B3LYP','PBE','PBE0','CAM-B3LYP','BP86','BLYP','B3PW91']);
const nonlinearTasks = new Set(['hyperpolarizability','secondHyperpolarizability','twoPhoton']);
const nonlinearFunctionals = new Set(['LDA','B3LYP','BLYP','B1LYP','BHandH','BHandHLYP','CAM-B3LYP']);
export function taskAvailable(settings, task) {
  return !!METHODS[settings.method]?.tasks.includes(task) &&
    !(settings.method === 'DFT' && nonlinearTasks.has(task) && !nonlinearFunctionals.has(settings.functional));
}
export const defaults = () => ({
  responseFrequency: 0,
  method: 'DFT',
  task: 'energy',
  functional: 'B3LYP',
  dispersion: 'none',
  environment: 'gas',
  pcmPrecision: 'course',
  excitedStates: 6,
  targetState: 1,
  basis: 'def2-SVP',
  charge: 0,
  multiplicity: 1,
  convergence: 'normal',
  maxSteps: 50,
  frozenCore: 0,
  activeElectrons: 2,
  activeOrbitals: 2,
  inactive: 0,
  roots: '1',
  weights: '1',
  stateAverage: false,
  activeIndices: [],
  mode: 'guided',
});
function choose(n, k) {
  if (k < 0 || k > n) return 0;
  let v = 1;
  for (let i = 1; i <= Math.min(k, n - k); i++) v = (v * (n - i + 1)) / i;
  return Math.round(v);
}
export function rootsAndWeights(s) {
  const roots = String(s.roots)
      .trim()
      .split(/[\s,]+/)
      .map(Number),
    raw = String(s.weights)
      .trim()
      .split(/[\s,]+/)
      .map(Number);
  if (
    !roots.length ||
    roots.some((r) => !Number.isInteger(r) || r < 1 || r > 20) ||
    new Set(roots).size !== roots.length
  )
    throw new Error('Choose unique roots between 1 and 20.');
  if (
    s.stateAverage &&
    (raw.length !== roots.length || raw.some((w) => !Number.isFinite(w) || w <= 0))
  )
    throw new Error('Provide one positive weight per selected root.');
  const sum = raw.reduce((a, b) => a + b, 0);
  return { roots, weights: s.stateAverage ? raw.map((w) => w / sum) : [] };
}
export function validateCalculation(mol, s, prepared) {
  const { errors, warnings, electrons } = validateMolecule(
    mol,
    Number(s.charge),
    Number(s.multiplicity),
  );
  if (!taskAvailable(s,s.task))
    errors.push('This method/functional/task combination is not enabled. Nonlinear DFT response requires a functional with higher derivatives (for example B3LYP, BLYP, LDA or CAM-B3LYP).');
  if (
    s.multiplicity !== 1 &&
    !METHODS[s.method]?.multireference &&
    (!['HF', 'DFT'].includes(s.method) || !['energy', 'optimize'].includes(s.task))
  )
    errors.push('Open-shell HF/DFT is available for energies and geometry optimization.');
  if (
    s.task !== 'energy' &&
    mol.atoms.length === 1 &&
    ['optimize', 'excitedOptimize', 'frequencies'].includes(s.task)
  )
    errors.push('An isolated atom has no internal geometry to optimize or vibrational modes.');
  if (!['none', 'd3', 'd3bj'].includes(s.dispersion ?? 'none'))
    errors.push('Choose a supported dispersion correction.');
  if ((s.dispersion ?? 'none') !== 'none' && s.method === 'DFT' && !DISPERSION_FUNCTIONALS.has(s.functional)) errors.push('No guided D3 parameters are available for this functional. Choose no dispersion.');
  if ((s.dispersion ?? 'none') !== 'none' && s.method !== 'DFT')
    errors.push('Dispersion presets require DFT.');
  if (!['course', 'strict'].includes(s.pcmPrecision ?? 'course'))
    errors.push('Choose a supported PCM geometry precision.');
  if (!['gas', 'water'].includes(s.environment ?? 'gas'))
    errors.push('Choose gas phase or PCM water.');
  if (
    (s.environment ?? 'gas') !== 'gas' &&
    (!['HF', 'DFT'].includes(s.method) || !['energy', 'optimize'].includes(s.task))
  )
    errors.push('The guided PCM workflow supports HF/DFT energies and ground-state optimization.');
  if (!Number.isFinite(s.responseFrequency ?? 0) || (s.responseFrequency ?? 0) < 0 || (s.responseFrequency ?? 0) > 2) errors.push('Response frequency must be between 0 and 2 Hartree.');
  if (['excitations', 'excitedOptimize', 'twoPhoton'].includes(s.task)) {
    if (s.multiplicity !== 1)
      errors.push('Excitations currently require a closed-shell singlet reference.');
    if (!Number.isInteger(s.excitedStates) || s.excitedStates < 1 || s.excitedStates > 20)
      errors.push('Request 1–20 excited singlet states.');
    if (!Number.isInteger(s.targetState) || s.targetState < 1 || s.targetState > s.excitedStates)
      errors.push('Select a target among the requested states.');
    if (s.task === 'excitedOptimize')
      warnings.push(
        `Numerical excited-state optimization needs about ${6 * mol.atoms.length} response calculations per gradient. Larger basis sets can take hours; the study makes this task optional.`,
      );
  }
  if (s.multiplicity > 1 && ['HF', 'DFT'].includes(s.method))
    warnings.push(
      'Restricted high-spin reference; singly occupied spatial orbitals share the same spin.',
    );
  if (!/^[A-Za-z0-9_+*()-]+$/.test(s.basis)) errors.push('Choose a bundled basis set.');
  if (s.method === 'DFT' && !FUNCTIONALS.some(([name]) => name === s.functional))
    errors.push('Choose a supported built-in functional.');
  if (!['normal', 'tight'].includes(s.convergence)) errors.push('Choose a convergence preset.');
  if (!Number.isInteger(s.maxSteps) || s.maxSteps < 1 || s.maxSteps > 200)
    errors.push('Maximum geometry steps must be between 1 and 200.');
  if (
    ['MP2', 'CCSD'].includes(s.method) &&
    (!Number.isInteger(s.frozenCore) || s.frozenCore < 0 || 2 * s.frozenCore >= electrons)
  )
    errors.push('Frozen-core count must leave correlated electrons.');
  let determinants = null;
  if (METHODS[s.method]?.multireference) {
    if (s.stateAverage)
      errors.push(
        'State-averaged CASSCF is unavailable: this Dalton version parses .MCAVER but does not apply its weights in orbital optimization. Use state-specific CASSCF or CAS-CI roots.',
      );
    const n = s.activeElectrons,
      m = s.activeOrbitals,
      inactive = s.inactive,
      unpaired = s.multiplicity - 1;
    if (
      ![n, m, inactive].every(Number.isInteger) ||
      m < 1 ||
      n < 1 ||
      n > 2 * m ||
      inactive < 0 ||
      2 * inactive + n !== electrons ||
      n < unpaired ||
      (n - unpaired) % 2
    )
      errors.push(
        'CAS needs integer counts, 2 × inactive + active electrons = total electrons, and a compatible active-space spin.',
      );
    else {
      determinants = choose(m, (n + unpaired) / 2) * choose(m, (n - unpaired) / 2);
      if (determinants > 1000000)
        errors.push(
          'The estimated determinant space exceeds the guided browser limit of one million. Reduce the CAS or use expert input.',
        );
      else if (determinants > 100000)
        warnings.push(
          `Large CAS: approximately ${determinants.toLocaleString()} determinants before spin adaptation.`,
        );
    }
    try {
      const { roots } = rootsAndWeights(s);
      if (!s.stateAverage && s.method === 'CASSCF' && roots.length !== 1)
        errors.push(
          'State-specific CASSCF takes one root; enable state averaging for several roots.',
        );
      if (s.method === 'CI' && s.stateAverage)
        errors.push('State averaging applies to CASSCF orbital optimization.');
      if (determinants != null && Math.max(...roots) > determinants)
        errors.push('Requested root exceeds the determinant-space size.');
    } catch (e) {
      errors.push(e.message);
    }
    if (prepared && m + inactive > prepared.orbitalCount)
      errors.push('The inactive and active spaces exceed the number of prepared orbitals.');
    if (s.activeIndices?.length) {
      if (!prepared?.orbitals || prepared.fingerprint !== fingerprint(mol, s))
        errors.push('Prepare reference orbitals for this geometry, basis, charge, and spin again.');
      if (s.activeIndices.length !== m || new Set(s.activeIndices).size !== m)
        errors.push('Select exactly the requested number of distinct active orbitals.');
      if (
        prepared &&
        s.activeIndices.some((i) => !Number.isInteger(i) || i < 1 || i > prepared.orbitalCount)
      )
        errors.push('An active orbital is outside the reference orbital space.');
    }
  }
  if (s.environment === 'water' && s.task === 'optimize')
    warnings.push(
      `PCM geometry criterion: gradient norm ${s.pcmPrecision === 'strict' ? '1e-4' : '1e-3'} a.u.; gradient convergence is required. Atomic-sphere cavity; no added interstitial spheres.`,
    );
  if (s.task === 'frequencies')
    warnings.push('Harmonic frequencies are most meaningful at a converged stationary geometry.');
  return { errors, warnings, electrons, determinants };
}
// Permutation includes all orbitals: inactive first, chosen active next, virtual last.
export function orbitalPermutation(s, count) {
  const all = Array.from({ length: count }, (_, i) => i + 1),
    active = new Set(s.activeIndices);
  const rest = all.filter((i) => !active.has(i));
  return [...rest.slice(0, s.inactive), ...s.activeIndices, ...rest.slice(s.inactive)];
}
export function generateInput(mol, s, prepared) {
  s = { ...defaults(), ...s };
  if (s.task === 'scan') throw new Error('Coordinate scans generate a separate input for each point.');
  const check = validateCalculation(mol, s, prepared);
  if (check.errors.length) throw new Error(check.errors.join('\n'));
  const mr = METHODS[s.method].multireference,
    threshold = s.convergence === 'tight' ? '1.0D-10' : '1.0D-8';
  let dal =
    '**DALTON INPUT\n' +
    (s.multiplicity > 1 && !mr ? '.DIRECT\n' : '') +
    {
      energy: '.RUN WAVE FUNCTIONS\n',
      optimize: '.OPTIMIZE\n*OPTIMIZE\n.MAX IT\n' + s.maxSteps + '\n',
      frequencies: '.RUN PROPERTIES\n',
      polarizability: '.RUN RESPONSE\n',
      excitations: '.RUN RESPONSE\n',
      excitedOptimize: '.OPTIMIZE\n*OPTIMIZE\n.MAX IT\n' + s.maxSteps + '\n',
      ...Object.fromEntries(Object.entries(PROPERTY_TASKS).map(([key,p]) => [key,p.module === 'properties' ? '.RUN PROPERTIES\n' : '.RUN RESPONSE\n'])),
    }[s.task];
  if (s.task === 'excitedOptimize') dal += '.TRUSTR\n0.15\n';
  if (s.environment === 'water') {
    if (s.task === 'optimize')
      dal = dal.replace(
        '*OPTIMIZE\n',
        `*OPTIMIZE\n.GRADIENT\n${s.pcmPrecision === 'strict' ? '1.0D-4' : '1.0D-3'}\n.STEP THRESHOLD\n${s.pcmPrecision === 'strict' ? '1.0D-4' : '1.0D-3'}\n`,
      );
    dal += '*PCM\n.SOLVNT\nWATER\n.RET\n100\n*PCMCAV\n.OLDCEN\n';
  }
  dal +=
    '**WAVE FUNCTIONS\n' +
    (s.method === 'DFT'
      ? `.DFT\n${s.functional}\n`
      : mr && (s.activeIndices.length || s.multiplicity !== 1)
        ? ''
        : '.HF\n');
  if (s.method === 'MP2' || s.method === 'SOPPA') dal += '.MP2\n';
  if (s.method === 'CCSD') dal += '.CC\n';
  if (mr) {
    dal += s.method === 'CI' ? '.CI\n' : '.MCSCF\n';
    dal += `*CONFIGURATION INPUT\n.SYMMETRY\n1\n.SPIN MUL\n${s.multiplicity}\n.INACTIVE\n${s.inactive}\n.ELECTRONS\n${s.activeElectrons}\n.CAS SPACE\n${s.activeOrbitals}\n`;
    const { roots, weights } = rootsAndWeights(s);
    if (s.method === 'CI') dal += `*CI INPUT\n.CIROOTS\n${Math.max(...roots)}\n`;
    else
      dal +=
        '*OPTIMIZATION\n' +
        (s.stateAverage
          ? `.MCAVER\n${roots.length}\n${roots.join(' ')}\n${weights.map((w) => w.toPrecision(14)).join(' ')}\n`
          : `.STATE\n${roots[0]}\n`);
    if (s.activeIndices.length && prepared) {
      const permutation = orbitalPermutation(s, prepared.orbitalCount);
      dal += `*ORBITAL INPUT\n.MOSTART\n FORM18\n.REORDER\n${permutation.length}\n${permutation.map((old, i) => `${i + 1} ${old}`).join(' ')}\n`;
    }
  }
  if (s.method === 'DFT' && s.dispersion !== 'none')
    dal += '*DFT INPUT\n' + (s.dispersion === 'd3' ? '.DFTD3\n' : '.DFD3BJ\n');
  dal += `*SCF INPUT\n.THRESH\n${['excitations', 'excitedOptimize'].includes(s.task) ? '1.0D-9' : threshold}\n`;
  if (s.environment === 'water') dal += '.NO BACKSTEP\n.MAX DIIS\n200\n';
  if (s.multiplicity > 1 && !mr)
    dal += `.DOUBLY OCCUPIED\n${(check.electrons - s.multiplicity + 1) / 2}\n.SINGLY OCCUPIED\n${s.multiplicity - 1}\n`;
  if (s.method === 'CCSD')
    dal += `*CC INPUT\n.CCSD\n.THRENR\n${threshold}\n.FREEZE\n${s.frozenCore} 0\n`;
  if (s.method === 'MP2' && s.frozenCore) dal += `*MP2 INPUT\n.MP2 FROZEN\n${s.frozenCore}\n`;
  if (s.method === 'HF') dal += '*ORBITAL INPUT\n.PUNCHOUTPUTORBITALS\n';
  if (s.task === 'frequencies') dal += '**PROPERTIES\n.VIBANA\n';
  if (s.task === 'polarizability')
    dal += '**RESPONSE\n' + (s.method === 'SOPPA' ? '.SOPPA\n' : '') + '*LINEAR\n.DIPLEN\n';
  if (['excitations', 'excitedOptimize'].includes(s.task))
    dal += `**RESPONSE\n${s.method === 'HF' ? '.CIS\n' : s.method === 'DFT' ? '.TDA\n' : ''}*LINEAR\n.SINGLE RESIDUE\n.DIPLEN\n.ROOTS\n${s.excitedStates}\n.THCPP\n1.0D-8\n`;
  dal += propertyInput(s.task, s);
  const numerical =
    s.task === 'excitedOptimize' ||
    (s.task === 'optimize' && s.method === 'DFT' && s.multiplicity > 1);
  if (numerical) dal += '**NMDDRV\n.DORDR\n1 0\n.DISPLACEMENT\n0.001\n';
  return {
    atomOrder: [...new Set(mol.atoms.map((a) => a.symbol))].flatMap((symbol) =>
      mol.atoms.filter((a) => a.symbol === symbol).map((a) => a.id),
    ),
    extraFiles:
      s.task === 'excitedOptimize'
        ? { 'BROWSER.ES': `${s.targetState}\n`, 'BROWSER.GEOCONV': '1\n' }
        : numerical
          ? {
              'BROWSER.NUMGRAD': '1\n',
              ...(s.environment === 'water' ? { 'BROWSER.GEOCONV': '1\n' } : {}),
            }
          : s.environment === 'water' && s.task === 'optimize'
            ? { 'BROWSER.GEOCONV': '1\n' }
            : {},
    dal:
      dal +
      '**END OF DALTON INPUT\n' +
      (s.activeIndices.length && prepared?.orbitals ? prepared.orbitals + '\n' : ''),
    mol: toDaltonMolecule(mol, s),
  };
}

// Input edits intentionally do not synchronize the controls. Infer only the
// supported result metadata from the immutable input used for this run.
export function settingsFromInput(dal, mol) {
  const has=keyword=>new RegExp('^\\s*\\.'+keyword+'(?:\\s|$)','im').test(dal);
  const method=has('CI')?'CI':has('MCSCF')?'CASSCF':has('CCSD')?'CCSD':has('SOPPA')?'SOPPA':has('DFT')?'DFT':has('MP2')?'MP2':has('HF')?'HF':undefined;
  let task=Object.entries(PROPERTY_TASKS).find(([,p])=>p.keyword&&has(p.keyword.slice(1)))?.[0];
  task ??= has('TWO-PHOTON')?'twoPhoton':/^\s*\*CUBIC/im.test(dal)?'secondHyperpolarizability':/^\s*\*QUADRATIC/im.test(dal)?'hyperpolarizability':has('VIBANA')?'frequencies':has('OPTIMIZE')?'optimize':has('SINGLE RESIDUE')?'excitations':has('RUN RESPONSE')?'polarizability':'energy';
  const count=keyword=>{const m=dal.match(new RegExp('^\\s*\\.'+keyword+'[^\\n]*\\n\\s*([0-9 ]+)','im'));return m?m[1].trim().split(/\s+/).map(Number).reduce((a,b)=>a+b,0):undefined;};
  return {mode:'expert',method,task,basis:/^BASIS\s*\n([^\n]+)/i.exec(mol)?.[1].trim(),
    functional:/^\s*\.DFT\s*\n\s*([^\n]+)/im.exec(dal)?.[1].trim(),
    inactive:count('INACTIVE'),activeOrbitals:count('CAS SPACE'),excitedStates:count('ROOTS')};
}
