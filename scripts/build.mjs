import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import asar from '@electron/asar';
import { flipFuses, getCurrentFuseWire, FuseVersion, FuseV1Options, FuseState } from '@electron/fuses';
import { patchFiles } from './patch.mjs';

export const requiredVersion = '26.930.61225';
const runCommand = (command, args) => execFileSync(command, args, {stdio:'inherit'});
const readCommand = (command, args) => execFileSync(command, args, {encoding:'utf8'}).trim();
const plistTool = '/usr/libexec/PlistBuddy';

export function unpackOptions(header) {
  function cover(node, prefix = '') {
    if (!node.files) return {total:1,unpacked:node.unpacked?1:0,dirs:[],files:node.unpacked?[prefix]:[]};
    let total=0,unpacked=0,dirs=[],files=[];
    for(const [name,child] of Object.entries(node.files)) {
      const result=cover(child,prefix?`${prefix}/${name}`:name);
      total+=result.total;unpacked+=result.unpacked;dirs.push(...result.dirs);files.push(...result.files);
    }
    return prefix&&total&&total===unpacked?{total,unpacked,dirs:[prefix],files:[]}:{total,unpacked,dirs,files};
  }
  const {dirs,files}=cover(header);
  const brace = items => items.length===1?items[0]:`{${items.join(',')}}`;
  return {globOptions:{dot:true},...(dirs.length?{unpackDir:brace(dirs)}:{}),...(files.length?{unpack:brace(files.map(file=>`**/${file}`))}:{})};
}
export function checkUnpacked(original,next,prefix='') {
  for(const [name,value] of Object.entries(original.files||{})) {
    const file=prefix?`${prefix}/${name}`:name, other=next.files?.[name];
    if(!other)throw Error(`Missing ASAR entry: ${file}`);
    if(value.files)checkUnpacked(value,other,file);
    else if(!!value.unpacked!==!!other.unpacked)throw Error(`Unpacked metadata changed: ${file}`);
    else if(value.link!==other.link)throw Error(`ASAR symlink changed: ${file}`);
  }
}
/** Produces an unsigned ASAR in a new path; does not edit an app or native binary. */
export async function preparePatchedAsar(sourceApp,outputAsar) {
  if(fs.existsSync(outputAsar)||fs.existsSync(`${outputAsar}.unpacked`))throw Error(`Target already exists: ${outputAsar}`);
  const originalAsar=path.join(sourceApp,'Contents/Resources/app.asar');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'history-guard-asar-'));
  try {
    const extracted=path.join(temp,'extracted'), header=asar.getRawHeader(originalAsar).header;
    asar.extractAll(originalAsar,extracted);
    patchFiles(extracted);
    await asar.createPackageWithOptions(extracted,outputAsar,unpackOptions(header));
    const rebuilt=asar.getRawHeader(outputAsar);
    checkUnpacked(header,rebuilt.header);
    return {hash:crypto.createHash('sha256').update(rebuilt.headerString).digest('hex')};
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
export async function hardenFuses(binary, api = {getCurrentFuseWire,flipFuses}) {
  const current=await api.getCurrentFuseWire(binary);
  if(current.version!==FuseVersion.V1)throw Error('Unknown Electron fuse version');
  const wanted = {
    [FuseV1Options.RunAsNode]:false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]:false,
    [FuseV1Options.EnableNodeCliInspectArguments]:false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]:true,
    [FuseV1Options.OnlyLoadAppFromAsar]:true
  };
  for(const key of Object.keys(wanted))if(current[key]===undefined||current[key]===FuseState.REMOVED)throw Error(`Required Electron fuse unavailable: ${FuseV1Options[key]}`);
  await api.flipFuses(binary,{version:FuseVersion.V1,...wanted,resetAdHocDarwinSignature:false});
  const verified=await api.getCurrentFuseWire(binary);
  for(const [key,value] of Object.entries(wanted))if(verified[key] !== (value?FuseState.ENABLE:FuseState.DISABLE))throw Error(`Electron fuse verification failed: ${FuseV1Options[key]}`);
}
function signUnpacked(dir,run,read) {
  if(!fs.existsSync(dir))return;
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    const file=path.join(dir,entry.name);
    if(entry.isDirectory())signUnpacked(file,run,read);
    else if(entry.isFile()&&read('/usr/bin/file',['-b',file]).includes('Mach-O'))run('/usr/bin/codesign',['--force','--sign','-',file]);
  }
}
export async function buildApp({sourceApp='/Applications/ChatGPT.app',targetApp=path.join(os.tmpdir(),'ChatGPT History Guard.app'),platform=process.platform,run=runCommand,read=readCommand,prepare=preparePatchedAsar,harden=hardenFuses}={}) {
  if(platform!=='darwin')throw Error('macOS build and signing unavailable on this platform; use the source handoff on a Mac');
  if(Number(process.versions.node.split('.')[0])<22)throw Error('Node >=22 is required');
  sourceApp=path.resolve(sourceApp);targetApp=path.resolve(targetApp);
  if(fs.existsSync(targetApp))throw Error(`Target already exists: ${targetApp}`);
  const plistSource=path.join(sourceApp,'Contents/Info.plist');
  const version=read(plistTool,['-c','Print :CFBundleShortVersionString',plistSource]);
  if(version!==requiredVersion)throw Error(`Expected official ChatGPT ${requiredVersion}, found ${version}`);
  // Fail before copying if the input signature is broken or the bundle is already patched.
  run('/usr/bin/codesign',['--verify','--deep','--strict',sourceApp]);
  const identifier=read(plistTool,['-c','Print :CFBundleIdentifier',plistSource]);
  if(identifier!=='com.openai.chat')throw Error(`Expected official ChatGPT bundle identifier, found ${identifier}`);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'chatgpt-history-guard-build-'));
  try {
    const rebuiltAsar=path.join(temp,'app.asar');
    const {hash}=await prepare(sourceApp,rebuiltAsar);
    run('/usr/bin/ditto',[sourceApp,targetApp]);
    const outputAsar=path.join(targetApp,'Contents/Resources/app.asar');
    fs.copyFileSync(rebuiltAsar,outputAsar);
    // Existing unpacked native files are retained by ditto; the packer preserves their metadata.
    if(fs.existsSync(`${rebuiltAsar}.unpacked`))run('/usr/bin/ditto',[`${rebuiltAsar}.unpacked`,`${outputAsar}.unpacked`]);
    const plist=path.join(targetApp,'Contents/Info.plist');
    for(const [key,value] of [['CFBundleIdentifier','com.personal.chatgpt-history-guard'],['CFBundleName','ChatGPT History Guard'],['CFBundleDisplayName','ChatGPT History Guard'],['ElectronAsarIntegrity:Resources/app.asar:hash',hash]])run(plistTool,['-c',`Set :${key} ${value}`,plist]);
    let hasURLHandlers=false;
    try{read(plistTool,['-c','Print :CFBundleURLTypes',plist]);hasURLHandlers=true;}catch{/* Missing handlers need no removal. */}
    if(hasURLHandlers)run(plistTool,['-c','Delete :CFBundleURLTypes',plist]);
    const framework=path.join(targetApp,'Contents/Frameworks/Codex Framework.framework/Versions/Current/Codex Framework');
    // @electron/fuses assumes the standard Electron framework for .app paths.
    // Use its supported plain-binary interface on an isolated copy of this renamed framework.
    const fuseBinary=path.join(temp,'CodexFramework');
    fs.copyFileSync(framework,fuseBinary);
    await harden(fuseBinary);
    fs.copyFileSync(fuseBinary,framework);
    signUnpacked(`${outputAsar}.unpacked`,run,read);
    run('/usr/bin/codesign',['--force','--deep','--sign','-',targetApp]);
    run('/usr/bin/codesign',['--verify','--deep','--strict',targetApp]);
    return {targetApp,hash};
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result=await buildApp({sourceApp:process.argv[2],targetApp:process.argv[3]});
    console.log(`Built ${result.targetApp}`);
  }catch(error){console.error(error.message);process.exitCode=1;}
}
