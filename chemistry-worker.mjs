import * as OCL from './vendor/openchemlib.mjs';
import { ELEMENTS, molecule } from './molecules.mjs';
self.onmessage = async ({ data }) => {
  try {
    await OCL.Resources.registerFromUrl(
      new URL('./vendor/ocl-resources.json', import.meta.url).href,
    );
    const mol =
      data.format === 'smiles'
        ? OCL.Molecule.fromSmiles(data.text)
        : OCL.Molecule.fromMolfile(data.text);
    if (!mol.getAllAtoms()) throw new Error('Draw or enter a molecule first.');
    if (mol.getAllAtoms() > 150)
      throw new Error(
        'Local 3D generation is limited to 150 atoms. Import coordinates for larger structures.',
      );
    const generated = new OCL.ConformerGenerator(42).getOneConformerAsMolecule(mol);
    if (!generated)
      throw new Error(
        'Could not generate 3D coordinates. Check stereochemistry, or import a structure.',
      );
    let cleanup = 'Not requested',
      energy = null;
    if (data.cleanup) {
      try {
        const ff = new OCL.ForceFieldMMFF94(generated, 'MMFF94');
        const code = ff.minimise({ maxIts: 1000 });
        cleanup = code === 0 ? 'MMFF94 converged' : 'MMFF94 reached its iteration limit';
        energy = ff.getTotalEnergy();
      } catch {
        cleanup = 'MMFF94 does not support this structure; unrelaxed conformer retained';
      }
    }
    const result = molecule(
      Array.from({ length: generated.getAllAtoms() }, (_, i) => ({
        symbol: ELEMENTS[generated.getAtomicNo(i)],
        x: generated.getAtomX(i),
        y: generated.getAtomY(i),
        z: generated.getAtomZ(i),
      })),
      data.name || 'Generated molecule',
    );
    result.source = 'generated';
    result.molfile = generated.toMolfile();
    result.charge = Array.from({ length: generated.getAllAtoms() }, (_, i) =>
      generated.getAtomCharge(i),
    ).reduce((a, b) => a + b, 0);
    self.postMessage({ molecule: result, cleanup, energy });
  } catch (e) {
    self.postMessage({ error: String(e?.message ?? e) });
  }
};
