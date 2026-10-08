import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoop} from '../loop.js';
function fixture(options={}){
  const events=[];let tick=0, clock=0;
  const session={inputSize:1,profile:{tickRate:20,maxCatchupSteps:5},metrics:{pace:1},closed:false,resimulating:false,
    poll(){events.push(['poll',clock]);if(this.resimulating)this.resimulating=false},
    advance(input){events.push(['advance',clock,input[0]]);return{status:'advanced',tick:++tick}},releaseInput(){events.push(['release'])}};
  const loop=createLoop({session,getInput:()=>new Uint8Array([7]),beforeFrame:timestamp=>{clock=timestamp;events.push(['before',timestamp])},
    render:ctx=>events.push(['render',ctx.alpha]),...options});
  return{session,loop,events,get tick(){return tick}};
}
test('manual loop updates clock before polling, respects each terminal step and continues recovery/render on holds',()=>{
  let allowed=true;const f=fixture({canAdvance:()=>allowed,onAdvance:()=>{allowed=false}});
  f.loop.pulse(0);f.loop.pulse(250);assert.equal(f.tick,1);
  assert.deepEqual(f.events.slice(0,2),[['before',0],['poll',0]]);
  assert.equal(f.events.filter(e=>e[0]==='advance')[0][1],250);
  f.session.resimulating=true;f.loop.pulse(500);assert.equal(f.session.resimulating,false);assert.equal(f.tick,1);
  assert.equal(f.events.filter(e=>e[0]==='render').length,3);
  allowed=true;f.loop.resetTiming();f.loop.pulse(1000);assert.equal(f.tick,1);f.loop.pulse(1050);assert.equal(f.tick,2);
});
test('loop executes due fixed ticks and caps accumulated wall-clock catchup',()=>{
  const f=fixture();
  f.loop.pulse(0);f.loop.pulse(250);assert.equal(f.tick,5);
  f.loop.pulse(300);assert.equal(f.tick,6);
  f.loop.pulse(10000);assert.equal(f.tick,6);
});

test('large clock gaps discard backlog once instead of replaying it across pulses',()=>{
  let dropped=null;const f=fixture({onBacklogDrop:event=>{dropped=event}});
  f.loop.pulse(0);f.loop.pulse(1000);
  assert.equal(f.tick,0);assert.equal(dropped.elapsedMs,1000);assert.equal(dropped.droppedTicks,20);
  f.loop.pulse(1050);assert.equal(f.tick,1);
});
test('automatic RAF start/stop is idempotent and errors stop scheduling',()=>{
  const callbacks=new Map();let next=0,cancelled=0,error;
  const f=fixture({requestFrame:callback=>{callbacks.set(++next,callback);return next},cancelFrame:id=>{callbacks.delete(id);cancelled++},onError:e=>{error=e}});
  f.loop.start();f.loop.start();assert.equal(callbacks.size,1);callbacks.get(1)(0);assert.equal(f.loop.running,true);
  callbacks.get(2)(NaN);assert.equal(f.loop.running,false);assert.match(error.message,/timestamp/);assert.equal(cancelled,1);
  const manual=fixture();assert.throws(()=>manual.loop.start(),/frame scheduler/);
});
test('loop rejects invalid callbacks',()=>{
  const f=fixture();
  assert.throws(()=>createLoop({session:f.session,canAdvance:false}),/callback/);
});

test('reentrant restart owns exactly one RAF chain; stale callbacks cannot revive it',()=>{
  const callbacks=new Map();let next=0,restart=true;
  const f=fixture({requestFrame:callback=>{callbacks.set(++next,callback);return next},cancelFrame:id=>callbacks.delete(id),
    render:()=>{if(restart){restart=false;f.loop.stop();f.loop.start()}}});
  f.loop.start();const old=callbacks.get(1);callbacks.delete(1);old(0);
  assert.equal(callbacks.size,1);assert.equal(next,2);
  old(50);assert.equal(callbacks.size,1);assert.equal(f.tick,0);
  f.loop.stop();assert.equal(callbacks.size,0);
});
test('stop cancels the current catchup pulse but later manual pulses remain supported',()=>{
  let stop=true,renders=0;const f=fixture({onAdvance:()=>{if(stop)f.loop.stop()},render:()=>renders++});
  f.loop.pulse(0);f.loop.pulse(250);assert.equal(f.tick,1);assert.equal(renders,1);
  stop=false;f.loop.resetTiming();f.loop.pulse(300);f.loop.pulse(350);assert.equal(f.tick,2);assert.equal(renders,3);
});
test('each callback boundary cancels stale work, including beforeFrame, poll, input and canAdvance',()=>{
  for(const boundary of ['beforeFrame','poll','canAdvance','getInput','advance']){
    let cancel=false,renders=0;const f=fixture({render:()=>renders++});
    const original=f.session[boundary];
    const options={session:f.session,render:()=>renders++};
    let loop;
    const callback=()=>{if(cancel)loop.stop();return boundary==='getInput'?new Uint8Array(1):true};
    if(boundary==='poll'||boundary==='advance') f.session[boundary]=(...args)=>{callback();return original.apply(f.session,args)};
    else options[boundary]=callback;
    loop=createLoop(options);loop.pulse(0);cancel=true;loop.pulse(250);
    assert.equal(f.tick,boundary==='advance'?1:0,boundary);assert.equal(renders,1,boundary);
  }
});
test('scalar pace avoids metrics snapshots; legacy pacing uses one read per step decision',()=>{
  let reads=0;const f=fixture();Object.defineProperty(f.session,'metrics',{get(){reads++;return{pace:1}}});
  Object.defineProperty(f.session,'pace',{get(){return 1}});
  f.loop.pulse(0);f.loop.pulse(250);assert.equal(f.tick,5);assert.equal(reads,0);
  const legacy=fixture();let legacyReads=0;Object.defineProperty(legacy.session,'metrics',{get(){legacyReads++;return{pace:1}}});
  legacy.loop.pulse(0);legacy.loop.pulse(250);assert.equal(legacy.tick,5);assert.ok(legacyReads<=6);
});

test('retain backlog preserves short elapsed debt in bounded batches; reset excludes pause duration',()=>{
  let allowed=true;const f=fixture({backlogPolicy:'retain',maxBacklogTicks:20,canAdvance:()=>allowed});
  f.loop.pulse(0);f.loop.pulse(1000);assert.equal(f.tick,5);
  f.loop.pulse(1000);f.loop.pulse(1000);f.loop.pulse(1000);assert.equal(f.tick,20);
  f.loop.pulse(1000);assert.equal(f.tick,20);
  allowed=false;f.loop.pulse(1500);assert.equal(f.tick,20);allowed=true;
  f.loop.pulse(1500);f.loop.pulse(1500);assert.equal(f.tick,30);
  f.loop.resetTiming();f.loop.pulse(100000);assert.equal(f.tick,30);f.loop.pulse(100050);assert.equal(f.tick,31);
  const drop=fixture({maxBacklogTicks:20});drop.loop.pulse(0);drop.loop.pulse(1000);drop.loop.pulse(1000);assert.equal(drop.tick,5);
  assert.throws(()=>fixture({backlogPolicy:'unbounded'}),/backlogPolicy/);
});
test('retain uses the current pace each step and retains debt after a held result',()=>{
  const f=fixture({backlogPolicy:'retain',maxBacklogTicks:20});let steps=0,held=true;
  Object.defineProperty(f.session,'pace',{get:()=>steps<2?2:1});
  f.session.advance=()=>{if(held)return{status:'held'};steps++;return{status:'advanced'}};
  f.loop.pulse(0);f.loop.pulse(500);assert.equal(steps,0);held=false;
  f.loop.pulse(500);assert.equal(steps,5);f.loop.pulse(500);assert.equal(steps,8);
});
test('retain stop during catchup cancels remaining steps and start resets previous debt',()=>{
  const callbacks=new Map();let next=0,stop=true;
  const f=fixture({backlogPolicy:'retain',maxBacklogTicks:20,requestFrame:callback=>{callbacks.set(++next,callback);return next},cancelFrame:id=>callbacks.delete(id),onAdvance:()=>{if(stop)f.loop.stop()}});
  f.loop.pulse(0);f.loop.pulse(1000);assert.equal(f.tick,1);
  stop=false;f.loop.start();const cb=callbacks.get(next);cb(2000);assert.equal(f.tick,1);f.loop.stop();
});
test('retain rejects regressed clocks and drops unsafe-sized gaps through the backlog boundary',()=>{
  const f=fixture({backlogPolicy:'retain'});f.loop.pulse(1000);
  assert.throws(()=>f.loop.pulse(999),/cannot regress/);
  f.loop.resetTiming();f.loop.pulse(0);
  assert.doesNotThrow(()=>f.loop.pulse(Number.MAX_SAFE_INTEGER+1));
  f.loop.resetTiming();f.loop.pulse(10);f.loop.pulse(60);assert.equal(f.tick,1);
});
test('advance-triggered stop debits a completed tick without touching a restarted timing epoch',()=>{
  for(const backlogPolicy of ['drop','retain']){
    const f=fixture({backlogPolicy});const advance=f.session.advance;
    f.session.advance=input=>{const result=advance.call(f.session,input);f.loop.stop();return result};
    f.loop.pulse(0);f.loop.pulse(50);assert.equal(f.tick,1);
    f.loop.pulse(50);assert.equal(f.tick,1,backlogPolicy);
    f.loop.pulse(100);assert.equal(f.tick,2);
    const restarted=fixture({backlogPolicy,requestFrame:()=>1,cancelFrame:()=>{}}),next=restarted.session.advance;
    restarted.session.advance=input=>{const result=next.call(restarted.session,input);restarted.loop.stop();restarted.loop.start();return result};
    restarted.loop.pulse(0);restarted.loop.pulse(50);assert.equal(restarted.tick,1);
    restarted.loop.pulse(50);assert.equal(restarted.tick,1);restarted.loop.stop();
  }
});
