import { JSMOL_BASE } from './viewer-config.mjs';
import { dipoleDisplay } from './dipole.mjs';
const NativeError = window.Error;
const send = (data) => parent.postMessage({ channel: 'dalton-viewer', ...data }, location.origin);
let applet;
window.daltonPick = (_app, _description, index) => {
  const atomIndex=Number(index);
  if (Number.isInteger(atomIndex) && atomIndex >= 0) send({type:'pick',index:atomIndex});
};
try {
  await new Promise((resolve,reject) => {
    const tag=document.createElement('script');
    tag.src=new URL('JSmol.min.js',JSMOL_BASE).href;
    tag.crossOrigin='anonymous';tag.onload=resolve;
    tag.onerror=()=>reject(new NativeError('Could not load JSmol. Check the viewer asset host and its CORS headers.'));
    document.head.append(tag);
  });
  Jmol.setDocument(0);
  document.getElementById('applet').innerHTML = Jmol.getAppletHtml('daltonViewer', {
    width: '100%',
    height: '100%',
    use: 'HTML5',
    j2sPath: new URL('j2s', JSMOL_BASE).href,
    serverURL: '',
    disableJ2SLoadMonitor: true,
    disableInitialConsole: true,
    // JSmol requires this for host pickCallback dispatch. File scripts stay off.
    allowJavaScript: true,
    allowEmbeddedScripts: false,
    readyFunction: () => {
      document.getElementById('message').hidden = true;
      send({ type: 'ready' });
    },
    pickCallback: 'daltonPick',
    script:
      // Rapid clicks on different atoms must keep picking, rather than start
      // JSmol's built-in double-click measurement mode.
      'set frank off;set antialiasDisplay true;set allowEmbeddedScripts false;set disablePopupMenu true;set picking identify;unbind "LEFT-DOUBLE";bind "LEFT-DOUBLE" "_pickAtom";background [245,248,241];',
  });
  applet = window.daltonViewer;
  new ResizeObserver(() => {
    if (innerWidth) Jmol.resizeApplet(applet, [innerWidth, innerHeight]);
  }).observe(document.body);
} catch (e) {
  send({ type: 'error', error: e?.message ?? String(e) });
}
const script = (text) => {
  const result = Jmol.scriptWait(applet, text);
  if (/script ERROR:/i.test(result)) throw new NativeError(result);
  return result;
};
function load(text, preserve = false) {
  const orientation = preserve ? Jmol.getPropertyAsArray(applet, 'orientationInfo') : null;
  script('set defaultLoadFilter "NOSORT";');
  const error = applet._applet.loadInlineString(text, '', false);
  if (error) throw new NativeError(String(error));
  script(
    `set frank off;select all;spacefill 23%;wireframe 0.12;background [245,248,241];${preserve ? '' : 'reset;rotate x 30;rotate y 30;zoom 70;'}`,
  );
  if (preserve && orientation?.moveTo) script(orientation.moveTo);
}
window.addEventListener('message', (event) => {
  if (
    event.source !== parent ||
    event.origin !== location.origin ||
    event.data?.channel !== 'dalton-viewer'
  )
    return;
  const data = event.data;
  let result;
  try {
    switch (data.action) {
      case 'structure':
        load(data.text, data.preserve);
        break;
      case 'orbitals':
        load(data.text);
        break;
      case 'dipole': {
        script('draw ID "daltonDipole" delete;');
        if (data.vector) {
          const display = dipoleDisplay(data.vector, data.origin);
          if (display.visible) {
            script(
              `draw ID "daltonDipole" arrow {${data.origin.join(' ')}} {${display.tip.join(' ')}} color [150,60,95] width 0.12;`,
            );
          }
        }
        break;
      }
      case 'representation':
        script(
          `select all;${data.space ? 'spacefill 100%;wireframe off;' : 'spacefill 23%;wireframe 0.12;'}${data.labels ? 'label %e%i;set labelOffset 6 6;color labels [35,49,61];font labels 14 SansSerif Bold;' : 'label off;'}`,
        );
        break;
      case 'orbital':
      case 'cube':
        if (
          !Number.isInteger(data.index) ||
          data.index < 1 ||
          !Number.isFinite(data.cutoff) ||
          data.cutoff < 0.005 ||
          data.cutoff > 0.2 ||
          !Number.isFinite(data.opacity) ||
          data.opacity < 0.1 ||
          data.opacity > 1
        )
          throw new NativeError('Invalid orbital controls.');
        if (data.action === 'cube') {
          if (
            typeof data.text !== 'string' ||
            data.text.length > 64 * 1024 ** 2 ||
            !data.text.startsWith('Dalton orbital ')
          )
            throw new NativeError('Invalid orbital cube.');
          script(
            `mo delete;isosurface delete;isosurface ID "daltonMO" cutoff ${data.cutoff} sign color [210,48,48] [45,87,200] inline ${JSON.stringify(data.text)};isosurface fill nomesh translucent ${1 - data.opacity};${data.first ? 'zoom 55;' : ''}`,
          );
          break;
        }
        script(
          `mo delete;mo resolution 5;mo cutoff ${data.cutoff};mo color [210,48,48] [45,87,200];mo titleformat " ";mo ${data.index};mo fill;mo nomesh;mo translucent ${1 - data.opacity};`,
        );
        break;
      case 'hideOrbital':
        script('mo delete;isosurface delete;');
        break;
      case 'reset':
        script('reset;rotate x 30;rotate y 30;zoom 70;');
        break;
      case 'stop':
        script('vibration off;');
        break;
      case 'png': {
        script('refresh;');
        const canvas = applet._canvas ?? document.querySelector('#applet canvas');
        if (!canvas) throw new NativeError('Could not export an image.');
        result = canvas.toDataURL('image/png');
        break;
      }
      default:
        throw new NativeError('Unknown viewer action.');
    }
    send({ id: data.id, result });
  } catch (e) {
    console.error('Viewer action failed', data.action, e?.stack ?? e);
    send({ id: data.id, error: e?.message ?? String(e) });
  }
});
