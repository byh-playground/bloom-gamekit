// Keyframes are evaluated in the vertex shader of the same draw: no pose texture, no extra pass.
// State row layout: texel0 = [clip header, local time, loop mode, duration], texel1 = [morph0, morph1, hidden-part mask, program offset].
export const POSE_PROGRAM_FUNCTIONS = `uniform sampler2D u_program;uniform sampler2D u_state;uniform sampler2D u_overrides;uniform int u_programWidth;
vec4 poseData(int base,int at){int i=at+base;return texelFetch(u_program,ivec2(i%u_programWidth,i/u_programWidth),0);}
float poseChannel(int base,int header,float time){vec4 h=poseData(base,header);float value=h.z;
 for(int i=0;i<64;i++){if(i>=int(h.y))break;vec4 s=poseData(base,int(h.x)+i*2);if(time<s.z)break;
 if(time>=s.w){value=s.y;continue;}float t=clamp((time-s.z)/(s.w-s.z),0.0,1.0);float ease=poseData(base,int(h.x)+i*2+1).x;
 if(ease>1.5)t=1.0-(1.0-t)*(1.0-t);else if(ease>0.5)t=0.5-0.5*cos(3.141592653589793*t);
 value=mix(s.x,s.y,t);break;}return value;}
mat3 poseLocal(int base,int part,int header,float time,int row,out float opacity){
 vec4 b0=texelFetch(u_overrides,ivec2(part*2,row),0);vec4 b1=texelFetch(u_overrides,ivec2(part*2+1,row),0);
 int at=header+part*6;vec2 translation=b0.xy+vec2(poseChannel(base,at,time),poseChannel(base,at+1,time));
 float rotation=b0.z+poseChannel(base,at+2,time);float sx=b0.w*poseChannel(base,at+3,time);float sy=b1.x*poseChannel(base,at+4,time);
 float c=cos(rotation);float s=sin(rotation);vec2 x=vec2(c,s)*sx;vec2 y=vec2(-s,c)*sy;vec2 pivot=poseData(base,part).xy;
 opacity=b1.y*b1.z*poseChannel(base,at+5,time);return mat3(vec3(x,0.0),vec3(y,0.0),vec3(pivot+translation-x*pivot.x-y*pivot.y,1.0));}
void poseEval(int part,int row,out vec4 row0,out vec4 row1,out vec4 pose){
 vec4 playback=texelFetch(u_state,ivec2(0,row),0);vec4 morph=texelFetch(u_state,ivec2(1,row),0);
 int base=int(morph.w);float time;
 if(playback.z<0.5)time=clamp(playback.y,0.0,playback.w);
 else if(playback.z<1.5)time=mod(playback.y,playback.w);
 else{float point=mod(playback.y,playback.w*2.0);time=point<=playback.w?point:playback.w*2.0-point;}
 mat3 matrix=mat3(1.0);float alpha=1.0;int current=part;
 for(int depth=0;depth<16;depth++){if(current<0)break;float opacity;mat3 m=poseLocal(base,current,int(playback.x),time,row,opacity);matrix=m*matrix;alpha*=opacity;current=int(poseData(base,current).z);}
 if((int(morph.z)&(1<<part))!=0)alpha=0.0;
 row0=vec4(matrix[0][0],matrix[1][0],matrix[2][0],0.0);row1=vec4(matrix[0][1],matrix[1][1],matrix[2][1],0.0);pose=vec4(morph.xy,alpha,0.0);}
`;
