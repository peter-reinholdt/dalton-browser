// Built-in Dalton functionals; no LibXC or external service is required.
export const FUNCTIONALS = [
  ['LDA','LDA · SVWN5','Local density'],['SVWN3','SVWN3','Local density'],
  ...['PBE','revPBE','RPBE','PW91','BLYP','BP86','BPW91','OLYP','KT1','KT2','KT3'].map(n=>[n,n,'GGA']),
  ...['B3LYP','PBE0','B3PW91','B3P86','B1LYP','B1PW91','BHandH','BHandHLYP','mPW1PW91','X3LYP'].map(n=>[n,n,'Hybrid']),
  ['CAM-B3LYP','CAM-B3LYP','Range-separated'],
];
export const PROPERTY_TASKS = {
  nmrShielding: {label:'NMR shieldings', module:'properties', keyword:'.SHIELD', heading:'NMR shielding', unit:'ppm'},
  spinSpin: {label:'NMR spin–spin couplings', module:'properties', keyword:'.SPIN-SPIN', heading:'Spin–spin coupling', unit:'Hz'},
  magnetizability: {label:'Magnetizability', module:'properties', keyword:'.MAGNET', heading:'Magnetizability'},
  quadrupole: {label:'Electric quadrupole moment', module:'properties', keyword:'.QUADRU', heading:'Quadrupole moment'},
  opticalRotation: {label:'Optical rotation', module:'properties', keyword:'.OPTROT', heading:'Optical rotation'},
  hyperpolarizability: {label:'First hyperpolarizability · β', module:'response', heading:'First hyperpolarizability'},
  secondHyperpolarizability: {label:'Second hyperpolarizability · γ', module:'response', heading:'Second hyperpolarizability'},
  twoPhoton: {label:'Two-photon absorption', module:'response', heading:'Two-photon absorption'},
};
export function propertyInput(task, settings) {
  const p=PROPERTY_TASKS[task];
  if(!p)return '';
  const frequency=Number(settings.responseFrequency??0).toPrecision(12);
  if(p.module==='properties')return '**PROPERTIES\n'+p.keyword+'\n'+

    (task==='opticalRotation'?'*ABALNR\n.FREQUENCIES\n1\n'+frequency+'\n':'');
  if(task==='twoPhoton')return '**RESPONSE\n*QUADRATIC\n.SINGLE RESIDUE\n.TWO-PHOTON\n.ROOTS\n'+settings.excitedStates+'\n';
  return '**RESPONSE\n'+(task==='hyperpolarizability'?'*QUADRATIC':'*CUBIC')+'\n.DIPLEN\n.FREQUENCIES\n1\n'+frequency+'\n';
}

const numeric='([-+]?\\d*\\.?\\d+(?:[dDeE][-+]?\\d+)?)';
const value=s=>Number(s.replace(/[dD]/g,'e'));
export function parsePropertyResults(text, task) {
  const spec=PROPERTY_TASKS[task];if(!spec)return null;
  const result={task,label:spec.label,rows:[],tensor:null};
  const matrix=block=>[...block.matchAll(new RegExp(`^\\s*(?:[A-Za-z][\\w-]*\\s+)?(?:[xyz]|B[xyz]|E[xyz])\\s+${numeric}\\s+${numeric}\\s+${numeric}\\s*$`,'gm'))].slice(0,3).map(m=>m.slice(1).map(value));
  if(task==='nmrShielding') {
    const blocks=[...text.matchAll(/Chemical shielding for\s+(\S+)\s*:([\s\S]*?)(?=Chemical shielding for|Total CPU|$)/g)];
    for(const m of blocks){const n=m[2].match(new RegExp(`Shielding constant:\\s*${numeric}`));if(n)result.rows.push({atom:m[1],isotropic:value(n[1]),tensor:matrix(m[2].split('Total shielding tensor (ppm):')[1]?.slice(0,600)??'')});}
    result.columns=[['atom','Atom'],['isotropic','Isotropic shielding / ppm']];
  } else if(task==='spinSpin') {
    for(const m of text.matchAll(/Indirect spin-spin coupling between\s+(\S+)\s+and\s+(\S+)\s*:([\s\S]*?)(?=Indirect spin-spin|Total CPU|$)/g)){
      const n=m[3].match(new RegExp(`Isotropic coupling\\s*:\\s*${numeric}`));if(!n)continue;
      const row={atoms:m[1]+'–'+m[2],isotropic:value(n[1])};
      for(const key of ['DSO','PSO','SD','FC']){const v=m[3].match(new RegExp(`Isotropic ${key} contribution\\s*:\\s*${numeric}`));row[key]=v?value(v[1]):null;}
      result.rows.push(row);
    }
    result.columns=[['atoms','Pair'],['isotropic','J / Hz'],['DSO','DSO / Hz'],['PSO','PSO / Hz'],['SD','SD / Hz'],['FC','FC / Hz']];
  } else if(task==='twoPhoton') {
    for(const m of text.matchAll(new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+${numeric}\\s+(Linear|Circular)\\s+${numeric}\\s+${numeric}\\s+${numeric}\\s+${numeric}\\s+${numeric}\\s*$`,'gm')))
      result.rows.push({symmetry:Number(m[1]),state:Number(m[2]),energy:value(m[3]),polarization:m[4],strength:value(m[7]),crossSection:value(m[8])});
    result.columns=[['state','State'],['energy','Excitation / eV'],['polarization','Polarization'],['strength','Strength / a.u.'],['crossSection','Cross section / GM']];
    result.note='Equal photon frequencies; Dalton’s cross sections assume a 0.1 eV FWHM. 1 GM = 10⁻⁵⁰ cm⁴ s photon⁻¹.';
  } else if(['hyperpolarizability','secondHyperpolarizability'].includes(task)) {
    const name=task==='hyperpolarizability'?'beta':'gamma';
    for(const m of text.matchAll(new RegExp(`${name}\\(([^)]+)\\)\\s*(?:=\\s*)?${numeric}(?=\\s|$)`,'g')))result.rows.push({component:m[1],value:value(m[2])});
    result.columns=[['component','Component'],['value',name==='beta'?'β / a.u.':'γ / a.u.']];
    result.note='Dalton’s tensor convention; frequency and permutation conventions are recorded in the input and full output.';
  } else if(task==='magnetizability') {
    const n=text.match(new RegExp(`Isotropic magnetizability:\\s*${numeric}`));if(n)result.rows.push({observable:'Isotropic magnetizability',value:value(n[1])});
    result.tensor=matrix(text.split('Total magnetizability tensor (au)')[1]?.slice(0,700)??'');
    result.columns=[['observable','Observable'],['value','a.u.']];
  } else if(task==='quadrupole') {
    result.tensor=matrix(text.split('Total quadrupole moments (au)')[1]?.slice(0,600)??'');
    result.note='Total electric quadrupole moment, including electronic and nuclear contributions, in Dalton’s traceless tensor convention / a.u.';
  } else if(task==='opticalRotation') {
    for(const m of text.matchAll(new RegExp(`Optical rotation \\((London|No-London)\\)\\s*:\\s*${numeric}`,'g')))result.rows.push({gauge:m[1],value:value(m[2])});
    result.columns=[['gauge','Gauge'],['value','degrees / (dm g cm⁻³)']];
  }
  return result;
}
export function propertyResultHTML(result,escape) {
  if(!result)return '';
  const format=v=>typeof v==='number'?(Math.abs(v)>0&&Math.abs(v)<1e-3?v.toExponential(6):Number(v.toPrecision(9)).toString()):escape(v??'—');
  const rows=result.rows.length?`<div class="table-scroll"><table><thead><tr>${result.columns.map(([,label])=>`<th>${escape(label)}</th>`).join('')}</tr></thead><tbody>${result.rows.map(row=>`<tr>${result.columns.map(([key])=>`<td>${format(row[key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`:'';
  const tensor=result.tensor?.length===3?`<table><thead><tr><th></th><th>x</th><th>y</th><th>z</th></tr></thead><tbody>${result.tensor.map((r,i)=>`<tr><th>${'xyz'[i]}</th>${r.map(v=>`<td>${format(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`:'';
  const nuclearTensors=result.task==='nmrShielding' ? `<details><summary>Shielding tensors / ppm</summary>${result.rows.filter(r=>r.tensor.length===3).map(r=>`<h3>${escape(r.atom)}</h3><table>${r.tensor.map((row,i)=>`<tr><th>${'xyz'[i]}</th>${row.map(v=>`<td>${format(v)}</td>`).join('')}</tr>`).join('')}</table>`).join('')}</details>` : '';
  return `<section class="property-results"><h2>${escape(result.label)}</h2>${rows}${tensor}${nuclearTensors}${rows||tensor?'<button id="property-csv" class="text-button">Download property results (CSV)</button>':''}${result.note?`<p class="hint">${escape(result.note)}</p>`:''}${!rows&&!tensor?'<p class="hint">Inspect the complete Dalton output above for this property.</p>':''}</section>`;
}
