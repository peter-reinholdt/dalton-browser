// Match the conversion printed by this Dalton version. Coordinates are in Å.
export const DIPOLE_DEBYE_PER_AU = 2.5415;
export const DIPOLE_ARROW_MIN_DEBYE = 1e-4;
export const DIPOLE_ARROW_MAX_ANGSTROM = 3;

export function dipoleNeedsRerun(run) {
  const engine = run?.execution?.engine ?? run?.engine;
  return engine?.preset?.startsWith('wasm') &&
    !engine.scientificFixes?.includes('sirius-dipole-vector-buffer');
}

export function dipoleDisplay(vector, origin = [0, 0, 0]) {
  if (vector?.length !== 3 || origin?.length !== 3 ||
      ![...vector, ...origin].every(Number.isFinite))
    throw new Error('Invalid dipole vector.');
  const magnitudeDebye = Math.hypot(...vector) * DIPOLE_DEBYE_PER_AU;
  const visible = magnitudeDebye >= DIPOLE_ARROW_MIN_DEBYE;
  // One Å per Debye, with a maximum length but no minimum-length magnification.
  const lengthAngstrom = visible ? Math.min(DIPOLE_ARROW_MAX_ANGSTROM, magnitudeDebye) : 0;
  const factor = visible ? lengthAngstrom / Math.hypot(...vector) : 0;
  return { magnitudeDebye, visible, lengthAngstrom,
    tip: origin.map((v, i) => v + factor * vector[i]) };
}
