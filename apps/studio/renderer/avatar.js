(function(root){
 'use strict';
 const NS='http://www.w3.org/2000/svg';
 function node(tag,attrs,parent){const e=document.createElementNS(NS,tag);Object.entries(attrs).forEach(([k,v])=>e.setAttribute(k,v));parent?.append(e);return e;}
 function avatar(c,talking){
  const a=c.appearance,svg=node('svg',{viewBox:'0 0 180 145',role:'img','aria-label':c.name+' · 形象占位'});
  node('rect',{x:35,y:25,width:110,height:100,rx:28,fill:a.primary,stroke:a.accent,'stroke-width':3},svg);
  [67,113].forEach(cx=>node('circle',{cx,cy:65,r:a.state==='惊讶'?7:5,fill:'#16232b'},svg));
  if(talking||a.mouth)node('ellipse',{cx:90,cy:92,rx:9,ry:8,fill:'#16232b'},svg);
  else node('path',{d:'M77 87 Q90 99 103 87',fill:'none',stroke:'#16232b','stroke-width':4,'stroke-linecap':'round'},svg);
  return svg;
 }
 root.StudioRender={avatar};
})(globalThis);
