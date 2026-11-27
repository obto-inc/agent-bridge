const path=require('path'),fs=require('fs'),os=require('os');
const R='/Users/divyanshverma/WebstormProjects/obto-inc-agent-bridge';
const OUT=path.join(__dirname,'raw'); fs.mkdirSync(OUT,{recursive:true});
const { chromium } = require(R+'/node_modules/playwright-core');
const { createExtLink } = require(R+'/src/browser-ext-link');
const { createBrowserDriver } = require(R+'/src/browser-driver');
const CHROME=os.homedir()+'/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'obshot-'));
  const sock=path.join(dir,'e.sock'), wrapper=path.join(dir,'host.sh');
  fs.writeFileSync(wrapper,'#!/bin/sh\nOBTO_BRIDGE_EXT_SOCK="'+sock+'" exec "'+process.execPath+'" "'+R+'/bin/obto-bridge-native-host.js" "$@"\n',{mode:0o755});
  const id=fs.readFileSync(R+'/extension/EXTENSION_ID','utf8').trim();
  const man=JSON.stringify({name:'co.obto.bridge',description:'test',path:wrapper,type:'stdio',allowed_origins:['chrome-extension://'+id+'/']});
  const profile=path.join(dir,'profile');
  const cftDir=path.join(os.homedir(),'Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts');
  const cftMan=path.join(cftDir,'co.obto.bridge.json'); const old=fs.existsSync(cftMan)?fs.readFileSync(cftMan):null;
  for (const d of [path.join(profile,'NativeMessagingHosts'), cftDir]) { fs.mkdirSync(d,{recursive:true}); fs.writeFileSync(path.join(d,'co.obto.bridge.json'),man); }
  const link=createExtLink({socketPath:sock}); await link.start();
  const ctx=await chromium.launchPersistentContext(profile,{headless:false,executablePath:CHROME,viewport:{width:1280,height:900},deviceScaleFactor:2,args:['--window-size=1280,900','--disable-extensions-except='+R+'/extension','--load-extension='+R+'/extension']});
  let welcome; const tw=Date.now(); while(!welcome && Date.now()-tw<8000){ await new Promise(r=>setTimeout(r,200)); welcome=ctx.pages().find(p=>p.url().includes('welcome.html')); }
  for (const [w,h,scheme] of [[1100,720,'light'],[1100,720,'dark']]) {
    await welcome.setViewportSize({width:w,height:h}); await welcome.emulateMedia({colorScheme:scheme});
    await welcome.waitForTimeout(400);
    await welcome.screenshot({path:path.join(OUT,'welcome-'+scheme+'.png'),fullPage:true});
  }
  await welcome.emulateMedia({colorScheme:'light'});
  await welcome.click('#agree');
  const t0=Date.now(); while(!link.connected() && Date.now()-t0<15000) await new Promise(r=>setTimeout(r,200));
  const drv=createBrowserDriver({ext:link,auditPath:path.join(dir,'a.jsonl'),launcher:async()=>{throw new Error('no')}});
  const exp=()=>new Date(Date.now()+25000).toISOString(); let n=0;
  const cfg={browserGrants:{'ycombinator.com':'read','wikipedia.org':'read'}};
  const run=(action,args)=>drv.run({cmdId:'c'+(++n),runId:'shot',action,args,expiresAt:exp()},cfg);
  await run('open',{url:'https://news.ycombinator.com/'});
  await run('open',{url:'https://en.wikipedia.org/wiki/Web_browser'});
  const pop=await ctx.newPage();
  await pop.goto('chrome-extension://'+id+'/popup.html');
  for (const scheme of ['light','dark']) {
    await pop.emulateMedia({colorScheme:scheme}); await pop.setViewportSize({width:340,height:260}); await pop.waitForTimeout(800);
    const h=await pop.evaluate(()=>document.documentElement.scrollHeight); const wd=await pop.evaluate(()=>document.documentElement.scrollWidth);
    await pop.setViewportSize({width:Math.max(wd,300),height:h});
    await pop.screenshot({path:path.join(OUT,'popup-'+scheme+'.png')});
  }
  console.log('linked', link.connected(), 'status text:', await pop.textContent('#status'));
  await ctx.close(); link.close();
  if (old) fs.writeFileSync(cftMan,old); 
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
