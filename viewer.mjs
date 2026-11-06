// JSmol runs in its own document: its Java compatibility globals must not alter
// native Error/DOM behavior in the workspace or the structure sketcher.
import { toXYZ } from './molecules.mjs';
import { sections } from './results.mjs';
export class MolecularViewer {
  constructor(element, onPick = () => {}) {
    this.element = element;
    this.key = null;
    this.selected = null;
    this.molden = null;
    this.pending = new Map();
    this.sequence = 0;
    this.orbitalSequence = 0;
    this.cubePending = new Map();
    this.frame = document.createElement('iframe');
    this.frame.title = 'Interactive molecular structure';
    this.frame.src = new URL('./viewer-frame.html', import.meta.url).href;
    this.frame.style.cssText = 'width:100%;height:100%;border:0;display:block';
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      this.timeout = setTimeout(
        () => reject(new Error('The molecular viewer did not initialize. Reload to retry.')),
        45000,
      );
    });
    this.listener = (event) => {
      if (
        event.source !== this.frame.contentWindow ||
        event.origin !== location.origin ||
        event.data?.channel !== 'dalton-viewer'
      )
        return;
      const data = event.data;
      if (data.type === 'ready') {
        clearTimeout(this.timeout);
        this.resolveReady();
      } else if (data.type === 'error' && !data.id) {
        clearTimeout(this.timeout);
        this.rejectReady(new Error(data.error));
      } else if (data.type === 'pick') onPick(data.index);
      else if (data.id) {
        const pending = this.pending.get(data.id);
        if (!pending) return;
        this.pending.delete(data.id);
        clearTimeout(pending.timeout);
        data.error ? pending.reject(new Error(data.error)) : pending.resolve(data.result);
      }
    };
    window.addEventListener('message', this.listener);
    element.replaceChildren(this.frame);
  }
  async call(action, args = {}) {
    await this.ready;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The molecular viewer did not finish this action.'));
      }, 30000);
      this.pending.set(id, { resolve, reject, timeout });
      this.frame.contentWindow.postMessage(
        { channel: 'dalton-viewer', id, action, ...args },
        location.origin,
      );
    });
  }
  async structure(xyz, key, { preserve = false } = {}) {
    await this.ready;
    if (this.key === key) return;
    this.clearCubes();
    this.key = key;
    this.molden = null;
    this.selected = null;
    await this.call('structure', { text: xyz, preserve });
  }
  async orbitals(text, key, native = null, geometry = null) {
    await this.ready;
    if (this.key === key) return;
    this.clearCubes();
    this.key = key;
    this.molden = text;
    this.selected = null;
    if (native) {
      this.cubeWorker = new Worker(new URL('./orbital-worker.mjs', import.meta.url), {
        type: 'module',
      });
      this.cubeWorker.onmessage = ({ data }) => {
        const pending = this.cubePending.get(data.id);
        if (!pending) return;
        this.cubePending.delete(data.id);
        clearTimeout(pending.timeout);
        data.error ? pending.reject(new Error(data.error)) : pending.resolve(data.result ?? true);
      };
      this.cubeWorker.onerror = (event) => {
        for (const pending of this.cubePending.values()) {
          clearTimeout(pending.timeout);
          pending.reject(new Error(event.message));
        }
        this.cubePending.clear();
      };
      await this.cubeCall('load', { text: native, geometry });
      await this.call('structure', { text: toXYZ(geometry) });
    } else {
      if (/^\s*[ghi]\s+\d+\s+/gim.test(text))
        throw new Error(
          'Native orbital data is missing. Rerun this calculation to enable higher angular momentum surfaces.',
        );
      // JSmol's trajectory reader cannot handle Dalton's mixed optimization
      // and final-orbital export. Give it the final structure and MOs only;
      // the original file and parsed trajectory remain intact in the run.
      const finalOrbitals = sections(text)
        .filter((s) => !['SCFCONV', 'GEOMETRIES', 'GEOCONV', 'FREQ', 'FR-COORD', 'FR-NORM-COORD', 'INT'].includes(s.name))
        .map((s) => `[${s.name}]${s.suffix ? ' ' + s.suffix : ''}\n${s.lines.join('\n')}`)
        .join('\n');
      await this.call('orbitals', { text: finalOrbitals });
    }
  }
  cubeCall(action, args) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.cubePending.delete(id);
        reject(new Error('Orbital grid generation timed out.'));
      }, 120000);
      this.cubePending.set(id, { resolve, reject, timeout });
      this.cubeWorker.postMessage({ id, action, ...args });
    });
  }
  clearCubes() {
    ++this.orbitalSequence;
    this.cubeWorker?.terminate();
    this.cubeWorker = null;
    this.cubeCache = null;
    for (const pending of this.cubePending.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(null);
    }
    this.cubePending.clear();
  }
  dipole(vector, origin) {
    return this.call('dipole', { vector, origin });
  }
  representation(space = false, labels = false) {
    return this.call('representation', { space, labels });
  }
  async showOrbital(index, cutoff = 0.04, opacity = 0.8, quality = 'fine') {
    if (!this.molden || !Number.isInteger(index) || index < 1)
      throw new Error('Load orbital results first.');
    if (
      !Number.isFinite(cutoff) ||
      cutoff < 0.005 ||
      cutoff > 0.2 ||
      !Number.isFinite(opacity) ||
      opacity < 0.1 ||
      opacity > 1
    )
      throw new Error('Choose an isovalue from 0.005 to 0.2 and opacity from 0.1 to 1.');
    this.selected = index;
    const sequence = ++this.orbitalSequence;
    if (this.cubeWorker) {
      const grid =
        this.cubeCache?.orbital === index && this.cubeCache.quality === quality
          ? this.cubeCache
          : await this.cubeCall('cube', { index, quality });
      if (!grid || sequence !== this.orbitalSequence) return false;
      const first = !this.cubeCache;
      this.cubeCache = grid;
      await this.call('cube', { text: grid.cube, index, cutoff, opacity, first });
      return true;
    }
    return this.call('orbital', { index, cutoff, opacity });
  }
  hideOrbital() {
    ++this.orbitalSequence;
    this.selected = null;
    return this.call('hideOrbital');
  }
  reset() {
    return this.call('reset');
  }
  stop() {
    return this.call('stop');
  }
  async png() {
    return this.call('png');
  }
}
