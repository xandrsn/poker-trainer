const { chromium } = require('playwright-core');
(async()=>{const b=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const c=await b.newContext({viewport:{width:1920,height:1080},reducedMotion:'reduce'});const p=await c.newPage();
await p.goto('http://localhost:3000/',{waitUntil:'load'});await p.waitForTimeout(500);
await p.click('[data-fmt="table"]');await p.click('#menu-start');await p.waitForTimeout(1500);
console.log(await p.evaluate(()=>{let e=document.getElementById('table'),o=[];while(e&&e!==document.body){const r=e.getBoundingClientRect(),cs=getComputedStyle(e);o.push((e.id||e.className.toString().split(' ')[0])+' '+Math.round(r.left)+'+'+Math.round(r.width)+' disp='+cs.display+' mw='+cs.maxWidth+' mi='+cs.marginInline+' js='+cs.justifySelf+' gtc='+cs.gridTemplateColumns.slice(0,40));e=e.parentElement}return o.join('\n')}));
await b.close();})();
