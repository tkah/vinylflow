const fs=require('fs');
const src=fs.readFileSync(require('path').join(__dirname,'..','..','backend','static','app.js'),'utf8');
const vinylApp=new Function(src+';return vinylApp;')();
const assert=require('assert');

function mkWS(){
  const h={}; let playing=false, cur=0, rejectPlay=false;
  const ws={
    on(ev,fn){ (h[ev]=h[ev]||[]).push(fn); },
    emit(ev,...a){ (h[ev]||[]).forEach(f=>f(...a)); },
    isPlaying:()=>playing, getCurrentTime:()=>cur, getDuration:()=>600,
    setTime(t){ cur=t; },
    play(){ if(rejectPlay) return Promise.reject(new Error('NotAllowed')); playing=true; ws.emit('play'); return Promise.resolve(); },
    pause(){ if(playing){ playing=false; ws.emit('pause'); } },
    tick(t){ cur=t; ws.emit('timeupdate',t); },
    setReject(v){ rejectPlay=v; },
    getWrapper:()=>({getBoundingClientRect:()=>({left:100,width:1000})}),
    destroy(){}
  };
  return ws;
}
function mkRegions(){
  const list=[]; return {list,getRegions:()=>list,clearRegions(){list.length=0;},
    addRegion(o){const r={...o,element:{style:{}},setOptions(x){Object.assign(r,x);}};list.push(r);return r;}};
}
const trk=(n,s,e,ig=false)=>({number:n,start:s,end:e,duration:e-s,editing:false,ignored:ig});
function mkApp(){
  const a=vinylApp();
  a.waveform=mkWS(); a.waveformRegions=mkRegions();
  // wire the same listeners initWaveform does
  const w=a.waveform;
  w.on('play',()=>{a.isPlaying=true;}); w.on('pause',()=>{a.isPlaying=false;a.cancelAudition();});
  w.on('finish',()=>{a.isPlaying=false;a.cancelAudition();});
  w.on('timeupdate',t=>a.onPlayerTime(t));
  a.currentFile={duration:600,musicStart:null};
  a.detectedTracks=[trk(1,10,100),trk(2,110,200),trk(3,200,300,true)];
  a.addTrackRegions();
  return a;
}
const key=(o={})=>({code:'Space',key:' ',target:{tagName:'DIV'},preventDefault(){this.prevented=true;},...o});
const tick=()=>new Promise(r=>setImmediate(r));

(async()=>{
let a=mkApp(), w=a.waveform;
// toggle follows events
assert.strictEqual(a.isPlaying,false);
a.togglePlay(); assert.strictEqual(a.isPlaying,true);
w.pause(); assert.strictEqual(a.isPlaying,false);   // externally paused
a.togglePlay(); w.emit('finish'); assert.strictEqual(a.isPlaying,false);

// space guards
a=mkApp(); w=a.waveform;
let e=key(); a.onGlobalKeydown(e); assert.ok(e.prevented); assert.strictEqual(a.isPlaying,true);
for(const tag of ['INPUT','SELECT','TEXTAREA']){ const e2=key({target:{tagName:tag}}); a.onGlobalKeydown(e2); assert.ok(!e2.prevented); }
const e3=key({target:{tagName:'DIV',isContentEditable:true}}); a.onGlobalKeydown(e3); assert.ok(!e3.prevented);
assert.strictEqual(a.isPlaying,true);
a.showSettings=true; const e4=key(); a.onGlobalKeydown(e4); assert.ok(!e4.prevented); a.showSettings=false;
a.setupRequired=true; const e5=key(); a.onGlobalKeydown(e5); assert.ok(!e5.prevented); a.setupRequired=false;
const e6=key({code:'KeyA',key:'a'}); a.onGlobalKeydown(e6); assert.ok(!e6.prevented);
a.onGlobalKeydown(key()); assert.strictEqual(a.isPlaying,false);

// start at music start
a=mkApp(); w=a.waveform; a.currentFile.musicStart=12.5;
a.togglePlay(); assert.strictEqual(w.getCurrentTime(),12.5);
a=mkApp(); w=a.waveform; a.currentFile.musicStart=0.3; a.togglePlay(); assert.strictEqual(w.getCurrentTime(),0);
a=mkApp(); w=a.waveform; a.currentFile.musicStart=12.5; w.setTime(50); a.togglePlay(); assert.strictEqual(w.getCurrentTime(),50);

// play rejection -> notice
a=mkApp(); w=a.waveform; w.setReject(true); a.togglePlay(); await tick();
assert.ok(/Could not start playback/.test(a.playerNotice)); assert.strictEqual(a.isPlaying,false);

// readout
a=mkApp(); a.togglePlay(); a.waveform.tick(75); assert.strictEqual(a.formatClock(a.playTime),'1:15'); assert.strictEqual(a.formatClock(605),'10:05');

// current track detection, gaps, change-only updates
a=mkApp(); w=a.waveform; a.togglePlay();
let calls=0; const orig=a.waveformRegions.getRegions; a.waveformRegions.getRegions=()=>{calls++;return orig();};
w.tick(5); assert.strictEqual(a.playheadIdx,-1);       // before first
w.tick(10); assert.strictEqual(a.playheadIdx,0);
const c1=calls; w.tick(11); w.tick(50); w.tick(99.9); assert.strictEqual(calls,c1);  // no region work
w.tick(100); assert.strictEqual(a.playheadIdx,-1);     // gap [100,110)
w.tick(110); assert.strictEqual(a.playheadIdx,1);
const reg=n=>a.waveformRegions.list.find(r=>r.id==='track-'+n);
assert.strictEqual(reg(2).color,'rgba(16, 185, 129, 0.55)'); assert.strictEqual(reg(1).color,'rgba(59, 130, 246, 0.3)');
w.tick(250); assert.strictEqual(a.playheadIdx,2);
assert.strictEqual(reg(3).color,'rgba(120, 120, 120, 0.15)');   // ignored stays grey
assert.strictEqual(reg(2).color,'rgba(16, 185, 129, 0.3)');     // restored

// row play
a=mkApp(); w=a.waveform;
a.toggleTrackPlay(1); assert.strictEqual(w.getCurrentTime(),110); assert.ok(a.isPlaying); assert.strictEqual(a.playheadIdx,1);
w.tick(120); a.toggleTrackPlay(1); assert.strictEqual(a.isPlaying,false);   // pause on current row
a.toggleTrackPlay(0); assert.strictEqual(w.getCurrentTime(),10);
w.tick(150); assert.strictEqual(a.playheadIdx,1);   // continues through following track

// audition
a=mkApp(); w=a.waveform;
a.auditionCut(1,'start'); assert.strictEqual(w.getCurrentTime(),107); assert.ok(a.isPlaying);
w.tick(112); assert.ok(a.isPlaying); w.tick(113); assert.strictEqual(a.isPlaying,false); assert.strictEqual(a._auditionStop,null);
a.auditionCut(1,'end'); assert.strictEqual(w.getCurrentTime(),197); w.tick(203); assert.strictEqual(a.isPlaying,false);
a.auditionCut(0,'start'); assert.strictEqual(w.getCurrentTime(),7);         // clamp low
a=mkApp(); w=a.waveform; a.detectedTracks[0].start=1; a.auditionCut(0,'start'); assert.strictEqual(w.getCurrentTime(),0); assert.strictEqual(a._auditionStop,4);
a.detectedTracks[2].end=599; a.auditionCut(2,'end'); assert.strictEqual(a._auditionStop,600);
// cancellations
a=mkApp(); w=a.waveform; a.auditionCut(1,'start'); a.onRegionClicked({id:'track-1'},{button:0,clientX:600,target:{}});
assert.strictEqual(a._auditionStop,null); w.tick(120); assert.ok(a.isPlaying);
a.auditionCut(1,'start'); a.togglePlay(); assert.strictEqual(a._auditionStop,null);
a=mkApp(); w=a.waveform; a.auditionCut(1,'start'); w.pause(); assert.strictEqual(a._auditionStop,null);
a=mkApp(); w=a.waveform; a.auditionCut(1,'start'); a.auditionCut(0,'end'); assert.strictEqual(a._auditionStop,103);

// region click seeking
a=mkApp(); w=a.waveform;
a.onRegionClicked({id:'track-1'},{button:0,clientX:600,target:{}});     // (600-100)/1000*600 = 300
assert.strictEqual(w.getCurrentTime(),300);
w.setTime(5);
a.onRegionClicked({id:'track-1'},{button:2,clientX:600,target:{}}); assert.strictEqual(w.getCurrentTime(),5);
a.onRegionClicked({id:'track-1'},{button:0,ctrlKey:true,clientX:600,target:{}}); assert.strictEqual(w.getCurrentTime(),5);
a._regionDownX=300; a.onRegionClicked({id:'track-1'},{button:0,clientX:600,target:{}}); assert.strictEqual(w.getCurrentTime(),5); // drag end
a.onRegionClicked({id:'expected-1'},{button:0,clientX:600,target:{}}); assert.strictEqual(w.getCurrentTime(),5);
a.onRegionClicked({id:'track-1'},{button:0,clientX:50,target:{}}); assert.strictEqual(w.getCurrentTime(),0);  // clamped

// destroy resets
a.destroyWaveform(); assert.strictEqual(a.isPlaying,false); assert.strictEqual(a.playheadIdx,-1);
console.log('slice3b OK');
})().catch(e=>{console.error(e);process.exit(1);});
