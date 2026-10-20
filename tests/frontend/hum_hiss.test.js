// Plan 07 slice 4: hum removal + hiss reduction controls, persistence, Settings sync,
// the hum suggestion, A/B signature / request / applied text, process request, markup.
const fs=require('fs'), assert=require('assert'), path=require('path');
const root=path.join(__dirname,'..','..','backend','static');
const src=fs.readFileSync(path.join(root,'app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
global.document={addEventListener(){},getElementById(){return null;}}; global.window=global; global.WaveSurfer={};
const vinylApp=new Function(src+';return vinylApp;')();

// Fake backend mirroring /api/config incl. the "reduction wins, strength remembered" rule.
function fakeServer(initial={}, humBody=null){
  const state={rumble_filter:false,declick:'off',album_gain:false,replaygain:true,output_format:'flac',
    hum_filter:false,hum_freq:60,hiss_reduction:'off',hiss_strength:'light',...initial};
  const puts=[], gets=[];
  global.fetch=async(url,opt={})=>{
    if(opt.method==='PUT'){
      const b=JSON.parse(opt.body); puts.push(b);
      if('hiss_strength' in b) state.hiss_strength=b.hiss_strength;
      if('hiss_reduction' in b){ state.hiss_reduction=b.hiss_reduction; if(b.hiss_reduction!=='off') state.hiss_strength=b.hiss_reduction; }
      for(const k of Object.keys(b)) if(!k.startsWith('hiss_')) state[k]=b[k];
      return {ok:true,json:async()=>({...state})};
    }
    gets.push(url);
    if(String(url).startsWith('/api/hum/')){
      if(humBody==='error') return {ok:false,status:500,json:async()=>({})};
      return {ok:true,json:async()=>humBody};
    }
    return {ok:true,json:async()=>({...state})};
  };
  return {state,puts,gets};
}
const tick=()=>new Promise(r=>setImmediate(r));
const mk=()=>{ const a=vinylApp(); a.notify=()=>{}; a.currentFileId='f'; a.currentFile={};
  a.detectedTracks=[{number:1,start:0,end:100,duration:100,ignored:false}]; return a; };

(async()=>{
  // ---- defaults: both off, 60 Hz, light remembered ----
  { const a=mk();
    assert.strictEqual(a.humFilter,false); assert.strictEqual(a.humFreq,60);
    assert.strictEqual(a.hissReduction,'off'); assert.strictEqual(a.hissStrength,'light'); assert.strictEqual(a.hissOn(),false);
    assert.deepStrictEqual(a.hissLevels.map(l=>l.label),['Light','Medium','Strong']);
    assert.ok(!a.abAnyProcessing(),'nothing on: nothing to test');
    assert.strictEqual(a.config.hum_filter,false); assert.strictEqual(a.config.hum_freq,60);
    assert.strictEqual(a.config.hiss_reduction,'off');
  }
  // ---- each control persists immediately ----
  { const srv=fakeServer(); const a=mk();
    a.toggleHum(); await tick();
    assert.strictEqual(a.humFilter,true); assert.deepStrictEqual(srv.puts.pop(),{hum_filter:true});
    assert.strictEqual(a.config.hum_filter,true,'config mirror updated from the response');
    assert.ok(a.abAnyProcessing(),'hum alone is something to test');
    a.setHumFreq(50); await tick();
    assert.strictEqual(a.humFreq,50); assert.deepStrictEqual(srv.puts.pop(),{hum_freq:50}); assert.strictEqual(a.config.hum_freq,50);
    a.setHumFreq('50'); await tick(); assert.strictEqual(srv.puts.length,0,'same frequency does not save');
    a.setHumFreq(55); await tick(); assert.strictEqual(a.humFreq,60,'unknown frequency reads as 60');
    assert.deepStrictEqual(srv.puts.pop(),{hum_freq:60});
    a.toggleHum(); await tick();
    assert.strictEqual(a.humFilter,false); assert.deepStrictEqual(srv.puts.pop(),{hum_filter:false});
    assert.strictEqual(a.humFreq,60,'frequency kept while off');
  }
  // ---- hiss toggle: off <-> last chosen strength (remembered) ----
  { const srv=fakeServer(); const a=mk();
    a.toggleHiss(); await tick();
    assert.strictEqual(a.hissReduction,'light'); assert.deepStrictEqual(srv.puts.pop(),{hiss_reduction:'light'});
    assert.ok(a.hissOn()); assert.ok(a.abAnyProcessing());
    a.setHissStrength('strong'); await tick();
    assert.strictEqual(a.hissReduction,'strong'); assert.strictEqual(a.hissStrength,'strong');
    assert.deepStrictEqual(srv.puts.pop(),{hiss_reduction:'strong'});
    a.toggleHiss(); await tick();
    assert.strictEqual(a.hissReduction,'off'); assert.strictEqual(a.hissStrength,'strong','strength remembered');
    assert.deepStrictEqual(srv.puts.pop(),{hiss_reduction:'off'});
    assert.strictEqual(srv.state.hiss_strength,'strong'); assert.strictEqual(a.config.hiss_strength,'strong');
    a.toggleHiss(); await tick();
    assert.strictEqual(a.hissReduction,'strong','toggling back on restores the last strength');
    assert.deepStrictEqual(srv.puts.pop(),{hiss_reduction:'strong'});
    a.setHissStrength('strong'); await tick(); assert.strictEqual(srv.puts.length,0,'re-selecting does not save');
    a.setHissStrength('bogus'); await tick();
    assert.strictEqual(a.hissReduction,'light','unknown strength reads as light'); srv.puts.length=0;
    // choosing a strength while off only remembers it (no accidental switch-on)
    a.toggleHiss(); await tick(); srv.puts.length=0;
    a.setHissStrength('medium'); await tick();
    assert.strictEqual(a.hissReduction,'off'); assert.strictEqual(a.hissStrength,'medium');
    assert.deepStrictEqual(srv.puts.pop(),{hiss_strength:'medium'});
    a.toggleHiss(); await tick(); assert.strictEqual(a.hissReduction,'medium');
  }
  // ---- loadConfig fills the panel; junk reads as off / 60 / light ----
  { fakeServer({hum_filter:true,hum_freq:50,hiss_reduction:'medium',hiss_strength:'medium'});
    const a=mk(); await a.loadConfig();
    assert.strictEqual(a.humFilter,true); assert.strictEqual(a.humFreq,50);
    assert.strictEqual(a.hissReduction,'medium'); assert.strictEqual(a.hissStrength,'medium');
    fakeServer({hum_freq:55,hiss_reduction:'bogus',hiss_strength:'bogus'}); await a.loadConfig();
    assert.strictEqual(a.humFreq,60); assert.strictEqual(a.hissReduction,'off'); assert.strictEqual(a.hissStrength,'light');
    fakeServer({hiss_reduction:'off',hiss_strength:'strong'}); await a.loadConfig();
    assert.strictEqual(a.hissStrength,'strong','remembered strength survives a reload while off');
    // an older server without the fields leaves everything off
    global.fetch=async()=>({ok:true,json:async()=>({rumble_filter:true})}); await a.loadConfig();
    assert.strictEqual(a.humFilter,false); assert.strictEqual(a.humFreq,60); assert.strictEqual(a.hissReduction,'off');
  }
  // ---- Settings modal <-> panel ----
  { const srv=fakeServer(); const a=mk(); await a.loadConfig();
    a.toggleHum(); a.setHumFreq(50); a.toggleHiss(); a.setHissStrength('medium'); await tick();
    assert.strictEqual(a.config.hum_filter,true); assert.strictEqual(a.config.hum_freq,50);
    assert.strictEqual(a.config.hiss_reduction,'medium'); assert.strictEqual(a.config.hiss_strength,'medium');
    // modal -> panel: edit config and Save settings
    a.config.hum_filter=false; a.config.hum_freq=60; a.config.hiss_reduction='strong';
    srv.puts.length=0; await a.saveConfig();
    const sent=srv.puts[0];
    assert.strictEqual(sent.hum_filter,false); assert.strictEqual(sent.hum_freq,60); assert.strictEqual(sent.hiss_reduction,'strong');
    assert.ok(!('hiss_strength' in sent),'a stale remembered strength is not sent along with an active hiss setting');
    assert.strictEqual(a.humFilter,false); assert.strictEqual(a.humFreq,60);
    assert.strictEqual(a.hissReduction,'strong'); assert.strictEqual(a.hissStrength,'strong');
    // switching hiss off in the modal keeps (and sends) the remembered strength
    a.config.hiss_reduction='off'; srv.puts.length=0; await a.saveConfig();
    assert.strictEqual(srv.puts[0].hiss_reduction,'off'); assert.strictEqual(srv.puts[0].hiss_strength,'strong');
    assert.strictEqual(a.hissReduction,'off'); assert.strictEqual(a.hissStrength,'strong');
  }
  // ---- changing a control clears a rendered A/B result; signature follows hum / hiss ----
  { fakeServer(); const a=mk();
    const s0=a.abSignature();
    a.humFilter=true; const s1=a.abSignature(); assert.notStrictEqual(s0,s1);
    a.humFreq=50; const s2=a.abSignature(); assert.notStrictEqual(s1,s2);
    a.hissReduction='light'; const s3=a.abSignature(); assert.notStrictEqual(s2,s3);
    a.hissReduction='strong'; assert.notStrictEqual(a.abSignature(),s3);
    a.hissReduction='light'; assert.strictEqual(a.abSignature(),s3,'stable');
    a.humFilter=false; const off50=a.abSignature(); a.humFreq=60; assert.strictEqual(a.abSignature(),off50,'frequency is irrelevant while hum removal is off');
    a.abResult={sig:a.abSignature()}; a.toggleHum(); assert.strictEqual(a.abResult,null);
    a.abResult={sig:a.abSignature()}; a.setHumFreq(50); assert.strictEqual(a.abResult,null);
    a.abResult={sig:a.abSignature()}; a.toggleHiss(); assert.strictEqual(a.abResult,null);
    a.abResult={sig:a.abSignature()}; a.setHissStrength('strong'); assert.strictEqual(a.abResult,null);
    a.abResult={sig:a.abSignature()}; a.applyHumSuggestion(); // no suggestion yet: no change
    assert.notStrictEqual(a.abResult,null);
  }
  // ---- A/B request body + applied text ----
  { fakeServer(); const a=mk(); a.rumbleFilter=true; a.humFilter=true; a.humFreq=60; a.declick='medium'; a.hissReduction='light'; a.albumGain=true;
    let body; global.fetch=async(u,o)=>{ if(u.startsWith('/api/clicks')) return {ok:true,json:async()=>({status:'running',strength:'medium',requested:'medium',progress:0})}; body=JSON.parse(o.body);
      return {ok:true,json:async()=>({original_url:'/o',processed_url:'/p',original_lufs:-20,processed_lufs:-18,gain_db:2.1,chain:'c',hum:60,hiss:'light'})}; };
    await a.abRender();
    assert.deepStrictEqual([body.hum_filter,body.hum_freq,body.hiss_reduction],[true,60,'light']);
    assert.strictEqual(a.abAppliedText(),'Rumble + hum 60 Hz + clicks (medium) + hiss (light) + album gain +2.1 dB');
    a.stopClickPoll('f');
  }
  { const a=mk(); a.abResult={rumble:true,hum:60,declick:'medium',hiss:'light',album:false};
    assert.strictEqual(a.abAppliedText(),'Rumble + hum 60 Hz + clicks (medium) + hiss (light)');
    a.abResult={rumble:false,hum:50,declick:'off',hiss:'off',album:false}; assert.strictEqual(a.abAppliedText(),'Hum 50 Hz only');
    a.abResult={rumble:false,hum:0,declick:'off',hiss:'strong',album:false}; assert.strictEqual(a.abAppliedText(),'Hiss (strong) only');
    a.abResult={rumble:false,declick:'off',album:false}; assert.strictEqual(a.abAppliedText(),'','results from older servers have no hum / hiss');
  }
  { // not rendering when nothing is on, hum-only is enough
    const a=mk(); assert.ok(!a.abCanRender()); a.humFilter=true; assert.ok(a.abCanRender());
    a.humFilter=false; a.hissReduction='light'; assert.ok(a.abCanRender());
  }
  // ---- hum detection + suggestion ----
  { const humBody={detected:60,level_dbfs:-48.3,prominence_db:31.2,harmonics:[60,120,180],analyzed_s:12.5,noise:null};
    const srv=fakeServer({}, humBody); const a=mk();
    assert.strictEqual(a.humSuggestion(),null,'nothing known yet');
    await a.fetchHum('f');
    assert.deepStrictEqual(srv.gets.filter(u=>u.startsWith('/api/hum/')),['/api/hum/f']);
    assert.strictEqual(a.humInfo.f.status,'done'); assert.strictEqual(a.humInfo.f.detected,60);
    await a.fetchHum('f'); assert.strictEqual(srv.gets.filter(u=>u.startsWith('/api/hum/')).length,1,'cached per file');
    // toggle off: muted suggestion with level, action turns it on at the detected frequency
    let s=a.humSuggestion();
    assert.strictEqual(s.text,'Hum detected at 60 Hz (−48 dBFS)'); assert.strictEqual(s.action,'Turn on'); assert.strictEqual(s.kind,'on');
    a.humFreq=50; a.applyHumSuggestion(); await tick();
    assert.strictEqual(a.humFilter,true); assert.strictEqual(a.humFreq,60);
    assert.deepStrictEqual(srv.puts.pop(),{hum_filter:true,hum_freq:60});
    assert.strictEqual(a.config.hum_freq,60);
    assert.strictEqual(a.humSuggestion(),null,'on at the right frequency: nothing to suggest');
    // on, different frequency detected: offer to switch
    a.humFreq=50; s=a.humSuggestion();
    assert.strictEqual(s.kind,'switch'); assert.strictEqual(s.text,'Hum detected at 60 Hz, not 50 Hz'); assert.strictEqual(s.action,'Switch to 60 Hz');
    a.applyHumSuggestion(); await tick();
    assert.strictEqual(a.humFreq,60); assert.strictEqual(a.humFilter,true); assert.deepStrictEqual(srv.puts.pop(),{hum_filter:true,hum_freq:60});
    // another file has its own result
    a.currentFileId='g'; assert.strictEqual(a.humSuggestion(),null);
  }
  { // 50 Hz, nothing detected, loading, errors
    fakeServer({}, {detected:50,level_dbfs:-61.6,harmonics:[50,100]}); let a=mk(); await a.fetchHum('f');
    assert.strictEqual(a.humSuggestion().text,'Hum detected at 50 Hz (−62 dBFS)');
    fakeServer({}, {detected:null,level_dbfs:null,prominence_db:null,harmonics:[]}); a=mk(); await a.fetchHum('f');
    assert.strictEqual(a.humInfo.f.status,'done'); assert.strictEqual(a.humSuggestion(),null);
    fakeServer({}, {detected:60,level_dbfs:null,harmonics:[60]}); a=mk(); await a.fetchHum('f');
    assert.strictEqual(a.humSuggestion().text,'Hum detected at 60 Hz');
    const warn=console.warn; console.warn=()=>{};
    const srv=fakeServer({}, 'error'); a=mk(); await a.fetchHum('f');
    assert.strictEqual(a.humInfo.f.status,'error'); assert.strictEqual(a.humSuggestion(),null);
    await a.fetchHum('f'); assert.strictEqual(srv.gets.filter(u=>u.startsWith('/api/hum/')).length,2,'retried after an error');
    console.warn=warn;
    a.humInfo={f:{status:'loading'}}; assert.strictEqual(a.humSuggestion(),null);
  }
  // ---- hum is looked for when the scan finishes / a scanned file is selected ----
  { const humBody={detected:60,level_dbfs:-50,harmonics:[60,120]};
    const srv=fakeServer({}, humBody); const a=mk(); a.searchDiscogs=async()=>{}; const log=console.log; console.log=()=>{};
    a.uploadedFiles=[{id:'f',filename:'x.wav',musicDuration:null}];
    a.handleWebSocketMessage({type:'scan_complete',file_id:'f',music_start:2,music_end:300});
    await tick(); await tick();
    assert.strictEqual(a.humInfo.f && a.humInfo.f.status,'done');
    assert.strictEqual(a.uploadedFiles[0].musicDuration,298);
    // selecting an already scanned file looks again only if nothing is known
    srv.gets.length=0; a.selectFile('f'); await tick();
    assert.strictEqual(srv.gets.filter(u=>u.startsWith('/api/hum/')).length,0);
    a.uploadedFiles.push({id:'h',filename:'y.wav',musicDuration:200}); a.selectFile('h'); await tick(); await tick();
    assert.ok(srv.gets.includes('/api/hum/h')); console.log=log;
  }
  // ---- process request carries the new fields ----
  { const m=/body: JSON\.stringify\(\{\s*file_id: this\.currentFileId,\s*release_id[\s\S]*?\}\)/.exec(src);
    assert.ok(m && /hum_filter: this\.humFilter/.test(m[0]) && /hum_freq: this\.humFreq/.test(m[0]) && /hiss_reduction: this\.hissReduction/.test(m[0]));
  }
  // ---- markup ----
  { const panel=html.indexOf('data-testid="audio-panel"'), test=html.indexOf('Test on one track');
    const hum=html.indexOf('data-testid="hum-control"'), hiss=html.indexOf('data-testid="hiss-control"');
    assert.ok(panel>0 && hum>panel && hiss>hum && hiss<test, 'both controls live in the panel, before the A/B block');
    assert.ok(html.includes('toggleHum()') && html.includes('setHumFreq(f)') && html.includes('toggleHiss()') && html.includes('setHissStrength(lvl.id)'));
    assert.ok(html.includes('Removes mains hum (50/60 Hz and harmonics).'));
    assert.ok(/x-show="humFilter"[^>]*aria-label="Mains frequency"/.test(html), 'frequency choice only while hum removal is on');
    assert.ok(/x-show="hissOn\(\)"[^>]*aria-label="Hiss reduction strength"/.test(html), 'strength choice only while hiss reduction is on');
    assert.ok(html.includes('humSuggestion()') && html.includes('applyHumSuggestion()'));
    assert.ok(html.includes('x-model="config.hum_filter"') && html.includes('x-model.number="config.hum_freq"') && html.includes('x-model="config.hiss_reduction"'));
    assert.ok(html.includes('This is only what the clean-up removed (clicks, hiss, hum).'));
    assert.ok(html.includes('hiss reduction or album gain to test'));
  }
  // ---- caution note under the Hum removal toggle: always visible, frequencies follow 50/60 ----
  { const a=mk();
    assert.strictEqual(a.humNoteFreqs(60),'60, 120 \u2026 360 Hz'); assert.strictEqual(a.humNoteFreqs(50),'50, 100 \u2026 300 Hz');
    assert.strictEqual(a.humNoteFreqs('50'),'50, 100 \u2026 300 Hz'); assert.strictEqual(a.humNoteFreqs(55),'60, 120 \u2026 360 Hz','unknown reads as 60');
    // render the notes the way Alpine would: x-text replaces the span's content
    const render=(id,expr,freq)=>{
      const m=new RegExp('<p([^>]*)data-testid="'+id+'"([^>]*)>([\\s\\S]*?)</p>').exec(html);
      assert.ok(m,id+' present'); assert.ok(!/x-show/.test(m[1]+m[2]),id+' is visible whether or not the toggle is on');
      assert.ok(m[3].includes('<span x-text="'+expr+'"'),id+' binds '+expr);
      const text=m[3].replace(/<span x-text="[^"]*">[^<]*<\/span>/,a.humNoteFreqs(freq)).replace(/&hellip;/g,'\u2026').replace(/\s+/g,' ').trim();
      return text; };
    for(const [f,list] of [[60,'60, 120 \u2026 360 Hz'],[50,'50, 100 \u2026 300 Hz']]){
      const panel=render('hum-caution','humNoteFreqs(humFreq)',f);
      assert.strictEqual(panel,'Use only if you hear hum. It cuts narrow notches at '+list+', which can quiet bass notes that sit close to those frequencies (by up to several dB). Check bass-heavy records with the test below.');
      const sett=render('settings-hum-caution','humNoteFreqs(config.hum_freq)',f);
      assert.ok(sett.startsWith('Use only if you hear hum. It cuts narrow notches at '+list+','),sett);
    }
    const hum=html.indexOf('data-testid="hum-control"'), note=html.indexOf('data-testid="hum-caution"'), freqBtns=html.indexOf('aria-label="Mains frequency"',hum);
    assert.ok(note>html.indexOf('@click="toggleHum()"')&&note<freqBtns,'note sits under the toggle, before the 50/60 choice');
    const sh=html.indexOf('data-testid="settings-hum"'); assert.ok(html.indexOf('data-testid="settings-hum-caution"')>sh&&html.indexOf('data-testid="settings-hum-caution"')<html.indexOf('data-testid="settings-hiss"'));
    // live: the panel state drives it
    a.humFreq=50; assert.strictEqual(a.humNoteFreqs(a.humFreq),'50, 100 \u2026 300 Hz'); a.config.hum_freq=50; assert.strictEqual(a.humNoteFreqs(a.config.hum_freq),'50, 100 \u2026 300 Hz');
  }
  console.log('hum + hiss ok');
})().catch(e=>{console.error(e);process.exit(1);});
