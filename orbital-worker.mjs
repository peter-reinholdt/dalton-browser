import { parseNativeOrbitals, orbitalCube } from './orbital-grid.mjs';
let basis, geometry;
self.onmessage = ({ data }) => {
  try {
    if (data.action === 'load') {
      basis = parseNativeOrbitals(data.text);
      geometry = data.geometry;
      self.postMessage({ id: data.id });
    } else if (data.action === 'cube') {
      if (!basis) throw new Error('Load native orbital data first.');
      const options = data.quality === 'standard' ? { spacing: 0.1, maxVoxels: 2000000 } : {};
      const { values, ...result } = orbitalCube(basis, data.index, geometry, options);
      self.postMessage({ id: data.id, result: { ...result, quality: data.quality } });
    }
  } catch (e) {
    self.postMessage({ id: data.id, error: e?.message ?? String(e) });
  }
};
