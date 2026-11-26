const path=require('path'),fs=require('fs'),os=require('os'),http=require('http');
const R=require('path').join(__dirname,'..','..'); // manual run: node test/e2e/extension-e2e.js (needs a playwright Chrome for Testing build)
const { chromium } = require(R+'/node_modules/playwright-core');
const { createExtLink } = require(R+'/src/browser-ext-link');
const { createBrowserDriver } = require(R+'/src/browser-driver');
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'obe2e-'));
  const sock=path.join(dir,'e.sock');
  const wrapper=path.join(dir,'host.sh');
  fs.writeFileSync(wrapper,'#!/bin/sh\nOBTO_BRIDGE_EXT_SOCK="'+sock+'" exec "'+process.execPath+'" "'+R+'/bin/obto-bridge-native-host.js" "$@"\n',{mode:0o755});
  const id=fs.readFileSync(R+'/extension/EXTENSION_ID','utf8').trim();
  const man=JSON.stringify({name:'co.obto.bridge',description:'test',path:wrapper,type:'stdio',allowed_origins:['chrome-extension://'+id+'/']});
  const profile=path.join(dir,'profile');
  const cftDir=path.join(os.homedir(),'Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts');
  for (const d of [path.join(profile,'NativeMessagingHosts'), cftDir]) { fs.mkdirSync(d,{recursive:true}); fs.writeFileSync(path.join(d,'co.obto.bridge.json'),man); }
  const srv=http.createServer((q,r)=>{r.setHeader('content-type','text/html');
    if(q.url.startsWith('/two')) return r.end('<h1>Page two</h1><a href="https://example.org/">offsite</a>');
    r.end('<h1>Test page</h1><label>Name <input id=n name=name></label><label>Password <input type=password name=pw></label><button onclick="document.title=\'clicked:\'+document.getElementById(\'n\').value">Save draft</button><button>Buy now</button><a href="/two">Go two</a>');}).listen(0);
  const port=srv.address().port;
  const link=createExtLink({socketPath:sock}); await link.start();
  const ctx=await chromium.launchPersistentContext(profile,{headless:false,executablePath:process.env.HOME+'/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',args:['--disable-extensions-except='+R+'/extension','--load-extension='+R+'/extension']});
  const t0=Date.now(); while(!link.connected() && Date.now()-t0<15000) await new Promise(r=>setTimeout(r,200));
  console.log('connected',link.connected(),link.info());
  const drv=createBrowserDriver({ext:link,auditPath:path.join(dir,'audit.jsonl'),launcher:async()=>{throw new Error('profile launched!')}});
  const exp=()=>new Date(Date.now()+25000).toISOString();
  const cfg={browserGrants:{localhost:'act','ycombinator.com':'read'}};
  let n=0; const run=async(action,args)=>{const r=await drv.run({cmdId:'c'+(++n),runId:'e2e',action,args,expiresAt:exp()},cfg); const s=JSON.stringify(r); console.log(action, s.length>300?s.slice(0,300)+'…':s); return r;};
  await run('open',{url:'https://news.ycombinator.com/user?id=pg'});
  const rd=await run('read',{}); console.log('karma line:', (rd.result.text.match(/karma:\s*\S+/)||[])[0]);
  await run('open',{url:'http://localhost:'+port+'/'});
  await run('type',{target:'Name',text:'hello'});
  await run('type',{target:'Password',text:'x'});
  await run('click',{target:'Buy now'});
  await run('click',{target:'Save draft'});
  await run('tabs',{});
  await run('click',{target:'Go two'});
  await run('read',{});
  await run('open',{url:'https://example.org/'});
  const sh=await run('screenshot',{}); console.log('shot bytes', sh.result && sh.result.jpegBase64 && sh.result.jpegBase64.length);
  await run('back',{});
  // ungranted landing: click offsite link on page two
  await run('open',{url:'http://localhost:'+port+'/two'});
  await run('click',{target:'offsite'});
  // other tabs invisible: a user tab outside the group
  const p=await ctx.newPage(); await p.goto('http://localhost:'+port+'/');
  await run('tabs',{});
  const pop=await ctx.newPage(); await pop.goto('chrome-extension://'+id+'/popup.html'); await pop.waitForTimeout(500);
  console.log('popup status:', await pop.textContent('#status'));
  await pop.click('#stop'); await pop.waitForTimeout(300);
  console.log('popup msg:', await pop.textContent('#msg'));
  await run('read',{});
  console.log('audit rows', fs.readFileSync(path.join(dir,'audit.jsonl'),'utf8').trim().split('\n').length);
  await ctx.close(); link.close(); srv.close();
  fs.unlinkSync(path.join(cftDir,'co.obto.bridge.json'));
})().catch(e=>{console.error('E2E FAIL',e);process.exit(1)});
