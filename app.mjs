import { safeName, validateJob } from './runtime.mjs';
const $ = id => document.getElementById(id);
const enc = new TextEncoder(), dec = new TextDecoder();
const water = `BASIS\nSTO-3G\nWater\nBrowser example, Angstrom\nAtomtypes=2 Angstrom\nCharge=8.0 Atoms=1\nO 0.000000 0.000000 0.000000\nCharge=1.0 Atoms=2\nH 0.000000 0.757160 0.586260\nH 0.000000 -0.757160 0.586260\n`;
const hf = `**DALTON INPUT\n.RUN WAVE FUNCTIONS\n**WAVE FUNCTIONS\n.HF\n*SCF INPUT\n.THRESH\n1.0D-9\n**END OF DALTON INPUT\n`;
const dft = hf.replace('.HF', '.DFT\nB3LYP');
let files = new Map(), active = '', worker = null, saveTimer, clockTimer, started;
let busy = false, manifest;
let dalSelection = 'hf.dal', molSelection = 'water.mol';
const term = new window.Terminal({ fontSize: 12, lineHeight: 1.3, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  scrollback: 4000, convertEol: true, theme: { background: '#10262e', foreground: '#d1e1d8', cursor: '#76c3a0', selectionBackground: '#345a53' } });
term.open($('terminal'));
function fit() {
  const box = $('terminal');
  term.resize(Math.max(20, Math.floor((box.clientWidth - 44) / 7.3)), Math.max(5, Math.floor((box.clientHeight - 30) / 16)));
}
new ResizeObserver(fit).observe($('terminal'));
function log(text, error = false) { term.write(error ? `\x1b[31m${text}\x1b[0m` : text); }
const database = new Promise((resolve, reject) => {
  const request = indexedDB.open('dalton-workspace', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('sessions');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function save() {
  clearTimeout(saveTimer);
  const snapshot = { files: [...files], active, dal: $('dal-select').value, mol: $('mol-select').value, memory: $('memory').value };
  try {
    const db = await database;
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('sessions', 'readwrite');
      transaction.objectStore('sessions').put(snapshot, 'current');
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    $('save-state').textContent = 'Saved locally';
  } catch { $('save-state').textContent = 'Storage unavailable — download to save'; }
}
function scheduleSave() { $('save-state').textContent = 'Saving…'; clearTimeout(saveTimer); saveTimer = setTimeout(save, 250); }
function isBinary(data) { return data.length > 2 * 1024 ** 2 || data.subarray(0, 8192).includes(0); }
function syncEditor() {
  const file = files.get(active);
  if (file && !isBinary(file.data)) file.data = enc.encode($('editor').value);
}
function lines() { $('line-numbers').textContent = Array.from({ length: $('editor').value.split('\n').length }, (_, i) => i + 1).join('\n'); }
function openFile(name) {
  syncEditor();
  const file = files.get(name);
  if (!file) throw new Error(`No such file: ${name}`);
  active = name;
  $('current-file').textContent = name;
  const binary = isBinary(file.data);
  $('editor').hidden = binary; $('line-numbers').hidden = binary; $('binary-message').hidden = !binary;
  $('editor').value = binary ? '' : dec.decode(file.data);
  $('editor').readOnly = Boolean(file.result);
  lines(); renderFiles(); scheduleSave();
}
function renderFiles() {
  $('files').replaceChildren();
  for (const [name, file] of files) {
    const button = document.createElement('button');
    button.classList.toggle('active', name === active);
    const text = document.createElement('span'); text.textContent = name;
    const size = document.createElement('small'); size.textContent = `${file.result ? 'OUT · ' : ''}${Math.max(1, Math.ceil(file.data.length / 1024))} KB`;
    button.append(text, size); button.onclick = () => openFile(name); $('files').append(button);
  }
  for (const [id, extension, selected] of [['dal-select', '.dal', dalSelection], ['mol-select', '.mol', molSelection]]) {
    const select = $(id); const previous = select.value || selected;
    select.replaceChildren();
    for (const name of files.keys()) if (name.toLowerCase().endsWith(extension)) select.add(new Option(name, name));
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
  }
}
function setBusy(value) {
  busy = value;
  $('run').disabled = value; $('cancel').disabled = !value;
  for (const id of ['dal-select', 'mol-select', 'memory', 'reset']) $(id).disabled = value;
}
function finish() { clearInterval(clockTimer); worker?.terminate(); worker = null; setBusy(false); }
async function run(dal = $('dal-select').value, mol = $('mol-select').value) {
  if (busy) throw new Error('A calculation is already running.');
  syncEditor();
  const job = { dal, mol, workspaceWords: Number($('memory').value), files: Object.fromEntries([...files].filter(([, file]) => !file.result).map(([name, file]) => [name, file.data])) };
  validateJob(job);
  setBusy(true);
  try {
  await save(); started = performance.now();
  log(`\n\x1b[32m› dalton ${dal} ${mol}\x1b[0m\n`);
  $('status').textContent = 'Starting…'; $('result-summary').textContent = 'Calculation in progress';
  clockTimer = setInterval(() => { if (busy) $('status').textContent = `Running · ${((performance.now() - started) / 1000).toFixed(1)} s`; }, 250);
  worker = new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module' });
  worker.onmessage = async ({ data }) => {
    if (data.type === 'output') log(data.text, data.source === 'stderr');
    else if (data.type === 'status') $('status').textContent = data.text;
    else if (data.type === 'error') {
      log(`\n${data.text}\n`, true); $('status').textContent = 'Failed'; $('result-summary').textContent = 'See terminal for details'; finish();
    } else if (data.type === 'done') {
      const r = data.result;
      // Keep each run's results under unique names, preserving earlier runs.
      const stem = dal.replace(/\.dal$/i, '');
      for (const file of r.outputs) {
        let name = file.name === 'DALTON.OUT' ? `${stem}.out` : `${stem}.${file.name}`;
        if (files.has(name)) {
          let n = 2; const base = name;
          while (files.has(name)) name = `${base}.${n++}`;
        }
        files.set(name, { data: file.data, result: true });
      }
      renderFiles(); scheduleSave();
      const seconds = (r.elapsedMs / 1000).toFixed(2);
      $('status').textContent = r.exitCode ? 'Failed' : `Completed · ${seconds} s`;
      $('result-summary').textContent = `${r.energy == null ? '' : `SCF E = ${r.energy.toFixed(10)} Eh · `}${(r.scratchBytes / 1024 ** 2).toFixed(1)} MB scratch`;
      log(`\n${r.exitCode ? 'Calculation failed' : 'Calculation completed'} · ${seconds} s · exit ${r.exitCode}\n`, Boolean(r.exitCode));
      if (r.failure) log(r.failure + '\n', true);
      if (r.omitted.length) log(`Large files omitted from export: ${r.omitted.map(f => f.name).join(', ')}\n`);
      finish();
    }
  };
  worker.onerror = event => { log(`\nWorker error: ${event.message}\n`, true); $('status').textContent = 'Failed'; $('result-summary').textContent = 'See terminal for worker error'; finish(); };
  worker.postMessage(job);
  } catch(error) {
    finish(); $('status').textContent = 'Failed'; $('result-summary').textContent = 'See terminal for details';
    throw error;
  }
}
function download(name, data) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(new Blob([data]));
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function command(text) {
  log(`\n\x1b[32mdalton › ${text}\x1b[0m\n`);
  const [cmd, ...args] = text.trim().match(/(?:[^\s"]+|"[^"]*")+/g)?.map(s => s.replace(/^"|"$/g, '')) ?? [];
  if (!cmd) return;
  if (cmd === 'help') log('help                    Show this help\nls                      List workspace files\nbasis                   List bundled basis sets\ncat FILE                Print a text file\nedit FILE               Open a file in the editor\ndalton INPUT MOLECULE    Run INPUT.dal with MOLECULE.mol\ndownload FILE           Save a file to your computer\ncancel                  Stop the running calculation\nclear                   Clear terminal output\n');
  else if (cmd === 'ls') log([...files].map(([name, file]) => `${String(file.data.length).padStart(9)}  ${name}`).join('\n') + '\n');
  else if (cmd === 'basis') {
    if (!manifest) throw new Error('Basis catalog is still loading.');
    const catalog = manifest.basisSets ?? manifest.basis.map(name => ({name}));
    log('Bundled basis sets:\n' + catalog.map(entry => `  ${entry.name}${entry.aliases?.length ? ` (also ${entry.aliases.join(', ')})` : ''}${entry.auxiliary ? ' — Huckel guess basis' : ''}`).join('\n') + '\n\nSet the second line of a BASIS-format .mol file to the desired name.\n');
  }
  else if (cmd === 'cat') {
    syncEditor(); const file = files.get(args[0]);
    if (!file) throw new Error('No such file');
    if (isBinary(file.data)) throw new Error('Use download for binary or large files.');
    log(dec.decode(file.data) + '\n');
  } else if (cmd === 'edit') openFile(args[0]);
  else if (cmd === 'download') { syncEditor(); if (!files.has(args[0])) throw new Error('No such file'); download(args[0], files.get(args[0]).data); }
  else if (cmd === 'dalton') await run(args[0] ? args[0].replace(/(?:\.dal)?$/i, '.dal') : undefined, args[1] ? args[1].replace(/(?:\.mol)?$/i, '.mol') : undefined);
  else if (cmd === 'cancel') cancel();
  else if (cmd === 'clear') term.clear();
  else throw new Error(`Unknown command: ${cmd}. Type help.`);
}
function cancel() { if (!worker) return; finish(); $('status').textContent = 'Cancelled'; $('result-summary').textContent = 'Inputs saved; incomplete scratch discarded'; log('\nCalculation cancelled. Inputs are saved.\n'); }
function catchError(fn) { return (...args) => Promise.resolve().then(() => fn(...args)).catch(error => log(`\n${error.message}\n`, true)); }
$('editor').addEventListener('input', () => { syncEditor(); lines(); scheduleSave(); });
$('editor').addEventListener('scroll', () => { $('line-numbers').scrollTop = $('editor').scrollTop; });
$('editor').addEventListener('keydown', event => { if (event.key === 'Tab') { event.preventDefault(); const editor = $('editor'); editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end'); editor.dispatchEvent(new Event('input')); } });
$('run').onclick = catchError(() => run()); $('cancel').onclick = cancel;
$('download').onclick = () => { syncEditor(); download(active, files.get(active).data); };
$('clear-terminal').onclick = () => term.clear();
$('basis-list').onclick = catchError(() => command('basis'));
$('upload').onclick = () => { $('upload-input').value = ''; $('upload-input').click(); };
$('upload-input').onchange = catchError(async () => {
  for (const file of $('upload-input').files) {
    if(file.name.endsWith('.json')) {
      let project;
      try { project=JSON.parse(await file.text()); } catch {}
      if(project?.format==='dalton-browser-v1') {
        if(!Array.isArray(project.files)) throw new Error('Invalid project file.');
        const imported=[]; let bytes=0;
        for(const entry of project.files) {
          const name=safeName(entry.name);
          if(imported.some(([n])=>n===name)) throw new Error(`Duplicate project entry: ${name}`);
          if(typeof entry.base64!=='string'||entry.base64.length>45*1024**2) throw new Error('Invalid or oversized project entry.');
          const data=Uint8Array.from(atob(entry.base64),c=>c.charCodeAt(0)); bytes+=data.length;
          if(bytes>128*1024**2) throw new Error('Project exceeds 128 MB.');
          if(files.has(name)) {
            const existing=files.get(name).data;
            if(existing.length===data.length&&existing.every((value,i)=>value===data[i])) continue;
            throw new Error(`${name} already exists with different contents. Rename the conflicting file before importing.`);
          }
          imported.push([name,{data,result:Boolean(entry.result)}]);
        }
        for(const [name,data] of imported) files.set(name,data);
        continue;
      }
    }
    safeName(file.name);
    if (files.has(file.name)) throw new Error(`${file.name} already exists. Rename the uploaded file first.`);
    if (file.size > 32 * 1024 ** 2) throw new Error('Upload files smaller than 32 MB.');
    files.set(file.name, { data: new Uint8Array(await file.arrayBuffer()), result: false });
  }
  renderFiles(); scheduleSave(); $('upload-input').value = '';
});
$('new-file').onclick = () => { $('file-name').value = ''; $('file-dialog').showModal(); };
$('file-dialog').addEventListener('close', catchError(() => {
  if ($('file-dialog').returnValue !== 'create') return;
  const name = safeName($('file-name').value.trim());
  if (files.has(name)) throw new Error(`${name} already exists.`);
  files.set(name, { data: enc.encode(''), result: false }); openFile(name);
}));
for (const button of document.querySelectorAll('[data-example]')) button.onclick = () => {
  const name = button.dataset.example === 'hf' ? 'hf.dal' : 'dft.dal';
  if (!files.has(name)) files.set(name, { data: enc.encode(name === 'hf.dal' ? hf : dft), result: false });
  if (!files.has('water.mol')) files.set('water.mol', { data: enc.encode(water), result: false });
  renderFiles(); $('dal-select').value = name; $('mol-select').value = 'water.mol'; openFile(name);
};
$('export-project').onclick = () => {
  syncEditor();
  const project = [...files].map(([name, file]) => {
    let binary = ''; for(let i=0;i<file.data.length;i+=32768) binary += String.fromCharCode(...file.data.subarray(i,i+32768));
    return { name, base64: btoa(binary), result: file.result };
  });
  download('dalton-project.json', JSON.stringify({ format: 'dalton-browser-v1', files: project }, null, 2));
};
$('reset').onclick = catchError(async () => { files = new Map([['hf.dal', { data: enc.encode(hf), result: false }], ['water.mol', { data: enc.encode(water), result: false }]]); active = ''; renderFiles(); openFile('hf.dal'); await save(); });
$('send-command').onclick = catchError(async () => { const text = $('command').value; $('command').value = ''; await command(text); });
$('command').addEventListener('keydown', event => { if (event.key === 'Enter') $('send-command').click(); });
term.onData(data => { $('command').focus(); if (data === '\r') $('send-command').click(); else if (data === '\x7f') $('command').value = $('command').value.slice(0, -1); else if (!/[\x00-\x1f]/.test(data)) $('command').value += data; });
for (const id of ['dal-select', 'mol-select', 'memory']) $(id).onchange = scheduleSave;
try {
  const db = await database;
  const session = await new Promise((resolve, reject) => { const r = db.transaction('sessions').objectStore('sessions').get('current'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  if (session?.files?.length) {
    files = new Map(session.files); active = ''; dalSelection = session.dal; molSelection = session.mol;
    if (session.memory) $('memory').value = session.memory;
    renderFiles(); openFile(files.has(session.active) ? session.active : files.keys().next().value);
  }
} catch { log('Browser storage unavailable. Download your inputs to save them.\n'); }
if (!files.size) { files.set('hf.dal', { data: enc.encode(hf), result: false }); files.set('water.mol', { data: enc.encode(water), result: false }); renderFiles(); openFile('hf.dal'); }
log('DALTON / molecular workspace\n\nChoose an example or upload .dal and .mol files.\nCalculations run locally; the tab must remain open.\nType help to explore terminal commands.\n');
try {
  const response = await fetch(new URL('./assets/manifest.json', import.meta.url));
  if (!response.ok) throw new Error('Missing WASM build');
  manifest = await response.json();
  $('build-info').textContent = `${manifest.preset} · ${manifest.revision.slice(0, 9)}`;
  const count = manifest.basisSets?.filter(entry => !entry.auxiliary).length ?? manifest.basis.length;
  $('basis-list').textContent = `${count} basis sets`;
  $('basis-list').disabled = false;
} catch { $('build-info').textContent = 'Build assets missing — see browser/README.md'; $('run').disabled = true; log('\nCompile Dalton to WASM before running calculations.\n', true); }
