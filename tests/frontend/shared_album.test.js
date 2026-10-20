// Shared albums are server jobs: fake endpoints exercise grouping, completion, warnings and recovery.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vinylApp = new Function(fs.readFileSync(path.join(__dirname, '../../backend/static/app.js'), 'utf8') + ';return vinylApp;')();
const tick = () => new Promise(resolve => setImmediate(resolve));
function app() {
    const instance = vinylApp();
    instance.uploadedFiles = ['one', 'two'].map(id => ({ id, filename: id+'.wav', duration: 60, status: 'analyzed' }));
    instance.currentFileId = 'one'; instance.currentFile = instance.uploadedFiles[0];
    instance.selectedRelease = { id: 99, tracks: [{position:'A1'}, {position:'C1'}] };
    instance.detectedTracks = [{number:1,start:0,end:60,duration:60,ignored:false}];
    instance.selectedSides = ['A']; instance.customMapping = [0]; instance.albumGain = true;
    instance.$nextTick = callback => callback?.(); instance.loadImportList = async () => {};
    instance.initWaveform = async () => {};
    instance.fetchScan = instance.fetchHum = instance.loadCachedClicks = () => {};
    instance.saveWorkspace(); instance.workspaces.two = JSON.parse(JSON.stringify(instance.workspaces.one));
    instance.workspaces.two.customMapping = [1]; instance.workspaces.two.selectedSides = ['C'];
    return instance;
}
(async () => {
    let instance = app();
    instance.workspaces.two.albumGain = false;
    assert.strictEqual(instance.fileReadiness('one').ready, false, 'mixed gain choices must be resolved before a shared export');
    instance.workspaces.two.albumGain = true;
    assert.strictEqual(instance.fileReadiness('one').ready, true);
    const previousInterval = global.setInterval, previousClear = global.clearInterval;
    let poll;
    global.setInterval = callback => { poll = callback; return 1; }; global.clearInterval = () => {};
    try {
        let posts = 0, groupId, body;
        global.fetch = async (url, options = {}) => {
            if (options.method === 'POST') {
                assert.strictEqual(url, '/api/process-album'); posts++;
                body = JSON.parse(options.body); groupId = body.job_id;
                return {ok:true,json:async()=>({job_id:groupId,status:'queued',files:body.files.map(item=>({file_id:item.file_id,status:'queued'}))})};
            }
            assert.strictEqual(url, `/api/process-album/${groupId}`);
            return {ok:true,json:async()=>({job_id:groupId,status:'complete',gain_db:3.2,
                warnings:['Synthetic incomplete-tag warning'],
                files:body.files.map(item=>({file_id:item.file_id,status:'complete',progress:1,tracks:['saved.flac']}))})};
        };
        const batch = instance.processAllReady(); await tick();
        assert.strictEqual(posts, 1); assert.strictEqual(body.files.length, 2);
        assert.deepStrictEqual(body.files.map(item=>item.track_mapping[0].discogs), ['A1','C1']);
        assert.strictEqual(instance.batchProcessing, true);
        await poll(); await batch;
        assert.strictEqual(instance.batchSummary.completed, 2);
        assert.ok(instance.albumWarnings.includes('Synthetic incomplete-tag warning'));
        assert.ok(instance.uploadedFiles.every(file=>file.status==='completed'));
        assert.strictEqual(instance.isProcessing, false);
        assert.strictEqual(instance.readyFiles.length, 0, 'a matching complete shared measurement is reusable');
        instance.workspaces.two.detectedTracks[0].end = 59;
        assert.strictEqual(instance.readyFiles.length, 2, 'one edited disc invalidates shared gain/tags on both discs');
        assert.strictEqual(instance.fileReadiness('one', false).completed, true, 'unchanged single export stays complete');

        // Queue recovery identifies an existing server album and never POSTs it again.
        instance = app(); instance.currentFileId = null; instance.currentFile = null;
        instance.uploadedFiles[0].status = 'processing'; instance.uploadedFiles[0].album_job_id = groupId;
        instance.selectFile('one');
        assert.strictEqual(instance.currentAlbumJobId, groupId);
        await poll();
        assert.strictEqual(posts, 1);
        assert.strictEqual(instance.isProcessing, false);
        // A lost POST response is recoverable by its exact UUID, even if the job already finished.
        const oldWindow = global.window;
        const saved = new Map();
        global.window = { localStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) } };
        try {
            instance = app(); instance._workspacesLoaded = true;
            let lostJobId;
            global.fetch = async (url, options) => {
                lostJobId = JSON.parse(options.body).job_id;
                throw new Error('Response lost after server acceptance');
            };
            const items = instance.readyFiles.map(file => ({ fileId:file.id,filename:file.filename,
                signature:instance.exportSignature(instance.workspaceFor(file.id)),request:instance.buildExportRequest(file.id) }));
            await instance.submitAlbumExport(items);
            const recovered = app(); recovered.currentFileId = null; recovered.currentFile = null;
            global.fetch = async () => ({ ok:true,json:async()=>({uploaded:recovered.uploadedFiles.map(file=>({...file,status:'completed',album_job_id:lostJobId,
                album_warnings:['Recovered album warning']}))}) });
            await recovered.loadWorkspaces();
            assert.strictEqual(recovered.readyFiles.length, 0, 'known server UUID confirms the lost acceptance without re-export');
            assert.ok(recovered.albumWarnings.includes('Recovered album warning'));
        } finally { global.window = oldWindow; }
        console.log('shared album frontend ok');
    } finally { global.setInterval = previousInterval; global.clearInterval = previousClear; }
})().catch(error => { console.error(error); process.exit(1); });
