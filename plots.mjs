// Small SVG charts: table/CSV alternatives remain available in the UI.
export function linePlot(values, label, { color = '#3d8057', zero = false } = {}) {
  if (!values.length) return '';
  const lo = Math.min(...values, zero ? 0 : Infinity),
    hi = Math.max(...values, zero ? 0 : -Infinity),
    span = hi - lo || Math.max(Math.abs(lo) * 1e-6, 1e-10),
    x = (i) => 45 + (i * 360) / Math.max(1, values.length - 1),
    y = (v) => 135 - ((v - lo) / span) * 110;
  return `<div class="plot"><svg viewBox="0 0 440 170" role="img" aria-label="${label}"><path d="M45 15V140H415" fill="none" stroke="#c9d8c5"/><text x="4" y="28" font-size="9" fill="#81967b">${hi.toPrecision(5)}</text><text x="4" y="138" font-size="9" fill="#81967b">${lo.toPrecision(5)}</text><polyline points="${values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="1.8"/>${values.length < 50 ? values.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="2" fill="${color}"/>`).join('') : ''}<text x="45" y="158" font-size="9" fill="#81967b">1</text><text x="390" y="158" font-size="9" fill="#81967b">${values.length}</text></svg><p>${label}</p></div>`;
}
export function spectrum(frequencies, intensities = [], width = 15) {
  if (!frequencies.length) return '';
  const hasIntensity = frequencies.every((_, i) => Number.isFinite(intensities[i])),
    f = frequencies.filter((v) => v > 0),
    max = Math.max(4000, ...f) + 100,
    min = 0,
    x = (v) => 35 + ((v - min) / (max - min)) * 380;
  const weights = hasIntensity ? intensities : frequencies.map(() => 1),
    peak = Math.max(1, ...weights);
  const sticks = frequencies
    .map((v, i) => (v > 0 ? `M${x(v)} 138V${138 - (95 * weights[i]) / peak}` : ''))
    .join(' ');
  const values = Array.from({ length: 500 }, (_, j) => {
      const v = (j * max) / 499;
      return frequencies.reduce(
        (sum, f, i) =>
          f > 0 ? sum + (weights[i] * width ** 2) / ((v - f) ** 2 + width ** 2) : sum,
        0,
      );
    }),
    height = Math.max(...values, 1e-10);
  return `<div class="plot"><svg viewBox="0 0 440 170" role="img" aria-label="${hasIntensity ? 'Harmonic IR spectrum' : 'Harmonic frequency positions'}"><path d="M35 20V138H420" fill="none" stroke="#c9d8c5"/><path d="${sticks}" stroke="#a0bca0" stroke-width="1" fill="none"/>${hasIntensity ? `<polyline points="${values.map((v, i) => `${35 + (i * 380) / 499},${138 - (100 * v) / height}`).join(' ')}" fill="none" stroke="#467d57" stroke-width="1.6"/>` : ''}<text x="35" y="157" font-size="9" fill="#81967b">0</text><text x="345" y="157" font-size="9" fill="#81967b">${max.toFixed(0)} cm⁻¹</text></svg><p>${hasIntensity ? 'IR intensities; Lorentzian broadening, half-width ' + width + ' cm⁻¹' : 'Frequency positions only; IR intensities were not exported.'}</p></div>`;
}
export function xyPlot(series, label, { xLabel = '', yLabel = '' } = {}) {
  const esc = (v) =>
    String(v).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const finite = series.flatMap((s) =>
    s.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
  );
  if (!finite.length) return '<p class="hint">The plot appears as successful results arrive.</p>';
  const xmin = Math.min(...finite.map((p) => p.x)),
    xmax = Math.max(...finite.map((p) => p.x)),
    ymin = Math.min(0, ...finite.map((p) => p.y)),
    ymax = Math.max(...finite.map((p) => p.y));
  const x = (v) => 55 + (350 * (v - xmin)) / (xmax - xmin || 1),
    y = (v) => 142 - (115 * (v - ymin)) / (ymax - ymin || 1);
  return `<div class="plot"><svg viewBox="0 0 440 185" role="img" aria-label="${esc(label)}"><path d="M55 15V142H415" fill="none" stroke="#c9d8c5"/>${series
    .map((s, i) => {
      const color = ['#3d8057', '#9a5c3d', '#5271b4'][i % 3];
      let path = '',
        pen = false;
      for (const p of s.points) {
        if (!Number.isFinite(p.y) || !Number.isFinite(p.x)) {
          pen = false;
          continue;
        }
        path += `${pen ? 'L' : 'M'}${x(p.x).toFixed(2)},${y(p.y).toFixed(2)}`;
        pen = true;
      }
      return `<path d="${path}" fill="none" stroke="${color}" stroke-width="1.8"/><text x="${65 + i * 115}" y="12" fill="${color}" font-size="10">${esc(s.name)}</text>`;
    })
    .join(
      '',
    )}<text x="3" y="30" font-size="9">${ymax.toPrecision(4)}</text><text x="3" y="141" font-size="9">${ymin.toPrecision(4)}</text><text x="55" y="157" font-size="9">${xmin.toPrecision(4)}</text><text x="370" y="157" font-size="9">${xmax.toPrecision(4)}</text><text x="170" y="178" font-size="10">${esc(xLabel)}</text></svg><p>${esc(label)}${yLabel ? ' · ' + esc(yLabel) : ''}</p></div>`;
}
