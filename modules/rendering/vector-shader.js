// Shared vector paint layout and fragment evaluation for native streams and ordered mesh/paint batches.
export const VECTOR_VERTEX_FLOATS = 21;

export const VECTOR_FRAGMENT_VARYINGS =
    'varying highp vec2 v_uv; varying vec4 v_color; varying highp vec4 v_paint; varying highp vec4 v_radial; varying highp vec4 v_rect;';

// paint.y: 0 normal, 1 white flash, 2 forced color (the texel only contributes its coverage).
export const VECTOR_FRAGMENT_FINISH =
    'float a=texel.a*v_color.a;if(u_depthWrite>0.5&&a<=0.0)discard;vec3 rgb=v_paint.y>1.5?v_color.rgb*a:mix(texel.rgb*v_color.rgb*v_color.a,vec3(a),v_paint.y);gl_FragColor=vec4(rgb,a);';
const PRIMITIVE_OUTSIDE = `bool primitiveOutside(vec2 l,vec4 p,vec4 m){
  float kind=p.x,stroke=p.y,width=p.z,option=p.w;
  if(kind<0.5){
    if(stroke<0.5)return length(l)>1.0;
    float ql=length(l);vec2 n=ql>0.000001?l/ql:vec2(1.0,0.0);float det=m.x*m.w-m.y*m.z;
    vec2 g=vec2(m.w*n.x-m.z*n.y,-m.y*n.x+m.x*n.y)/max(abs(det),0.000001);
    return abs((ql-1.0)/max(length(g),0.000001))>width*0.5;
  }
  if(kind<1.5){
    if(stroke<0.5)return max(abs(l.x),abs(l.y))>1.0;
    float sx=length(vec2(m.x,m.z));float sy=length(vec2(m.y,m.w));
    if(option>0.5){
      float ox=1.0+width/(2.0*max(sx,0.000001));float oy=1.0+width/(2.0*max(sy,0.000001));
      float ix=max(0.0,1.0-width/(2.0*max(sx,0.000001)));float iy=max(0.0,1.0-width/(2.0*max(sy,0.000001)));
      return max(abs(l.x)/ox,abs(l.y)/oy)>1.0||max(abs(l.x)/max(ix,0.000001),abs(l.y)/max(iy,0.000001))<1.0;
    }
    vec2 q=(abs(l)-vec2(1.0))*vec2(sx,sy);float sd=length(max(q,vec2(0.0)))+min(max(q.x,q.y),0.0);
    return abs(sd)>width*0.5;
  }
  float halfLength=length(vec2(m.x,m.z));float halfWidth=length(vec2(m.y,m.w));
  float x=l.x*halfLength;float y=l.y*halfWidth;float center=halfLength-(option>0.5?halfWidth:0.0);float d;
  if(option<0.5)d=max(abs(x)-center,abs(y)-halfWidth);
  else if(option<1.5)d=max(abs(x)-center-halfWidth,abs(y)-halfWidth);
  else d=length(vec2(max(abs(x)-center,0.0),y))-halfWidth;
  return d>0.0;
}`;
// Posed sprites move on the GPU, so their clip is tested per fragment against the batch's edge planes; every
// other vertex was clipped on the CPU and passes this test trivially.
export function vectorFragmentShader(planes, meshes = false) {
    const PLANES = planes
        ? `varying highp vec2 v_position; uniform vec3 u_planes[${planes}]; uniform int u_planeCount;`
        : '';
    const CLIP = planes
        ? `for(int i=0;i<${planes};i++){if(i>=u_planeCount)break;if(dot(u_planes[i],vec3(v_position,1.0))<0.0)discard;}`
        : '';
    const MESH = meshes
        ? 'if(v_paint.z< -0.5){if(u_depthWrite>0.5&&v_color.a<=0.0)discard;gl_FragColor=v_color;return;}'
        : '';
    return `precision mediump float; precision mediump sampler2DArray; uniform sampler2DArray u_texture;uniform float u_depthWrite;
${VECTOR_FRAGMENT_VARYINGS}${PLANES}
float radialParameter(vec2 q){
  vec2 d=v_radial.xy;float r0=v_radial.z,dr=v_radial.w;
  float a=dot(d,d)-dr*dr,b=-2.0*(dot(q,d)+r0*dr),c=dot(q,q)-r0*r0;
  if(abs(a)<0.000001){if(abs(b)<0.000001)return -10000.0;float t=-c/b;return r0+dr*t>0.0?t:-10000.0;}
  float discriminant=b*b-4.0*a*c;if(discriminant<0.0)return -10000.0;
  float root=sqrt(max(discriminant,0.0)),t0=(-b-root)/(2.0*a),t1=(-b+root)/(2.0*a),chosen=-10000.0;
  if(r0+dr*t0>0.0)chosen=t0;if(r0+dr*t1>0.0)chosen=max(chosen,t1);return chosen;
}
${PRIMITIVE_OUTSIDE}
void main(){${CLIP}${MESH}if(v_paint.z>4.5){if(primitiveOutside(v_uv,v_radial,v_rect)||(u_depthWrite>0.5&&v_color.a<=0.0))discard;gl_FragColor=vec4(v_color.rgb*v_color.a,v_color.a);return;}
if(v_paint.z>1.5&&v_paint.z<2.5)discard;vec2 uv=v_uv;
if(v_paint.z>2.5){uv=v_rect.xy+vec2(clamp(v_uv.x,0.0,1.0),0.5)*v_rect.zw;}
else if(v_paint.z>0.5){float t=radialParameter(v_uv);if(t< -1000.0)discard;uv=v_rect.xy+vec2(clamp(t,0.0,1.0),0.5)*v_rect.zw;}
if(v_paint.w>0.5){vec2 size=vec2(textureSize(u_texture,0).xy);uv=(floor(uv*size)+0.5)/size;}
vec4 texel=texture2D(u_texture,vec3(uv,floor(v_paint.x+0.5)));${VECTOR_FRAGMENT_FINISH}}`;
}
