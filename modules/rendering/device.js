/** Programmable WebGL 1 resource/stream/pass core. Game owns geometry and materials. */
const FUNCTIONS = Object.freeze({ never: 'NEVER', less: 'LESS', equal: 'EQUAL', lequal: 'LEQUAL', greater: 'GREATER', notequal: 'NOTEQUAL', gequal: 'GEQUAL', always: 'ALWAYS' });
const OPERATIONS = Object.freeze({ keep: 'KEEP', zero: 'ZERO', replace: 'REPLACE', increment: 'INCR', decrement: 'DECR', invert: 'INVERT', 'increment-wrap': 'INCR_WRAP', 'decrement-wrap': 'DECR_WRAP' });
const UNIFORMS = new Set(['1f','2f','3f','4f','1i','2i','3i','4i','1iv','1fv','2fv','3fv','4fv','matrix3fv','matrix4fv']);
const BLENDS = new Set(['source-over','straight-alpha','copy','lighter','source-in','destination-in']);
const ALL_COLOR = Object.freeze([true,true,true,true]);
function integer(n, name, min = 0, max = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(n) || n < min || n > max) throw new RangeError(`${name}: ${min}..${max}`); }
function finiteArray(value, count, name) { if (!value || value.length !== count || !Array.from(value).every(Number.isFinite)) throw new TypeError(`${name} needs ${count} finite numbers`); }
function compile(gl, type, source) {
  const shader = gl.createShader(type); if (!shader) throw new Error('Shader allocation failed');
  gl.shaderSource(shader, source); gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { const message = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw new Error(`Shader compilation failed: ${message}`); }
  return shader;
}

/**
 * Stable resource handles survive context restoration. Streaming buffers are reallocated
 * empty on restore: upload this frame's geometry again. No loop, sorting, art or game state.
 * Shader outputs select explicit premultiplied or straight-alpha blending per draw.
 */
export class WebGLDevice {
  constructor(canvas, { alpha = false, antialias = true, depth = true, stencil = true, preserveDrawingBuffer = false,
    powerPreference = 'default', failIfMajorPerformanceCaveat = false, checkGLErrors = false,
    maxTextures = 8, maxBufferBytes = 128 * 1024 * 1024 } = {}) {
    if (!canvas?.getContext || !canvas?.addEventListener) throw new TypeError('canvas required');
    if (!['default', 'low-power', 'high-performance'].includes(powerPreference)) throw new TypeError('Invalid WebGL powerPreference');
    if (typeof failIfMajorPerformanceCaveat !== 'boolean') throw new TypeError('failIfMajorPerformanceCaveat must be boolean');
    if (typeof checkGLErrors !== 'boolean') throw new TypeError('checkGLErrors must be boolean');
    this.checkGLErrors = checkGLErrors;
    integer(maxTextures, 'maxTextures', 1, 32); integer(maxBufferBytes, 'maxBufferBytes', 4);
    this.canvas = canvas; this.maxBufferBytes = maxBufferBytes;
    this.gl = canvas.getContext('webgl', { alpha, antialias, depth, stencil, premultipliedAlpha: true, preserveDrawingBuffer, powerPreference, failIfMajorPerformanceCaveat });
    if (!this.gl) throw new Error('WebGL 1 required');
    this._instancingExtension = this.gl.getExtension('ANGLE_instanced_arrays');
    this.instancingSupported = !!this._instancingExtension;
    this.maxTextures = Math.min(maxTextures, this.gl.getParameter(this.gl.MAX_TEXTURE_IMAGE_UNITS));
    this.maxTextureSize = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
    this.depthAvailable = !!this.gl.getContextAttributes().depth; this.stencilAvailable = !!this.gl.getContextAttributes().stencil;
    this.state = 'ready'; this.failure = null; this.active = false; this.boundTextureCount = 0;
    this.pipelines = new Map(); this.buffers = new Map(); this.textures = new Map(); this.renderTargets = new Map(); this.renderTargetStack = []; this.activeRenderTarget = null; this.enabledAttributes = new Set();
    this.stats = { frame:0, drawCalls:0, instancedDrawCalls:0, vertices:0, bufferUploads:0, bufferBytes:0, textureUploads:0, textureBytes:0,
      frameCopies:0, bufferAllocations:0, gpuBufferBytes:0, gpuRenderTargetBytes:0, pipelineCount:0, bufferCount:0, textureCount:0, renderTargetCount:0, restores:0 };
    this.onLost = event => { event.preventDefault(); this.active = false; this.renderTargetStack.length = 0; this.activeRenderTarget = null; this.state = 'lost'; };
    this.onRestored = () => {
      if (this.state === 'disposed') return;
      try {
        this.enabledAttributes.clear(); this.boundTextureCount = 0;
        this._instancingExtension = this.gl.getExtension('ANGLE_instanced_arrays');
        this.instancingSupported = !!this._instancingExtension;
        for (const record of this.pipelines.values()) this._pipeline(record);
        for (const record of this.buffers.values()) { record.gpu = this.gl.createBuffer(); if (!record.gpu) throw new Error('Buffer allocation failed'); this.gl.bindBuffer(this.gl.ARRAY_BUFFER,record.gpu); this.gl.bufferData(this.gl.ARRAY_BUFFER,record.capacity,this.gl.DYNAMIC_DRAW); record.used = 0; this.stats.bufferAllocations++; }
        for (const record of this.textures.values()) { record.gpu = null; this._texture(record); }
        for (const record of this.renderTargets.values()) this._renderTarget(record);
        this.state = 'ready'; this.failure = null; this.stats.restores++;
      } catch (error) { this.state = 'failed'; this.failure = error.message; this._deleteGPU(); }
    };
    canvas.addEventListener('webglcontextlost',this.onLost); canvas.addEventListener('webglcontextrestored',this.onRestored);
  }
  _ready() { if (this.state !== 'ready') throw new Error(`WebGLDevice is ${this.state}${this.failure ? `: ${this.failure}` : ''}`); }
  _handle(map, handle, name) { const record = map.get(handle); if (!record) throw new Error(`Unknown/deleted ${name}`); return record; }
  _pipeline(record) {
    const gl = this.gl; let vertex, fragment, program;
    try {
      vertex = compile(gl,gl.VERTEX_SHADER,record.vertex); fragment = compile(gl,gl.FRAGMENT_SHADER,record.fragment);
      program = gl.createProgram(); if (!program) throw new Error('Program allocation failed');
      gl.attachShader(program,vertex); gl.attachShader(program,fragment); gl.linkProgram(program);
      if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
      record.locations = record.attributes.map(attribute => ({ ...attribute, location: gl.getAttribLocation(program,attribute.name) }));
      record.uniformLocations = new Map(); for (const name of Object.keys(record.uniforms)) record.uniformLocations.set(name,gl.getUniformLocation(program,name));
      record.gpu = program;
    } catch(error) { if (program) gl.deleteProgram(program); throw error; }
    finally { if(vertex)gl.deleteShader(vertex);if(fragment)gl.deleteShader(fragment); }
  }
  /** Attributes use interleaved FLOAT components and byte offsets in their vertex/instance source. */
  createPipeline({ vertex, fragment, stride, instanceStride = 0, attributes, uniforms = {} }) {
    this._ready(); if (typeof vertex !== 'string' || typeof fragment !== 'string') throw new TypeError('Shader sources required');
    integer(stride,'stride',4,255); if (stride % 4) throw new RangeError('stride must align to FLOAT');
    integer(instanceStride,'instanceStride',0,255); if (instanceStride % 4) throw new RangeError('instanceStride must align to FLOAT');
    if (!Array.isArray(attributes) || !attributes.length) throw new TypeError('attributes required');
    const names = new Set();
    for (const a of attributes) {
      if (!a || typeof a.name !== 'string' || !a.name || names.has(a.name)) throw new TypeError('Unique attribute names required');
      names.add(a.name); integer(a.size,'attribute size',1,4);
      const source=a.source??'vertex'; if(source!=='vertex'&&source!=='instance')throw new TypeError('attribute source must be vertex or instance');
      const sourceStride=source==='instance'?instanceStride:stride;
      if(!sourceStride)throw new RangeError('instance attributes require instanceStride');
      integer(a.offset,'attribute offset',0,sourceStride-4); if(a.offset%4 || a.offset+a.size*4>sourceStride) throw new RangeError('attribute outside source stride');
    }
    if (!uniforms || typeof uniforms !== 'object') throw new TypeError('uniform descriptors required');
    for (const type of Object.values(uniforms)) if (!UNIFORMS.has(type)) throw new TypeError(`Unsupported uniform ${type}`);
    const record = {vertex,fragment,stride,instanceStride,instanced:attributes.some(a=>a.source==='instance'),attributes:attributes.map(a=>({...a,source:a.source??'vertex'})),uniforms:{...uniforms},gpu:null}; this._pipeline(record);
    const handle = Object.freeze({stride,instanceStride}); this.pipelines.set(handle,record); this.stats.pipelineCount=this.pipelines.size; return handle;
  }
  deletePipeline(handle) { const r=this.pipelines.get(handle); if(!r)return false; this.gl.useProgram(null);this.gl.deleteProgram(r.gpu);this.pipelines.delete(handle);this.stats.pipelineCount=this.pipelines.size;return true; }
  createVertexBuffer({capacityBytes=0}={}) {
    this._ready();integer(capacityBytes,'capacityBytes',0,this.maxBufferBytes);if(capacityBytes%4)throw new RangeError('capacityBytes must align to FLOAT');
    const gl=this.gl,gpu=gl.createBuffer();if(!gpu)throw new Error('Buffer allocation failed');gl.bindBuffer(gl.ARRAY_BUFFER,gpu);gl.bufferData(gl.ARRAY_BUFFER,capacityBytes,gl.DYNAMIC_DRAW);
    const handle=Object.freeze({});this.buffers.set(handle,{gpu,capacity:capacityBytes,used:0});this.stats.bufferAllocations++;this.stats.gpuBufferBytes+=capacityBytes;this.stats.bufferCount=this.buffers.size;return handle;
  }
  /** View is uploaded synchronously, never copied into another CPU arena or retained. */
  uploadVertices(handle, data) {
    this._ready();const r=this._handle(this.buffers,handle,'buffer');if(!(data instanceof Float32Array))throw new TypeError('Float32Array required');
    if(data.byteLength>this.maxBufferBytes)throw new RangeError('Stream exceeds maxBufferBytes');const gl=this.gl;gl.bindBuffer(gl.ARRAY_BUFFER,r.gpu);
    if(data.byteLength>r.capacity){let capacity=Math.max(4,r.capacity);while(capacity<data.byteLength)capacity=Math.min(this.maxBufferBytes,capacity*2);gl.bufferData(gl.ARRAY_BUFFER,capacity,gl.DYNAMIC_DRAW);this.stats.gpuBufferBytes+=capacity-r.capacity;r.capacity=capacity;this.stats.bufferAllocations++;}
    if(data.byteLength){gl.bufferSubData(gl.ARRAY_BUFFER,0,data);this.stats.bufferUploads++;this.stats.bufferBytes+=data.byteLength;}r.used=data.byteLength;
  }
  deleteVertexBuffer(handle){const r=this.buffers.get(handle);if(!r)return false;this.gl.deleteBuffer(r.gpu);this.buffers.delete(handle);this.stats.gpuBufferBytes-=r.capacity;this.stats.bufferCount=this.buffers.size;return true;}
  _source(source, format, premultiplied) {
    if(source===this.canvas)throw new TypeError('Use copyFrameToTexture for GPU frame composition, not canvas upload');
    if(typeof premultiplied!=='boolean')throw new TypeError('premultiplied must be boolean');
    if(Object.prototype.toString.call(source)==='[object ImageBitmap]')throw new TypeError('ImageBitmap alpha mode is not inspectable');
    const width=source?.naturalWidth??source?.width,height=source?.naturalHeight??source?.height;integer(width,'texture width',1,this.maxTextureSize);integer(height,'texture height',1,this.maxTextureSize);
    if(format!=='rgba'&&format!=='luminance')throw new TypeError('texture format must be rgba or luminance');
    let retained=source;
    if(source.data!==undefined){
      const data=source.data,components=format==='rgba'?4:1;
      if(data!==null&&(!(data instanceof Uint8Array||data instanceof Uint8ClampedArray)||data.length!==width*height*components))throw new TypeError('Texture byte count does not match dimensions/format');
      retained=data===null?null:new Uint8Array(data);
      if(retained&&format==='rgba'&&!premultiplied)for(let i=0;i<retained.length;i+=4){const alpha=retained[i+3]/255;retained[i]=Math.round(retained[i]*alpha);retained[i+1]=Math.round(retained[i+1]*alpha);retained[i+2]=Math.round(retained[i+2]*alpha);}
    }else if(format!=='rgba'||premultiplied)throw new TypeError('DOM sources require rgba and premultiplied:false');
    return {source:retained,width,height,format,premultiplied};
  }
  _texture(record) {
    const gl=this.gl;record.gpu=gl.createTexture();if(!record.gpu)throw new Error('Texture allocation failed');
    try{
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,record.gpu);this.boundTextureCount=Math.max(1,this.boundTextureCount);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE);
      const pixels=record.source===null||record.source instanceof Uint8Array,format=record.copyFormat==='rgb'?gl.RGB:record.format==='rgba'?gl.RGBA:gl.LUMINANCE;gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,!pixels);
      if(pixels)gl.texImage2D(gl.TEXTURE_2D,0,format,record.width,record.height,0,format,gl.UNSIGNED_BYTE,record.source);
      else gl.texImage2D(gl.TEXTURE_2D,0,format,format,gl.UNSIGNED_BYTE,record.source);
      this._filter(record.filter);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      const error=gl.getError();if(error!==gl.NO_ERROR)throw new Error(`Texture upload error ${error}`);
      this.stats.textureUploads++;this.stats.textureBytes+=record.width*record.height*(record.format==='rgba'?4:1);
    }catch(error){gl.deleteTexture(record.gpu);record.gpu=null;throw error;}
  }
  _filter(filter){if(filter!=='nearest'&&filter!=='linear')throw new TypeError('filter must be nearest or linear');const gl=this.gl,value=filter==='nearest'?gl.NEAREST:gl.LINEAR;gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,value);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,value);}
  _renderTarget(record){
    const gl=this.gl,previous=gl.getParameter(gl.FRAMEBUFFER_BINDING),framebuffer=gl.createFramebuffer();
    if(!framebuffer)throw new Error('Render target framebuffer allocation failed');
    try{
      gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,record.gpu,0);
      const status=gl.checkFramebufferStatus(gl.FRAMEBUFFER);if(status!==gl.FRAMEBUFFER_COMPLETE)throw new Error(`Render target framebuffer incomplete: ${status}`);
      record.framebuffer=framebuffer;
    }catch(error){gl.deleteFramebuffer(framebuffer);throw error;}finally{gl.bindFramebuffer(gl.FRAMEBUFFER,previous);}
  }
  /** Creates a reusable, premultiplied RGBA texture/FBO pair; the handle is also a draw texture. */
  createRenderTarget(width,height,{filter='linear'}={}){
    this._ready();integer(width,'render target width',1,this.maxTextureSize);integer(height,'render target height',1,this.maxTextureSize);
    if(filter!=='nearest'&&filter!=='linear')throw new TypeError('filter must be nearest or linear');
    const record={width,height,format:'rgba',premultiplied:true,source:null,filter,gpu:null,framebuffer:null};
    this._texture(record);
    try{this._renderTarget(record);}catch(error){this.gl.deleteTexture(record.gpu);record.gpu=null;throw error;}
    const handle=Object.freeze({width,height});this.textures.set(handle,record);this.renderTargets.set(handle,record);
    this.stats.textureCount=this.textures.size;this.stats.renderTargetCount=this.renderTargets.size;this.stats.gpuRenderTargetBytes+=width*height*4;return handle;
  }
  /** Binds a target inside an active frame. Bindings may nest and must unwind in LIFO order. */
  bindRenderTarget(handle){
    this._ready();if(!this.active)throw new Error('beginFrame required');const record=this._handle(this.renderTargets,handle,'render target');
    if(this.activeRenderTarget===handle||this.renderTargetStack.some(entry=>entry.handle===handle))throw new Error('Render target is already bound');
    const gl=this.gl;this.renderTargetStack.push({handle:this.activeRenderTarget,framebuffer:gl.getParameter(gl.FRAMEBUFFER_BINDING),viewport:gl.getParameter(gl.VIEWPORT)});
    gl.bindFramebuffer(gl.FRAMEBUFFER,record.framebuffer);gl.viewport(0,0,record.width,record.height);this.activeRenderTarget=handle;return handle;
  }
  /** Completes the target pass and restores the previous framebuffer and viewport. */
  unbindRenderTarget(handle){
    this._ready();if(!this.active)throw new Error('beginFrame required');if(!this.renderTargetStack.length)throw new Error('No render target is bound');
    if(handle!==undefined&&handle!==this.activeRenderTarget)throw new Error('Render targets must be unbound in LIFO order');
    const previous=this.renderTargetStack.pop(),gl=this.gl;gl.bindFramebuffer(gl.FRAMEBUFFER,previous.framebuffer);gl.viewport(...previous.viewport);this.activeRenderTarget=previous.handle;return this.activeRenderTarget;
  }
  deleteRenderTarget(handle){
    const record=this.renderTargets.get(handle);if(!record)return false;
    if(this.renderTargetStack.some(entry=>entry.handle===handle)||this.activeRenderTarget===handle)throw new Error('Cannot delete a bound render target');
    this.gl.deleteFramebuffer(record.framebuffer);this.gl.deleteTexture(record.gpu);this.renderTargets.delete(handle);this.textures.delete(handle);
    this.stats.textureCount=this.textures.size;this.stats.renderTargetCount=this.renderTargets.size;this.stats.gpuRenderTargetBytes-=record.width*record.height*4;return true;
  }
  createTexture(source,{format='rgba',premultiplied=false,filter='linear'}={}){
    this._ready();if(filter!=='nearest'&&filter!=='linear')throw new TypeError('Invalid filter');const record={...this._source(source,format,premultiplied),filter,gpu:null};this._texture(record);
    const handle=Object.freeze({width:record.width,height:record.height});this.textures.set(handle,record);this.stats.textureCount=this.textures.size;return handle;
  }
  /** Full source remains restoration authority; region describes only bytes changed since prior upload. */
  updateTexture(handle,source,{x=0,y=0,width=handle.width,height=handle.height}={}){
    this._ready();const r=this._handle(this.textures,handle,'texture');if(this.renderTargets.has(handle))throw new Error('Render targets cannot be updated from CPU pixels');integer(x,'x');integer(y,'y');integer(width,'width',1);integer(height,'height',1);
    if(x+width>r.width||y+height>r.height)throw new RangeError('Texture region outside bounds');
    const next=this._source(source,r.format,r.premultiplied);if(next.width!==r.width||next.height!==r.height||next.source===null)throw new RangeError('Update requires matching full source');
    if(r.copyFormat){const replacement={...next,filter:r.filter,gpu:null};this._texture(replacement);this.gl.deleteTexture(r.gpu);Object.assign(r,replacement);delete r.copyFormat;return;}
    const gl=this.gl,format=r.format==='rgba'?gl.RGBA:gl.LUMINANCE;let pixels=next.source;
    if(pixels instanceof Uint8Array){
      const components=r.format==='rgba'?4:1;
      if(x||y||width!==r.width||height!==r.height){const needed=width*height*components;if(!this.regionBytes||this.regionBytes.length!==needed)this.regionBytes=new Uint8Array(needed);for(let row=0;row<height;row++){const start=((y+row)*r.width+x)*components;this.regionBytes.set(pixels.subarray(start,start+width*components),row*width*components);}pixels=this.regionBytes;}
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
    }else{
      if(x||y||width!==r.width||height!==r.height){
        if(!this.regionCanvas){const doc=this.canvas.ownerDocument;if(!doc?.createElement)throw new Error('DOM region uploads require canvas.ownerDocument');this.regionCanvas=doc.createElement('canvas');this.regionContext=this.regionCanvas.getContext('2d');if(!this.regionContext)throw new Error('Asset-region Canvas2D unavailable');}
        const c=this.regionCanvas,q=this.regionContext;if(c.width!==width||c.height!==height){c.width=width;c.height=height;}else q.clearRect(0,0,width,height);q.drawImage(next.source,x,y,width,height,0,0,width,height);pixels=c;
      }
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);
    }
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,r.gpu);this.boundTextureCount=Math.max(1,this.boundTextureCount);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
    if(pixels instanceof Uint8Array)gl.texSubImage2D(gl.TEXTURE_2D,0,x,y,width,height,format,gl.UNSIGNED_BYTE,pixels);else gl.texSubImage2D(gl.TEXTURE_2D,0,x,y,format,gl.UNSIGNED_BYTE,pixels);
    if(this.checkGLErrors){const error=gl.getError();if(error!==gl.NO_ERROR)throw new Error(`Texture update error ${error}`);}r.source=next.source;this.stats.textureUploads++;this.stats.textureBytes+=width*height*(r.format==='rgba'?4:1);
  }
  /** Copies the resolved framebuffer on-GPU. Recopy after restore; pixels are not CPU-retained. */
  copyFrameToTexture(handle,{x=0,y=0}={}){
    this._ready();const r=this._handle(this.textures,handle,'texture');if(this.renderTargets.has(handle))throw new Error('Render targets cannot be copied from the default framebuffer');integer(x,'x');integer(y,'y');if(r.format!=='rgba'||x+r.width>this.canvas.width||y+r.height>this.canvas.height)throw new RangeError('Framebuffer copy outside bounds');
    const gl=this.gl;gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,r.gpu);this.boundTextureCount=Math.max(1,this.boundTextureCount);
    // WebGL 1 cannot copy RGB default-framebuffer pixels into RGBA storage.
    // Preserve RGB-only contexts (both games) without requesting an alpha buffer.
    let allocated=false;
    if(!gl.getContextAttributes().alpha&&r.copyFormat!=='rgb'){
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,r.width,r.height,0,gl.RGB,gl.UNSIGNED_BYTE,null);r.copyFormat='rgb';allocated=true;
      this.stats.textureUploads++;this.stats.textureBytes+=r.width*r.height*3;
    }
    gl.copyTexSubImage2D(gl.TEXTURE_2D,0,0,0,x,y,r.width,r.height);if(allocated||this.checkGLErrors){const error=gl.getError();if(error!==gl.NO_ERROR)throw new Error(`Framebuffer copy error ${error}`);}r.source=null;this.stats.frameCopies++;
  }
  deleteTexture(handle){const r=this.textures.get(handle);if(!r)return false;if(this.renderTargets.has(handle))throw new Error('Use deleteRenderTarget for render targets');this.gl.deleteTexture(r.gpu);this.textures.delete(handle);this.stats.textureCount=this.textures.size;return true;}
  beginFrame({width=this.canvas.width,height=this.canvas.height,clearColor=[0,0,0,0],clearDepth=1,clearStencil=0}={}){
    if(this.state==='lost')return false;this._ready();if(this.active)throw new Error('endFrame required');integer(width,'width',1);integer(height,'height',1);
    const gl=this.gl,limit=gl.getParameter(gl.MAX_VIEWPORT_DIMS);if(width>limit[0]||height>limit[1])throw new RangeError('Viewport exceeds WebGL limit');
    if(this.canvas.width!==width)this.canvas.width=width;if(this.canvas.height!==height)this.canvas.height=height;gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,width,height);this.renderTargetStack.length=0;this.activeRenderTarget=null;
    this.stats.frame++;for(const name of ['drawCalls','instancedDrawCalls','vertices','bufferUploads','bufferBytes','textureUploads','textureBytes','frameCopies'])this.stats[name]=0;
    this.active=true;this.clear({color:clearColor,depth:clearDepth,stencil:clearStencil});return true;
  }
  clear({color,depth,stencil}={}){
    this._ready();const gl=this.gl;let flags=0;
    if(color!==undefined){finiteArray(color,4,'clear color');gl.colorMask(true,true,true,true);gl.clearColor(...color);flags|=gl.COLOR_BUFFER_BIT;}
    if(depth!==undefined){if(!Number.isFinite(depth)||depth<0||depth>1)throw new RangeError('clear depth 0..1');gl.depthMask(true);gl.clearDepth(depth);flags|=gl.DEPTH_BUFFER_BIT;}
    if(stencil!==undefined){integer(stencil,'clear stencil',0,255);gl.stencilMask(255);gl.clearStencil(stencil);flags|=gl.STENCIL_BUFFER_BIT;}
    gl.disable(gl.SCISSOR_TEST);gl.clear(flags);
  }
  /** Full pass state is explicit per draw; no state leakage between game materials. */
  draw({pipeline,buffer,instanceBuffer,instances=1,first=0,count,uniforms={},textures=[],blend='source-over',depth=false,stencil=false,colorMask=ALL_COLOR,filter}={}){
    this._ready();if(!this.active)throw new Error('beginFrame required');const p=this._handle(this.pipelines,pipeline,'pipeline'),b=this._handle(this.buffers,buffer,'buffer');
    integer(first,'first');integer(count,'count');if(first+count>b.used/p.stride)throw new RangeError('draw exceeds uploaded vertices');
    integer(instances,'instances',1);
    let instanceRecord;
    if(p.instanced){
      if(!this._instancingExtension)throw new Error('ANGLE_instanced_arrays required for instance attributes');
      instanceRecord=this._handle(this.buffers,instanceBuffer,'instance buffer');
      if(instances>instanceRecord.used/p.instanceStride)throw new RangeError('draw exceeds uploaded instances');
    }else if(instances!==1)throw new RangeError('Multiple instances require instance attributes');
    if(!Number.isSafeInteger(count*instances))throw new RangeError('draw vertex count exceeds safe integer range');
    if(depth&&!this.depthAvailable)throw new Error('Context has no depth buffer');if(stencil&&!this.stencilAvailable)throw new Error('Context has no stencil buffer');
    if(blend!==false&&!BLENDS.has(blend))throw new TypeError('Unsupported blend');if(depth&&!FUNCTIONS[depth.func??'lequal'])throw new TypeError('Unsupported depth function');
    if(stencil){if(!FUNCTIONS[stencil.func??'always'])throw new TypeError('Unsupported stencil function');for(const key of ['fail','zfail','pass'])if(!OPERATIONS[stencil[key]??'keep'])throw new TypeError('Unsupported stencil operation');for(const key of ['ref','mask','writeMask'])integer(stencil[key]??(key==='ref'?0:255),key,0,255);}
    if(!colorMask||colorMask.length!==4||!Array.from(colorMask).every(v=>typeof v==='boolean'))throw new TypeError('colorMask must contain booleans');
    if(!Array.isArray(textures)||textures.length>this.maxTextures)throw new RangeError('Too many textures');for(const handle of textures){this._handle(this.textures,handle,'texture');if(handle===this.activeRenderTarget)throw new Error('Cannot sample the active render target');}
    if(filter!==undefined&&filter!=='nearest'&&filter!=='linear')throw new TypeError('Unsupported filter');
    const gl=this.gl,instancing=this._instancingExtension;gl.useProgram(p.gpu);
    for(const index of this.enabledAttributes){if(instancing)instancing.vertexAttribDivisorANGLE(index,0);gl.disableVertexAttribArray(index);}this.enabledAttributes.clear();
    let boundBuffer=null;
    for(const a of p.locations)if(a.location>=0){
      const isInstance=a.source==='instance',sourceBuffer=isInstance?instanceRecord:b;
      if(boundBuffer!==sourceBuffer.gpu){gl.bindBuffer(gl.ARRAY_BUFFER,sourceBuffer.gpu);boundBuffer=sourceBuffer.gpu;}
      gl.enableVertexAttribArray(a.location);gl.vertexAttribPointer(a.location,a.size,gl.FLOAT,false,isInstance?p.instanceStride:p.stride,a.offset);
      if(instancing)instancing.vertexAttribDivisorANGLE(a.location,isInstance?1:0);this.enabledAttributes.add(a.location);
    }
    for(const [name,value]of Object.entries(uniforms)){
      const type=p.uniforms[name];if(!type)throw new TypeError(`Undeclared uniform ${name}`);const location=p.uniformLocations.get(name);if(location===null)continue;
      if(type.startsWith('matrix'))gl[`uniformMatrix${type[6]}fv`](location,false,value);
      else if(type.endsWith('v'))gl[`uniform${type}`](location,value);
      else if(type[0]==='1')gl[`uniform${type}`](location,value);
      else gl[`uniform${type}`](location,...value);
    }
    const textureUnits=Math.max(this.boundTextureCount,textures.length);for(let i=0;i<textureUnits;i++){gl.activeTexture(gl.TEXTURE0+i);const r=i<textures.length?this.textures.get(textures[i]):null;gl.bindTexture(gl.TEXTURE_2D,r?.gpu??null);if(r)this._filter(filter??r.filter);}if(textureUnits)gl.activeTexture(gl.TEXTURE0);this.boundTextureCount=textures.length;
    if(blend===false)gl.disable(gl.BLEND);else{gl.enable(gl.BLEND);gl.blendEquation(gl.FUNC_ADD);const factors=blend==='source-over'?[gl.ONE,gl.ONE_MINUS_SRC_ALPHA]:blend==='straight-alpha'?[gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA]:blend==='copy'?[gl.ONE,gl.ZERO]:blend==='lighter'?[gl.ONE,gl.ONE]:blend==='source-in'?[gl.DST_ALPHA,gl.ZERO]:[gl.ZERO,gl.SRC_ALPHA];gl.blendFunc(...factors);}
    if(depth){gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl[FUNCTIONS[depth.func??'lequal']]);gl.depthMask(depth.write??true);}else{gl.disable(gl.DEPTH_TEST);gl.depthMask(false);}
    if(stencil){gl.enable(gl.STENCIL_TEST);gl.stencilFunc(gl[FUNCTIONS[stencil.func??'always']],stencil.ref??0,stencil.mask??255);gl.stencilMask(stencil.writeMask??255);gl.stencilOp(gl[OPERATIONS[stencil.fail??'keep']],gl[OPERATIONS[stencil.zfail??'keep']],gl[OPERATIONS[stencil.pass??'keep']]);}else gl.disable(gl.STENCIL_TEST);
    gl.colorMask(...colorMask);gl.disable(gl.CULL_FACE);gl.disable(gl.DITHER);gl.disable(gl.SCISSOR_TEST);
    if(p.instanced){instancing.drawArraysInstancedANGLE(gl.TRIANGLES,first,count,instances);this.stats.instancedDrawCalls++;}
    else gl.drawArrays(gl.TRIANGLES,first,count);
    this.stats.drawCalls++;this.stats.vertices+=count*instances;
  }
  endFrame(){this._ready();if(!this.active)throw new Error('beginFrame required');if(this.renderTargetStack.length)throw new Error('Unbind render targets before endFrame');this.active=false;return this.stats;}
  _deleteGPU(){const gl=this.gl;gl.useProgram(null);gl.bindBuffer(gl.ARRAY_BUFFER,null);for(let i=0;i<this.maxTextures;i++){gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,null);}gl.activeTexture(gl.TEXTURE0);for(const r of this.pipelines.values())gl.deleteProgram(r.gpu);for(const r of this.buffers.values())gl.deleteBuffer(r.gpu);for(const r of this.renderTargets.values())gl.deleteFramebuffer(r.framebuffer);for(const r of this.textures.values())gl.deleteTexture(r.gpu);}
  dispose(){if(this.state==='disposed')return;this.canvas.removeEventListener('webglcontextlost',this.onLost);this.canvas.removeEventListener('webglcontextrestored',this.onRestored);this._deleteGPU();this.pipelines.clear();this.buffers.clear();this.textures.clear();this.renderTargets.clear();this.renderTargetStack.length=0;this.activeRenderTarget=null;this.enabledAttributes.clear();this.regionCanvas=this.regionContext=this.regionBytes=null;this.stats.pipelineCount=this.stats.bufferCount=this.stats.textureCount=this.stats.renderTargetCount=this.stats.gpuBufferBytes=this.stats.gpuRenderTargetBytes=0;this.active=false;this.state='disposed';}
}
