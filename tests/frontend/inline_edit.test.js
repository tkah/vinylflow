const fs=require('fs');
const src=fs.readFileSync(require('path').join(__dirname,'..','..','backend','static','app.js'),'utf8');
const vinylApp=new Function(src+';return vinylApp;')();
const assert=require('assert');
const T=(p,d)=>({position:p,title:'t'+p,duration:d});
const mk=()=>vinylApp();
// album 2532s over A/B
const album={id:1,tracks:[T('A1','20:00'),T('A2','1:10'),T('B1','21:00')]};          // 2530... A=1270 B=1260 all=2530
const lp2={id:2,tracks:[T('A1','10:00'),T('B1','10:00'),T('C1','10:50'),T('D1','10:50')]}; // disc1=1200 disc2=1300 all=2500
const single={id:3,tracks:[T('1','40:00')]};
const big={id:4,tracks:[T('A1','30:00'),T('B1','25:12')]};                              // 3312
const nolen={id:5,tracks:[T('A1',''),T('B1','')]};
const a=mk(); a.currentFile={duration:2600,musicDuration:2551};
let fit=a.cardFit(album);
assert.strictEqual(fit.state,'fit');
assert.strictEqual(a.fitText(fit),'Full album 42:10 · your music 42:31 ✓');
a.currentFile={duration:1325};
fit=a.cardFit(lp2); assert.strictEqual(a.fitText(fit),'Disc 2 (C/D) 21:40 · your file 22:05 ✓');
a.currentFile={duration:1190,musicDuration:0};
assert.strictEqual(a.fitText(a.cardFit(lp2)),'Disc 1 (A/B) 20:00 · your file 19:50 ✓');
a.currentFile={duration:2400,musicDuration:2551}; // single side, full match
assert.strictEqual(a.fitText(a.cardFit(single)),'Full album 40:00 · your music 42:31 ✓');
assert.strictEqual(a.fitText(a.cardFit(big)),"Lengths don't fit this file (full album 55:12 vs music 42:31)");
assert.strictEqual(a.cardFit(big).state,'nofit');
assert.strictEqual(a.cardFit(nolen),null);
assert.strictEqual(a.cardFit({id:9,tracks:null}),null);
a.currentFile={duration:0}; assert.strictEqual(a.cardFit(album),null);
a.currentFile={duration:2400}; assert.ok(a.fitText(a.cardFit(big)).includes('vs file 40:00'));

// ordering + filter + best fit
const b=mk(); b.currentFile={duration:2500,musicDuration:2500};
const unloaded={id:6,tracks:null,detailStatus:'pending'};
b.searchResults=[big,album,nolen,lp2,unloaded];
assert.deepStrictEqual(b.filteredResults.map(r=>r.id),[4,1,5,2,6]);   // not settled: Discogs order
assert.strictEqual(b.bestFitId,null);
b.detailsSettled=true;
assert.deepStrictEqual(b.filteredResults.map(r=>r.id),[1,2,4,5,6]);   // fits first, stable
assert.strictEqual(b.bestFitId,2);                                    // 2500 exact vs 2530
b.onlyWithLengths=true;
assert.deepStrictEqual(b.filteredResults.map(r=>r.id),[1,2,4,6]);     // nolen hidden, unloaded kept
b.detailsSettled=false;
assert.deepStrictEqual(b.filteredResults.map(r=>r.id),[4,1,2,6]);

// progressive loader
(async()=>{
  const c=mk();
  c.searchResults=[1,2,3,4,5].map(id=>({id,tracks:null,detailStatus:'pending',opening:false}));
  let active=0,maxActive=0,calls=[];
  global.fetch=async url=>{
    const id=+url.split('/').pop(); calls.push(id); active++; maxActive=Math.max(maxActive,active);
    await new Promise(r=>setTimeout(r,10)); active--;
    return {ok:id!==3,json:async()=>id===3?{detail:'boom'}:({id,tracks:[T('A1','3:00')],artist:'X',title:'Y'})};
  };
  c.searchSeq=1; await c.loadAllReleaseDetails(1);
  assert.strictEqual(maxActive,2); assert.deepStrictEqual(calls,[1,2,3,4,5]);
  assert.strictEqual(c.searchResults[0].tracks.length,1); assert.strictEqual(c.searchResults[0].detailStatus,'loaded');
  assert.strictEqual(c.searchResults[2].detailStatus,'error'); assert.strictEqual(c.searchResults[2].tracks,null);
  assert.strictEqual(c.detailsSettled,true);

  // stops on seq change
  const d=mk(); d.searchSeq=1; calls=[];
  d.searchResults=[1,2,3,4,5,6].map(id=>({id,tracks:null,detailStatus:'pending'}));
  const p=d.loadAllReleaseDetails(1);
  await new Promise(r=>setTimeout(r,15)); d.searchSeq=2; d.searchResults=[];
  await p;
  assert.ok(calls.length<6,'calls '+calls.length); assert.strictEqual(d.detailsSettled,false);

  // click on unloaded: fetch then select; failure -> no select
  const e=mk(); e.searchSeq=1; let sel=[]; e.selectRelease=r=>sel.push(r.id);
  e.searchResults=[{id:7,tracks:null,opening:false},{id:3,tracks:null,opening:false}];
  const pr=e.chooseResult(e.searchResults[0]); assert.strictEqual(e.searchResults[0].opening,true);
  await pr; assert.deepStrictEqual(sel,[7]); assert.strictEqual(e.searchResults[0].opening,false);
  await e.chooseResult(e.searchResults[1]); assert.deepStrictEqual(sel,[7]); assert.strictEqual(e.searchResults[1].detailStatus,'error');
  console.log('slice2b ok');
})().catch(e=>{console.error(e);process.exit(1)});
