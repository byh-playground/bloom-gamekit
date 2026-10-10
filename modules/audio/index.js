/** Independent event-driven Web Audio resource owner. All public durations are ms. */
export const audioDefaults={volume:.7,headroom:.24,maxVoices:12,rampMs:8,storageKey:null,
  synthesis:{attackMs:4,releaseTailMs:6,sourceTailMs:10,noiseMs:1000,minGain:.0001,minHz:20},
  compressor:{threshold:-18,knee:12,ratio:6,attackMs:3,releaseMs:120},
  categories:{sfx:{volume:1,max:12,gapMs:0,priority:0}},sounds:{}};
function validateRecipe(recipe){if(!recipe||!Array.isArray(recipe.layers)||!recipe.layers.length)throw new TypeError('sound.layers required');
  for(const layer of recipe.layers){if(!['tone','noise','buffer'].includes(layer.kind)||!Number.isFinite(layer.ms)||layer.ms<=0||layer.ms>10000||!Number.isFinite(layer.gain)||layer.gain<0||layer.gain>1||!Number.isFinite(layer.delay??0)||(layer.delay??0)<0)throw new RangeError('finite bounded layer duration/gain/delay required');
    if(layer.kind==='tone'&&(!Number.isFinite(layer.hz)||layer.hz<=0||!Number.isFinite(layer.end)||layer.end<=0||!['sine','square','triangle','sawtooth'].includes(layer.type)))throw new RangeError('valid tone frequency/type required');
    if(layer.kind==='noise'&&(!Number.isFinite(layer.hz)||layer.hz<=0))throw new RangeError('noise cutoff required');}}
export function makeNoise(context,noiseMs=audioDefaults.synthesis.noiseMs){const buffer=context.createBuffer(1,Math.round(context.sampleRate*noiseMs/1000),context.sampleRate),data=buffer.getChannelData(0);let seed=213341;
  for(let i=0;i<data.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;data[i]=seed/2147483648-1;}return buffer;}
export function createMix(context,destination,config=audioDefaults){const compressor=context.createDynamicsCompressor(),master=context.createGain();
  for(const key of ['threshold','knee','ratio'])compressor[key].value=config.compressor[key];compressor.attack.value=config.compressor.attackMs/1000;compressor.release.value=config.compressor.releaseMs/1000;
  master.gain.value=config.headroom*config.volume;compressor.connect(master);master.connect(destination);return {input:compressor,master,compressor};}
// Same graph builder is used in live playback and OfflineAudioContext verification.
export function renderSound(context,destination,recipe,buffer,{at=context.currentTime,scale=1,onEnded=()=>{},buffers=new Map(),synthesis=audioDefaults.synthesis}={}){
  validateRecipe(recipe);for(const layer of recipe.layers)if(layer.kind==='buffer'&&!buffers.has(layer.bufferId))throw new Error('AudioBuffer not registered: '+layer.bufferId);
  const voices=[];let remaining=recipe.layers.length,finished=false;
  const finish=()=>{if(--remaining===0&&!finished){finished=true;onEnded();}};
  for(const layer of recipe.layers){const start=at+(layer.delay||0)/1000,duration=layer.ms/1000,gain=context.createGain();let source,filter;
    if(layer.kind==='buffer'){source=context.createBufferSource();source.buffer=buffers.get(layer.bufferId);source.connect(gain);}
    else if(layer.kind==='noise'){source=context.createBufferSource();source.buffer=buffer;source.loop=duration>buffer.duration;filter=context.createBiquadFilter();filter.type='lowpass';filter.frequency.value=layer.hz;source.connect(filter);filter.connect(gain);}
    else{source=context.createOscillator();source.type=layer.type;source.frequency.setValueAtTime(layer.hz,start);source.frequency.exponentialRampToValueAtTime(Math.max(synthesis.minHz,layer.end),start+duration);source.connect(gain);}
    gain.gain.setValueAtTime(0,start);gain.gain.linearRampToValueAtTime(layer.gain*scale,start+synthesis.attackMs/1000);gain.gain.exponentialRampToValueAtTime(synthesis.minGain,start+duration);gain.gain.linearRampToValueAtTime(0,start+duration+synthesis.releaseTailMs/1000);gain.connect(destination);
    source.onended=()=>{source.disconnect();filter?.disconnect();gain.disconnect();finish();};source.start(start);source.stop(start+duration+synthesis.sourceTailMs/1000);voices.push({source,gain});
  }
  return {stop(){for(const voice of voices){try{voice.gain.gain.cancelScheduledValues(context.currentTime);voice.gain.gain.setTargetAtTime(0,context.currentTime,.004);voice.source.stop(context.currentTime);}catch{}}}};
}
/** Sound recipes/categories are caller-owned; this player owns only audio resources and budgets. */
export class AudioPlayer {
  constructor(config=audioDefaults){config={...audioDefaults,...config,compressor:{...audioDefaults.compressor,...config.compressor},synthesis:{...audioDefaults.synthesis,...config.synthesis}};this.config=config;
    if(!Number.isSafeInteger(config.maxVoices)||config.maxVoices<1||config.maxVoices>64)throw new RangeError('maxVoices must be 1..64');
    for(const c of Object.values(config.categories))if(!Number.isFinite(c.volume)||c.volume<0||c.volume>1||!Number.isSafeInteger(c.max)||c.max<1||!Number.isFinite(c.gapMs)||c.gapMs<0||!Number.isFinite(c.priority))throw new RangeError('valid category volume/budget/gap/priority required');
    for(const recipe of Object.values(config.sounds)){validateRecipe(recipe);if(!config.categories[recipe.category])throw new Error('unknown sound category');}
    this.disposed=false;this.buffers=new Map();this.categoryVolumes=new Map(Object.entries(config.categories).map(([name,c])=>[name,c.volume]));this.context=null;this.mix=null;this.noise=null;this.analyser=null;this.volume=config.volume;this.muted=false;this.voices=new Set();this.lastCategory=new Map();this.metrics={played:0,dropped:0,blocked:0,maxObserved:0,bySound:{}};
    try{const data=JSON.parse(config.storageKey?globalThis.localStorage?.getItem(config.storageKey):null);if(data){if(Number.isFinite(data.volume))this.volume=Math.max(0,Math.min(1,data.volume));this.muted=data.muted===true;for(const [name,value] of Object.entries(data.categories||{}))if(this.categoryVolumes.has(name)&&Number.isFinite(value))this.categoryVolumes.set(name,Math.max(0,Math.min(1,value)));}}catch{}
    this.onGesture=()=>{if(!globalThis.document?.hidden)void this.unlock();};this.onHidden=()=>{if(globalThis.document?.hidden){this.stopAll();void this.context?.suspend().catch(()=>{});}};
    globalThis.document?.addEventListener('pointerdown',this.onGesture,{capture:true});globalThis.document?.addEventListener('keydown',this.onGesture,{capture:true});globalThis.document?.addEventListener('visibilitychange',this.onHidden);
  }
  async unlock(){if(this.disposed)return false;try{if(!this.context){const Audio=globalThis.AudioContext||globalThis.webkitAudioContext;if(!Audio)return false;this.context=new Audio({latencyHint:'interactive'});this.analyser=this.context.createAnalyser();this.analyser.fftSize=512;this.mix=createMix(this.context,this.analyser,this.config);this.analyser.connect(this.context.destination);this.noise=makeNoise(this.context,this.config.synthesis.noiseMs);this.applyVolume();this.context.onstatechange=()=>{if(this.context.state!=='running')this.stopAll();};}
    if(globalThis.document?.hidden)return false;if(this.context.state!=='running')await this.context.resume();return this.context.state==='running';
    }catch(error){this.metrics.blocked++;this.lastError=String(error.message||error);return false;}}
  applyVolume(){if(!this.mix)return;const now=this.context.currentTime;this.mix.master.gain.cancelScheduledValues(now);this.mix.master.gain.setTargetAtTime(this.muted?0:this.volume*this.config.headroom,now,this.config.rampMs/1000);}
  save(){if(!this.config.storageKey)return;try{globalThis.localStorage?.setItem(this.config.storageKey,JSON.stringify({volume:this.volume,muted:this.muted,categories:Object.fromEntries(this.categoryVolumes)}));}catch{}}
  /** Registers caller-owned reusable decoded data; no fetch/decode or gameplay history. */
  setBuffer(id,buffer){if(typeof id!=='string'||!id||typeof buffer?.getChannelData!=='function')throw new TypeError('AudioBuffer and string ID required');this.buffers.set(id,buffer);}
  setCategoryVolume(name,value){if(!this.categoryVolumes.has(name)||!Number.isFinite(value))return false;this.categoryVolumes.set(name,Math.max(0,Math.min(1,value)));this.save();return true;}
  setVolume(value){if(!Number.isFinite(value))return;this.volume=Math.max(0,Math.min(1,value));this.applyVolume();this.save();}
  setMuted(value){this.muted=!!value;this.applyVolume();if(this.muted)this.stopAll();this.save();}
  stopAll(){for(const voice of this.voices)voice.handle.stop();this.voices.clear();this.lastCategory.clear();}
  play(id,strength=1){return !!this.start(id,strength);}
  /** Returns a stoppable voice or null; blocked/muted events are dropped, never queued. */
  start(id,strength=1,onEnded=()=>{}){if(this.disposed||!Number.isFinite(strength)||strength<=0)return null;if(this.muted||this.volume<=0)return null;if(!this.context||this.context.state!=='running'||globalThis.document?.hidden){this.metrics.blocked++;return null;}
    const recipe=this.config.sounds[id];if(!recipe)return null;const category=this.config.categories[recipe.category],priority=recipe.priority??category.priority,now=this.context.currentTime*1000;
    if(now-(this.lastCategory.get(recipe.category)??-Infinity)<(recipe.gapMs??category.gapMs)){this.metrics.dropped++;return null;}
    if(this.categoryVolumes.get(recipe.category)<=0)return null;
    const group=[...this.voices].filter(v=>v.category===recipe.category);if(group.length>=category.max){const low=group.sort((a,b)=>a.priority-b.priority||a.at-b.at)[0];if(low.priority>=priority){this.metrics.dropped++;return null;}low.handle.stop();this.voices.delete(low);}
    if(this.voices.size>=this.config.maxVoices){const low=[...this.voices].sort((a,b)=>a.priority-b.priority||a.at-b.at)[0];if(low.priority>=priority){this.metrics.dropped++;return null;}low.handle.stop();this.voices.delete(low);}
    const voice={category:recipe.category,priority,at:now,handle:null};voice.handle=renderSound(this.context,this.mix.input,recipe,this.noise,{scale:this.categoryVolumes.get(recipe.category)*Math.max(0,Math.min(1,strength)),buffers:this.buffers,synthesis:this.config.synthesis,onEnded:()=>{this.voices.delete(voice);onEnded();}});this.voices.add(voice);this.lastCategory.set(recipe.category,now);
    this.metrics.played++;this.metrics.bySound[id]=(this.metrics.bySound[id]||0)+1;this.metrics.maxObserved=Math.max(this.metrics.maxObserved,this.voices.size);return voice.handle;
  }
  /** Connect to PresentationEventQueue's confirmed SFX policy; no second journal. */
  createAdapter({onEnded=()=>{}}={}){return {reversible:false,start:event=>{if(event.policy&&event.policy!=='confirmed')throw new Error('one-shot SFX requires confirmed policy');let stopped=false;const handle=this.start(event.payload?.soundId,event.payload?.strength??1,()=>{if(!stopped)onEnded(event);});return handle?{stop(){stopped=true;handle.stop();}}:null;},stop:handle=>handle?.stop()};}
  meter(){if(!this.analyser)return {peak:0,rms:0};const values=new Float32Array(this.analyser.fftSize);this.analyser.getFloatTimeDomainData(values);let peak=0,sum=0;for(const value of values){peak=Math.max(peak,Math.abs(value));sum+=value*value;}return {peak,rms:Math.sqrt(sum/values.length)};}
  snapshot(){return {state:this.disposed?'disposed':this.context?.state||'locked',volume:this.volume,muted:this.muted,voices:this.voices.size,categoryVolumes:Object.fromEntries(this.categoryVolumes),lastError:this.lastError||null,...this.metrics,bySound:{...this.metrics.bySound}};}
  dispose(){if(this.disposed)return;this.disposed=true;globalThis.document?.removeEventListener('pointerdown',this.onGesture,true);globalThis.document?.removeEventListener('keydown',this.onGesture,true);globalThis.document?.removeEventListener('visibilitychange',this.onHidden);this.stopAll();this.buffers.clear();this.noise=null;this.analyser?.disconnect();this.mix?.master.disconnect();this.mix?.compressor.disconnect();return this.context?.close().catch(()=>{});}
}
