import { uvSpectrum, experimentalCSV, EV, HC } from './excitations.mjs';
import { xyPlot } from './plots.mjs';
import { csv } from './results.mjs';
export function excitationResults(run, ctx) {
  const { element: el, $, escape: e, download, save, guard, showOrbital } = ctx,
    d = run.results?.response;
  if (!d?.states.length) return;
  let unit = 'eV',
    fwhm = 0.2;
  el.insertAdjacentHTML(
    'beforeend',
    `<h2>${e(d.model)} electronic excitations</h2><p class="hint">Vertical singlet excitations · ${d.states.length} of ${d.requested ?? d.states.length} requested states converged. ${d.amplitudesAvailable === false ? 'Energies and oscillator strengths are read from Dalton’s multiconfigurational response tables.' : "Transition weights are normalized X² − Y² contributions from this calculation's reference orbitals."}</p><div class="form-grid"><label class="field">Spectrum axis<select id="uv-unit"><option>eV</option><option>nm</option></select></label><label class="field">Gaussian FWHM / eV<input id="uv-width" type="number" value="0.2" min="0.01" max="2" step="0.01"></label></div><div id="uv-plot"></div><div class="row wrap"><button id="uv-csv" class="outline">Download excitations CSV</button><button id="uv-curve" class="outline">Download spectrum CSV</button></div><details><summary>Overlay an experimental spectrum</summary><p class="hint">CSV: two columns, wavelength or energy followed by intensity. Header optional. Both curves are scaled to their own maximum for comparison.</p><label class="field">Experimental x units<select id="experimental-unit"><option>nm</option><option>eV</option></select></label><input id="experimental-file" type="file" accept=".csv,.txt"><button id="clear-experimental" class="text-button">Clear overlay</button></details><table><thead><tr><th>State</th><th>eV</th><th>nm</th><th>Oscillator strength</th><th>Dominant contributions</th></tr></thead><tbody>${d.states
      .map(
        (s) =>
          `<tr><td>S${s.root}</td><td>${s.ev.toFixed(4)}</td><td>${s.nm.toFixed(2)}</td><td>${s.oscillatorStrength.toExponential(5)}</td><td>${
            s.transitions
              .filter((t) => t.weight >= 0.05)
              .slice(0, 6)
              .map(
                (t) =>
                  `<div><button class="text-button" data-transition-mo="${t.occupied}">MO ${t.occupied}</button> → <button class="text-button" data-transition-mo="${t.virtual}">MO ${t.virtual}</button> ${(100 * t.weight).toFixed(1)}%</div>`,
              )
              .join('') || (d.amplitudesAvailable === false ? 'See multiconfigurational response vectors in the output' : 'Distributed over small contributions')
          }</td></tr>`,
      )
      .join(
        '',
      )}</tbody></table><p class="hint">${d.amplitudesAvailable === false ? 'Full response vectors are available in DALTON.OUT.' : 'All amplitudes and full precision excitation data are available in DALTON.RESPONSE.json.'} Spectra show relative absorption, without vibronic structure or a calibrated molar extinction coefficient.</p>`,
  );
  function render() {
    const points = uvSpectrum(d.states, { unit, fwhm }),
      max = Math.max(...points.map((p) => p.y), 1e-30),
      overlay = run.experimentalSpectrum ?? [];
    const series = [{ name: d.model, points: points.map((p) => ({ x: p.x, y: p.y / max })) }];
    if (overlay.length) {
      const peak = Math.max(...overlay.map((p) => p.intensity), 1e-30);
      series.push({
        name: 'Experiment',
        points: overlay
          .map((p) => ({ x: unit === 'nm' ? HC / p.ev : p.ev, y: p.intensity / peak }))
          .sort((a, b) => a.x - b.x),
      });
    }
    $('uv-plot').innerHTML = xyPlot(series, 'Absorption spectrum', {
      xLabel: unit,
      yLabel: `relative intensity · Gaussian FWHM ${fwhm} eV`,
    });
  }
  $('uv-unit').onchange = guard(() => {
    unit = $('uv-unit').value;
    render();
  });
  $('uv-width').onchange = guard(() => {
    fwhm = Number($('uv-width').value);
    render();
  });
  $('experimental-file').onchange = guard(async () => {
    const file = $('experimental-file').files[0];
    if (!file) return;
    if (file.size > 4 * 1024 ** 2) throw new Error('Experimental CSV must be smaller than 4 MB.');
    run.experimentalSpectrum = experimentalCSV(await file.text(), $('experimental-unit').value);
    save();
    render();
  });
  $('clear-experimental').onclick = () => {
    delete run.experimentalSpectrum;
    save();
    render();
  };
  $('uv-csv').onclick = () =>
    download(
      'excitations.csv',
      csv([
        [
          'State',
          'Excitation / Eh',
          'Excitation / eV',
          'Wavelength / nm',
          'Oscillator strength',
          'Source run',
        ],
        ...d.states.map((s) => [s.root, s.energy, s.ev, s.nm, s.oscillatorStrength, run.id]),
      ]),
      'text/csv',
    );
  $('uv-curve').onclick = guard(() =>
    download(
      'spectrum.csv',
      csv([
        [unit, 'Relative absorption', 'Gaussian FWHM / eV'],
        ...uvSpectrum(d.states, { unit, fwhm }).map((p) => [p.x, p.y, fwhm]),
      ]),
      'text/csv',
    ),
  );
  for (const b of el.querySelectorAll('[data-transition-mo]'))
    b.onclick = guard(() => showOrbital(Number(b.dataset.transitionMo)));
  render();
}
