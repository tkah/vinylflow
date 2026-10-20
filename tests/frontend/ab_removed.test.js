// Plan 07 slice 3: Original | Processed | Removed A/B switch and the +12 dB WebAudio boost
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
let ctxs=[], sources=[];
class StubCtx{
  constructor(){ this.state='suspended'; this.resumed=0; this.destination={}; ctxs.push(this); }
  createGain(){ return {gain:{value:1},connect(){}}; }
  createMediaElementSource(el){ if(sources.includes(el)) throw new Error('InvalidStateError: already connected'); sources.push(el); return {el,connect(){}}; }
  resume(){ this.resumed++; this.state='running'; return Promise.resolve(); }
}
const result=(extra={})=>({original_url:'/o',processed_url:'/p',removed_url:'/d',original_lufs:-20,processed_lufs:-17,removed_peak_dbfs:-18.2,gain_db:null,rumble:true,declick:'light',album:false,sig:'x',...extra});
function mk(){
  const a=vinylApp();
  const o=mkAudio(), p=mkAudio(), r=mkAudio();
  a.$refs={abOriginal:o,abProcessed:p,abRemoved:r};
  for(const [n,el] of [['original',o],['processed',p],['removed',r]]){
    el.on('play',()=>a.abOnPlay(n)); el.on('pause',()=>a.abOnPause(n));
  }
  let wp=false; a.waveform={isPlaying:()=>wp,play(){wp=true;a.isPlaying=true;a.abPause();return Promise.resolve();},
    pause(){ if(wp){wp=false;a.isPlaying=false;} }, getCurrentTime:()=>0,getDuration:()=>600,setTime(){} };
  a.currentFileId='f1'; a.currentFile={};
  a.detectedTracks=[{number:1,start:0,end:100,duration:100,ignored:false}];
  a.rumbleFilter=true; a.abResult=result();
  return {a,o,p,r};
}
const near=(x,y)=>assert.ok(Math.abs(x-y)<1e-6,`${x} vs ${y}`);
const BOOST=Math.pow(10,12/20);

// three-way switch keeps position and play state
{ global.AudioContext=StubCtx; ctxs=[]; sources=[];
  const {a,o,p,r}=mk();
  o.currentTime=12.5; a.abToggle(); assert.ok(a.abPlaying);
  a.abSetSide('processed'); assert.ok(o.paused&&!p.paused); near(p.currentTime,12.5);
  a.abSetSide('removed'); assert.ok(p.paused&&!r.paused); near(r.currentTime,12.5); assert.ok(a.abPlaying);
  assert.strictEqual(a.abSide,'removed');
  r.currentTime=30; a.abSetSide('original'); assert.ok(r.paused&&!o.paused); near(o.currentTime,30);
  // paused switch stays paused
  o.pause(); a.abSetSide('removed'); assert.ok(o.paused&&r.paused&&!a.abPlaying); near(r.currentTime,30);
  a.abSeek('7'); near(r.currentTime,7);
}
// Removed disabled when removed_url is null
{ const {a,r}=mk(); a.abResult=result({removed_url:null});
  assert.ok(!a.abRemovedAvailable()); a.abSetSide('removed'); assert.strictEqual(a.abSide,'original'); assert.ok(r.paused);
  a.abResult=result(); assert.ok(a.abRemovedAvailable());
  assert.strictEqual(a.abRemovedLevelText(),'Removed audio peaks at -18 dBFS');
  a.abResult=result({removed_peak_dbfs:null}); assert.strictEqual(a.abRemovedLevelText(),'');
  const html=fs.readFileSync(require('path').join(__dirname,'..','..','backend','static','index.html'),'utf8');
  assert.ok(html.includes('No clean-up filters on (only album gain)')); assert.ok(html.includes('Boost removed audio +12 dB'));
  assert.ok(html.includes('x-ref="abRemoved"'));
}
// boost: GainNode created once, lazily, value 1 <-> +12 dB, context resumed
{ global.AudioContext=StubCtx; ctxs=[]; sources=[];
  const {a,r}=mk();
  assert.ok(a.abBoost, 'default on'); assert.strictEqual(ctxs.length,0,'nothing before use');
  a.abSetSide('removed'); assert.strictEqual(ctxs.length,0,'switching alone creates nothing');
  a.abToggle(); assert.strictEqual(ctxs.length,1); assert.strictEqual(sources.length,1);
  assert.strictEqual(ctxs[0].resumed,1,'resumed inside the click'); assert.ok(!r.paused);
  a.abToggle(); a.abToggle();             // pause, play again
  assert.strictEqual(ctxs.length,1,'context created once'); assert.strictEqual(sources.length,1,'one MediaElementSource');
  assert.strictEqual(r.volume,1,'unity element volume');
}
// gain value toggling (capture the node)
{ let gainNode; class Ctx2 extends StubCtx{ createGain(){ gainNode=super.createGain(); return gainNode; } }
  global.AudioContext=Ctx2; ctxs=[]; sources=[];
  const {a}=mk(); a.abSetSide('removed'); a.abToggle();
  near(gainNode.gain.value,BOOST); assert.ok(Math.abs(BOOST-3.981)<0.001);
  a.abBoost=false; a.abApplyVolumes(); assert.strictEqual(gainNode.gain.value,1);
  a.abBoost=true; a.abApplyVolumes(); near(gainNode.gain.value,BOOST);
  // checkbox off before first use -> created at unity
  gainNode=null; ctxs=[]; sources=[];
  const b=mk().a; b.abBoost=false; b.abSetSide('removed'); b.abToggle(); assert.strictEqual(gainNode.gain.value,1);
  // already-running context is not resumed again
  assert.strictEqual(ctxs[0].resumed,1);
}
// no WebAudio -> hidden checkbox, plays at unity
{ delete global.AudioContext; delete global.webkitAudioContext;
  const {a,r}=mk(); assert.ok(!a.abBoostAvailable());
  a.abSetSide('removed'); a.abToggle(); assert.ok(!r.paused); assert.strictEqual(r.volume,1);
  // webkit prefix works
  ctxs=[]; sources=[]; global.webkitAudioContext=StubCtx; assert.ok(mk().a.abBoostAvailable());
  delete global.webkitAudioContext;
  // constructor throws -> falls back, still plays
  global.AudioContext=class{ constructor(){ throw new Error('nope'); } };
  const c=mk(); c.a.abSetSide('removed'); c.a.abToggle(); assert.ok(!c.r.paused); assert.ok(c.a.abAudioFailed); assert.ok(!c.a.abBoostAvailable());
  delete global.AudioContext;
}
// mutual pause includes the third element
{ global.AudioContext=StubCtx; ctxs=[]; sources=[];
  const {a,r}=mk(); a.abSetSide('removed');
  a.togglePlay(); assert.ok(a.isPlaying);
  a.abToggle(); assert.ok(!r.paused); assert.ok(!a.isPlaying,'waveform paused by Removed');
  a.togglePlay(); assert.ok(a.isPlaying); assert.ok(r.paused,'Removed paused by waveform'); assert.ok(!a.abPlaying);
  a.abToggle(); a.abClear(); assert.ok(r.paused); assert.strictEqual(a.abSide,'original');
}
// match levels never touch Removed
{ const {a,r}=mk(); a.abResult=result({original_lufs:-20,processed_lufs:-14});
  a.abApplyVolumes(); assert.strictEqual(r.volume,1); assert.strictEqual(a.abVolumes().removed,1);
  a.abMatch=false; a.abApplyVolumes(); assert.strictEqual(r.volume,1);
}
console.log('abremoved ok');
