import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as bundle from '../../../dist/rollback-netcode.js';
import * as source from '../index.js';
const read=p=>readFileSync(p,'utf8');
const publicNames=['VERSION','PROTOCOL_VERSION','CHUNK_SIZE','MAX_TICK','profiles','hashBytes','statelessRandom','SeededPRNG','fixedPoint','createSession','RollbackSession','playReplay','WebRTCTransport','createWebRTCPeer','createLoop','createNostrRoom','createNostrGroupRoom','createNostrDynamicRoom','createNostrPublicRoom','createRoomSession','RoomSession','createBootstrapReplay','nostrCrypto','createNostrSignaler','createSyncTestSession','SyncTestSession','runSyncTest','runSyncTestAsync','DeterminismError','createValueCodec','binaryCodec','jsonCodec'].sort();
test('standalone compatibility bundle preserves every upstream public export and declarations',()=>{
  assert.deepEqual(Object.keys(bundle).sort(),publicNames);
  assert.deepEqual(Object.keys(source).sort(),publicNames);
  const declarations=read('modules/rollback-netcode/rollback-netcode.d.ts');
  for(const name of publicNames)assert.match(declarations,new RegExp('export (?:const|class|function) '+name+'\\b'));
  assert.equal(bundle.VERSION,'0.2.0-dev');assert.equal(bundle.PROTOCOL_VERSION,1);
});
test('independent bundles have no runtime import and no unrelated transport or session code',async()=>{
  const symbols=new Set();
  for(const name of ['rollback','deterministic','simloop','transport','replay']){
    const code=read(`dist/${name}.js`);
    assert.doesNotMatch(code,/^\s*import\s|\bimport\s*\(/m);
    const exports=await import(`../../../dist/${name}.js`);
    for(const key of Object.keys(exports)){assert.ok(!symbols.has(key),key);symbols.add(key)}
    if(name!=='transport')assert.doesNotMatch(code,/RTCPeerConnection|\bWebSocket\b|function createNostr/);
    if(name!=='rollback')assert.doesNotMatch(code,/class RollbackSession|RollbackSession = class/);
  }
  assert.deepEqual([...symbols].sort(),publicNames);
  const code=read('modules/rollback/core.js');assert.doesNotMatch(code,/nostr|WebSocket|RTCPeerConnection|\bdocument\.|\bwindow\./);
});
test('unchanged migration source matches upstream; reviewed modifications have separate hashes',()=>{
  const provenance=JSON.parse(read('modules/rollback-netcode/provenance.json'));
  const owners={'core.js':'rollback','loop.js':'simloop','utilities.js':'deterministic','value-codec.js':'deterministic','synctest.js':'deterministic','protocol.js':'_rollback-shared','webrtc.js':'transport','nostr.js':'transport','nostr-crypto.js':'transport','room.js':'transport','group-room.js':'transport','star-transport.js':'transport'};
  for(const [file,owner] of Object.entries(owners)){
    let code=read(`modules/${owner}/${file}`);
    if(file==='core.js'){
      code=code.replace("import { StateHistory, CheckpointHistory } from '../_rollback-shared/history.js';\n",read('modules/_rollback-shared/history.js'));
      code+=read('modules/replay/index.js').replace(/^import[^\n]*\n/gm,'');
    }
    if(file==='synctest.js')code=code.replace("from '../_rollback-shared/history.js'","from './core.js'");
    code=code.replace(/from '\.\.\/[^/]+\/([^']+)'/g,"from './$1'");
    const original = provenance.files[`src/${file}`], modified = provenance.modifiedFiles?.[`src/${file}`];
    if (modified) { assert.notEqual(modified.normalizedSha256, original, file); assert.ok(modified.reason, file); }
    assert.equal(createHash('sha256').update(code).digest('hex'), modified?.normalizedSha256 ?? original, file);
  }
});
