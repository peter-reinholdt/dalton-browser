import { uid, toXYZ } from './molecules.mjs';
import { defaults, METHODS } from './calculations.mjs';
import {
  STUDY_TYPES,
  COURSE_PRESETS,
  courseMolecule,
  courseMeasurements,
  createStudy,
  geometryForStep,
  studyInput,
  constraintCoordinate,
  analyzeStudy,
  UNITS,
} from './studies.mjs';
import { coordinate, resultGeometry } from './geometry.mjs';
import { parseMolden, csv } from './results.mjs';
import { xyPlot } from './plots.mjs';
export function studyWorkspace(ctx) {
  const {
    $,
    p,
    escape: e,
    save,
    notice,
    moleculeChanged,
    setStage,
    runCalculation,
    cancel,
    lock,
    download,
    refreshViewer,
  } = ctx;
  let running = false,
    stopping = false,
    preview = null,
    coordinateCount = null,
    gridCount = null;
  const selected = () => p().studies.find((s) => s.id === p().activeStudy && s.kind === 'scan');
  const ids = () =>
    ['a', 'b', 'c', 'd']
      .map((k) => $('measure-' + k).value)
      .filter((v) => v !== '')
      .map((i) => p().molecule.atoms[Number(i)].id);
  const options = () => ({
    name: $('study-name').value.trim() || ($('scan-mode').value === 'both' ? 'Rigid and relaxed' : $('scan-mode').value === 'rigid' ? 'Rigid' : 'Relaxed') + ' ' + ({2:'distance',3:'angle',4:'dihedral'}[coordinateCount]) + ' scan',
    measurements: p()
      .measurements.filter((m) => m.moleculeId === p().molecule.id)
      .map((m) => ({ name: m.name, ids: m.ids })),
    sourceRunId: $('study-source').value || undefined,
    otherMolecule: p().structures.find((s) => s.id === $('study-other').value)?.molecule,
    coordinate: ids().slice(0, coordinateCount),
    bases: $('study-bases')
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    start: Number($('scan-start').value),
    end: Number($('scan-end').value),
    step: Number($('scan-step').value),
    relaxed: $('scan-mode').value !== 'rigid',
    scanMode: $('scan-mode').value,
    optimizeStart: $('scan-optimize-start').checked,
    conformerAngle: Number($('conformer-angle').value),
    ionMultiplicity: Number($('ion-multiplicity').value),
  });
  function syncSelection(requestedCount = null, infer = true) {
    const selectedIds = ids();
    const count = requestedCount ?? (infer && selectedIds.length >= 2 ? selectedIds.length : coordinateCount ?? 2);
    coordinateCount = count;
    $('scan-coordinate-type').value = String(count);
    for (const [i,key] of ['a','b','c','d'].entries()) {
      const select = $('scan-atom-'+key);
      const value = $('measure-'+key).value;
      select.replaceChildren(new Option('Choose atom',''), ...p().molecule.atoms.map((a,index)=>new Option(`${a.symbol}${index+1}`,String(index))));
      select.value = value;
      select.closest('label').hidden = i >= count;
    }
    const unit = count === 2 ? 'Å' : '°';
    $('scan-from-label').textContent = `From / ${unit}`;
    try {
      const selected = selectedIds.slice(0,count);
      if (selected.length !== count) throw new Error(`Select ${count} distinct atoms in order.`);
      const value = coordinate(p().molecule,selected);
      $('scan-coordinate-value').textContent = `Current ${count === 2 ? 'distance' : count === 3 ? 'angle' : 'dihedral'}: ${value.toFixed(4)} ${unit}.`;
      if (count !== gridCount) {
        gridCount = count;
        const center = count === 2 ? Math.max(0.21,Number(value.toFixed(2))) : Math.max(11,Math.min(169,Math.round(value)));
        $('scan-start').value = count === 4 ? '0' : (center-(count === 2 ? .1 : 10)).toFixed(count === 2 ? 2 : 0);
        $('scan-end').value = count === 4 ? '360' : (center+(count === 2 ? .1 : 10)).toFixed(count === 2 ? 2 : 0);
        $('scan-step').value = count === 2 ? '.05' : count === 3 ? '5' : '30';
      }
    } catch(error) { $('scan-coordinate-value').textContent = error.message; }
    const optimize = METHODS[p().calculation.method].tasks.includes('optimize');
    for (const option of $('scan-mode').options) option.disabled = option.value !== 'rigid' && !optimize;
    if (!optimize) { $('scan-mode').value='rigid';$('scan-optimize-start').checked=false; }
    $('scan-optimize-start').disabled = running || !optimize;
    $('scan-method-note').textContent = optimize ? 'Rigid: change only the selected coordinate. Relaxed: optimize the other coordinates while holding the selected one fixed.' : 'This method offers rigid scans. Choose SCF for guided constrained relaxation.';
  }
  $('scan-coordinate-type').onchange = () => {
    const count=Number($('scan-coordinate-type').value);
    for(const key of ['a','b','c','d'].slice(count)) $('measure-'+key).value='';
    ctx.updateMeasurement({scanType:count});
    ctx.renderCalculation();
  };
  for(const key of ['a','b','c','d']) $('scan-atom-'+key).onchange = () => {
    $('measure-'+key).value=$('scan-atom-'+key).value;
    ctx.updateMeasurement({scanType:coordinateCount});
  };
  $('scan-mode').onchange = () => ctx.renderCalculation();
  function add(study) {
    p().studies.push(study);
    p().activeStudy = study.id;
    save();
    $('study-kind').closest('details').open = false;
    setStage('studies');
    render();
    $('study-content').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  $('course-preset').replaceChildren(
    ...Object.entries(COURSE_PRESETS).map(([id, s]) => new Option(s.label, id)),
  );
  $('study-kind').replaceChildren(
    new Option('Coordinate scan', 'scan'),
  );
  function studyFields() {
    const kind = $('study-kind').value;
    for (const [id, visible] of [
      ['study-bases', kind === 'basis'],
      ['study-other', ['conformers', 'solvent'].includes(kind)],
      ['scan-start', kind === 'scan'],
      ['scan-end', kind === 'scan'],
      ['scan-step', kind === 'scan'],
      ['conformer-angle', kind === 'conformers'],
      ['ion-multiplicity', ['ionization', 'affinity'].includes(kind)],
      ['scan-relaxed', kind === 'scan'],
    ])
      $(id).closest('label').hidden = !visible;
    $('ion-multiplicity').value = kind === 'affinity' ? '1' : '2';
  }
  $('study-kind').onchange = studyFields;
  studyFields();
  $('create-course').onclick = ctx.guard(() => {
    if (running) throw new Error('Finish or pause the current study first.');
    const preset = COURSE_PRESETS[$('course-preset').value],
      mol = courseMolecule(preset.molecule),
      settings = { ...defaults(), ...preset.settings };
    p().calculation = settings;
    moleculeChanged(mol);
    add(
      createStudy(preset.kind, mol, settings, {
        name: preset.label,
        coordinate: preset.coordinate,
        otherMolecule: preset.other ? courseMolecule(preset.other) : undefined,
        preset: $('course-preset').value,
        orbitalRange: preset.range,
        measurements: courseMeasurements(preset.molecule),
      }),
    );
  });
  async function start() {
    if (running) throw new Error('Finish or pause the current study first.');
    if (p().calculation.mode === 'expert') throw new Error('Change a calculation setting to regenerate input before starting a scan.');
    const opts = options();
    if (opts.coordinate.length !== coordinateCount) throw new Error(`Select ${coordinateCount} distinct atoms for this coordinate scan.`);
    let mol = p().molecule;
    if (opts.sourceRunId) {
      const source = p().runs.find((r) => r.id === opts.sourceRunId),
        file = source.artifacts.find((a) => a.name === 'molden.inp');
      mol = resultGeometry(source, parseMolden(new TextDecoder().decode(file.data)));
      opts.measurements = p()
        .measurements.filter((m) => m.moleculeId === mol.id)
        .map((m) => ({ name: m.name, ids: m.ids }));
    }
    const study = createStudy('scan', mol, p().calculation, opts);
    add(study);
    await run(study);
  }
  $('create-study').onclick = ctx.guard(start);
  $('study-select').onchange = () => {
    p().activeStudy = $('study-select').value;
    save();
    render();
  };
  $('save-measurement').onclick = ctx.guard(() => {
    const selectedIds = ids();
    coordinate(p().molecule, selectedIds);
    const name =
      selectedIds
        .map(
          (id) =>
            p().molecule.atoms.find((a) => a.id === id).symbol +
            (p().molecule.atoms.findIndex((a) => a.id === id) + 1),
        )
        .join('–');
    p().measurements.push({ id: uid(), moleculeId: p().molecule.id, name, ids: selectedIds });
    save();
    renderStructures();
  });
  $('saved-measurements').onclick = ctx.guard((ev) => {
    const button = ev.target.closest('[data-measurement]');
    if (!button) return;
    const m = p().measurements.find((m) => m.id === button.dataset.measurement);
    ['a', 'b', 'c', 'd'].forEach((k, i) => {
      const index = p().molecule.atoms.findIndex((a) => a.id === m.ids[i]);
      $('measure-' + k).value = index < 0 ? '' : String(index);
    });
    ctx.updateMeasurement();
  });
  $('save-structure').onclick = ctx.guard(() => {
    const name = $('structure-name').value.trim() || p().molecule.name;
    p().structures.push({ id: uid(), name, molecule: structuredClone(p().molecule) });
    save();
    renderStructures();
    notice('Saved structure: ' + name);
  });
  $('saved-structures').onclick = ctx.guard((ev) => {
    const b = ev.target.closest('[data-structure]');
    if (!b) return;
    if (running) throw new Error('Pause the study before editing structures.');
    moleculeChanged(
      structuredClone(p().structures.find((s) => s.id === b.dataset.structure).molecule),
    );
  });
  $('preview-coordinate').onclick = ctx.guard(async () => {
    if (running) throw new Error('Pause the study before editing geometry.');
    const { editCoordinate } = await import('./geometry.mjs');
    preview = editCoordinate(p().molecule, ids(), Number($('coordinate-target').value));
    await ctx.showGeometry(preview);
    $('apply-coordinate').disabled = false;
    $('cancel-coordinate').disabled = false;
    notice('Preview only. Apply to keep this geometry.');
  });
  function clearPreview() {
    preview = null;
    $('apply-coordinate').disabled = true;
    $('cancel-coordinate').disabled = true;
  }
  $('apply-coordinate').onclick = ctx.guard(() => {
    if (preview) moleculeChanged(preview);
    clearPreview();
  });
  $('cancel-coordinate').onclick = ctx.guard(async () => {
    clearPreview();
    await refreshViewer();
    notice('');
  });
  function renderStructures() {
    $('saved-measurements').innerHTML = p()
      .measurements.filter((m) => m.moleculeId === p().molecule.id)
      .map((m) => `<button class="text-button" data-measurement="${e(m.id)}">${e(m.name)}</button>`)
      .join('');
    $('saved-structures').innerHTML = p()
      .structures.map(
        (s) => `<button class="text-button" data-structure="${e(s.id)}">${e(s.name)}</button>`,
      )
      .join('');
  }
  function render() {
    renderStructures();
    const scans = p().studies.filter(s => s.kind === 'scan');
    if (!selected()) p().activeStudy = scans.at(-1)?.id ?? null;
    const current = $('study-select').value;
    $('study-select').replaceChildren(
      ...scans.map((s) => new Option(`${s.name} · ${s.status}`, s.id)),
    );
    $('study-select').value = p().activeStudy ?? current;
    const other = $('study-other').value,
      source = $('study-source').value;
    $('study-other').replaceChildren(
      new Option('Use torsion rotation / choose structure', ''),
      ...p().structures.map((s) => new Option(s.name, s.id)),
    );
    $('study-other').value = other;
    $('study-source').replaceChildren(
      new Option('Current molecule', ''),
      ...p()
        .runs.filter(
          (r) => r.status === 'completed' && r.artifacts.some((a) => a.name === 'molden.inp'),
        )
        .map((r) => new Option(r.name, r.id)),
    );
    $('study-source').value = source;
    $('study-select').disabled = running;
    $('course-preset').disabled = running;
    const study = selected(),
      el = $('study-content');
    if (!study) {
      el.innerHTML = '<p class="hint">Configure a coordinate scan above to compare its energies and sampled barrier.</p>';
      return;
    }
    const analysis = analyzeStudy(study, p().runs);
    const setup = study.steps[0]?.settings ?? {};
    el.innerHTML = `<h2>${e(study.name)}</h2><p class="hint">${e(setup.method === 'DFT' ? setup.functional : setup.method)} / ${e(setup.basis)}${setup.dispersion !== 'none' ? ' · ' + e(setup.dispersion) : ''} · ${e(study.molecule.name)}</p><p class="intro">${e(study.status)} · ${study.steps.filter((s) => s.status === 'completed').length} / ${study.steps.filter((s) => !s.optional || s.enabled).length} calculations complete</p><div class="row wrap"><button id="study-run" class="primary" ${running ? 'disabled' : ''}>${study.status === 'ready' ? 'Run scan' : 'Resume / retry unfinished'}</button><button id="study-stop" class="outline" ${!running ? 'disabled' : ''}>Pause scan</button><button id="study-csv" class="outline">Download scan CSV</button></div>${study.failure ? `<p class="error">${e(study.failure)}</p>` : ''}<div class="table-scroll"><table><thead><tr><th>Calculation</th><th>Status</th><th>Energy / Eh</th><th>Dipole / D</th><th></th></tr></thead><tbody>${study.steps
      .map((s) => {
        const r = p().runs.find((r) => r.id === s.runId);
        return `<tr><td>${s.optional ? `<label class="check"><input data-optional="${e(s.id)}" type="checkbox" ${s.enabled ? 'checked' : ''} ${running ? 'disabled' : ''}>${e(s.name)}</label>` : e(s.name)}</td><td>${e(s.status)}</td><td>${r?.status === 'completed' ? (r.results?.energy?.toFixed(10) ?? '—') : '—'}</td><td>${r?.status === 'completed' ? (r.results?.dipoleDebye?.toFixed(4) ?? '—') : '—'}</td><td>${r ? `<button class="text-button" data-study-run="${e(r.id)}">Inspect</button>` : ''}</td></tr>`;
      })
      .join(
        '',
      )}</tbody></table></div><p class="hint">Resume retains completed calculations and restarts an unconverged optimization from its last geometry.</p><label class="field">MPI processes for unfinished calculations<select id="study-processes" ${running ? 'disabled' : ''}>${Array.from($('processes').options).map(option => `<option value="${option.value}" ${Number(option.value) === Number(study.processes ?? $('processes').value) ? 'selected' : ''} ${option.disabled ? 'disabled' : ''}>${e(option.textContent)}</option>`).join('')}</select><small>Completed calculations retain their recorded process counts. Work memory is per process.</small></label><h2>Calculated comparisons</h2>${analysis.values.length ? `<table><thead><tr><th>Quantity</th><th>Value</th></tr></thead><tbody>${analysis.values.map((v) => `<tr><td>${e(v.name)}<details><summary>Formula & source calculations</summary><p>${e(v.formula)}</p>${v.sources.map((id) => `<button class="text-button" data-study-run="${e(id)}">${e(p().runs.find((r) => r.id === id)?.name ?? id)}</button>`).join('')}</details></td><td>${v.value.toFixed(4)} ${e(v.unit)}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">Comparisons appear automatically when their source calculations finish.</p>'}${study.kind === 'spin' ? '<p class="warning">The closed-shell O₂ singlet is an approximation, not a spin-adapted treatment of the experimental singlet terms.</p>' : ''}${study.kind === 'ionization' ? '<p class="hint">Adiabatic values are electronic energies, without zero-point or thermal corrections. The HOMO estimate is approximate, particularly for DFT.</p>' : ''}${study.kind === 'uvvis' ? '<p class="hint">Optional excited-state optimization uses numerical gradients and may take much longer. State tracking compares sampled transition-density character; it pauses if continuity is uncertain.</p>' : ''}<div id="study-scan"></div><label class="field">Notes<textarea id="study-notes" rows="4"></textarea></label>`;
    if (study.kind === 'uvvis') {
      const step = study.steps.find((s) => s.id === 'excited');
      const vertical = p().runs.find(
        (r) => r.id === study.steps.find((s) => s.id === 'excitation')?.runId,
      );
      if (vertical?.elapsedMs)
        $('study-content')
          .querySelector('.table-scroll')
          .insertAdjacentHTML(
            'beforebegin',
            `<p class="hint">Excited-state optimization needs about ${6 * study.molecule.atoms.length} response evaluations per gradient. A rough estimate from your vertical run is ${((vertical.elapsedMs * 6 * study.molecule.atoms.length) / 60000).toFixed(1)} minutes per gradient; actual time varies. Several gradients are needed.</p>`,
          );
      $('study-content')
        .querySelector('.table-scroll')
        .insertAdjacentHTML(
          'beforebegin',
          `<label class="field">Target excited state<select id="study-target-state" ${running || step.status === 'completed' ? 'disabled' : ''}>${Array.from({ length: step.settings.excitedStates }, (_, i) => `<option value="${i + 1}">S${i + 1}</option>`).join('')}</select></label>`,
        );
      $('study-target-state').value = step.settings.targetState;
      $('study-target-state').onchange = () => {
        step.settings.targetState = Number($('study-target-state').value);
        delete step.resumeRunId;
        save();
        render();
      };
    }
    if (analysis.geometries.length) {
      $('study-scan').insertAdjacentHTML(
        'beforebegin',
        `<h2>Geometry comparison</h2><div class="table-scroll"><table><thead><tr><th>Calculation</th>${study.measurements.map((m) => `<th>${e(m.name)} / ${m.ids.length === 2 ? 'Å' : '°'}</th>`).join('')}</tr></thead><tbody>${analysis.geometries.map((g) => `<tr><td><button class="text-button" data-study-run="${e(g.runId)}">${e(g.name)}</button></td>${g.values.map((v) => `<td>${v.value.toFixed(4)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`,
      );
    }
    $('study-notes').value = study.notes;
    $('study-notes').oninput = () => {
      study.notes = $('study-notes').value;
      save();
    };
    if (analysis.scan.length) {
      const zero = analysis.scan[0].points.find((p) => p.energy != null)?.energy;
      const curves = analysis.scan.map((s) => ({
        name: s.mode,
        points: s.points.map((p) => ({
          x: p.angle,
          y: p.energy == null ? null : (p.energy - zero) * UNITS.hartreeToKJMol,
        })),
      }));
      $('study-scan').innerHTML =
        `<h2>Coordinate scan</h2>${xyPlot(curves, 'Relative electronic energy', { xLabel: study.options.coordinate.length === 2 ? 'Distance / Å' : study.options.coordinate.length === 3 ? 'Angle / °' : 'Dihedral / °', yLabel: 'kJ/mol' })}<p class="hint">Common zero: first successful ${analysis.scan[0].mode} point. Failed or missing points leave gaps. Barriers require a complete scan and refer to the sampled grid.</p><table><thead><tr><th>Coordinate / ${study.options.coordinate.length === 2 ? 'Å' : '°'}</th><th>Mode</th><th>ΔE / kJ mol⁻¹</th><th>Achieved</th></tr></thead><tbody>${analysis.scan.flatMap((s) => s.points.map((p) => `<tr><td>${p.angle}</td><td>${s.mode}</td><td>${p.energy == null ? '—' : ((p.energy - zero) * UNITS.hartreeToKJMol).toFixed(3)}</td><td>${p.actual?.toFixed(3) ?? '—'}</td></tr>`)).join('')}</tbody></table>`;
    }
    $('study-processes').onchange = event => { study.processes = Number(event.target.value); save(); };
    $('study-run').onclick = ctx.guard(() => run(study));
    $('study-stop').onclick = () => {
      stopping = true;
      cancel();
    };
    $('study-csv').onclick = () =>
      download(
        'study.csv',
        csv([
          ['Calculation', 'Status', 'Energy / Eh', 'Dipole / Debye', 'Coordinate', 'Mode'],
          ...study.steps.map((s) => {
            const r = p().runs.find((r) => r.id === s.runId);
            return [
              s.name,
              s.status,
              r?.status === 'completed' ? r.results?.energy : null,
              r?.status === 'completed' ? r.results?.dipoleDebye : null,
              s.scanValue,
              s.scanMode,
            ];
          }),
          [],
          ['Derived quantity', 'Value', 'Unit', 'Formula', 'Source run IDs'],
          ...analysis.values.map((v) => [v.name, v.value, v.unit, v.formula, v.sources.join(';')]),
          [],
          ['Geometry quantity', 'Calculation', 'Value', 'Unit', 'Source run ID'],
          ...analysis.geometries.flatMap((g) =>
            g.values.map((v) => [v.name, g.name, v.value, v.unit, g.runId]),
          ),
        ]),
        'text/csv',
      );
  }
  $('study-content').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-study-run]');
    if (b) {
      p().activeRun = b.dataset.studyRun;
      setStage('results');
      save();
    }
  });
  $('study-content').addEventListener('change', (ev) => {
    const id = ev.target.dataset.optional;
    if (id) {
      selected().steps.find((s) => s.id === id).enabled = ev.target.checked;
      save();
    }
  });
  async function run(study) {
    if (running) throw new Error('A study is already running.');
    running = true;
    stopping = false;
    lock(true);
    study.processes ??= Number($('processes').value || 1);
    study.status = 'running';
    study.failure = null;
    render();
    await save();
    try {
      for (const step of study.steps) {
        if (stopping) break;
        if (step.status === 'completed' || (step.optional && !step.enabled)) continue;
        step.status = 'running';
        render();
        await save();
        try {
          const mol = geometryForStep(study, step, p().runs);
          step.attempts ??= [];
          let input;
          if (step.constraint) {
            const pre = await runCalculation('coordinate', {
              molecule: mol,
              settings: step.settings,
              input: studyInput(study, step, mol),
              name: step.name + ' · coordinate identification',
              studyId: study.id,
              processes: study.processes,
              stepId: step.id,
            });
            if (stopping) break;
            if (!pre || pre.status !== 'completed')
              throw new Error(pre?.failure ?? 'Coordinate identification failed.');
            step.preflightRunId = pre.id;
            const text = new TextDecoder().decode(
                pre.artifacts.find((a) => a.name === 'DALTON.OUT').data,
              ),
              index = constraintCoordinate(text, pre.input.atomOrder, step.constraint);
            step.constraintIndex = index;
            input = studyInput(study, step, mol, index);
          }
          const r = await runCalculation('study', {
            molecule: mol,
            settings: step.settings,
            input,
            name: study.name + ' · ' + step.name,
            studyId: study.id,
              processes: study.processes,
            stepId: step.id,
          });
          if (r) {
            step.runId = r.id;
            step.attempts.push(r.id);
          }
          if (stopping) break;
          if (r?.status === 'unconverged') step.resumeRunId = r.id;
          if (!r || r.status !== 'completed')
            throw new Error(r?.failure ?? 'Calculation did not complete.');
          if (step.transform) {
            const a = r.artifacts.find((a) => a.name === 'molden.inp');
            if (!a) throw new Error('No result geometry available to verify the scan coordinate.');
            step.actualCoordinate = coordinate(
              resultGeometry(r, parseMolden(new TextDecoder().decode(a.data))),
              step.transform.ids,
            );
            const d =
              step.transform.ids.length === 4
                ? Math.abs(((step.actualCoordinate - step.transform.value + 540) % 360) - 180)
                : Math.abs(step.actualCoordinate - step.transform.value);
            if (step.constraint && d > (step.transform.ids.length === 2 ? 0.005 : 0.5))
              throw new Error(
                'Relaxed scan coordinate drifted from its constraint. Inspect the run before retrying.',
              );
          }
          step.status = 'completed';
          delete step.resumeRunId;
          render();
          await save();
        } catch (error) {
          step.status = 'failed';
          step.failure = error.message;
          study.failure = step.name + ': ' + error.message;
          throw error;
        }
      }
      study.status = stopping ? 'paused' : 'completed';
      if (stopping) {
        const step = study.steps.find((s) => s.status === 'running');
        if (step) step.status = 'interrupted';
      }
    } catch (error) {
      study.status = 'failed';
      notice(error.message, true);
    } finally {
      running = false;
      lock(false);
      render();
      await save();
      if (study.status === 'completed') $('study-content').scrollIntoView({block:'start',behavior:'smooth'});
    }
  }
  return {
    start,
    syncSelection,
    render,
    isRunning: () => running,
    stop: () => {
      stopping = true;
    },
    clearPreview,
  };
}
