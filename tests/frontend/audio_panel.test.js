// Plan 07 slice 1: Audio processing panel state, persistence, settings sync, A/B wiring.
const fs=require('fs'), assert=require('assert'), path=require('path');
const root=path.join(__dirname,'..','..','backend','static');
const src=fs.readFileSync(path.join(root,'app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
global.document={addEventListener(){},getElementById(){return null;}}; global.window=global; global.WaveSurfer={};
const vinylApp=new Function(src+';return vinylApp;')();

// Fake backend: remembers PUT bodies, applies them like the real /api/config.
function fakeServer(initial={}){
  const state={rumble_filter:false,declick:'off',album_gain:false,replaygain:true,output_format:'flac',...initial};
  const puts=[];
  global.fetch=async(url,opt={})=>{
    if(opt.method==='PUT'){
      const b=JSON.parse(opt.body); puts.push(b);
      if('restoration_level' in b) throw new Error('legacy field must not be sent');
      Object.assign(state,b);
      return {ok:true,json:async()=>({...state,restoration_level:(state.rumble_filter||state.declick!=='off')?1:0})};
    }
    return {ok:true,json:async()=>({...state})};
  };
  return {state,puts};
}
const mk=()=>{ const a=vinylApp(); a.notify=()=>{}; a.currentFileId='f'; a.currentFile={};
  a.detectedTracks=[{number:1,start:0,end:100,duration:100,ignored:false}]; return a; };

(async()=>{
  // ---- defaults + controls ----
  { const a=mk();
    assert.strictEqual(a.rumbleFilter,false); assert.strictEqual(a.declick,'off');
    assert.deepStrictEqual(a.declickLevels.map(l=>l.id),['off','light','medium','strong']);
    assert.deepStrictEqual(a.declickLevels.map(l=>l.label),['Off','Light','Medium','Strong']);
    assert.ok(!a.abAnyProcessing());
    assert.strictEqual(a.normDeclick('brutal'),'off'); assert.strictEqual(a.normDeclick(undefined),'off');
    assert.strictEqual(a.normDeclick('strong'),'strong');
  }
  // ---- each control persists immediately ----
  { const srv=fakeServer(); const a=mk();
    a.toggleRumble(); await new Promise(r=>setImmediate(r));
    assert.strictEqual(a.rumbleFilter,true); assert.deepStrictEqual(srv.puts.pop(),{rumble_filter:true});
    assert.strictEqual(a.config.rumble_filter,true,'config mirror updated from response');
    a.setDeclick('medium'); await new Promise(r=>setImmediate(r));
    assert.strictEqual(a.declick,'medium'); assert.deepStrictEqual(srv.puts.pop(),{declick:'medium'});
    assert.strictEqual(a.config.declick,'medium');
    a.setDeclick('medium'); await new Promise(r=>setImmediate(r));
    assert.strictEqual(srv.puts.length,0,'re-selecting the same strength does not save');
    a.setDeclick('nonsense'); await new Promise(r=>setImmediate(r));
    assert.strictEqual(a.declick,'off'); assert.deepStrictEqual(srv.puts.pop(),{declick:'off'});
    a.toggleAlbumGain(); await new Promise(r=>setImmediate(r));
    assert.strictEqual(a.albumGain,true); assert.deepStrictEqual(srv.puts.pop(),{album_gain:true});
    assert.strictEqual(a.config.replaygain,true);
    a.toggleReplayGain(); await new Promise(r=>setImmediate(r));
    assert.strictEqual(a.config.replaygain,false); assert.deepStrictEqual(srv.puts.pop(),{replaygain:false});
    a.toggleReplayGain(); await new Promise(r=>setImmediate(r));
    assert.strictEqual(a.config.replaygain,true); assert.deepStrictEqual(srv.puts.pop(),{replaygain:true});
  }
  // ---- loadConfig fills the panel (and migrates nothing client-side) ----
  { fakeServer({rumble_filter:true,declick:'strong',album_gain:true,replaygain:false});
    const a=mk(); await a.loadConfig();
    assert.strictEqual(a.rumbleFilter,true); assert.strictEqual(a.declick,'strong');
    assert.strictEqual(a.albumGain,true); assert.strictEqual(a.config.replaygain,false);
    fakeServer({declick:'bogus'}); await a.loadConfig(); assert.strictEqual(a.declick,'off');
  }
  // ---- settings modal <-> panel stay in sync (shared state) ----
  { const srv=fakeServer(); const a=mk(); await a.loadConfig();
    // panel -> modal
    a.setDeclick('light'); a.toggleRumble(); a.toggleReplayGain(); await new Promise(r=>setImmediate(r));
    assert.strictEqual(a.config.declick,'light'); assert.strictEqual(a.config.rumble_filter,true);
    assert.strictEqual(a.config.replaygain,false);
    // modal -> panel: edit config in the modal, Save settings
    a.config.declick='strong'; a.config.rumble_filter=false; a.config.replaygain=true; a.config.album_gain=true;
    srv.puts.length=0; await a.saveConfig();
    const sent=srv.puts[0];
    assert.strictEqual(sent.declick,'strong'); assert.strictEqual(sent.rumble_filter,false);
    assert.ok(!('restoration_level' in sent),'legacy field not sent back');
    assert.strictEqual(a.declick,'strong'); assert.strictEqual(a.rumbleFilter,false);
    assert.strictEqual(a.albumGain,true); assert.strictEqual(a.config.replaygain,true);
  }
  // ---- A/B signature includes rumble + declick ----
  { fakeServer(); const a=mk(); a.rumbleFilter=true;
    const s0=a.abSignature();
    a.declick='light'; const s1=a.abSignature(); assert.notStrictEqual(s0,s1);
    a.declick='medium'; const s2=a.abSignature(); assert.notStrictEqual(s1,s2);
    a.rumbleFilter=false; assert.notStrictEqual(a.abSignature(),s2);
    a.rumbleFilter=true; a.declick='medium'; assert.strictEqual(a.abSignature(),s2,'stable');
    // changing any control clears a rendered result
    a.abResult={sig:a.abSignature()}; a.setDeclick('strong'); assert.strictEqual(a.abResult,null);
    a.abResult={sig:a.abSignature()}; a.toggleRumble(); assert.strictEqual(a.abResult,null);
  }
  // ---- A/B request body + applied text ----
  { fakeServer(); const a=mk(); a.rumbleFilter=true; a.declick='medium'; a.albumGain=true;
    let body; global.fetch=async(u,o)=>{ if(u.startsWith('/api/clicks')) return {ok:true,json:async()=>({status:'running',strength:'medium',requested:'medium',progress:0})}; body=JSON.parse(o.body);
      return {ok:true,json:async()=>({original_url:'/o',processed_url:'/p',original_lufs:-20,processed_lufs:-18,gain_db:2.1,chain:'c'})}; };
    await a.abRender();
    assert.deepStrictEqual([body.rumble,body.declick,body.album_gain],[true,'medium',true]);
    assert.strictEqual(a.abAppliedText(),'Rumble + clicks (medium) + album gain +2.1 dB');
    assert.deepStrictEqual(body.album_ranges,[[0,100,'medium']],'album ranges carry each track\'s effective strength');
    a.stopClickPoll('f'); // the A/B render also started a click scan
  }
  // ---- process request carries the new fields ----
  { const a=mk(); a.rumbleFilter=true; a.declick='strong';
    a.selectedRelease={id:5,tracks:[{position:'A1'}]}; a.customMapping=[0];
    const request=a.buildExportRequest(a.currentFileId);
    assert.strictEqual(request.rumble_filter,true); assert.strictEqual(request.declick,'strong');
    assert.ok(!('restoration_level' in request));
  }
  // ---- markup ----
  { assert.ok(html.includes('Audio processing')); assert.ok(html.includes('Removes inaudible turntable rumble below 15 Hz.'));
    assert.ok(html.includes('Lets players even out volume without changing the audio (track + album).'));
    assert.ok(html.includes('Stronger settings catch fainter clicks but take longer to process. Use the test below to hear the difference on your record.'));
    assert.ok(!/Restore \(rumble/.test(html), 'old Restore toggle gone');
    assert.ok(!/ReplayGain tags: <span/.test(html), 'old ReplayGain line gone');
    assert.ok(html.includes('toggleRumble()') && html.includes('setDeclick(lvl.id)') && html.includes('toggleReplayGain()'));
    assert.ok(html.includes('x-model="config.rumble_filter"') && html.includes('x-model="config.declick"'));
    // test block lives inside the panel
    const panel=html.indexOf('data-testid="audio-panel"'), test=html.indexOf('Test on one track'), process=html.indexOf('<!-- Process Button -->');
    assert.ok(panel>0 && test>panel && test<process);
  }
  console.log('audio panel ok');
})().catch(e=>{console.error(e);process.exit(1);});
