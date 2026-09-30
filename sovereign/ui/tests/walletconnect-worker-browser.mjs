/** Offline actual-SDK/production-worker probe. Args: UI_DIR DRIVER_DIR CHROMIUM.
 * Run under the repository browser runner's loopback-only OS sandbox. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
const [uiInput, driverInput, chromiumInput] = process.argv.slice(2);
const fixtureRoot = process.env.TCG_BROWSER_ROOT;
if(fixtureRoot)await readFile(join(fixtureRoot,'.tcg-browser-fixture'));
const uiArg=uiInput || (fixtureRoot && join(fixtureRoot,'ui'));
const driverArg=driverInput || process.env.TCG_BROWSER_DRIVER;
const chromiumPath=chromiumInput || process.env.TCG_BROWSER_CHROMIUM;
if (!uiArg || !driverArg || !chromiumPath) throw Error('Expected UI_DIR DRIVER_DIR CHROMIUM');
const ui = await realpath(resolve(uiArg)), root = await realpath(await mkdtemp(join(fixtureRoot ? join(fixtureRoot,'tmp') : tmpdir(), 'cashloom-wc-worker-browser-')));
const { build } = await import(pathToFileURL(join(ui, 'node_modules/vite/dist/node/index.js')).href);
const { chromium } = await import(pathToFileURL(driverArg.endsWith('.mjs') ? driverArg : join(driverArg, 'index.mjs')).href);
let browser, server;
try {
  const entry = join(root, 'entry.js');
  await writeFile(entry, `globalThis.fixtureWorker=()=>new Worker(new URL(${JSON.stringify(join(ui, 'tests/walletconnect-worker.fixture.ts'))},import.meta.url),{type:'module'});`);
  await writeFile(join(root, 'index.html'), '<!doctype html><script type="module" src="/entry.js"></script>');
  await build({ configFile: join(ui, 'vite.config.ts'), root, logLevel: 'error', build: { outDir: join(root, 'dist'), emptyOutDir: true } });
  server = http.createServer(async(req,res)=>{try{
    const pathname = new URL(req.url,'http://localhost').pathname;
    if (!/^\/(?:index.html|assets\/[a-z0-9._-]+)$/i.test(pathname)) throw Error();
    const data=await readFile(join(root,'dist',pathname)); res.setHeader('Content-Type',pathname.endsWith('.js')?'application/javascript':'text/html');res.end(data);
  }catch{res.writeHead(404);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({executablePath:chromiumPath,headless:true,args:['--disable-background-networking','--disable-component-update','--no-first-run']});
  const context=await browser.newContext();let externalRequests=0;
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){externalRequests++;return route.abort();}return route.continue();});
  const page=await context.newPage(), consoleMessages=[];
  page.on('console',message=>consoleMessages.push(message.type()));
  await page.goto(origin+'/index.html');await page.waitForFunction(()=>typeof globalThis.fixtureWorker==='function');
  const results=await page.evaluate(async(origin)=>{
    const all=[];
    async function make(mode='valid') {
      const worker=globalThis.fixtureWorker(), messages=[];
      worker.onmessage=event=>messages.push(event.data);
      const wait=async(predicate)=>{for(let i=0;i<500;i++){const found=messages.find(predicate);if(found)return found;const error=messages.find(message=>message.type==='error');if(error)throw Error('Worker fixture refused: '+error.code);await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Worker fixture timeout; safe phases='+JSON.stringify(messages.map(message=>({type:message.type,initialized:message.initialized,prepared:message.prepared,proposed:!!message.proposedMethods,stage:message.stage}))));};
      await wait(message=>message.prepared);worker.postMessage({type:'fixture_mode',mode});
      worker.postMessage({type:'start',project_id:'0'.repeat(32),origin});
      return {worker,messages,wait};
    }
    const first=await make();const ready=await first.wait(message=>message.type==='ready');
    first.worker.postMessage({type:'confirm',request_id:1,address:ready.accounts[0]});await first.wait(message=>message.type==='confirmed');
    first.worker.postMessage({type:'close'});await first.wait(message=>message.type==='closed');first.worker.terminate();
    all.push({scenario:'valid',reports:first.messages.filter(message=>message.type==='fixture_report'),ready:true,confirmed:true});
    const extra=await make('extra');const refusal=await extra.wait(message=>message.type==='error');extra.worker.terminate();
    all.push({scenario:'extra',code:refusal.code,hasReady:extra.messages.some(message=>message.type==='ready')});
    for(const event of ['session_update','session_event','session_delete','session_expire','session_extend']){
      const value=await make();await value.wait(message=>message.type==='ready');value.worker.postMessage({type:'fixture_event',event});
      const error=await value.wait(message=>message.type==='error');value.worker.terminate();all.push({scenario:event,code:error.code});
    }
    const expired=await make('uri_expired');const expiration=await expired.wait(message=>message.type==='error');expired.worker.terminate();all.push({scenario:'uri_expired',code:expiration.code});
    const late=await make('late');await late.wait(message=>message.type==='pairing');late.worker.postMessage({type:'close'});await late.wait(message=>message.type==='closed');
    late.worker.postMessage({type:'fixture_release'});await new Promise(resolve=>setTimeout(resolve,30));late.worker.terminate();all.push({scenario:'late',hasReady:late.messages.some(message=>message.type==='ready')});
    return all;
  },origin);
  const valid=results.find(result=>result.scenario==='valid');
  const init=valid.reports.find(report=>report.initialized), proposal=valid.reports.find(report=>report.proposedMethods);
  assert.equal(init.httpBlocked,true);assert.equal(init.foreignSocketBlocked,true);assert.equal(init.relayAllowed,true);
  assert.equal(init.underlyingFetches,0);assert.equal(init.underlyingSockets,1);assert.equal(init.globalCoreKeys,0);
  assert.equal(init.telemetryFlag,false);assert.equal(init.restoredSessions,0);assert.equal(init.metadataOriginMatches,true);
  assert.equal(init.memoryStorage,true);assert.equal(valid.reports.find(report=>report.memoryKeysAfterClose!==undefined).memoryKeysAfterClose,0);
  assert.deepEqual(proposal.proposedMethods,[]);assert.deepEqual(proposal.proposedChains,['eip155:8453']);assert.equal(proposal.requiredNamespaceCount,0);
  assert.equal(results.find(result=>result.scenario==='extra').code,'phone_scope_refused');assert.equal(results.find(result=>result.scenario==='extra').hasReady,false);
  for(const event of ['session_update','session_event','session_delete','session_extend'])assert.equal(results.find(result=>result.scenario===event).code,'phone_changed');
  assert.equal(results.find(result=>result.scenario==='session_expire').code,'phone_expired');assert.equal(results.find(result=>result.scenario==='uri_expired').code,'phone_expired');
  assert.equal(results.find(result=>result.scenario==='late').hasReady,false);assert.equal(externalRequests,0);assert.deepEqual(consoleMessages,[]);
  console.log(JSON.stringify({suite:'production-worker-actual-sdk',sdk:'2.25.0',checks:results.length,network:'synthetic relay only',httpBlocked:true,offOriginWebSocketBlocked:true,globalCoreShared:false,restoredSessions:0,externalRequests:0}));
} finally { if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true}); }
