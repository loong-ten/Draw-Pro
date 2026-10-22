import { PaintDocument, makeCanvas, uid } from './core.js';

// Original, code-drawn sample artwork. Every document has real editable layers.
const C = {
  cream: '#F1EBD5', cloud: '#FAF5E5', sun: '#E8AF73', gold: '#D5AA61',
  mist: '#CCD3B5', far: '#ADC4AD', ridge: '#83A99D', mid: '#648F84',
  pine: '#2E615A', deep: '#234D48', ink: '#1C423F', leaf: '#8DAE88',
  grass: '#B5C28D', water: '#9FC7B5', shine: '#E3DDB2', wood: '#AE8159',
  roof: '#714F44', rose: '#CD9776', shadow: '#597A6A',
};

function rect(g, color, x, y, w, h) {
  g.fillStyle = color;
  g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

function poly(g, color, points) {
  g.fillStyle = color;
  g.beginPath();
  points.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
  g.closePath();
  g.fill();
}

function ridge(g, color, points, bottom = 160) {
  const stepped = [];
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    if (i) stepped.push([x, points[i - 1][1]]);
    stepped.push([x, y]);
  }
  poly(g, color, [[points[0][0], bottom], ...stepped, [points.at(-1)[0], bottom]]);
}

function disk(g, color, cx, cy, radius) {
  // Horizontal one-pixel slices preserve the stepped silhouette of pixel art.
  for (let y = -radius; y <= radius; y++) {
    const half = Math.floor(Math.sqrt(radius * radius - y * y));
    rect(g, color, cx - half, cy + y, half * 2 + 1, 1);
  }
}

function pine(g, x, base, height, color, highlight = null) {
  const top = base - height;
  rect(g, color, x - 1, top, 2, height);
  for (let row = 3; row < height - 4; row += 5) {
    const half = Math.max(2, Math.floor(row * .27));
    poly(g, color, [[x, top + row - 5], [x + half + 1, top + row + 3],
      [x + half - 2, top + row + 3], [x + half + 2, top + row + 5],
      [x - half - 2, top + row + 5], [x - half + 1, top + row + 2],
      [x - half, top + row + 2]]);
    if (highlight && row % 10 === 3) {
      rect(g, highlight, x - half + 1, top + row + 2, Math.max(2, half - 1), 1);
    }
  }
}

function layer(name, width, height, scale, draw) {
  const small = makeCanvas(Math.ceil(width / scale), Math.ceil(height / scale));
  const ctx = small.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  draw(ctx, small.width, small.height);
  const canvas = makeCanvas(width, height);
  const out = canvas.getContext('2d');
  out.imageSmoothingEnabled = false;
  out.drawImage(small, 0, 0, width, height);
  return { id: uid(), name, canvas, visible: true, opacity: 1, locked: false };
}

function finish(name, width, height, layers) {
  const doc = new PaintDocument({ name, width, height, canvas: null, fill: 'transparent' });
  doc.layers = layers;
  doc.activeLayerId = layers.at(-1).id;
  doc.isDemo = true;
  doc.commit('示例载入');
  if (Array.isArray(doc.history) && doc.history.length) {
    doc.history = [doc.history.at(-1)];
    doc.historyIndex = 0;
  }
  doc.dirty = false;
  return doc;
}

function landscape() {
  const sky = layer('天空 · 暖阳', 960, 640, 4, g => {
    rect(g, C.cream, 0, 0, 240, 160);
    rect(g, '#E8E9CD', 0, 63, 240, 97);
    disk(g, C.sun, 68, 38, 18);
    rect(g, C.cream, 47, 45, 44, 2);
    rect(g, C.cream, 50, 51, 36, 1);
    const cloud = (x, y, w) => {
      rect(g, C.cloud, x + 5, y, w - 15, 2);
      rect(g, C.cloud, x, y + 2, w, 3);
      rect(g, C.cloud, x + 12, y + 5, w - 17, 1);
    };
    cloud(120, 25, 41); cloud(173, 42, 26); cloud(4, 32, 28);
    rect(g, '#D6DBC1', 110, 54, 36, 1);
    rect(g, '#D6DBC1', 117, 56, 46, 1);
    rect(g, '#D6DBC1', 5, 63, 32, 1);
    // Small distant birds, drawn as crisp two-step wings.
    [[102,37],[111,34],[106,42]].forEach(([x,y]) => {
      rect(g, '#91A694', x, y, 2, 1);
      rect(g, '#91A694', x + 2, y + 1, 1, 1);
      rect(g, '#91A694', x + 3, y, 2, 1);
    });
  });

  const mountains = layer('远山 · 河谷', 960, 640, 4, g => {
    ridge(g, C.far, [[0,83],[9,77],[17,74],[23,71],[29,65],[34,61],
      [41,65],[47,69],[53,74],[62,77],[71,83],[78,84],[85,81],[94,76],
      [101,70],[109,66],[117,60],[124,55],[129,49],[133,46],[139,49],
      [144,54],[150,60],[159,66],[167,71],[174,74],[183,70],[190,64],
      [197,62],[203,66],[211,72],[220,77],[231,80],[240,78]]);
    ridge(g, '#C8D2B5', [[103,70],[113,62],[124,53],[130,47],[133,46],
      [137,49],[140,55],[144,59],[147,66],[154,70]], 79);
    ridge(g, C.ridge, [[0,102],[10,99],[17,93],[24,87],[32,85],[38,80],
      [46,75],[50,71],[57,74],[65,79],[70,82],[75,84],[81,87],[88,93],
      [98,97],[108,102],[118,105],[131,100],[142,92],[151,84],[158,79],
      [164,74],[170,70],[177,65],[182,60],[186,57],[191,60],[197,67],
      [204,75],[211,80],[218,87],[227,91],[240,95]]);
    // The lit slopes point into the valley, carrying the eye toward the river.
    ridge(g, '#91B3A0', [[119,103],[129,98],[140,91],[150,84],[159,77],
      [167,72],[175,66],[183,59],[186,57],[186,69],[180,79],[175,86],
      [170,90],[168,96],[163,101],[157,106]], 113);
    ridge(g, C.mid, [[0,101],[9,98],[17,100],[24,104],[33,107],[41,109],
      [51,113],[60,114],[69,117],[80,120],[91,122],[101,119],[113,114],
      [125,110],[136,105],[146,103],[155,100],[163,96],[173,97],[181,99],
      [188,101],[198,104],[208,106],[219,109],[231,111],[240,109]]);
    ridge(g, C.leaf, [[85,124],[101,120],[113,114],[125,109],[139,105],
      [149,104],[159,106],[171,108],[183,111],[197,114],[210,119],
      [226,121],[240,124]]);
    ridge(g, C.grass, [[97,128],[110,121],[125,116],[140,112],[153,111],
      [164,113],[178,116],[190,121],[209,126],[224,130],[240,131]]);
    // A stepped, winding river with a dark far bank and broken sunlight.
    poly(g, C.shadow, [[143,108],[152,108],[153,112],[143,115],[137,119],
      [140,124],[155,131],[160,138],[155,144],[146,151],[140,160],
      [92,160],[106,147],[121,139],[127,134],[125,130],[119,126],
      [122,120],[131,116],[141,112]]);
    poly(g, C.water, [[145,109],[150,109],[150,112],[140,116],[133,120],
      [136,125],[149,131],[154,137],[150,143],[139,150],[132,160],
      [98,160],[112,148],[127,140],[132,134],[129,128],[124,125],
      [125,121],[134,116],[144,112]]);
    [[140,112,8],[134,117,7],[129,122,5],[132,126,5],[140,131,7],
      [145,137,7],[137,143,10],[120,151,17],[109,158,21]].forEach(([x,y,w]) => {
      rect(g,C.shine,x,y,w,1);
    });
    [[32,111],[40,113],[50,115],[58,117],[75,120],[170,106],[180,111],
      [193,114],[214,119],[224,119]].forEach(([x,y], i) =>
      pine(g,x,y,9 + (i % 3) * 3, i<5 ? '#527C70' : '#799D7F'));
    // A tiny valley footpath.
    ridge(g, '#D8C791', [[161,119],[169,118],[178,119],[184,121],[195,123]], 123);
    // Warm cabin with stone footing, a lit window, and a stepped roof.
    rect(g, '#718568', 172, 116, 18, 6);
    rect(g, C.wood, 173, 109, 16, 12);
    rect(g, '#C89F6C', 173, 111, 8, 10);
    ridge(g, C.roof, [[169,109],[172,106],[175,103],[178,100],
      [181,100],[184,103],[188,106],[192,109]], 111);
    rect(g, '#987358', 179, 103, 2, 1);
    rect(g, '#987358', 184, 106, 4, 1);
    rect(g, C.deep, 183, 113, 3, 8);
    rect(g, '#F0D797', 175, 113, 4, 4);
    rect(g, C.wood, 177, 113, 1, 4);
    rect(g, C.wood, 175, 115, 4, 1);
    rect(g, C.roof, 187, 99, 2, 8);
    rect(g, '#D2D7BD', 187, 94, 3, 3);
    rect(g, '#D9DEC5', 190, 91, 4, 2);
    rect(g, '#D2D7BD', 192, 88, 4, 2);
    // Meadow details use a deterministic pattern, so the sample is reproducible.
    for(let i=0;i<65;i++) {
      const x=(i*37+13)%240, y=124+(i*11)%33;
      if (x>91 && x<161) continue;
      rect(g, i%4===0 ? '#DAC995' : '#9BAF7E', x,y, 2+(i%3),1);
    }
  });

  const foreground = layer('前景 · 松林', 960, 640, 4, g => {
    ridge(g, '#467665', [[0,128],[11,126],[24,129],[36,132],[48,137],
      [60,141],[73,146],[82,150],[89,155],[93,160]]);
    ridge(g, C.pine, [[0,143],[12,142],[24,144],[35,148],[43,151],
      [55,153],[63,157],[71,160]]);
    ridge(g, '#527D66', [[170,160],[181,151],[190,145],[202,140],
      [214,137],[225,133],[240,131]]);
    pine(g, 3, 145, 55, C.pine, '#42786A');
    pine(g, 23, 150, 69, C.deep, '#376F61');
    pine(g, 42, 155, 44, C.pine, '#538674');
    pine(g, 54, 161, 32, C.deep);
    pine(g, 228, 148, 57, C.pine, '#54836A');
    pine(g, 213, 150, 36, '#3D6F5B', '#628D6F');
    pine(g, 241, 154, 73, C.deep, '#3B6E5C');
    pine(g, 198, 157, 27, '#3A6B58');
    ridge(g, C.deep, [[0,154],[16,153],[29,155],[43,158],[49,160]]);
    ridge(g, C.deep, [[179,160],[191,157],[201,155],[212,153],
      [223,153],[235,150],[240,151]]);
    [[9,153],[18,151],[35,156],[45,157],[183,158],[207,152],[224,151]].forEach(([x,y]) => {
      rect(g, '#8AA278',x,y,2,1);
      rect(g, '#698D6B',x+1,y+1,3,1);
    });
    // Small golden foreground flowers.
    [[64,151],[69,155],[191,151],[203,148],[230,146]].forEach(([x,y]) => {
      rect(g,C.deep,x,y,1,5);
      rect(g,C.gold,x-1,y-1,3,2);
      rect(g,C.cream,x,y-1,1,1);
    });
  });
  return finish('山野之间.png', 960, 640, [sky, mountains, foreground]);
}

function botanical() {
  const foliage = layer('枝叶', 384, 384, 3, g => {
    // Transparent sprig, suited to trying selections and shared alignment guides.
    const branch = (points, color, width=2) => {
      g.strokeStyle=color; g.lineWidth=width; g.lineJoin='miter';
      g.beginPath();points.forEach(([x,y],i)=>i?g.lineTo(x,y):g.moveTo(x,y));g.stroke();
    };
    branch([[62,113],[65,98],[61,82],[65,66],[60,48],[64,29],[63,16]],C.deep,3);
    const leaf=(x,y,w,h,right,color)=>{
      const d=right?1:-1;
      poly(g,color,[[x,y],[x+d*3,y-h/2],[x+d*(w-4),y-h],
        [x+d*w,y-h],[x+d*w,y-h+5],[x+d*(w-3),y-3],[x+d*5,y+2]]);
      branch([[x,y],[x+d*(w-5),y-h+6]],C.pine,1);
    };
    leaf(64,100,27,19,false,C.leaf);
    leaf(63,91,31,20,true,C.pine);
    leaf(62,80,29,24,false,C.pine);
    leaf(65,69,28,25,true,C.leaf);
    leaf(60,54,24,25,false,C.leaf);
    leaf(63,41,23,22,true,C.pine);
    leaf(63,29,14,17,false,C.pine);
    poly(g,C.leaf,[[63,22],[60,16],[60,8],[63,4],[66,9],[67,16]]);
    branch([[63,95],[91,80]],C.deep,2);
    branch([[62,78],[37,67]],C.deep,2);
  });
  const berries=layer('暖金果实',384,384,3,g=>{
    [[91,79],[98,74],[95,84],[35,65],[30,71],[40,71]].forEach(([x,y],i)=>{
      disk(g,i%2?C.sun:C.gold,x,y,4);
      rect(g,C.cream,x-1,y-2,2,1);
      rect(g,C.wood,x+1,y+2,2,1);
    });
  });
  return finish('山野枝叶.png',384,384,[foliage,berries]);
}

function colorStudy() {
  const paper=layer('纸色',384,384,3,g=>rect(g,C.cream,0,0,128,128));
  const tiles=layer('山野色彩 · 拼片',384,384,3,g=>{
    const colors=[C.deep,C.leaf,C.sun,C.rose];
    for(let row=0;row<4;row++) for(let col=0;col<4;col++) {
      const x=8+col*28,y=8+row*28, i=(row+col)%4;
      rect(g, colors[i],x,y,26,26);
      const alt=colors[(i+2)%4];
      switch((row*4+col)%6) {
        case 0: disk(g,C.cream,x+13,y+13,8);break;
        case 1: poly(g,C.deep,[[x,y+26],[x+13,y+5],[x+26,y+26]]);break;
        case 2:
          rect(g,C.cream,x+5,y+5,6,16);rect(g,C.cream,x+15,y+5,6,16);break;
        case 3:
          for(let a=0;a<3;a++)for(let b=0;b<3;b++)rect(g,C.cream,x+5+a*6,y+5+b*6,3,3);break;
        case 4:
          disk(g,alt,x+7,y+13,8);disk(g,C.cream,x+18,y+13,7);break;
        default:
          poly(g,C.cream,[[x+5,y+21],[x+5,y+14],[x+14,y+5],[x+21,y+5],[x+21,y+12],[x+12,y+21]]);
      }
    }
  });
  return finish('山野色卡.png',384,384,[paper,tiles]);
}

export function createDemoDocuments() {
  return [landscape(), botanical(), colorStudy()];
}
