const fs=require('fs'), assert=require('assert');
const src=fs.readFileSync(require('path').join(__dirname,'..','..','backend','static','app.js'),'utf8');
global.document={addEventListener(){},getElementById(){return null;}}; global.window=global; global.WaveSurfer={};
const vinylApp=new Function(src+';return vinylApp;')();

function mkAudio(){
  const h={}; const a={paused:true,currentTime:0,volume:1,duration:100,
    play(){a.paused=false;(h.play||[]).forEach(f=>f());return Promise.resolve();},
    pause(){ if(!a.paused){a.paused=true;(h.pause||[]).forEach(f=>f());} },
    on(ev,fn){(h[ev]=h[ev]||[]).push(fn);}};
  return a;
}
const trk=(n,s,e,ig=false)=>({number:n,start:s,end:e,duration:e-s,ignored:ig});
function mk(){
  const a=vinylApp();
  const o=mkAudio(), p=mkAudio();
  a.$refs={abOriginal:o,abProcessed:p};
  o.on('play',()=>a.abOnPlay('original')); o.on('pause',()=>a.abOnPause('original'));
  p.on('play',()=>a.abOnPlay('processed')); p.on('pause',()=>a.abOnPause('processed'));
  let wp=false; const ws={isPlaying:()=>wp,play(){wp=true;a.isPlaying=true;a.abPause();return Promise.resolve();},
    pause(){ if(wp){wp=false;a.isPlaying=false;} }, getCurrentTime:()=>0,getDuration:()=>600,setTime(){} };
  a.waveform=ws;
  a.currentFileId='f1'; a.currentFile={};
  a.detectedTracks=[trk(1,0,100,true),trk(2,100,200),trk(3,200,300)];
  a.rumbleFilter=true;
  a.saveExportDefault=()=>{};
  return {a,o,p,ws};
}
const result=(ol,pl,extra={})=>({original_url:'/o',processed_url:'/p',original_lufs:ol,processed_lufs:pl,gain_db:null,rumble:true,declick:'off',album:false,sig:'x',...extra});
const near=(x,y)=>assert.ok(Math.abs(x-y)<1e-9,`${x} vs ${y}`);

// default track choice
{ const {a}=mk();
  assert.strictEqual(a.abEffectiveIdx(),1);            // first active (idx0 ignored)
  a.playheadIdx=2; assert.strictEqual(a.abEffectiveIdx(),2);   // under playhead
  a.playheadIdx=0; assert.strictEqual(a.abEffectiveIdx(),1);   // ignored track under playhead -> first active
  a.playheadIdx=-1; a.abSelectTrack('2'); assert.strictEqual(a.abEffectiveIdx(),2);
  a.detectedTracks.forEach(t=>t.ignored=true); assert.strictEqual(a.abEffectiveIdx(),-1);
  assert.ok(!a.abCanRender());
  // labels
  const b=mk().a; assert.strictEqual(b.abTrackLabel(1),'Track 2');
  b.selectedRelease={tracks:[{position:'A1',title:'One'},{position:'A2',title:'Two'},{position:'B1',title:'Three'}]};
  b.customMapping=[0,1,2]; assert.strictEqual(b.abTrackLabel(1),'A2 · Two');
  // render gating
  b.rumbleFilter=false; b.declick='off'; b.albumGain=false; assert.ok(!b.abCanRender());
  b.albumGain=true; assert.ok(b.abCanRender());
  b.albumGain=false; b.declick='light'; assert.ok(b.abCanRender(),'declick alone is testable');
  b.declick='off'; b.rumbleFilter=true; assert.ok(b.abCanRender(),'rumble alone is testable');
}
// match levels
{ const {a,o,p}=mk();
  a.abResult=result(-20,-17); a.abApplyVolumes();            // processed louder by 3
  near(p.volume,Math.pow(10,-3/20)); assert.strictEqual(o.volume,1);
  assert.ok(/3\.0 dB louder; matched for fair comparison/.test(a.abMatchNote()));
  a.abResult=result(-17,-20); a.abApplyVolumes();            // original louder
  near(o.volume,Math.pow(10,-3/20)); assert.strictEqual(p.volume,1);
  assert.ok(/quieter; matched/.test(a.abMatchNote()));
  a.abMatch=false; a.abApplyVolumes();
  assert.strictEqual(o.volume,1); assert.strictEqual(p.volume,1);
  assert.ok(/not matched/.test(a.abMatchNote()));
  a.abMatch=true; a.abResult=result(null,-17); a.abApplyVolumes(); assert.strictEqual(o.volume,1);assert.strictEqual(p.volume,1);
  a.abResult=result(-20,-20); a.abApplyVolumes(); assert.strictEqual(o.volume,1);assert.strictEqual(p.volume,1);
}
// applied text
{ const {a}=mk();
  a.abResult=result(-20,-20); assert.strictEqual(a.abAppliedText(),'Rumble only');
  a.abResult=result(-20,-20,{gain_db:4.1,album:true}); assert.strictEqual(a.abAppliedText(),'Rumble + album gain +4.1 dB');
  a.abResult=result(-20,-20,{declick:'medium',gain_db:2.1,album:true}); assert.strictEqual(a.abAppliedText(),'Rumble + clicks (medium) + album gain +2.1 dB');
  a.abResult=result(-20,-20,{rumble:false,declick:'strong'}); assert.strictEqual(a.abAppliedText(),'Clicks (strong) only');
  a.abResult=result(-20,-20,{gain_db:-2,album:true,rumble:false}); assert.strictEqual(a.abAppliedText(),'Album gain −2.0 dB');
}
// switch keeps position and play state
{ const {a,o,p}=mk(); a.abResult=result(-20,-20);
  o.currentTime=12.5; a.abToggle();
  assert.ok(!o.paused); assert.ok(a.abPlaying);
  a.abSetSide('processed');
  assert.ok(o.paused); assert.ok(!p.paused); near(p.currentTime,12.5); assert.ok(a.abPlaying);
  assert.strictEqual(a.abSide,'processed');
  // paused switch stays paused
  p.pause(); assert.ok(!a.abPlaying); p.currentTime=40;
  a.abSetSide('original'); assert.ok(o.paused&&p.paused); near(o.currentTime,40); assert.ok(!a.abPlaying);
  // seek
  a.abSeek('7'); near(o.currentTime,7); near(a.abTime,7);
}
// mutual pausing
{ const {a,o,p,ws}=mk(); a.abResult=result(-20,-20);
  a.togglePlay(); assert.ok(a.isPlaying);
  a.abToggle(); assert.ok(!o.paused); assert.ok(!a.isPlaying, 'waveform paused by A/B');
  a.togglePlay(); assert.ok(a.isPlaying); assert.ok(o.paused, 'A/B paused by waveform'); assert.ok(!a.abPlaying);
  a.abToggle(); assert.ok(!o.paused && !a.isPlaying);
  a.toggleTrackPlay(1); assert.ok(o.paused && a.isPlaying);
  a.abToggle(); a.auditionCut(1,'start'); assert.ok(o.paused);
}
// invalidation
{ const {a,o}=mk();
  const fresh=()=>{ a.abResult=result(-20,-20,{sig:a.abSignature()}); a.abCheckStale(); return a.abResult!==null; };
  assert.ok(fresh(),'stable signature keeps result');
  a.detectedTracks[1].end=205; a.abCheckStale(); assert.strictEqual(a.abResult,null,'bounds change');
  assert.ok(fresh()); a.abSelectTrack('2'); a.abCheckStale(); assert.strictEqual(a.abResult,null,'track pick');
  assert.ok(fresh()); a.toggleRumble(); assert.strictEqual(a.abResult,null,'rumble toggle');
  a.rumbleFilter=true; assert.ok(fresh()); a.setDeclick('medium'); assert.strictEqual(a.abResult,null,'declick change');
  assert.ok(fresh()); a.declick='strong'; a.abCheckStale(); assert.strictEqual(a.abResult,null,'declick signature');
  a.declick='off'; assert.ok(fresh()); a.toggleAlbumGain(); assert.strictEqual(a.abResult,null,'album toggle');
  assert.ok(fresh()); a.currentFileId='f2'; a.abCheckStale(); assert.strictEqual(a.abResult,null,'file changed');
  // album gain on: other tracks' ranges matter; off: they do not
  a.currentFileId='f1'; a.abSelectTrack('1'); a.albumGain=false; assert.ok(fresh()); a.detectedTracks[2].end=290; a.abCheckStale(); assert.ok(a.abResult,'unrelated track, album off');
  a.albumGain=true; assert.ok(fresh()); a.detectedTracks[2].end=280; a.abCheckStale(); assert.strictEqual(a.abResult,null,'album ranges');
  // clear keeps the choice, pauses; reset forgets it
  a.abSelectTrack('2'); a.abResult=result(1,1); o.currentTime=3; a.abToggle(); a.abClear();
  assert.ok(o.paused); assert.strictEqual(a.abResult,null); assert.strictEqual(a.abTrackIdx,2);
  a.abReset(); assert.strictEqual(a.abTrackIdx,null);
  a.abResult=result(1,1); a.selectFile = a.selectFile; 
}
// render flow with stubbed fetch + stale discard
(async()=>{
  const {a}=mk(); a.albumGain=true;
  let bodies=[]; let resolve;
  global.fetch=(url,opt)=>{bodies.push(JSON.parse(opt.body)); return new Promise(r=>{resolve=()=>r({ok:true,json:async()=>({original_url:'/o',processed_url:'/p',original_lufs:-20,processed_lufs:-16,gain_db:4,chain:'c'})});});};
  a.playheadIdx=2;
  const pr=a.abRender(); assert.ok(a.abRendering); assert.strictEqual(a.abTrackIdx,2);
  assert.deepStrictEqual(bodies[0].album_ranges,[[100,200,'off'],[200,300,'off']]);
  assert.strictEqual(bodies[0].start,200); assert.ok(bodies[0].rumble&&bodies[0].album_gain); assert.strictEqual(bodies[0].declick,'off'); assert.ok(!('restore' in bodies[0]));
  a.playheadIdx=1; assert.strictEqual(a.abEffectiveIdx(),2,'pick locked');
  a.toggleRumble(); // invalidates in-flight
  resolve(); await pr; assert.strictEqual(a.abResult,null,'stale response discarded'); assert.ok(!a.abRendering);
  a.rumbleFilter=true;
  const p2=a.abRender(); resolve(); await p2;
  assert.ok(a.abResult&&a.abResult.gain_db===4); near(a.abVolumes().processed,Math.pow(10,-4/20));
  // error path
  a.abClear(); global.fetch=async()=>({ok:false,status:500,json:async()=>({detail:'boom'})});
  await a.abRender(); assert.strictEqual(a.abError,'boom'); assert.strictEqual(a.abResult,null); assert.ok(!a.abRendering);
  console.log('abtest ok');
})().catch(e=>{console.error(e);process.exit(1);});
