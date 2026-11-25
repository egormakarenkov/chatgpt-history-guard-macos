import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { transformFiles, FETCH_ANCHOR } from './patch.mjs';
import { buildApp, hardenFuses } from './build.mjs';
import { FuseV1Options, FuseState } from '@electron/fuses';

const fixture = path.resolve(import.meta.dirname, '../../../../analysis-packaged');
const preloadSource = fs.readFileSync(path.resolve(import.meta.dirname, '../guard/preload.cjs'), 'utf8');
const usePackaged = process.env.HISTORY_GUARD_SYNTHETIC_FIXTURE !== '1' && fs.existsSync(path.join(fixture, '.vite/build/main-C7cfj__D.js')) && fs.existsSync(path.join(fixture, 'webview/assets'));
const routeName = usePackaged ? fs.readdirSync(path.join(fixture, 'webview/assets')).find(n => /^chatgpt-conversation-page-/.test(n) && fs.readFileSync(path.join(fixture, 'webview/assets', n), 'utf8').includes('function e_()')) : 'chatgpt-conversation-page-fixture.js';
// Tiny authored specimens exercise the transformation contract without shipping app code.
// A development checkout uses the real packaged fixtures when present.
const synthetic = {
  '.vite/build/early-bootstrap.js': 'originalEarly();',
  '.vite/build/preload.js': 'originalPreload();',
  '.vite/build/main-C7cfj__D.js': `class Fixture {${FETCH_ANCHOR}return e;}}`,
  [`webview/assets/${routeName}`]: 'function e_(){let o=i?.archivedConversationPreview===!0;if(n==null)return null;return n}function t_(){let e=(0,O_.c)(7),{sharedConversationId:t}=Sn();if(t==null)return null;return t}',
  'webview/index.html': '<!doctype html><html lang="en" data-build="<!-- PROD_BUILD_TAG_HERE -->"><head><script type="module" crossorigin src="./assets/index-fixture.js"></script></head><body><div id="root"></div></body></html>'
};
function originals() {
  if (!usePackaged) return { ...synthetic };
  const files = {};
  for (const name of ['early-bootstrap.js', 'preload.js', 'main-C7cfj__D.js']) files[`.vite/build/${name}`] = fs.readFileSync(path.join(fixture, '.vite/build', name), 'utf8');
  files[`webview/assets/${routeName}`] = fs.readFileSync(path.join(fixture, 'webview/assets', routeName), 'utf8').replaceAll('if(globalThis.__personalHistoryGuardOnConversation?.(n))return null;', '').replaceAll('if(globalThis.__personalHistoryGuardOnConversation?.(t))return null;', '');
  const htmlPath = path.join(fixture, 'webview/index.html');
  files['webview/index.html'] = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8').replace(/\s*<link[^>]+history-guard\.css[^>]*>/g, '').replace(/\s*<script[^>]+history-guard\.js[^>]*><\/script>/g, '') : synthetic['webview/index.html'];
  return files;
}
test('patches the packaged transport and requires guard initialization on both routes', async () => {
  const source = originals(), result = transformFiles(source, preloadSource);
  assert.ok(result['.vite/build/early-bootstrap.js'].startsWith("require('./history-guard-main.cjs').install(require('electron'));"));
  for (const name of ['early-bootstrap.js']) {
    const order=[];
    const injected=result[`.vite/build/${name}`].split('\n')[0];
    vm.runInNewContext(injected+";original()",{require:id=>id==='electron'?{electron:true}:{install:e=>{assert.equal(e.electron,true);order.push('install');}},original:()=>order.push('original')});
    assert.deepEqual(order,['install','original']);
  }
  const main = result['.vite/build/main-C7cfj__D.js'];
  const wrapper = main.slice(main.indexOf('async performDesktopFetch(e){'), main.indexOf('async __personalGuardPerformFetch('));
  let forwarded, authRefresh, hostToken, authSignal, originalReceived;
  const guarded = {body:'guarded-body',redirect:'error',signal:'host-cancellation',expectedPrincipal:'host-principal'};
  const transport = { protectFetch: async (args, perform, getAuth) => { forwarded = args; const auth = await getAuth(); hostToken = auth.principal; authSignal = auth.signal; return perform(guarded); } };
  const Class = vm.runInNewContext(`(class {${wrapper}async __personalGuardPerformFetch(args){receive(args);return args.body}getAppServerConnection(id){if(id!=='host')throw Error('wrong host');return{getBackendRequestAuth:async options=>{capture(options);return{token:'host-token',signal:'account-signal'}}}}})`, { require: () => transport, s: { h: 'host' }, m: { ba: t => `principal:${t}` }, capture: v => { authRefresh = v.refreshToken; },receive: v => {originalReceived=v;} });
  const args = {body:'original-body',resolvedUrl:'https://chatgpt.com/backend-api/conversation'};
  assert.equal(await new Class().performDesktopFetch(args), 'guarded-body');
  assert.equal(originalReceived, guarded);
  assert.equal(forwarded, args); assert.equal(hostToken, 'principal:host-token'); assert.equal(authRefresh, false); assert.equal(authSignal, 'account-signal');
  assert.ok(main.includes(FETCH_ANCHOR.replace('performDesktopFetch', '__personalGuardPerformFetch')));
  for (const id of ['n', 't']) {
    const route = result[`webview/assets/${routeName}`];
    const check = route.match(new RegExp(`if\\(typeof globalThis\\.__personalHistoryGuardOnConversation[^;]+\\(${id === 't' ? '"shared:"\\+t' : 'n'}\\)\\)return null;`))?.[0];
    assert.ok(check, `route ${id} patch missing`);
    for (const guard of [undefined, () => true, () => false]) assert.equal(vm.runInNewContext(`(()=>{const ${id}='old';${check}return 'render';})()`, {__personalHistoryGuardOnConversation:guard}), guard && !guard() ? 'render' : null);
  }
  const html = result['webview/index.html'];
  assert.ok(html.indexOf('src="./history-guard.js"') < html.indexOf('type="module"'));
  assert.ok(!html.includes('defer src="./history-guard.js"')); assert.match(html, /<html[^>]*class="personal-history-guard-starting"/);
  assert.throws(() => transformFiles(result, preloadSource), /already patched/);
  assert.deepEqual(source, originals());
});
test('patched HTML and real CSS hide startup when guard cannot load and release it after initialization', async () => {
  const html=transformFiles(originals(),preloadSource)['webview/index.html'];
  const css=fs.readFileSync(path.resolve(import.meta.dirname,'../guard/history-guard.css'),'utf8');
  const code=fs.readFileSync(path.resolve(import.meta.dirname,'../guard/history-guard.js'),'utf8');
  const observers=[];
  const dom=new JSDOM(html.replace('</head>',`<style>${css}</style></head>`),{url:'https://desktop.test/index.html',runScripts:'outside-only',pretendToBeVisual:true,beforeParse(window){const Observer=window.MutationObserver;window.MutationObserver=class extends Observer{constructor(callback){super(callback);observers.push(this);}};}});
  try {
    const root=dom.window.document.getElementById('root');
    root.textContent='Protected app';
    assert.equal(dom.window.getComputedStyle(root).visibility,'hidden');
    dom.window.eval(code);
    await new Promise(resolve=>setTimeout(resolve,40));
    assert.equal(dom.window.document.documentElement.classList.contains('personal-history-guard-starting'),false);
    assert.notEqual(dom.window.getComputedStyle(root).visibility,'hidden');
  }finally{for(const observer of observers)observer.disconnect();dom.window.close();}
  const existing=originals(); existing['webview/index.html']=existing['webview/index.html'].replace('<html ','<html class="original" ');
  assert.throws(()=>transformFiles(existing,preloadSource),/HTML class/);
});
test('sandboxed preload installs the real bridge inline using only electron', () => {
  const input = originals();
  input['.vite/build/preload.js'] = 'original();';
  const result = transformFiles(input, preloadSource);
  const order = [];
  let exposed;
  vm.runInNewContext(result['.vite/build/preload.js'], {
    require: id => {
      assert.equal(id, 'electron', 'sandbox cannot require relative CommonJS files');
      return {contextBridge:{exposeInMainWorld:(name,bridge)=>{order.push('guard');assert.equal(name,'personalHistoryGuard');exposed=bridge;}},ipcRenderer:{sendSync:()=>({account:'host'}),on:()=>{},removeListener:()=>{},invoke:async()=>false}};
    },
    original:()=>order.push('original')
  });
  assert.deepEqual(order, ['guard','original']);
  assert.equal(exposed.getSnapshot().account,'host');
  assert.throws(()=>transformFiles(input, preloadSource.replace('module.exports = { install };', 'module.exports = install;')), /preload export/);
  assert.throws(()=>transformFiles(input, "require('node:fs');\n"+preloadSource), /sandboxed preload/);
});
test('macOS builder preflight refuses Windows before any system commands', async () => {
  const commands = [];
  await assert.rejects(buildApp({platform:'win32',run:(...a)=>commands.push(a),read:(...a)=>commands.push(a)}), /macOS.*unavailable/i);
  assert.deepEqual(commands, []);
});
test('fuse hardening uses official API, requires integrity support, and verifies enabled state', async () => {
  const calls = [];
  const wire = {version:'1'};
  for (const key of [0,2,3,4,5]) wire[key] = FuseState.ENABLE;
  await hardenFuses('binary', {getCurrentFuseWire:async()=>{calls.push('read');return {...wire}}, flipFuses:async(p,config)=>{calls.push('flip');for(const key of [0,2,3,4,5])wire[key]=config[key]?FuseState.ENABLE:FuseState.DISABLE}});
  assert.deepEqual(calls,['read','flip','read']);
  assert.equal(wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation],FuseState.ENABLE);
  assert.equal(wire[FuseV1Options.OnlyLoadAppFromAsar],FuseState.ENABLE);
  for(const key of [0,2,3])assert.equal(wire[key],FuseState.DISABLE);
  await assert.rejects(hardenFuses('binary',{getCurrentFuseWire:async()=>({version:'1'}),flipFuses:()=>{throw Error('must not mutate')}}),/required.*fuse/i);
  await assert.rejects(hardenFuses('binary',{getCurrentFuseWire:async()=>({...wire,[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]:FuseState.DISABLE}),flipFuses:async()=>{}}),/verification failed/i);
});
test('Mac command boundaries preserve source and sign only after final ASAR hash and fuses', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'guard-builder-test-'));
  try {
    const sourceApp=path.join(root,'Official.app'),targetApp=path.join(root,'Guard.app');
    const framework='Contents/Frameworks/Codex Framework.framework/Versions/Current/Codex Framework';
    fs.mkdirSync(path.dirname(path.join(sourceApp,framework)),{recursive:true});
    fs.writeFileSync(path.join(sourceApp,framework),'ORIGINAL');
    fs.mkdirSync(path.join(sourceApp,'Contents/Resources'),{recursive:true});
    fs.writeFileSync(path.join(sourceApp,'Contents/Resources/app.asar'),'OFFICIAL');
    const events=[];
    const run=(command,args)=>{
      events.push([command,...args]);
      if(command==='/usr/bin/ditto')fs.cpSync(args[0],args[1],{recursive:true});
    };
    const read=(command,args)=>{
      events.push([command,...args]);
      if(args[1]==='Print :CFBundleShortVersionString')return '26.930.61225';
      if(args[1]==='Print :CFBundleIdentifier')return 'com.openai.chat';
      if(args[1]==='Print :CFBundleURLTypes')throw Error('missing');
      return 'Mach-O';
    };
    const prepare=async(source,out)=>{assert.equal(source,sourceApp);fs.writeFileSync(out,'PATCHED');fs.mkdirSync(`${out}.unpacked`);fs.writeFileSync(path.join(`${out}.unpacked`,'native.node'),'NATIVE');return{hash:'final-header-hash'}};
    const harden=async file=>{assert.ok(!file.includes('.app'));assert.equal(fs.readFileSync(file,'utf8'),'ORIGINAL');events.push(['fuses']);fs.writeFileSync(file,'HARDENED');};
    const result=await buildApp({platform:'darwin',sourceApp,targetApp,run,read,prepare,harden});
    assert.equal(result.hash,'final-header-hash');
    assert.equal(fs.readFileSync(path.join(targetApp,framework),'utf8'),'HARDENED');
    assert.equal(fs.readFileSync(path.join(sourceApp,framework),'utf8'),'ORIGINAL');
    assert.equal(fs.readFileSync(path.join(sourceApp,'Contents/Resources/app.asar'),'utf8'),'OFFICIAL');
    const hashIndex=events.findIndex(e=>e.includes('Set :ElectronAsarIntegrity:Resources/app.asar:hash final-header-hash'));
    const fuseIndex=events.findIndex(e=>e[0]==='fuses');
    const signs=events.map((e,i)=>e[0]==='/usr/bin/codesign'&&e.includes('--sign')?i:-1).filter(i=>i>=0);
    assert.ok(hashIndex>=0&&fuseIndex>hashIndex&&signs.length===2&&signs.every(i=>i>fuseIndex));
    assert.deepEqual(events.at(-1),['/usr/bin/codesign','--verify','--deep','--strict',targetApp]);
    const count=events.length;
    await assert.rejects(buildApp({platform:'darwin',sourceApp,targetApp,run,read,prepare,harden}),/already exists/);
    assert.equal(events.length,count);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('rejects missing, duplicate, or drifted anchors before changing input', () => {
  const files = originals();
  files['.vite/build/main-C7cfj__D.js'] = files['.vite/build/main-C7cfj__D.js'].replace(FETCH_ANCHOR, 'async changed(){');
  assert.throws(() => transformFiles(files, preloadSource), /transport/);
  const duplicate = originals(); duplicate['.vite/build/main-C7cfj__D.js'] += FETCH_ANCHOR;
  assert.throws(() => transformFiles(duplicate, preloadSource), /transport/);
});
