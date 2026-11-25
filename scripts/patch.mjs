import fs from 'node:fs';
import path from 'node:path';

export const FETCH_ANCHOR = 'async performDesktopFetch({body:e,expectedPrincipal:t,headers:n,method:i,onUploadProgress:a,redirect:o,resolvedUrl:c,retry:l,signal:u,messagingTrace:d}){';
const FETCH_WRAPPER = "async performDesktopFetch(e){return require('./history-guard-main.cjs').protectFetch(e,guarded=>this.__personalGuardPerformFetch(guarded),async()=>{const a=await this.getAppServerConnection(s.h).getBackendRequestAuth({refreshToken:false});return{principal:m.ba(a?.token),token:a?.token,signal:a?.signal}})}";
function once(text, anchor, replacement, label) {
  if (text.split(anchor).length !== 2) throw new Error(`Unexpected ${label} anchor count; expected official ChatGPT 26.930.61225`);
  return text.replace(anchor, replacement);
}
/** Pure, all-or-nothing transformations. Every version-specific anchor is checked. */
export function transformFiles(input, preloadSource) {
  const output = { ...input };
  const required = ['webview/index.html', '.vite/build/early-bootstrap.js', '.vite/build/preload.js', '.vite/build/main-C7cfj__D.js'];
  for (const key of required) if (typeof input[key] !== 'string') throw new Error(`Missing packaged file: ${key}`);
  for (const text of Object.values(input)) if (/history-guard\.(?:js|css)|history-guard-main\.cjs|history-guard-preload\.cjs|personal-history-guard inline preload|__personalHistoryGuardOnConversation|__personalGuardPerformFetch/.test(text)) throw new Error('Input already patched; rebuild from the original official app');
  const exportAnchor = 'module.exports = { install };';
  if (typeof preloadSource !== 'string' || !preloadSource.trimEnd().endsWith(exportAnchor)) throw new Error('Unexpected preload export anchor');
  const inlinePreload = once(preloadSource, exportAnchor, '', 'preload export');
  if (/\brequire\s*\(|\bmodule\s*\.|\bexports\s*[.=]/.test(inlinePreload)) throw new Error('Unsupported imports in sandboxed preload guard');
  const routes = Object.keys(input).filter(key => /^webview\/assets\/chatgpt-conversation-page-.*\.js$/.test(key) && input[key].includes('function e_()'));
  if (routes.length !== 1) throw new Error('Unexpected normal/shared conversation component count');
  output['.vite/build/early-bootstrap.js'] = "require('./history-guard-main.cjs').install(require('electron'));\n" + input['.vite/build/early-bootstrap.js'];
  output['.vite/build/preload.js'] = "/* personal-history-guard inline preload */\n(()=>{\n" + inlinePreload + "\ninstall(require('electron'));\n})();\n" + input['.vite/build/preload.js'];
  output['.vite/build/main-C7cfj__D.js'] = once(input['.vite/build/main-C7cfj__D.js'], FETCH_ANCHOR, FETCH_WRAPPER + FETCH_ANCHOR.replace('performDesktopFetch', '__personalGuardPerformFetch'), 'host transport');
  const deny = id => `if(typeof globalThis.__personalHistoryGuardOnConversation!=="function"||globalThis.__personalHistoryGuardOnConversation(${id}))return null;`;
  let route = once(input[routes[0]], 'o=i?.archivedConversationPreview===!0;if(n==null)', 'o=i?.archivedConversationPreview===!0;' + deny('n') + 'if(n==null)', 'normal conversation');
  route = once(route, 'function t_(){let e=(0,O_.c)(7),{sharedConversationId:t}=Sn();if(t==null)', 'function t_(){let e=(0,O_.c)(7),{sharedConversationId:t}=Sn();' + deny('"shared:"+t') + 'if(t==null)', 'shared conversation');
  output[routes[0]] = route;
  let html = input['webview/index.html'];
  const moduleTags = [...html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*>/g)];
  if (moduleTags.length !== 1) throw new Error('Unexpected application module script count');
  html = once(html, moduleTags[0][0], '<link rel="stylesheet" href="./history-guard.css">\n<script src="./history-guard.js"></script>\n' + moduleTags[0][0], 'early guard HTML');
  const htmlTags = [...html.matchAll(/<html\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)];
  if (htmlTags.length !== 1) throw new Error('Unexpected HTML opening tag count');
  if (/\bclass\s*=/i.test(htmlTags[0][0])) throw new Error('Unexpected existing HTML class attribute');
  html = once(html, htmlTags[0][0], htmlTags[0][0].replace(/^<html\b/i, '<html class="personal-history-guard-starting"'), 'HTML starting class');
  html = once(html, 'id="root"', 'id="root"', 'application root');
  output['webview/index.html'] = html;
  return output;
}
/** Validate every transformation before writing files in an isolated extraction. */
export function patchFiles(root, guardDirectory = path.resolve(import.meta.dirname, '../guard')) {
  const names = ['webview/index.html', '.vite/build/early-bootstrap.js', '.vite/build/preload.js', '.vite/build/main-C7cfj__D.js'];
  for (const name of fs.readdirSync(path.join(root, 'webview/assets'))) if (/^chatgpt-conversation-page-.*\.js$/.test(name)) names.push(`webview/assets/${name}`);
  const input = Object.fromEntries(names.map(name => [name, fs.readFileSync(path.join(root, name), 'utf8')]));
  const output = transformFiles(input, fs.readFileSync(path.join(guardDirectory, 'preload.cjs'), 'utf8'));
  const copies = [['history-guard.js', 'webview/history-guard.js'], ['history-guard.css', 'webview/history-guard.css'], ['main.cjs', '.vite/build/history-guard-main.cjs'], ['policy.cjs', '.vite/build/history-guard-policy.cjs'], ['preload.cjs', '.vite/build/history-guard-preload.cjs']];
  for (const [from] of copies) if (!fs.existsSync(path.join(guardDirectory, from))) throw new Error(`Missing guard runtime: ${from}`);
  for (const [name, text] of Object.entries(output)) fs.writeFileSync(path.join(root, name), text);
  for (const [from, to] of copies) fs.copyFileSync(path.join(guardDirectory, from), path.join(root, to));
  return Object.keys(output).concat(copies.map(([, to]) => to));
}
