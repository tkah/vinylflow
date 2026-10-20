const fs=require('fs');
const src=fs.readFileSync(require('path').join(__dirname,'..','..','backend','static','app.js'),'utf8');
const vinylApp=new Function(src+';return vinylApp;')();
const assert=require('assert');
const T=(p,t,d)=>({position:p,title:t,duration:d});
const rel={id:1,tracks:[T('A1','One','4:00'),T('A2','A very long title that definitely exceeds the limit','5:00'),T('B1','Three','3:00'),T('B2','Four','')]};
const tick=()=>new Promise(r=>setImmediate(r));

// ---- fake regions plugin ----
function mkRegions(){
  const list=[];
  return {list,
    getRegions:()=>list,
    clearRegions(){ list.length=0; },
    addRegion(o){ const r={...o,end:o.end??o.start,element:{style:{}},remove(){ list.splice(list.indexOf(r),1); },setOptions(x){ Object.assign(r,x); }}; list.push(r); return r; }};
}
function mkApp(){
  const a=vinylApp();
  a.$nextTick=async()=>{}; a.$refs={};
  a.initWaveform=async()=>{ a.waveform={getDuration:()=>600,destroy(){}}; a.waveformRegions=mkRegions(); a.addTrackRegions(); };
  a.currentFileId='f'; a.uploadedFiles=[{id:'f',filename:'a.wav'}]; a.currentFile={duration:600};
  a.waveformRegions=mkRegions(); a.waveform={getDuration:()=>600,destroy(){}};
  return a;
}
const trk=(n,s,e)=>({number:n,start:s,end:e,duration:e-s,editing:false,ignored:false});

(async()=>{
// ---- labels ----
let a=mkApp();
a.detectedTracks=[trk(1,0,100),trk(2,100,200),trk(3,200,300)];
assert.strictEqual(a.regionLabel(a.detectedTracks[0]),'Track 1');           // no release
a.selectedRelease=rel; a.customMapping=[0,'1',2];                            // string from <select>
assert.strictEqual(a.regionLabel(a.detectedTracks[0]),'A1 · One');
assert.ok(a.regionLabel(a.detectedTracks[1]).startsWith('A2 · A very long title'));
assert.ok(a.regionLabel(a.detectedTracks[1]).endsWith('…'));
assert.ok(a.regionLabel(a.detectedTracks[1]).length<=5+28);
a.detectedTracks[2].ignored=true;
assert.strictEqual(a.regionLabel(a.detectedTracks[2]),'Ignored: B1 · Three');
a.selectedRelease=null; assert.strictEqual(a.regionLabel(a.detectedTracks[2]),'Ignored: Track 3');
a.selectedRelease=rel;
// live update in place
a.addTrackRegions();
const regs=a.waveformRegions.list; const r1=regs.find(r=>r.id==='track-1');
assert.strictEqual(r1.content,'A1 · One');
a.setMapping(0,'2'); assert.strictEqual(a.customMapping[0],2); assert.strictEqual(r1.content,'B1 · Three');
assert.strictEqual(regs.find(r=>r.id==='track-1'),r1); // same object, not rebuilt
a.detectedTracks[2].ignored=false;
// reverse
a.selectedSides=['A','B']; a.detectedTracks=[trk(1,0,100),trk(2,100,200),trk(3,200,300),trk(4,300,400)];
a.resetMappingToTargets(); a.addTrackRegions();
assert.deepStrictEqual(a.customMapping,[0,1,2,3]);
a.reverseMapping(); assert.deepStrictEqual(a.customMapping,[3,2,1,0]);
assert.strictEqual(a.waveformRegions.list.find(r=>r.id==='track-1').content,'B2 · Four');
assert.strictEqual(a.waveformRegions.list.find(r=>r.id==='track-4').content,'A1 · One');
a.reverseMapping(); assert.strictEqual(a.waveformRegions.list.find(r=>r.id==='track-1').content,'A1 · One');
// changeRelease -> Track N
a.changeRelease(); assert.strictEqual(a.waveformRegions.list.find(r=>r.id==='track-1').content,'Track 1');

// ---- delta + buckets ----
a=mkApp(); a.selectedRelease=rel; a.customMapping=[0,1,2,3];
const dt=(d)=>({duration:d});
assert.strictEqual(a.trackDelta(dt(243),0),3);  assert.strictEqual(a.deltaBucket(3),'good');
assert.strictEqual(a.trackDelta(dt(236),0),-4); assert.strictEqual(a.deltaBucket(-4),'warn');
assert.strictEqual(a.deltaBucket(10),'warn');   assert.strictEqual(a.deltaBucket(10.5),'bad');
assert.strictEqual(a.deltaBucket(-30),'bad');   assert.strictEqual(a.deltaBucket(0),'good');
assert.strictEqual(a.trackDelta(dt(100),3),null);       // no Discogs length
assert.strictEqual(a.deltaText(null),'—'); assert.strictEqual(a.deltaBucket(null),'none');
assert.strictEqual(a.deltaText(4.2),'+4s'); assert.strictEqual(a.deltaText(-12),'−12s');
assert.strictEqual(a.discogsLength(1),300); assert.strictEqual(a.discogsLength(3),null);
a.selectedRelease=null; assert.strictEqual(a.trackDelta(dt(100),0),null);
assert.notStrictEqual(a.deltaColor(1),a.deltaColor(5)); assert.notStrictEqual(a.deltaColor(5),a.deltaColor(50));
// swatch == region colour
a=mkApp(); a.detectedTracks=[trk(1,0,100),trk(2,100,200)]; a.detectedTracks[1].ignored=true; a.addTrackRegions();
assert.strictEqual(a.trackSwatchColor(a.detectedTracks[0],0),a.waveformRegions.list.find(r=>r.id==='track-1').color);
assert.strictEqual(a.trackSwatchColor(a.detectedTracks[1],1),a.waveformRegions.list.find(r=>r.id==='track-2').color);

// ---- neighbour push rules ----
a=mkApp(); a.detectedTracks=[trk(1,0,100),trk(2,110,200),trk(3,200,300)]; a.addTrackRegions();
const R=n=>a.waveformRegions.list.find(r=>r.id==='track-'+n);
// gap preserved: shrink track 1's end, neighbour untouched
R(1).end=90; a.updateTrackFromRegion(R(1));
assert.strictEqual(a.detectedTracks[0].end,90); assert.strictEqual(a.detectedTracks[0].duration,90);
assert.strictEqual(a.detectedTracks[1].start,110); assert.strictEqual(a.boundariesEdited,true);
// extend within gap: still untouched
R(1).end=105; a.updateTrackFromRegion(R(1)); assert.strictEqual(a.detectedTracks[1].start,110);
// overlap pushes next start
R(1).end=130; a.updateTrackFromRegion(R(1));
assert.strictEqual(a.detectedTracks[1].start,130); assert.strictEqual(a.detectedTracks[1].duration,70); assert.strictEqual(R(2).start,130);
// start before prev.end pushes prev end
R(3).start=150; a.updateTrackFromRegion(R(3));
assert.strictEqual(a.detectedTracks[2].start,150); assert.strictEqual(a.detectedTracks[1].end,150); assert.strictEqual(a.detectedTracks[1].duration,20); assert.strictEqual(R(2).end,150);
// start dragged into a gap only (after prev.end) leaves prev
a=mkApp(); a.detectedTracks=[trk(1,0,80),trk(2,100,200)]; a.addTrackRegions();
R(2).start=90; a.updateTrackFromRegion(R(2)); assert.strictEqual(a.detectedTracks[0].end,80);
// minimum length: end cannot invert
a=mkApp(); a.detectedTracks=[trk(1,0,100),trk(2,100,200)]; a.addTrackRegions();
R(1).end=-5; a.updateTrackFromRegion(R(1));
assert.ok(a.detectedTracks[0].end-a.detectedTracks[0].start>=1-1e-9); assert.strictEqual(R(1).end,a.detectedTracks[0].end);
// cannot squash neighbour below minimum
R(1).end=199.9; a.updateTrackFromRegion(R(1));
assert.ok(a.detectedTracks[1].end-a.detectedTracks[1].start>=1-1e-9); assert.strictEqual(a.detectedTracks[1].end,200);
// inline inputs follow the same rules and update regions
a=mkApp(); a.detectedTracks=[trk(1,0,100),trk(2,110,200)]; a.addTrackRegions();
a.updateTrackEnd(0,'90'); assert.strictEqual(a.detectedTracks[1].start,110); assert.strictEqual(R(1).end,90);
a.updateTrackEnd(0,'120'); assert.strictEqual(a.detectedTracks[1].start,120); assert.strictEqual(R(2).start,120); assert.strictEqual(a.detectedTracks[1].duration,80);
a.updateTrackStart(1,'119.5'); assert.strictEqual(a.detectedTracks[0].end,119.5); assert.strictEqual(R(1).end,119.5);
a.updateTrackStart(1,'199.9'); assert.ok(a.detectedTracks[1].end-a.detectedTracks[1].start>=1-1e-9);
// unchanged values (e.g. label refresh echo) are not an edit
a=mkApp(); a.detectedTracks=[trk(1,0,100)]; a.addTrackRegions(); a.updateTrackFromRegion(R(1)); assert.strictEqual(a.boundariesEdited,false);
a.selectedRelease=rel; a.customMapping=[0]; a.refreshRegionLabels(); assert.strictEqual(a.boundariesEdited,false);

// ---- expected- regions ignored ----
a=mkApp(); a.detectedTracks=[trk(1,0,100),trk(2,100,200)]; a.expectedBoundaries=[100,150]; a.addTrackRegions();
const ghosts=a.waveformRegions.list.filter(r=>r.id.startsWith('expected-'));
assert.strictEqual(ghosts.length,2); assert.ok(ghosts.every(g=>g.drag===false&&g.resize===false&&g.end===g.start));
const before=JSON.stringify(a.detectedTracks);
ghosts[0].start=10; ghosts[0].end=10; a.updateTrackFromRegion(ghosts[0]);
assert.strictEqual(JSON.stringify(a.detectedTracks),before); assert.strictEqual(a.boundariesEdited,false);
a.selectedRelease=rel; a.customMapping=[0,1]; a.refreshRegionLabels();
assert.strictEqual(ghosts[0].content,undefined);
a.clearExpectedMarkers(); assert.strictEqual(a.waveformRegions.list.filter(r=>r.id.startsWith('expected-')).length,0);
assert.strictEqual(a.waveformRegions.list.length,2); assert.deepStrictEqual(a.expectedBoundaries,[]);

// ---- boundariesEdited flow ----
a=mkApp(); const calls=[]; let resp;
const guided=(n,method)=>({ok:true,json:async()=>({tracks:Array.from({length:n},(_,i)=>({number:i+1,start:i*100,end:i*100+100,duration:100})),method:method||'durations',matched:true,
  boundaries:Array.from({length:n-1},(_,i)=>({index:i+1,expected:(i+1)*95,snapped:true,position:(i+1)*100,gap:null})),music_start:0,music_end:n*100})});
global.fetch=async(url,opts)=>{ calls.push(url); return guided(JSON.parse(opts.body).expected_tracks); };
a.currentFile={duration:0}; a.selectRelease(rel); await tick(); await tick();
assert.deepStrictEqual(calls,['/api/analyze-guided']);
assert.deepStrictEqual(a.selectedSides,['A','B']); assert.strictEqual(a.detectedTracks.length,4);
assert.deepStrictEqual(a.expectedBoundaries,[95,190,285]);                        // durations -> markers
assert.strictEqual(a.boundariesEdited,false);
// count method clears markers
global.fetch=async(url,opts)=>{ calls.push(url); return guided(JSON.parse(opts.body).expected_tracks,'count'); };
await a.redetectForTargets(); assert.deepStrictEqual(a.expectedBoundaries,[]);
global.fetch=async(url,opts)=>{ calls.push(url); return guided(JSON.parse(opts.body).expected_tracks); };
await a.redetectForTargets(); assert.strictEqual(a.expectedBoundaries.length,3);
calls.length=0;
// user edits
a.addTrackRegions(); a.waveformRegions.list.find(r=>r.id==='track-1').end=60; a.updateTrackFromRegion(a.waveformRegions.list.find(r=>r.id==='track-1'));
assert.strictEqual(a.boundariesEdited,true);
a.selectedSides=['A']; a.toggleSide('B');                                    // change sides with edits
await tick();
assert.deepStrictEqual(calls,[]); assert.strictEqual(a.editBanner,true);
assert.deepStrictEqual(a.expectedBoundaries,[]);
assert.deepStrictEqual(a.customMapping.length,4);
a.applyPreset(['A']); await tick(); assert.deepStrictEqual(calls,[]);
a.selectRelease(rel); await tick(); assert.deepStrictEqual(calls,[]);       // release change too
// keep my edits
a.keepMyEdits(); assert.strictEqual(a.editBanner,false); assert.strictEqual(a.boundariesEdited,true); assert.deepStrictEqual(calls,[]);
// snap + undo
const edited=JSON.parse(JSON.stringify(a.detectedTracks)); const editedMap=[...a.customMapping];
a.editBanner=true;
await a.snapToDiscogs();
assert.deepStrictEqual(calls,['/api/analyze-guided']); assert.strictEqual(a.editBanner,false);
assert.strictEqual(a.boundariesEdited,false); assert.ok(a.snapUndo); assert.ok(a.snapNotice.startsWith('Snapped'));
assert.notDeepStrictEqual(a.detectedTracks.map(t=>t.end),edited.map(t=>t.end));
a.undoSnap();
assert.deepStrictEqual(JSON.parse(JSON.stringify(a.detectedTracks)),edited);
assert.deepStrictEqual(a.customMapping,editedMap); assert.strictEqual(a.boundariesEdited,true);
assert.strictEqual(a.snapUndo,null);
assert.strictEqual(a.waveformRegions.list.find(r=>r.id==='track-1').end,edited[0].end); // regions rebuilt from snapshot
// editing after a snap drops the undo
await a.snapToDiscogs(); assert.ok(a.snapUndo); a.markEdited(); assert.strictEqual(a.snapUndo,null);
// no release -> snap does nothing
const na=mkApp(); const n0=calls.length; await na.snapToDiscogs(); assert.strictEqual(calls.length,n0);
// non-guided path clears flags and markers
a.expectedBoundaries=[1,2]; a.boundariesEdited=true; a.setDetectedTracks([{number:1,start:0,end:5,duration:5}]);
assert.deepStrictEqual(a.expectedBoundaries,[]); assert.strictEqual(a.boundariesEdited,false);
// split / delete mark edited
a=mkApp(); a.detectedTracks=[trk(1,0,100),trk(2,100,200)]; a.contextMenu={time:50}; a.splitAtContextMenu(); assert.strictEqual(a.boundariesEdited,true);
assert.strictEqual(a.detectedTracks.length,3);
a.boundariesEdited=false; a.deleteTrack(2); assert.strictEqual(a.boundariesEdited,true);
console.log('slice3 ok');
})().catch(e=>{console.error(e);process.exit(1)});
