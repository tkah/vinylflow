const fs=require('fs');
const src=fs.readFileSync(require('path').join(__dirname,'..','..','backend','static','app.js'),'utf8');
const vinylApp=new Function(src+';return vinylApp;')();
const assert=require('assert');
function mk(){const a=vinylApp();return a;}
const T=(p,d)=>({position:p,title:'t'+p,duration:d});
const two={id:1,tracks:[T('A1','4:00'),T('A2','5:00'),T('A3','3:00'),T('B1','5:00'),T('B2','6:00')]}; // A=720 B=660 all=1380
const partial={id:2,tracks:[T('A1','4:00'),T('A2',''),T('B1','5:00')]};
const numeric={id:3,tracks:[T('1','3:00'),T('2','4:00'),T('3','')]};
const empty={id:4,tracks:[]};
const a=mk();
assert.deepStrictEqual(a.releaseDurationInfo(two),{total:5,withDuration:5,status:'full'});
assert.deepStrictEqual(a.releaseDurationInfo(partial),{total:3,withDuration:2,status:'partial'});
assert.strictEqual(a.releaseDurationInfo(numeric).status,'partial');
assert.deepStrictEqual(a.releaseDurationInfo(empty),{total:0,withDuration:0,status:'none'});
assert.strictEqual(a.releaseDurationInfo({tracks:[T('A1','')]}).status,'none');
const g=a.releaseSides(two);
assert.deepStrictEqual(g.map(x=>[x.side,x.tracks.length,x.totalSeconds]),[['A',3,720],['B',2,660]]);
assert.strictEqual(g[1].tracks[0].releaseIdx,3);
assert.strictEqual(a.sidesSummary(two),'A·3  B·2');
assert.deepStrictEqual(a.releaseSides(partial).map(x=>x.totalSeconds),[null,300]);
const ng=a.releaseSides(numeric); assert.strictEqual(ng.length,1); assert.strictEqual(ng[0].side,''); assert.strictEqual(a.sidesSummary(numeric),'All·3');
assert.deepStrictEqual(a.releaseSides(empty),[]);
assert.strictEqual(a.sidesSummary(empty),'');
// suggestions
assert.deepStrictEqual(a.suggestSides(two,700),{sides:['A'],matched:true,reason:'length'});
assert.deepStrictEqual(a.suggestSides(two,650),{sides:['B'],matched:true,reason:'length'});
assert.deepStrictEqual(a.suggestSides(two,1400),{sides:['A','B'],matched:true,reason:'length'});
assert.deepStrictEqual(a.suggestSides(two,3000),{sides:['A','B'],matched:false,reason:'default'});
assert.deepStrictEqual(a.suggestSides(partial,300),{sides:['B'],matched:true,reason:'length'});
assert.deepStrictEqual(a.suggestSides(partial,0),{sides:['A','B'],matched:false,reason:'default'});
assert.deepStrictEqual(a.suggestSides(numeric,100),{sides:[''],matched:false,reason:'single'});
assert.deepStrictEqual(a.suggestSides(empty,100),{sides:[],matched:false,reason:'single'});

const b=mk(); b.currentFile={duration:650}; b.detectedTracks=[1,2,3,4,5].map(n=>({number:n,ignored:false}));
b.selectedRelease=two; b.selectedSides=['B'];
assert.deepStrictEqual(b.targetTracks.map(t=>t.releaseIdx),[3,4]);
b.resetMappingToTargets();
assert.deepStrictEqual(b.customMapping,[3,4,4,4,4]);
assert.strictEqual(b.trackCountMismatch,true);
b.detectedTracks=[1,2].map(n=>({number:n,ignored:false})); b.resetMappingToTargets();
assert.deepStrictEqual(b.customMapping,[3,4]); assert.strictEqual(b.trackCountMismatch,false);
b.reverseMapping(); assert.deepStrictEqual(b.customMapping,[4,3]); assert.strictEqual(b.trackMappingReversed,true);
b.reverseMapping(); assert.deepStrictEqual(b.customMapping,[3,4]);
b.selectedSides=['A','B']; assert.deepStrictEqual(b.targetTracks.map(t=>t.releaseIdx),[0,1,2,3,4]);
b.selectedSides=['B','A']; assert.deepStrictEqual(b.targetTracks.map(t=>t.releaseIdx),[0,1,2,3,4]);
const tick=()=>new Promise(r=>setImmediate(r));
let calls=[];
global.fetch=async(url,opts)=>{ const body=JSON.parse(opts.body); calls.push(url+':'+body.expected_tracks);
  return {ok:true,json:async()=>({tracks:Array.from({length:body.expected_tracks},(_,i)=>({number:i+1,start:i*10,end:i*10+10,duration:10})),method:'count',matched:true,boundaries:[]})}; };
const wire=x=>{ x.currentFileId='f'; x.uploadedFiles=[{id:'f',filename:'a.wav'}]; x.$nextTick=async()=>{}; x.$refs={}; x.initWaveform=async()=>{}; return x; };
wire(b);
(async()=>{
b.analyzing=false; b.selectedSides=['A']; b.toggleSide('B'); await tick(); assert.deepStrictEqual(b.selectedSides,['A','B']);
b.toggleSide('A'); await tick(); assert.deepStrictEqual(b.selectedSides,['B']);
b.toggleSide('B'); await tick(); assert.deepStrictEqual(b.selectedSides,['B']);
assert.deepStrictEqual(calls,['/api/analyze-guided:5','/api/analyze-guided:2']);
const c=wire(mk()); c.currentFile={duration:700};
c.selectRelease(two); await tick(); assert.deepStrictEqual(c.selectedSides,['A']); assert.strictEqual(c.sidesMatchedByDuration,true); assert.strictEqual(calls[calls.length-1],'/api/analyze-guided:3');
const d=wire(mk()); d.currentFile={duration:700}; d.detectedTracks=[{ignored:false}]; let n0=calls.length;
d.selectRelease(empty); await tick(); assert.strictEqual(calls.length,n0); assert.deepStrictEqual(d.customMapping,[0]);
const e=wire(mk()); e.currentFile={duration:420}; e.selectRelease(numeric); await tick();
assert.deepStrictEqual(e.selectedSides,['']); assert.strictEqual(e.targetTracks.length,3);
const f=mk(); f.searchResults=[two,partial,numeric,empty]; assert.strictEqual(f.filteredResults.length,4); f.onlyWithLengths=true; assert.deepStrictEqual(f.filteredResults.map(r=>r.id),[1]);

// ---- Slice 1b: presets, 4-side suggestions, multi-file ----
const four={id:10,artist:'X',title:'Y',tracks:[T('A1','10:00'),T('A2','10:00'),T('B1','10:00'),T('B2','10:00'),T('C1','12:00'),T('C2','12:00'),T('D1','12:00'),T('D2','12:00')]}; // A=1200 B=1200 C=1440 D=1440 total 5280
const fourNoLen={id:11,artist:'X',title:'Z',tracks:['A1','A2','B1','B2','C1','C2','D1','D2'].map(p=>T(p,''))};
const q=mk();
assert.deepStrictEqual(q.suggestSides(four,5280).sides,['A','B','C','D']);
assert.strictEqual(q.suggestSides(four,5280).reason,'length');
assert.deepStrictEqual(q.suggestSides(four,2400).sides,['A','B']);   // Disc 1 (A+B=2400)
assert.deepStrictEqual(q.suggestSides(four,2880).sides,['C','D']);   // Disc 2
assert.deepStrictEqual(q.suggestSides(four,1440).sides,['C']);       // exact C or D; C+? single wins
// side B alone: use a release where B is distinctive
const four2={id:12,tracks:[T('A1','5:00'),T('B1','9:00'),T('C1','20:00'),T('D1','30:00')]}; // A=300 B=540 C=1200 D=1800
assert.deepStrictEqual(q.suggestSides(four2,540).sides,['B']);
// no lengths -> full album
assert.deepStrictEqual(q.suggestSides(fourNoLen,3000),{sides:['A','B','C','D'],matched:false,reason:'default'});
assert.deepStrictEqual(q.suggestSides(four,0),{sides:['A','B','C','D'],matched:false,reason:'default'});
assert.deepStrictEqual(q.suggestSides(four,50000).sides,['A','B','C','D']); // no candidate within 15%
// other file used A/B -> C/D
assert.deepStrictEqual(q.suggestSides(fourNoLen,3000,['A','B']),{sides:['C','D'],matched:false,reason:'default'});
assert.deepStrictEqual(q.suggestSides(fourNoLen,3000,['A']),{sides:['C','D'],matched:false,reason:'default'});
assert.deepStrictEqual(q.suggestSides(fourNoLen,3000,['A','B','C','D']).sides,['A','B','C','D']);
// exclusion applies to length matches too: recording ~ disc1 but disc1 used -> not A+B
assert.ok(!q.suggestSides(four,2400,['A','B']).sides.includes('A'));
// tie-break: A=B=C=D=600 sides; rec 1200: A+B, B+C, C+D tie -> disc-aligned A+B (first aligned)
const eq={id:13,tracks:[T('A1','10:00'),T('B1','10:00'),T('C1','10:00'),T('D1','10:00')]};
assert.deepStrictEqual(q.suggestSides(eq,1200).sides,['A','B']);
// full vs aligned near-tie prefers full album: 2-side-ish: rec ~ total, sides A+B+C+D vs A+B+C within 1pp
const eq2={id:14,tracks:[T('A1','10:00'),T('B1','10:00'),T('C1','10:00'),T('D1','0:30')]}; // total 1830 vs ABC 1800 (1.6% apart)
assert.deepStrictEqual(q.suggestSides(eq2,1815).sides,['A','B','C','D']); // diffs .008 vs .008 -> full wins
// tie: non-aligned (B+C) vs single is not a tie; aligned beats misaligned when equal
const eq3={id:15,tracks:[T('A1','1:00'),T('B1','10:00'),T('C1','10:00'),T('D1','1:00')]}; // B+C=1200, A+B=660,C+D=660, ABCD=1320
assert.deepStrictEqual(q.suggestSides(eq3,1260).sides,['A','B','C']);
// presets
const p=mk(); p.selectedRelease=four; p.selectedSides=['A','B'];
let pr=p.sidePresets; assert.deepStrictEqual(pr.map(x=>x.label),['Full album','Disc 1 (A/B)','Disc 2 (C/D)']);
assert.strictEqual(pr[0].trackCount,8); assert.strictEqual(pr[0].totalSeconds,5280); assert.strictEqual(pr[1].totalSeconds,2400);
assert.ok(p.sidesEqualSelection(pr[1].sides)); assert.ok(!p.sidesEqualSelection(pr[0].sides));
p.selectedRelease=fourNoLen; assert.strictEqual(p.sidePresets[0].totalSeconds,null);
p.selectedRelease=two; pr=p.sidePresets; assert.deepStrictEqual(pr.map(x=>x.label),['Full album']);
p.selectedRelease=numeric; assert.deepStrictEqual(p.sidePresets,[]);
let pc=calls.length; wire(p); p.uploadedFiles=[{id:'f',filename:'a.wav'}]; p.currentFileId='f1'; p.uploadedFiles=[{id:'f1',filename:'a.wav'}];
p.selectedRelease=four; p.selectedSides=['A','B']; p.applyPreset(['C','D']); await tick(); assert.deepStrictEqual(p.selectedSides,['C','D']); assert.deepStrictEqual(calls.slice(pc),['/api/analyze-guided:4']);
assert.deepStrictEqual(p.releaseChoices.f1.sides,['C','D']);
// multi-file
const m=mk(); m.discogsConfigured=false; m.redetectForTargets=async()=>true;
m.uploadedFiles=[{id:'f1',filename:'Disc One Side AB.wav',duration:3000},{id:'f2',filename:'Disc Two.wav',duration:3000}];
m.currentFileId='f1'; m.currentFile=m.uploadedFiles[0]; m.selectRelease(fourNoLen);
assert.deepStrictEqual(m.selectedSides,['A','B','C','D']); // nothing used, no lengths -> full
m.toggleSide('C'); m.toggleSide('D'); assert.deepStrictEqual(m.releaseChoices.f1.sides,['A','B']);
m.currentFileId='f2'; m.currentFile=m.uploadedFiles[1]; m.selectedRelease=null; m.selectedSides=[];
assert.strictEqual(m.sameReleaseShortcuts.length,1); assert.strictEqual(m.sameReleaseShortcuts[0].fileId,'f1');
assert.deepStrictEqual(Object.keys(m.sidesUsedByOthers(fourNoLen)).sort(),['A','B']);
assert.strictEqual(m.shortFilename('Disc One Side AB.wav'),'Disc One Side AB'.length>18?'x':'Disc One Side AB');
m.selectRelease(m.sameReleaseShortcuts[0].release);
assert.deepStrictEqual(m.selectedSides,['C','D']); assert.strictEqual(m.sidesSuggestionReason,'default');
assert.ok(m.defaultScopeNote.includes('not used'));
m.currentFileId='f1'; assert.strictEqual(m.sameReleaseShortcuts.length,1); assert.strictEqual(m.sameReleaseShortcuts[0].fileId,'f2');
// changeRelease forgets, removeFile forgets
m.currentFileId='f2'; m.changeRelease(); assert.ok(!('f2' in m.releaseChoices));
m.selectRelease(fourNoLen); assert.ok('f2' in m.releaseChoices);
global.fetch=async()=>({});
m.removeFile('f1'); assert.ok(!('f1' in m.releaseChoices)); assert.strictEqual(m.sameReleaseShortcuts.length,0); console.log('ALL OK',calls);

})().catch(e=>{console.error(e);process.exit(1)});
