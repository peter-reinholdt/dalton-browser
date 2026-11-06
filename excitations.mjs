// Versioned native response data: amplitudes are tied to this run's own MO indices.
export const EV = 27.2114,
  HC = 1239.841984;
export function parseResponse(text) {
  const d = JSON.parse(text);
  if (
    d.version !== 1 ||
    !['CIS', 'TDA-DFT', 'TDHF', 'TDDFT'].includes(d.model) ||
    !Number.isFinite(d.groundEnergy) ||
    !Array.isArray(d.states)
  )
    throw new Error('Unsupported response artifact.');
  for (const [i, s] of d.states.entries()) {
    s.energy = s.excitationEnergy;
    if (
      !Number.isFinite(s.energy) ||
      s.energy <= 0 ||
      !Number.isFinite(s.oscillatorStrength) ||
      !Array.isArray(s.amplitudes)
    )
      throw new Error('Invalid excited-state data.');
    s.root = i + 1;
    s.ev = s.energy * EV;
    s.nm = HC / s.ev;
    if (
      s.amplitudes.some(
        (a) =>
          a.length !== 4 ||
          !a.every(Number.isFinite) ||
          !Number.isInteger(a[0]) ||
          !Number.isInteger(a[1]),
      )
    )
      throw new Error('Invalid response amplitudes.');
    const weights = s.amplitudes.map((a) => Math.max(0, a[2] ** 2 - a[3] ** 2)),
      total = weights.reduce((a, b) => a + b, 0);
    s.transitions = s.amplitudes
      .map((a, j) => ({
        occupied: a[0],
        virtual: a[1],
        x: a[2],
        y: a[3],
        weight: total > 0 ? weights[j] / total : 0,
      }))
      .sort((a, b) => b.weight - a.weight);
  }
  return d;
}
export function uvSpectrum(states, { fwhm = 0.2, unit = 'eV', points = 700 } = {}) {
  if (!Number.isFinite(fwhm) || fwhm <= 0 || fwhm > 2)
    throw new Error('Choose a Gaussian FWHM from 0 to 2 eV.');
  if (!states.length) return [];
  const low = Math.max(0.05, Math.min(...states.map((s) => s.ev)) - 4 * fwhm),
    high = Math.max(...states.map((s) => s.ev)) + 4 * fwhm;
  return Array.from({ length: points }, (_, i) => {
    const ev = low + ((high - low) * i) / (points - 1);
    return {
      x: unit === 'nm' ? HC / ev : ev,
      y: states.reduce(
        (sum, s) =>
          sum + s.oscillatorStrength * Math.exp(-4 * Math.log(2) * ((ev - s.ev) / fwhm) ** 2),
        0,
      ),
    };
  }).sort((a, b) => a.x - b.x);
}
export function experimentalCSV(text, unit = 'nm') {
  const lines = text.trim().split(/\r?\n/),
    points = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const cols = line.split(/[;,\t]/).map((v) => v.trim().replace(/^"|"$/g, '')),
      x = Number(cols[0]),
      y = Number(cols[1]);
    if (i === 0 && !Number.isFinite(x) && !Number.isFinite(y)) continue;
    if (cols.length < 2 || !Number.isFinite(x) || !Number.isFinite(y) || x <= 0)
      throw new Error(
        'Experimental CSV needs two numeric columns: wavelength (nm) or energy (eV), then intensity.',
      );
    points.push({ ev: unit === 'nm' ? HC / x : x, intensity: y });
  }
  if (points.length < 2 || points.length > 50000)
    throw new Error('Import 2–50,000 experimental data points.');
  return points.sort((a, b) => a.ev - b.ev);
}

// Multiconfigurational response uses the ordinary Dalton state tables. Do not
// interpret its CI/orbital response vectors as SCF occupied→virtual amplitudes.
export function parsePrintedResponse(text, settings, groundEnergy) {
  const states=[];
  for(const m of text.matchAll(/@\s*Excited state no:\s*(\d+) in symmetry\s*(\d+)([\s\S]*?)(?=@\s*Excited state no:|Total CPU|$)/g)) {
    const energy=m[3].match(/@\s*Excitation energy\s*:\s*([-+\d.DEde]+)\s+au/);
    const strength=m[3].match(/@\s*Total oscillator strength \(LENGTH\)\s*:\s*([-+\d.DEde]+)/);
    if(!energy||!strength)continue;
    const excitationEnergy=Number(energy[1].replace(/[dD]/g,'e'));
    if(!(excitationEnergy>0))continue;
    states.push({root:Number(m[1]),symmetry:Number(m[2]),energy:excitationEnergy,excitationEnergy,
      ev:excitationEnergy*EV,nm:HC/(excitationEnergy*EV),oscillatorStrength:Number(strength[1].replace(/[dD]/g,'e')),
      transitions:[],amplitudes:[]});
  }
  return states.length?{model:settings.method==='CI'?'CAS-CI response':'MCSCF response',groundEnergy,states,
    requested:settings.excitedStates,amplitudesAvailable:false,source:'DALTON.OUT'}:null;
}
