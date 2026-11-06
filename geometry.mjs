const v = (a) => [a.x, a.y, a.z],
  sub = (a, b) => a.map((x, i) => x - b[i]),
  dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0),
  cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  norm = (a) => Math.hypot(...a);
const unit = (a) => {
  const n = norm(a);
  if (n < 1e-10) throw new Error('Undefined coordinate: coincident or collinear atoms.');
  return a.map((x) => x / n);
};
export function coordinate(mol, ids) {
  const atoms = ids.map((id) => mol.atoms.find((a) => a.id === id));
  if (
    ![2, 3, 4].includes(atoms.length) ||
    atoms.some((a) => !a) ||
    new Set(ids).size !== ids.length
  )
    throw new Error('Choose two, three, or four distinct atoms.');
  const p = atoms.map(v);
  if (p.length === 2) return norm(sub(p[0], p[1]));
  if (p.length === 3)
    return (
      (Math.acos(Math.max(-1, Math.min(1, dot(unit(sub(p[0], p[1])), unit(sub(p[2], p[1])))))) *
        180) /
      Math.PI
    );
  const axis = unit(sub(p[2], p[1])),
    a = sub(p[0], p[1]),
    b = sub(p[3], p[2]),
    u = sub(
      a,
      axis.map((x) => x * dot(a, axis)),
    ),
    w = sub(
      b,
      axis.map((x) => x * dot(b, axis)),
    );
  unit(u);
  unit(w);
  return (Math.atan2(dot(cross(axis, u), w), dot(u, w)) * 180) / Math.PI;
}
export function bonds(mol) {
  if (mol.bonds?.length) return mol.bonds.map((b) => [b.a, b.b]);
  const radii = {
    H: 0.31,
    B: 0.84,
    C: 0.76,
    N: 0.71,
    O: 0.66,
    F: 0.57,
    Si: 1.11,
    P: 1.07,
    S: 1.05,
    Cl: 1.02,
    Br: 1.2,
    I: 1.39,
  };
  const result = [];
  for (let i = 0; i < mol.atoms.length; i++)
    for (let j = 0; j < i; j++) {
      const a = mol.atoms[i],
        b = mol.atoms[j],
        d = norm(sub(v(a), v(b)));
      if (d > 0.15 && d < 1.22 * ((radii[a.symbol] ?? 1.1) + (radii[b.symbol] ?? 1.1)))
        result.push([a.id, b.id]);
    }
  return result;
}
export function editCoordinate(mol, ids, target) {
  if (!Number.isFinite(target)) throw new Error('Enter a finite coordinate value.');
  const current = coordinate(mol, ids),
    n = ids.length;
  if (n === 2 && target <= 0.1) throw new Error('A bond length must exceed 0.1 Å.');
  if (n === 3 && (target <= 0.1 || target >= 179.9))
    throw new Error('Choose an angle between 0.1° and 179.9°.');
  const [left, right] = n === 2 ? ids : n === 3 ? [ids[1], ids[2]] : [ids[1], ids[2]],
    graph = new Map(mol.atoms.map((a) => [a.id, []]));
  let linked = false;
  for (const [a, b] of bonds(mol)) {
    if ((a === left && b === right) || (a === right && b === left)) {
      linked = true;
      continue;
    }
    graph.get(a)?.push(b);
    graph.get(b)?.push(a);
  }
  if (!linked) throw new Error('The edited coordinate must follow connected bonds.');
  const moving = new Set([right]),
    queue = [right];
  while (queue.length) {
    for (const id of graph.get(queue.shift()) ?? [])
      if (!moving.has(id)) {
        moving.add(id);
        queue.push(id);
      }
  }
  if (moving.has(left))
    throw new Error('This bond belongs to a ring; a unique moving fragment cannot be selected.');
  if (n === 4 && (!moving.has(ids[3]) || moving.has(ids[0])))
    throw new Error(
      'Choose four atoms ordered along the torsion, with the fourth on the moving side.',
    );
  const out = structuredClone(mol),
    points = ids.map((id) => v(mol.atoms.find((a) => a.id === id))),
    origin = n === 2 ? points[0] : points[1];
  let axis, angle, shift;
  if (n === 2) shift = unit(sub(points[1], points[0])).map((x) => x * (target - current));
  else {
    axis =
      n === 3
        ? unit(cross(sub(points[0], points[1]), sub(points[2], points[1])))
        : unit(sub(points[2], points[1]));
    angle = ((target - current) * Math.PI) / 180;
  }
  for (const a of out.atoms)
    if (moving.has(a.id) && !(n === 4 && a.id === right)) {
      const p = sub(v(a), origin);
      const q = shift
        ? v(a).map((x, i) => x + shift[i])
        : p.map(
            (x, i) =>
              origin[i] +
              x * Math.cos(angle) +
              cross(axis, p)[i] * Math.sin(angle) +
              axis[i] * dot(axis, p) * (1 - Math.cos(angle)),
          );
      [a.x, a.y, a.z] = q;
    }
  delete out.molfile;
  out.source = 'edited coordinates';
  const actual = coordinate(out, ids),
    error = n === 4 ? Math.abs(((actual - target + 540) % 360) - 180) : Math.abs(actual - target);
  if (error > 1e-6) throw new Error('Coordinate rotation did not reach the requested value.');
  return out;
}
export function resultGeometry(run, data) {
  const geo = data.geometry,
    ids = run.atomOrder ?? run.input?.atomOrder ?? run.atomIds;
  if (run.molecule?.id) geo.id = run.molecule.id;
  if (ids?.length === geo.atoms.length) geo.atoms.forEach((a, i) => (a.id = ids[i]));
  return geo;
}
export function scanValues(start, end, step) {
  if (![start, end, step].every(Number.isFinite) || step === 0 || (end - start) * step < 0)
    throw new Error('Choose a scan step directed from start to end.');
  const count = Math.round((end - start) / step);
  if (Math.abs(start + count * step - end) > 1e-7 || count < 0 || count > 72)
    throw new Error('Use an inclusive grid of at most 73 points with an exact final step.');
  return Array.from({ length: count + 1 }, (_, i) => start + i * step);
}
export function orderedAtoms(mol) {
  return [...new Set(mol.atoms.map((a) => a.symbol))].flatMap((s) =>
    mol.atoms.filter((a) => a.symbol === s).map((a) => a.id),
  );
}
