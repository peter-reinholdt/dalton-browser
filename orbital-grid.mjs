// Native Dalton basis export: normalized radial contractions and real-spherical
// polynomials, in Dalton AO order. No Molden harmonic conventions are inferred.
import { BOHR, atomicNumber } from './molecules.mjs';
export function parseNativeOrbitals(text) {
  if (text.length > 32 * 1024 ** 2) throw new Error('Orbital data exceeds 32 MB.');
  const lines = text.trim().split(/\r?\n/);
  if (lines.shift() !== 'DALTON_AO_V1') throw new Error('Unsupported native orbital format.');
  const tokens = lines.join(' ').trim().split(/\s+/);
  let offset = 0;
  const number = () => {
    const n = Number(tokens[offset++]);
    if (!Number.isFinite(n)) throw new Error('Incomplete or invalid native orbital data.');
    return n;
  };
  const integer = (lo, hi) => {
    const n = number();
    if (!Number.isInteger(n) || n < lo || n > hi) throw new Error('Invalid orbital dimensions.');
    return n;
  };
  const basisCount = integer(1, 400),
    orbitalCount = integer(1, 400),
    count = integer(1, 400);
  const shells = [];
  let basisOffset = 0;
  for (let s = 0; s < count; s++) {
    const center = [number(), number(), number()];
    const size = integer(1, 45),
      cartesian = integer(1, 45),
      primitives = integer(1, 1000);
    const radial = Array.from({ length: primitives }, () => {
      const exponent = number(),
        coefficient = number();
      if (exponent <= 0) throw new Error('Invalid Gaussian exponent.');
      return [exponent, coefficient];
    });
    const polynomials = Array.from({ length: cartesian }, () => ({
      powers: [integer(0, 8), integer(0, 8), integer(0, 8)],
      coefficients: Array.from({ length: size }, number),
    }));
    shells.push({ center, size, radial, polynomials, offset: basisOffset });
    basisOffset += size;
  }
  if (basisOffset !== basisCount) throw new Error('Native basis dimensions do not match.');
  const orbitals = new Map();
  while (offset < tokens.length) {
    const id = integer(1, orbitalCount);
    if (orbitals.has(id)) throw new Error('Duplicate native orbital index.');
    orbitals.set(id, Float64Array.from({ length: basisCount }, number));
  }
  return { basisCount, orbitalCount, shells, orbitals };
}
export function compileOrbital(basis, index) {
  const coefficients = basis.orbitals.get(index);
  if (!coefficients) throw new Error(`Native coefficients for MO ${index} are unavailable.`);
  return basis.shells
    .map((shell) => ({
      ...shell,
      terms: shell.polynomials
        .map((p) => ({
          powers: p.powers,
          coefficient: p.coefficients.reduce(
            (sum, c, i) => sum + c * coefficients[shell.offset + i],
            0,
          ),
        }))
        .filter((p) => Math.abs(p.coefficient) > 1e-16),
    }))
    .filter((shell) => shell.terms.length);
}
export function evaluateOrbital(shells, point) {
  let value = 0;
  for (const shell of shells) {
    const x = point[0] - shell.center[0],
      y = point[1] - shell.center[1],
      z = point[2] - shell.center[2];
    const r2 = x * x + y * y + z * z;
    const radial = shell.radial.reduce((sum, [a, c]) => sum + c * Math.exp(-a * r2), 0);
    const angular = shell.terms.reduce(
      (sum, t) => sum + t.coefficient * x ** t.powers[0] * y ** t.powers[1] * z ** t.powers[2],
      0,
    );
    value += radial * angular;
  }
  return value;
}
export function orbitalCube(
  basis,
  index,
  geometry,
  { spacing = 0.08, padding = 5, maxVoxels = 3000000 } = {},
) {
  const atoms = geometry.atoms;
  if (!atoms?.length || atoms.length > 100) throw new Error('Cube rendering supports 1–100 atoms.');
  if (
    !(
      spacing >= 0.08 &&
      spacing <= 1 &&
      padding >= 3 &&
      padding <= 12 &&
      maxVoxels >= 1000 &&
      maxVoxels <= 3000000
    )
  )
    throw new Error('Invalid cube grid limits.');
  // Centers belong to the actual exported basis, including symmetry images.
  const origin = [0, 1, 2].map((i) => Math.min(...basis.shells.map((s) => s.center[i])) - padding);
  const extent = [0, 1, 2].map(
    (i) => Math.max(...basis.shells.map((s) => s.center[i])) + padding - origin[i],
  );
  if (extent.some((v) => !Number.isFinite(v) || v > 20000))
    throw new Error('Orbital centers exceed the supported rendering extent.');
  let step = spacing,
    dimensions;
  do {
    dimensions = extent.map((v) => Math.ceil(v / step) + 1);
    if (dimensions.reduce((a, b) => a * b, 1) <= maxVoxels && Math.max(...dimensions) <= 220) break;
    step *= 1.05;
  } while (true);
  const [nx, ny, nz] = dimensions,
    values = new Float64Array(nx * ny * nz);
  for (const shell of compileOrbital(basis, index)) {
    const positions = dimensions.map((n, axis) =>
      Float64Array.from({ length: n }, (_, i) => origin[axis] + i * step - shell.center[axis]),
    );
    const exponentials = shell.radial.map(([a]) =>
      positions.map((p) => Float64Array.from(p, (x) => Math.exp(-a * x * x))),
    );
    const powers = shell.terms.map((t) =>
      positions.map((p, axis) => Float64Array.from(p, (x) => x ** t.powers[axis])),
    );
    let k = 0;
    for (let x = 0; x < nx; x++)
      for (let y = 0; y < ny; y++)
        for (let z = 0; z < nz; z++, k++) {
          let radial = 0;
          for (let p = 0; p < shell.radial.length; p++)
            radial +=
              shell.radial[p][1] *
              exponentials[p][0][x] *
              exponentials[p][1][y] *
              exponentials[p][2][z];
          if (Math.abs(radial) < 1e-20) continue;
          let angular = 0;
          for (let t = 0; t < shell.terms.length; t++)
            angular +=
              shell.terms[t].coefficient * powers[t][0][x] * powers[t][1][y] * powers[t][2][z];
          values[k] += radial * angular;
        }
  }
  const lines = [
    `Dalton orbital ${index}`,
    'Native normalized AO polynomials; coordinates in bohr',
    `${atoms.length} ${origin.join(' ')}`,
  ];
  dimensions.forEach((n, i) =>
    lines.push(`${n} ${[0, 1, 2].map((j) => (i === j ? step : 0)).join(' ')}`),
  );
  for (const atom of atoms) {
    const z = atomicNumber(atom.symbol);
    if (z < 1 || ![atom.x, atom.y, atom.z].every(Number.isFinite))
      throw new Error('Invalid cube atom.');
    lines.push(`${z} ${z} ${[atom.x, atom.y, atom.z].map((v) => v / BOHR).join(' ')}`);
  }
  for (let i = 0; i < values.length; i += 6)
    lines.push(Array.from(values.subarray(i, i + 6), (v) => v.toExponential(7)).join(' '));
  let maxBoundary = 0;
  for (let x = 0; x < nx; x++)
    for (let y = 0; y < ny; y++)
      for (let z = 0; z < nz; z++) {
        if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1)
          maxBoundary = Math.max(maxBoundary, Math.abs(values[(x * ny + y) * nz + z]));
      }
  return {
    cube: lines.join('\n') + '\n',
    values,
    origin,
    dimensions,
    step,
    maxBoundary,
    orbital: index,
  };
}
