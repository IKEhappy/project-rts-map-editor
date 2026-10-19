import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apiCall, click, createWorkspaceFixture, evaluate, launchEditor, reload, waitFor } from './workspace-smoke.mjs';

const root = process.cwd(), project = path.resolve(root, '../project-rts');
const label = process.argv[2] || 'baseline';
const artifacts = path.join(root, '.smoke-artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const fixture = createWorkspaceFixture({ parent: path.join(os.tmpdir(), 'map-perf'), project });
const source = JSON.parse(fs.readFileSync(path.join(project, 'data/maps/stateofwar_m22.json'), 'utf8'));
const image = source.background?.topdown;
if (image) {
  const destination = path.join(fixture.project, image.slice(6));
  fs.mkdirSync(path.dirname(destination), {recursive:true});
  fs.copyFileSync(path.join(project, image.slice(6)), destination);
}
fs.writeFileSync(path.join(fixture.maps, 'performance.json'), JSON.stringify(source));
const editor = await launchEditor({ executable:path.join(root,'node_modules/electron/dist/electron.exe'),
  args:[root, `--user-data-dir=${path.join(fixture.root,'profile')}`, '--force-device-scale-factor=1', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], cwd:root, port:9235 });
const { client } = editor;
const errors = [];
client.Runtime.exceptionThrown(({exceptionDetails}) => errors.push(exceptionDetails.exception?.description || exceptionDetails.text));
const pause = () => evaluate(client,'new Promise(r=>setTimeout(r,100))');
const timedClick = async (id) => { const t=Date.now(); await click(client,id); await evaluate(client,'new Promise(r=>setTimeout(r,0))'); return Date.now()-t; };
try {
  await waitFor(client,'!!window.meApi','API');
  const opened = await apiCall(client,'openWorkspace',{path:fixture.maps,projectRoot:fixture.project});
  if (!opened.ok) throw new Error(opened.error);
  await reload(client); await client.Page.bringToFront();
  await client.Emulation.setDeviceMetricsOverride({width:1920,height:1080,deviceScaleFactor:1,mobile:false});
  await click(client,'tab-maps'); await click(client,'map-item-performance-json');
  await waitFor(client,"document.querySelector('[data-testid=map-canvas] canvas')?.dataset.background === 'true'",'large image');
  await click(client,'map-tool-none'); await client.Page.captureScreenshot({format:'png'}); await pause();
  await evaluate(client,`(() => {
    window.perfDraw={};window.perfLayers={};window.perfLong=[];
    const mainCanvas=document.querySelector('[data-testid=map-canvas] canvas');
    for(const key of ['drawImage','fillRect','stroke','fillText']){
      const original=CanvasRenderingContext2D.prototype[key];
      CanvasRenderingContext2D.prototype[key]=function(...args){const t=performance.now();try{return original.apply(this,args);}finally{const elapsed=performance.now()-t;const s=window.perfDraw[key] ||= {calls:0,ms:0};s.calls++;s.ms+=elapsed;const layer=window.perfLayers[(this.canvas===mainCanvas?'onscreen.':'static.')+key] ||= {calls:0,ms:0};layer.calls++;layer.ms+=elapsed;}};
    }
    new PerformanceObserver(list=>window.perfLong.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:false});
  })()`);
  const report={ label, objects:source.buildings.length+(source.spawns?.length||0), boxes:source.box_mode.length, errors };
  report.controlClickMs=await timedClick('map-tool-move-unit'); await click(client,'map-tool-none');
  const frame=await evaluate(client,"document.querySelector('[data-testid=map-canvas] canvas').getBoundingClientRect().toJSON()");
  const start={x:frame.x+frame.width*.5,y:frame.y+frame.height*.5};
  for(let i=0;i<10;i++){await client.Input.dispatchMouseEvent({type:'mouseWheel',...start,deltaX:0,deltaY:-600});await pause();}
  await pause(); await client.Page.captureScreenshot({format:'png'});
  await evaluate(client,'window.perfDraw={};window.perfLayers={}');
  report.panStart=await evaluate(client,`({target:document.elementFromPoint(${start.x},${start.y})?.outerHTML.slice(0,160),data:{...document.querySelector('[data-testid=map-canvas] canvas').dataset}})`);
  const before=await evaluate(client,"Number(document.querySelector('[data-testid=map-canvas] canvas').dataset.staticBuilds)");
  await client.Input.dispatchMouseEvent({type:'mousePressed',button:'middle',buttons:4,clickCount:1,...start});
  const times=[];
  for(let i=1;i<=30;i++){const t=Date.now();await client.Input.dispatchMouseEvent({type:'mouseMoved',button:'middle',buttons:4,x:start.x-i*4,y:start.y-i});await evaluate(client,'new Promise(r=>setTimeout(r,0))');times.push(Date.now()-t);}
  await client.Input.dispatchMouseEvent({type:'mouseReleased',button:'middle',clickCount:1,x:start.x-120,y:start.y-30});
  await pause();
  report.panEnd=await evaluate(client,"({...document.querySelector('[data-testid=map-canvas] canvas').dataset})");
  report.panPixels=await evaluate(client,`(() => {const c=document.querySelector('[data-testid=map-canvas] canvas'),pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let hash=2166136261;for(let i=0;i<pixels.length;i++)hash=Math.imul(hash^pixels[i],16777619);return {width:c.width,height:c.height,hash:hash>>>0}})()`);
  report.pan={events:times.length,meanMs:times.reduce((a,b)=>a+b,0)/times.length,p95Ms:[...times].sort((a,b)=>a-b)[Math.floor(times.length*.95)],staticBuilds:await evaluate(client,"Number(document.querySelector('[data-testid=map-canvas] canvas').dataset.staticBuilds)")-before};
  report.draw=await evaluate(client,'window.perfDraw');
  report.layers=await evaluate(client,'window.perfLayers');
  report.openJsonMs=await timedClick('map-json-toggle');await pause();
  report.json=await evaluate(client,"({fields:document.querySelectorAll('.field-tree .field-row').length,inputs:document.querySelectorAll('.field-tree input').length})");
  const jsonStart={x:frame.x+Math.min(frame.width*.25,220),y:frame.y+frame.height*.5};
  const jsonTarget=await evaluate(client,`document.elementFromPoint(${jsonStart.x},${jsonStart.y})?.tagName`);
  if(jsonTarget!=='CANVAS')throw new Error('JSON pan benchmark must target the exposed canvas: '+jsonTarget);
  const jsonBefore=await evaluate(client,"Number(document.querySelector('[data-testid=map-canvas] canvas').dataset.staticBuilds)");
  await evaluate(client,'window.perfDraw={};window.perfLayers={}');
  await client.Input.dispatchMouseEvent({type:'mousePressed',button:'middle',buttons:4,clickCount:1,...jsonStart});
  const jsonTimes=[];
  for(let i=1;i<=30;i++){const t=Date.now();await client.Input.dispatchMouseEvent({type:'mouseMoved',button:'middle',buttons:4,x:jsonStart.x-i*4,y:jsonStart.y-i});await evaluate(client,'new Promise(r=>setTimeout(r,0))');jsonTimes.push(Date.now()-t);}
  await client.Input.dispatchMouseEvent({type:'mouseReleased',button:'middle',clickCount:1,x:jsonStart.x-120,y:jsonStart.y-30});
  await pause();
  report.panWithJson={events:jsonTimes.length,meanMs:jsonTimes.reduce((a,b)=>a+b,0)/jsonTimes.length,p95Ms:[...jsonTimes].sort((a,b)=>a-b)[Math.floor(jsonTimes.length*.95)],staticBuilds:await evaluate(client,"Number(document.querySelector('[data-testid=map-canvas] canvas').dataset.staticBuilds)")-jsonBefore,layers:await evaluate(client,'window.perfLayers')};
  const editBefore=await evaluate(client,"Number(document.querySelector('[data-testid=map-canvas] canvas').dataset.staticBuilds)");
  report.editJsonMs=await evaluate(client,`new Promise(resolve=>{const input=document.querySelector('[data-testid=field-name]');const t=performance.now();input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'performance changed');input.dispatchEvent(new Event('input',{bubbles:true}));setTimeout(()=>resolve(performance.now()-t),0);})`);
  await pause(); report.editStaticBuilds=await evaluate(client,"Number(document.querySelector('[data-testid=map-canvas] canvas').dataset.staticBuilds)")-editBefore;
  report.longTasks=await evaluate(client,'window.perfLong');
  fs.writeFileSync(path.join(artifacts,`map-performance-${label}.json`),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally { await editor.close(); }
