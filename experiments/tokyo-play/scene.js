// Fixed station anchors and schematic artwork for the Tokyo East scenario.
// Geographic coordinates feed the native model; u/v only locate map artwork.
const places = [
  {key:'ueno', name:'上野', lon:139.777, lat:35.714, u:.32,v:.19},
  {key:'asakusa', name:'浅草', lon:139.797,lat:35.711,u:.56,v:.235},
  {key:'oshiage',name:'押上',lon:139.813,lat:35.71,u:.81,v:.20},
  {key:'ochanomizu', name:'御茶之水',lon:139.765,lat:35.700,u:.155,v:.42},
  {key:'akiba',name:'秋叶原',lon:139.7731,lat:35.6984,u:.38,v:.435},
  {key:'ryogoku',name:'两国',lon:139.7945,lat:35.696,u:.65,v:.48},
  {key:'kinshi',name:'锦糸町',lon:139.814,lat:35.696,u:.85,v:.49},
  {key:'tokyo',name:'东京',lon:139.7671,lat:35.6812,u:.245,v:.73},
  {key:'nihonbashi',name:'日本桥',lon:139.7747,lat:35.682,u:.45,v:.735},
  {key:'kiyosumi',name:'清澄白河',lon:139.799,lat:35.682,u:.75,v:.77}
];
const stationByKey = new Map(places.map(p => [p.key,p]));
const board = document.querySelector('#board'), canvas = board.querySelector('canvas');
const paper = document.createElement('canvas');
let width, height, pixelRatio;
function riverX(y) {return .665 - .08*Math.sin(y*4.15+.1) + .018*Math.sin(y*10);}
function cityArt() {
  width=board.clientWidth; height=board.clientHeight;
  pixelRatio=Math.min(2,devicePixelRatio||1);
  for (const surface of [paper,canvas]) {surface.width=Math.round(width*pixelRatio);surface.height=Math.round(height*pixelRatio);}
  const c=paper.getContext('2d');c.scale(pixelRatio,pixelRatio);
  c.fillStyle='#233b32';c.fillRect(0,0,width,height);
  let seed=3512;
  const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
  const unit=Math.min(width/900,height/490),bank=width*.026+4;
  function face(points,color){c.beginPath();points.forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y));c.closePath();c.fillStyle=color;c.fill();}
  const dx=34*unit,dy=23*unit;
  for(let row=-1;row<height/dy+2;row++)for(let col=-2;col<width/dx+2;col++){
    const x=col*dx+Math.sin(row*.55)*11*unit+(row%2)*9*unit,y=row*dy;
    const d=Math.abs(x-riverX(y/height)*width);
    if(d<bank+dx*.48)continue;
    const park=(x/width-.24)**2*2+(y/height-.19)**2<.011 || (x/width-.77)**2+(y/height-.70)**2<.004;
    face([[x-dx*.48,y+dy*.16],[x+dx*.16,y-dy*.44],[x+dx*.46,y-dy*.12],[x-dx*.19,y+dy*.49]],park?'#385641':'#304336');
    if(park||random()<.16){
      c.fillStyle=park?'#487051':'#3d5842';
      for(let i=0;i<4;i++){c.beginPath();c.arc(x+(random()-.5)*dx*.64,y+(random()-.5)*dy*.62,unit*(1.8+random()*2),0,Math.PI*2);c.fill();}
      continue;
    }
    const a=(7+random()*9)*unit,b=(3+random()*5)*unit;
    const tower=(x/width<.5 && y/height>.58) || (x/width>.72 && y/height<.52);
    const h=(4+random()*(tower?25:12))*unit;
    const roof=['#617162','#596857','#687263','#647568','#56695c'][Math.floor(random()*5)];
    face([[x-a,y],[x,y+b],[x,y+b-h],[x-a,y-h]],'#374b42');
    face([[x,y+b],[x+a,y],[x+a,y-h],[x,y+b-h]],'#283d36');
    face([[x-a,y-h],[x,y-b-h],[x+a,y-h],[x,y+b-h]],roof);
    if(random()<.54){c.fillStyle='#aeaa78';for(let j=3*unit;j<h-2*unit;j+=5*unit)c.fillRect(x+a*.35,y+b*.57-h+j,2*unit,1.3*unit);}
  }
  function river(offset,color,lineWidth){
    c.beginPath();for(let i=-2;i<=102;i++){const y=i/100,x=riverX(y)*width+offset;i===-2?c.moveTo(x,y*height):c.lineTo(x,y*height);}
    c.lineJoin='round';c.strokeStyle=color;c.lineWidth=lineWidth;c.stroke();
  }
  river(0,'#62736a',bank*2+5*unit);river(0,'#244c4a',bank*2);river(0,'#305955',bank*1.6);
  c.strokeStyle='#508079';c.lineWidth=unit;
  for(let i=0;i<95;i++){const y=random(),x=riverX(y)*width+(random()-.5)*bank*1.5;c.beginPath();c.moveTo(x,y*height);c.lineTo(x+(3+random()*9)*unit,y*height-unit);c.stroke();}
  for(const y of [.13,.345,.57,.845]){const x=riverX(y)*width;c.save();c.translate(x,height*y);c.rotate(-.095);
    c.fillStyle='#182d29';c.fillRect(-bank-8*unit,0,2*bank+16*unit,7*unit);c.fillStyle='#788477';c.fillRect(-bank-8*unit,-3*unit,2*bank+16*unit,6*unit);c.strokeStyle='#d6b479';c.strokeRect(-bank-8*unit,-3*unit,2*bank+16*unit,5*unit);c.restore();}
  c.save();c.translate(riverX(.89)*width,height*.905);c.fillStyle='#9ac7b7';c.font='12px sans-serif';c.textAlign='center';c.fillText('隅田川',0,0);c.restore();
  const shadow=c.createLinearGradient(0,0,0,height);shadow.addColorStop(0,'#12252175');shadow.addColorStop(.2,'#14251e00');shadow.addColorStop(.86,'#14251e00');shadow.addColorStop(1,'#12251f70');c.fillStyle=shadow;c.fillRect(0,0,width,height);
}
function renderMap(route,live) {
  const c=canvas.getContext('2d');c.setTransform(1,0,0,1,0,0);c.drawImage(paper,0,0);c.scale(pixelRatio,pixelRatio);
  const points=route.map(key=>stationByKey.get(key));
  if(points.length>1){
    c.beginPath();points.forEach((p,i)=>i?c.lineTo(width*p.u,height*p.v):c.moveTo(width*p.u,height*p.v));
    c.lineJoin='round';c.lineCap='round';c.lineWidth=9;c.strokeStyle='#16291e';c.stroke();c.lineWidth=live?5:3.5;c.strokeStyle='#ffce80';if(!live)c.setLineDash([7,6]);c.stroke();c.setLineDash([]);
  }
  for(const train of live?.trains||[]){
    const a=stationByKey.get(train.from), b=stationByKey.get(train.to);if(!a||!b)continue;
    const p=train.moving?Math.min(1,Math.max(0,train.progress)):0,x=width*(a.u+(b.u-a.u)*p),y=height*(a.v+(b.v-a.v)*p);
    c.save();c.translate(x,y);c.rotate(Math.atan2(height*(b.v-a.v),width*(b.u-a.u)));c.translate(0,-4);c.fillStyle='#0d2822';c.fillRect(-9,-4,18,8);c.fillStyle='#f9f7d9';c.fillRect(-8,-3,16,6);c.fillStyle='#3d6f67';c.fillRect(-5,-2,7,3);c.fillStyle='#ffa449';c.fillRect(4,-2,3,3);c.restore();
  }
}
