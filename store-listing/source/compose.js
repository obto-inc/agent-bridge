const fs=require('fs'),path=require('path'),os=require('os');
const { chromium } = require('/Users/divyanshverma/WebstormProjects/obto-inc-agent-bridge/node_modules/playwright-core');
const CHROME=os.homedir()+'/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const RAW=path.join(__dirname,'raw'), OUT=path.join(__dirname,'out'); fs.mkdirSync(OUT,{recursive:true});
const css=`@font-face{font-family:Figtree;src:url(Figtree-Variable.woff2) format("woff2");font-weight:300 900}
*{box-sizing:border-box;margin:0}body{font-family:Figtree,sans-serif;background:#F5F3EF;color:#121214;-webkit-font-smoothing:antialiased}
.shot{width:1280px;height:800px;display:grid;grid-template-columns:440px 1fr;gap:56px;padding:64px 64px 64px 72px;align-items:center;position:relative}
.lock{position:absolute;left:72px;top:56px;height:30px}
h1{font-size:52px;line-height:1.06;font-weight:800;letter-spacing:-.035em}
p{font-size:22px;line-height:1.45;color:#5E5C66;margin-top:20px;font-weight:450}
.stage{display:flex;align-items:center;justify-content:center;height:100%}
.card{background:#fff;border:1px solid #E2DFD9;border-radius:28px;padding:28px;box-shadow:0 1px 2px rgba(18,18,20,.04),0 12px 32px rgba(18,18,20,.06);overflow:hidden}
.cap{background:#FAF9F6!important}.card img{display:block;max-width:100%;}
.foot{position:absolute;left:72px;bottom:52px;font-size:15px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#5E5C66;display:flex;align-items:center;gap:10px}
.dot{width:10px;height:10px;border-radius:50%;background:#7C6CF2;display:inline-block}`;
const shot=(h,p,inner,foot)=>`<div class="shot"><img class="lock" src="obto-lockup.svg"><div><h1>${h}</h1><p>${p}</p></div><div class="stage">${inner}</div><div class="foot"><span class="dot"></span>${foot}</div></div>`;
const pages={
 'screenshot-1-reads-your-pages':shot('Your AI agent, in your own Chrome','Ask in OBTO. The agent opens and reads pages in its own tab group, signed in as you.','<div class="card cap" style="width:680px"><img src="result.png" style="width:624px"></div>','Works where you are signed in'),
 'screenshot-2-approve-each-site':shot('You approve every site','Before the agent uses a new site, OBTO asks you. For one task, or for longer.','<div class="card cap" style="width:560px;position:relative"><img src="card.png" style="width:504px"></div>','Site by site, your call'),
 'screenshot-3-consent-first':shot('Nothing starts until you agree','The extension shows what leaves your computer and what never does, before it connects.','<div class="card" style="width:600px;height:548px;padding:0"><img src="welcome-light.png" style="width:1031px;max-width:none;margin-left:-216px;margin-top:-38px"></div>','Clear consent, in plain words'),
 'screenshot-4-stop-any-time':shot('Stop it at any time','One click on Stop ends the agent\'s use of your browser. Switch it off whenever you like.','<div class="card" style="padding:28px 32px 8px"><img src="popup-light.png" style="width:440px"></div>','You stay in control'),
 'screenshot-5-you-press-send':shot('It prepares. You press send.','The agent never sends, posts, buys or deletes for you, and never types passwords or payment details.','<div class="card cap" style="width:680px"><img src="refusal.png" style="width:624px"></div>','Safe by default'),
};
const tile=`<div style="width:440px;height:280px;background:#F5F3EF;padding:36px;display:flex;flex-direction:column;justify-content:space-between">
<div style="display:flex;align-items:center;gap:14px"><img src="obto-app-icon.svg" style="width:56px;height:56px"><div style="font-size:30px;font-weight:800;letter-spacing:-.03em">OBTO agent</div></div>
<div style="font-size:24px;line-height:1.25;font-weight:700;letter-spacing:-.02em">Your AI agent, in your own Chrome.</div>
<div style="font-size:15px;font-weight:600;color:#5E5C66;display:flex;align-items:center;gap:8px"><span class="dot"></span>Only on sites you approve</div></div>`;
const marquee=`<div style="width:1400px;height:560px;background:#F5F3EF;display:grid;grid-template-columns:1fr 600px;gap:64px;padding:72px 80px;align-items:center">
<div><div style="display:flex;align-items:center;gap:16px;margin-bottom:36px"><img src="obto-app-icon.svg" style="width:64px;height:64px"><div style="font-size:34px;font-weight:800;letter-spacing:-.03em">OBTO agent</div></div>
<div style="font-size:60px;line-height:1.04;font-weight:800;letter-spacing:-.035em">Your AI agent, in your own Chrome.</div>
<div style="font-size:22px;color:#5E5C66;margin-top:20px;line-height:1.45">Signed in as you. Only on sites you approve. You press send.</div></div>
<div class="card cap" style="width:600px"><img src="result.png" style="width:544px"></div></div>`;
(async()=>{
  const b=await chromium.launch({executablePath:CHROME}); const pg=await b.newPage({deviceScaleFactor:1});
  const render=async(name,html,w,h)=>{fs.writeFileSync(path.join(RAW,'_'+name+'.html'),`<!doctype html><meta charset=utf-8><style>${css}</style>${html}`);
    await pg.setViewportSize({width:w,height:h}); await pg.goto('file://'+path.join(RAW,'_'+name+'.html')); await pg.evaluate(()=>document.fonts.ready); await pg.waitForTimeout(300);
    const f=await pg.evaluate(()=>[...document.fonts].map(x=>x.family+':'+x.status).join(','));
    await pg.screenshot({path:path.join(OUT,name+'.png'),clip:{x:0,y:0,width:w,height:h}}); console.log(name,f);};
  for (const [n,h] of Object.entries(pages)) await render(n,h,1280,800);
  await render('promo-small-440x280',tile,440,280);
  await render('promo-marquee-1400x560',marquee,1400,560);
  fs.copyFileSync(path.join(RAW,'icon128.png'),path.join(OUT,'store-icon-128.png'));
  await b.close();
})();
