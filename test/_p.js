const { chromium } = require('playwright-core');
(async()=>{const b=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
for (const [w,h] of [[1366,768]]) for (const m of ['practice']){
const c=await b.newContext({viewport:{width:w,height:h},reducedMotion:'reduce'});const p=await c.newPage();
await p.goto('http://localhost:3000/',{waitUntil:'load'});await p.waitForTimeout(500);
await p.click('[data-fmt="'+m+'"]').catch(async()=>{await p.click('#'+m).catch(()=>{})});await p.waitForTimeout(200);await p.click('#menu-start');await p.waitForTimeout(1500);
const r=await p.evaluate(()=>{const t=document.getElementById('table').getBoundingClientRect();const v=document.getElementById('view-game');return {cls:v&&v.className,table:[Math.round(t.left),Math.round(t.top),Math.round(t.width),Math.round(t.height)],vw:innerWidth}});
console.log(w+'x'+h,m,JSON.stringify(r));await p.screenshot({path:'.e2e-shots/pos-'+m+'-'+w+'.png'});await c.close();}
await b.close();})();
