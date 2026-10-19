import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { apiCall, click, createWorkspaceFixture, evaluate, launchEditor, reload, setInput, waitFor } from './workspace-smoke.mjs';

export async function runInspectorSmoke({client,fixture,artifacts}) {
  const checks=[],layouts=[],errors=[];
  const check=(name,value,detail)=>{assert(value,`${name}: ${JSON.stringify(detail)}`);checks.push(name);console.log(`  ok: ${name}`);};
  client.Runtime.exceptionThrown(({exceptionDetails})=>errors.push(exceptionDetails.exception?.description||exceptionDetails.text));
  const file=path.join(fixture.maps,'inspector_smoke.json');
  const units=JSON.parse(fs.readFileSync(path.join(fixture.project,'data/units.json'))).units;
  const doc={version:1,name:'inspector_smoke',width:30,height:28,default_terrain:0,seed:1,box_mode:[],terrain_patches:[],decor:Array.from({length:50},(_,i)=>({kind:'tree',x:29,y:i%28})),init:{},
    buildings:Array.from({length:72},(_,i)=>({key:i===71?'turret_guard':'mine',x:1+i%9*3,y:1+Math.floor(i/9)*3,w:i===71?1:2,h:i===71?1:2,team:1})),
    spawns:[{kind:units.find(u=>u.key==='cougar').id,x:28,y:25,team:1,count:1}]};
  fs.writeFileSync(file,JSON.stringify(doc));
  const pause=()=>evaluate(client,'new Promise(r=>setTimeout(r,100))');
  const point=async(x,y)=>evaluate(client,`(()=>{const c=document.querySelector('[data-testid=map-canvas] canvas'),r=c.getBoundingClientRect();return {x:r.x+(${x}+.5-Number(c.dataset.ox))*Number(c.dataset.ppc),y:r.y+(${y}+.5-Number(c.dataset.oy))*Number(c.dataset.ppc)}})()`);
  const mouse=async(x,y,button='left')=>{const p=await point(x,y);await client.Input.dispatchMouseEvent({type:'mouseMoved',...p});await client.Input.dispatchMouseEvent({type:'mousePressed',button,clickCount:1,...p});await client.Input.dispatchMouseEvent({type:'mouseReleased',button,clickCount:1,...p});};
  const selected=(p)=>waitFor(client,`document.querySelector('[data-testid=map-object-inspector]')?.dataset.objectPath === '${p}' && document.querySelector('[data-testid=map-inspector-tab-object]')?.getAttribute('aria-selected') === 'true'`,p);
  const context=async(x,y,action)=>{await mouse(x,y,'right');await click(client,action);await pause();};
  const add=async(field,parent='')=>{await click(client,`add-field-btn-${parent}`);await evaluate(client,`(()=>{const s=document.querySelector('[data-testid="add-field-select-${parent}"]');if(![...s.options].some(o=>o.value===${JSON.stringify(field)}))throw new Error('Missing template ${field}');s.value=${JSON.stringify(field)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await pause();};
  try {
    await client.Page.bringToFront();
    await client.Emulation.setDeviceMetricsOverride({width:1920,height:1080,deviceScaleFactor:1,mobile:false});
    await reload(client);await click(client,'tab-maps');await click(client,'map-item-inspector_smoke-json');await pause();
    await client.Page.captureScreenshot({format:'png'});
    await waitFor(client,"(()=>{const c=document.querySelector('[data-testid=map-canvas] canvas');return Math.abs(Number(c.dataset.cssW)-c.parentElement.clientWidth)<2&&Math.abs(Number(c.dataset.cssH)-c.parentElement.clientHeight)<2})()",'inspector canvas resize');
    check('newly opened map defaults to map properties',await evaluate(client,"document.querySelector('[data-testid=map-inspector-tab-map]')?.getAttribute('aria-selected')==='true' && !document.querySelector('[data-testid=map-object-inspector]')"));
    await click(client,'map-view-reset');await click(client,'map-tool-none');await mouse(22,22);await selected('buildings-70');
    check('click selects original building index beyond first JSON page',await evaluate(client,"document.querySelector('[data-testid=map-object-title]')?.textContent.includes('mine') && document.querySelectorAll('[data-testid=map-object-inspector] .field-row').length < 20 && !document.querySelector('[data-testid=map-json-drawer]')"));
    await setInput(client,'field-team',3);await click(client,'map-undo-btn');
    check('single object property edit supports undo',await evaluate(client,"document.querySelector('[data-testid=field-team]')?.value==='1'"));
    await click(client,'map-redo-btn');
    check('single object property edit supports redo',await evaluate(client,"document.querySelector('[data-testid=field-team]')?.value==='3'"));
    await evaluate(client,"(()=>{const i=document.querySelector('[data-testid=field-team]');i.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'4');i.dispatchEvent(new Event('input',{bubbles:true}));})()");await pause();
    await client.Input.dispatchKeyEvent({type:'keyDown',key:'z',code:'KeyZ',modifiers:2,windowsVirtualKeyCode:90});
    await client.Input.dispatchKeyEvent({type:'keyUp',key:'z',code:'KeyZ',modifiers:0,windowsVirtualKeyCode:90});await pause();
    check('keyboard undo synchronizes a still-focused numeric editor',await evaluate(client,"document.activeElement?.dataset.testid==='field-team' && document.querySelector('[data-testid=field-team]')?.value==='3'"));
    await evaluate(client,"document.activeElement.blur()");await pause();
    check('blurring after undo does not recommit stale numeric draft',await evaluate(client,"document.querySelector('[data-testid=field-team]')?.value==='3'"));
    const step=await evaluate(client,"(()=>{const r=document.querySelector('[data-testid=field-team-step-up]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
    await client.Input.dispatchMouseEvent({type:'mouseMoved',...step});await client.Input.dispatchMouseEvent({type:'mousePressed',button:'left',buttons:1,clickCount:1,...step});
    await evaluate(client,'new Promise(r=>setTimeout(r,1100))');await client.Input.dispatchMouseEvent({type:'mouseReleased',button:'left',buttons:0,clickCount:1,...step});
    check('holding numeric step advances across repeated ticks',await evaluate(client,"Number(document.querySelector('[data-testid=field-team]').value)>=5"));
    await setInput(client,'field-team',3);
    await evaluate(client,"(()=>{const i=document.querySelector('[data-testid=field-team]');i.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'-');i.dispatchEvent(new Event('input',{bubbles:true}));})()");await pause();
    check('incomplete numeric draft stays editable',await evaluate(client,"document.querySelector('[data-testid=field-team]')?.value==='-'"));
    await evaluate(client,"document.activeElement.blur()");await pause();
    check('incomplete numeric draft does not overwrite the document',await evaluate(client,"document.querySelector('[data-testid=field-team]')?.value==='3'"));
    await click(client,'map-inspector-tab-map');await pause();
    check('manual map tab shows only map controls',await evaluate(client,"!!document.querySelector('[data-testid=background-inspector]')&&!document.querySelector('[data-testid=map-object-inspector]')"));
    await context(25,22,'ctx-field-hp');await selected('buildings-71');
    check('right-click turret opens and focuses its missing standard hp',await evaluate(client,"document.activeElement?.dataset.testid==='field-hp' && Number(document.querySelector('[data-testid=field-hp]')?.value)>0 && document.querySelector('[data-testid=map-object-title]')?.textContent.includes('turret_guard')"));
    await context(22,22,'ctx-field-lines');await selected('buildings-70');
    check('right-click mine opens resource lines with focus',await evaluate(client,"document.querySelector('[data-testid=field-lines-2-income]')?.value==='3' && document.activeElement?.dataset.testid==='field-lines-0-income'"));
    await evaluate(client,`[...document.querySelectorAll('[data-testid=map-object-inspector] [data-field-path]')].find(e=>e.dataset.fieldPath===JSON.stringify(['lines'])).querySelector('.collapse-btn').click()`);await pause();
    check('Object production lines can be manually collapsed',await evaluate(client,"!document.querySelector('[data-testid=field-lines-0-income]')"));
    await context(22,22,'ctx-field-lines');
    check('repeated context navigation expands the target array itself',await evaluate(client,"document.activeElement?.dataset.testid==='field-lines-0-income'"));
    await click(client,'array-add-lines');await setInput(client,'field-lines-3-income',7);
    await add('hp');await setInput(client,'field-hp',620);
    check('Object tree supports nested line editing and standard additions',await evaluate(client,"document.querySelector('[data-testid=field-lines-3-income]')?.value==='7' && document.querySelector('[data-testid=field-hp]')?.value==='620'"));
    await mouse(1,1);await selected('buildings-0');
    check('switching Object does not leak another placement fields',await evaluate(client,"!document.querySelector('[data-testid=field-lines-3-income]')&&!document.querySelector('[data-testid=field-hp]')"));
    await context(28,25,'spawn-ctx-count');await selected('spawns-0');
    check('right-click unit focuses count in Object tree',await evaluate(client,"document.activeElement?.dataset.testid==='field-count' && document.querySelector('[data-testid=map-object-title]')?.textContent.includes('cougar')"));
    await setInput(client,'field-count',2);
    await click(client,'map-save-btn');await waitFor(client,"!!document.querySelector('[data-testid=map-save-ok],[data-testid=map-save-errors]')",'inspector save',180000);
    const saveError=await evaluate(client,"document.querySelector('[data-testid=map-save-errors]')?.textContent");assert(!saveError,saveError);
    const saved=JSON.parse(fs.readFileSync(file,'utf8'));
    check('Object edits save to only their original placement indexes',saved.buildings[70].team===3&&saved.buildings[70].hp===620&&saved.buildings[70].lines[3].income===7&&saved.spawns[0].count===2&&!('hp'in saved.buildings[0]));
    await click(client,'map-reload-doc-btn');await pause();
    check('saved selected Object reloads with correct value',await evaluate(client,"document.querySelector('[data-testid=field-count]')?.value==='2'"));
    await context(22,22,'ctx-field-lines');
    await click(client,'map-json-toggle');await pause();
    check('large whole-map arrays start collapsed',await evaluate(client,"!document.querySelector('[data-testid=field-buildings-0-x]')"));
    await evaluate(client,`[...document.querySelectorAll('[data-field-path]')].find(e=>e.dataset.fieldPath===JSON.stringify(['buildings'])).querySelector('.collapse-btn').click()`);await pause();
    check('large array page contains a bounded set of editable placements',await evaluate(client,"!!document.querySelector('[data-testid=field-buildings-49-x]')&&!document.querySelector('[data-testid=field-buildings-50-x]')"));
    await evaluate(client,"[...document.querySelector('[data-testid=array-pages-buildings]').querySelectorAll('button')].find(b=>b.textContent==='下一页').click()");await pause();
    check('later pages retain full JSON editing access',await evaluate(client,"document.querySelector('[data-testid=field-buildings-70-hp]')?.value==='620'"));
    await click(client,'array-add-decor');await pause();
    check('adding item 51 keeps the array expanded on its new page',await evaluate(client,"!!document.querySelector('[data-testid=field-decor-50-x]')&&!document.querySelector('[data-testid=field-decor-49-x]')"));
    await click(client,'array-remove-buildings-50');await selected('buildings-69');
    check('deleting an earlier JSON row keeps the same Object selected',await evaluate(client,"document.querySelector('[data-testid=map-object-inspector] [data-testid=field-hp]')?.value==='620'"));
    await click(client,'array-remove-buildings-69');await pause();
    check('deleting the selected Object clears its inspector',await evaluate(client,"!!document.querySelector('[data-testid=map-object-empty]')"));
    for(let i=0;i<2&&!await evaluate(client,"!!document.querySelector('[data-testid=field-buildings-71-x]')");i++){await click(client,'map-undo-btn');await pause();}
    await click(client,'map-json-toggle');await context(22,22,'ctx-field-lines');
    for(const theme of ['dark','light'])for(const [width,height]of[[1920,1080],[1280,720]]){
      await click(client,'theme-trigger');await click(client,`theme-${theme}`);
      await client.Emulation.setDeviceMetricsOverride({width,height,deviceScaleFactor:1,mobile:false});await client.Page.captureScreenshot({format:'png'});await pause();
      const layout=await evaluate(client,"(()=>{const p=document.querySelector('[data-testid=map-inspector]'),r=p.getBoundingClientRect();return {width:innerWidth,height:innerHeight,theme:document.documentElement.dataset.theme,inside:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,overflow:p.scrollWidth>p.clientWidth+1,rows:[...p.querySelectorAll('.field-row')].length}})()");
      check(`Object grid fits ${theme} ${width}x${height}`,layout.inside&&!layout.overflow,layout);layouts.push(layout);
      fs.writeFileSync(path.join(artifacts,`inspector-${theme}-${width}x${height}.png`),Buffer.from((await client.Page.captureScreenshot({format:'png'})).data,'base64'));
    }
    check('Object inspector has no JavaScript exceptions',errors.length===0,errors);
    fs.writeFileSync(path.join(artifacts,'inspector-report.json'),JSON.stringify({checks,layouts,errors},null,2));
    return {checks,layouts};
  } finally { fs.unlinkSync(file); }
}

if (path.resolve(process.argv[1]||'')===fileURLToPath(import.meta.url)) {
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const project=path.resolve(process.env.ME_GAME_DIR||path.join(root,'../project-rts'));
  const fixture=createWorkspaceFixture({parent:path.join(os.tmpdir(),'inspector-smoke'),project});
  const artifacts=path.join(root,'.smoke-artifacts');fs.mkdirSync(artifacts,{recursive:true});
  const editor=await launchEditor({executable:path.join(root,'node_modules/electron/dist/electron.exe'),args:[root,`--user-data-dir=${path.join(fixture.root,'profile')}`,'--force-device-scale-factor=1','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','--disable-background-timer-throttling'],cwd:root,port:9236,
    env:{ME_MAP_PROJECT:fixture.project,ME_GODOT_PROJECT:project,ME_DATA_DIR:path.join(fixture.project,'data')}});
  try {
    await waitFor(editor.client,'!!window.meApi','API');
    const opened=await apiCall(editor.client,'openWorkspace',{path:fixture.maps,projectRoot:fixture.project});assert(opened.ok,opened.error);
    await editor.client.Page.bringToFront();
    await editor.client.Emulation.setDeviceMetricsOverride({width:1920,height:1080,deviceScaleFactor:1,mobile:false});
    const report=await runInspectorSmoke({client:editor.client,fixture,artifacts});console.log(`INSPECTOR_OK checks=${report.checks.length}`);
  } catch(error) {
    fs.writeFileSync(path.join(artifacts,'inspector-failure.png'),Buffer.from((await editor.client.Page.captureScreenshot({format:'png'})).data,'base64'));
    throw error;
  } finally {await editor.close();}
}
