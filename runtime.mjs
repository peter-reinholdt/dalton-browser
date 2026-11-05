// The same runner is exercised in browser workers and Node numerical tests.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export function safeName(name) {
  if (!/^[A-Za-z0-9_+.,=*()-]+$/.test(name) || name === '.' || name === '..') {
    throw new Error(`Invalid file name: ${name}`);
  }
  return name;
}
export function validateJob(job) {
  const words = Number(job.workspaceWords ?? 16000000);
  if (!Number.isSafeInteger(words) || words < 1000000 || words > 64000000) {
    throw new Error('Workspace must be between 1 and 64 million eight-byte words.');
  }
  for (const name of Object.keys(job.files)) safeName(name);
  if (!job.files[job.dal] || !job.files[job.mol]) throw new Error('Select a Dalton input and a molecule file.');
  return words;
}
export function parseResults(text) {
  const numbers = [...text.matchAll(/Final\s+(?:HF|DFT|KS(?:-DFT)?)\s+energy:\s*([-+\d.]+(?:[DEde][-+]?\d+)?)/g)];
  const dipole = text.match(/Total dipole moment \(a\.u\.\)\s*=\s*([-+\d.]+)/);
  return { energy: numbers.length ? Number(numbers.at(-1)[1].replace(/[dD]/, 'e')) : null,
    dipole: dipole ? Number(dipole[1]) : null };
}
export async function executeJob(job, options = {}) {
  const words = validateJob(job);
  const onOutput = options.onOutput ?? (() => {});
  const createModule = options.createModule ?? (await import('./assets/dalton.mjs')).default;
  const started = performance.now();
  let exitCode = 0;
  let failure = null;
  const module = await createModule({
    ...(options.moduleOptions ?? {}), noInitialRun: true,
    preRun: [m => Object.assign(m.ENV, { BASDIR: '/work:/basis', WRKMEM: String(words), OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' })],
    print: line => onOutput(`${line}\n`, 'stdout'),
    printErr: line => onOutput(`${line}\n`, 'stderr'),
    quit: (code, exception) => { throw exception ?? Object.assign(new Error(`Exit ${code}`), { status: code }); },
  });
  const FS = module.FS;
  FS.mkdir('/work');
  FS.mkdir('/basis');
  for (const [name, data] of Object.entries(job.files)) {
    FS.writeFile(`/work/${safeName(name)}`, typeof data === 'string' ? encoder.encode(data) : data);
  }
  for (const [name, data] of Object.entries(options.basis ?? {})) {
    FS.writeFile(`/basis/${safeName(name)}`, data);
  }
  FS.writeFile('/work/DALTON.INP', FS.readFile(`/work/${job.dal}`));
  FS.writeFile('/work/MOLECULE.INP', FS.readFile(`/work/${job.mol}`));
  FS.chdir('/work');
  Object.assign(module.ENV, { BASDIR: '/work:/basis', WRKMEM: String(words), OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' });
  // This executes synchronously while WASM is running. postMessage can still
  // deliver it to the main thread; polling this busy worker cannot.
  const write = FS.write;
  const streamDecoder = new TextDecoder();
  FS.write = function(stream, buffer, offset, length, ...rest) {
    const count = write.call(this, stream, buffer, offset, length, ...rest);
    if (stream.path === '/work/DALTON.OUT' && count) {
      onOutput(streamDecoder.decode(buffer.subarray(offset, offset + count), { stream: true }), 'dalton');
    }
    return count;
  };
  try {
    module.callMain([]);
  } catch (error) {
    if (typeof error?.status === 'number') exitCode = error.status;
    else { exitCode = 1; failure = String(error?.stack ?? error); }
  }
  const outputs = [];
  let scratchBytes = 0;
  let exportedBytes = 0;
  const omitted = [];
  for (const name of FS.readdir('/work')) {
    if (name === '.' || name === '..') continue;
    const stat = FS.stat(`/work/${name}`);
    if (!FS.isFile(stat.mode)) continue;
    scratchBytes += stat.size;
    const selected = /^(DALTON\.(OUT|PROP|MOL|ORB|HES|MOPUN|BAS|TRJ|STAT)|molden\.inp|SIRIFC.*|.*\.(xyz|cube))$/.test(name);
    if (!selected) continue;
    if (stat.size > 32 * 1024 ** 2 || exportedBytes + stat.size > 128 * 1024 ** 2) {
      omitted.push({ name, bytes: stat.size });
      continue;
    }
    outputs.push({ name, data: FS.readFile(`/work/${name}`) });
    exportedBytes += stat.size;
  }
  const out = outputs.find(f => f.name === 'DALTON.OUT');
  const text = out ? decoder.decode(out.data) : '';
  // Some legacy error paths STOP without a nonzero code. Treat their reports
  // as failure too, while retaining all available output for diagnosis.
  if (/(?:FATAL ERROR|SEVERE ERROR|Reason for quit:|ERROR \(.*\)|ABORT)/i.test(text)) exitCode ||= 1;
  return { exitCode, failure, outputs, omitted, scratchBytes,
    elapsedMs: performance.now() - started, ...parseResults(text) };
}
