import {makeCanvas, cloneCanvas, composite, PaintDocument, uid} from './core.js';
import {sharpenCanvas} from './fine-raster.js';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const DEFAULT = Object.freeze({brightness:100, contrast:100, saturation:100, hue:0, blur:0});
const FIELDS = [
  ['brightness','亮度',0,200,1,'%'], ['contrast','对比度',0,200,1,'%'],
  ['saturation','饱和度',0,200,1,'%'], ['hue','色相',-180,180,1,'°'], ['blur','高斯模糊',0,12,.1,'px']
];
const PRESETS = {
  original:{...DEFAULT}, soft:{brightness:108,contrast:86,saturation:82,hue:0,blur:0},
  warm:{brightness:104,contrast:108,saturation:115,hue:-12,blur:0},
  mono:{brightness:100,contrast:110,saturation:0,hue:0,blur:0}
};
const BLENDS = new Set(['source-over','multiply','screen','overlay','soft-light','darken','lighten','difference']);
const filterString = f => `brightness(${f.brightness}%) contrast(${f.contrast}%) saturate(${f.saturation}%) hue-rotate(${f.hue}deg) blur(${f.blur}px)`;
const layerKey = d => d && d.activeLayer ? `${d.id}/${d.activeLayer.id}/${d.revision}` : '';

/** Pixelroom's inspection tools adapted to the shared PaintDocument workspace. */
export function createInspections(api, mount) {
  if (!mount) throw new Error('精修面板容器不存在。');
  mount.classList.add('fine-workbench');
  mount.innerHTML = `<div class="fine-tabs" role="tablist" aria-label="精修工具">
    <button type="button" role="tab" data-fine-tab="adjust" aria-selected="true">色彩调整</button>
    <button type="button" role="tab" data-fine-tab="pixel" aria-selected="false">像素检查</button>
    <button type="button" role="tab" data-fine-tab="history" aria-selected="false">历史</button>
  </div>
  <section class="fine-section" data-fine-section="adjust" role="tabpanel">
    <div class="fine-heading"><strong>图层调整</strong><small class="fine-target" data-fine="target"></small></div>
    <canvas class="fine-histogram" data-fine="histogram" width="256" height="60" aria-label="图像亮度分布"></canvas>
    <div class="fine-histogram-axis"><span>0</span><span>亮度分布 · 预览采样</span><span>255</span></div>
    ${FIELDS.map(([key,label,min,max,step,unit])=>`<div class="fine-control"><div class="fine-control-label"><label for="fine-range-${key}">${label}</label><span class="fine-value"><input type="number" data-fine-number="${key}" aria-label="${label}数值" min="${min}" max="${max}" step="${step}" value="${DEFAULT[key]}"><span>${unit}</span></span></div><input type="range" id="fine-range-${key}" data-fine-range="${key}" aria-label="${label}" min="${min}" max="${max}" step="${step}" value="${DEFAULT[key]}"></div>`).join('')}
    <div class="fine-heading"><strong>快速风格</strong><small>应用于当前图层</small></div>
    <div class="fine-presets">${[['original','原图'],['soft','柔和'],['warm','暖调'],['mono','黑白']].map(([key,label])=>`<button type="button" data-fine-preset="${key}"><span class="fine-preset-swatch"></span>${label}</button>`).join('')}</div>
    <div class="fine-actions"><button type="button" class="fine-button" data-fine-action="reset">重置</button><button type="button" class="fine-button fine-primary" data-fine-action="apply" disabled>应用调整</button></div>
    <span class="fine-status" data-fine="adjust-status" role="status">滑动参数预览，应用后可撤销。</span>
    <div class="fine-sharpen"><div class="fine-heading"><strong>细节锐化</strong><small>保留透明度</small></div><p class="fine-note">增强边缘对比；适合图像精修，可撤销。</p><button type="button" class="fine-button" data-fine-action="sharpen">应用一次锐化</button></div>
  </section>
  <section class="fine-section" data-fine-section="pixel" role="tabpanel" hidden>
    <div class="fine-heading"><strong>像素放大镜</strong><small>11 × 11 px</small></div>
    <div class="fine-loupe-wrap"><canvas class="fine-loupe" data-fine="loupe" width="176" height="176" aria-label="光标附近的像素放大预览"></canvas></div>
    <div class="fine-pixel-values"><span class="fine-pixel-swatch"><i data-fine="swatch"></i></span><div><strong data-fine="hex"># ——————</strong><small data-fine="rgba">RGBA —</small></div></div>
    <div class="fine-pixel-coords" data-fine="coords">将光标移到画布上查看。</div>
    <div class="fine-actions"><button type="button" class="fine-button" data-fine-action="use-color" disabled>设为前景色</button><button type="button" class="fine-button" data-fine-action="copy-color" disabled>复制 HEX</button></div>
    <p class="fine-note">取样合成后的可见图层。中心白框对应当前像素，透明区域保留棋盘底纹。</p>
  </section>
  <section class="fine-section" data-fine-section="history" role="tabpanel" hidden>
    <div class="fine-heading"><strong>操作历史</strong><small data-fine="history-count"></small></div>
    <div class="fine-history-list" data-fine="history-list"></div>
    <p class="fine-history-info">点击步骤恢复当前图片。每张图片独立保存历史；大图会按内存上限缩短记录。</p>
    <div class="fine-actions"><button type="button" class="fine-button" data-fine-action="undo">← 撤销</button><button type="button" class="fine-button" data-fine-action="redo">重做 →</button></div>
  </section>
  <section class="fine-section fine-navigator"><div class="fine-heading"><strong>导航器</strong><button type="button" class="fine-button fine-ghost" data-fine-action="nav-fit">适应窗口</button></div><canvas class="fine-nav-canvas" data-fine="navigator" width="256" height="138" aria-label="画布导航器，点击或拖动定位" tabindex="0"></canvas><div class="fine-nav-meta"><span data-fine="nav-size"></span><span data-fine="nav-zoom"></span></div></section>`;

  const $ = key => mount.querySelector(`[data-fine="${key}"]`);
  const $$ = selector => [...mount.querySelectorAll(selector)];
  const actionButton = name => mount.querySelector(`[data-fine-action="${name}"]`);
  let active = true, section = 'adjust', params = {...DEFAULT};
  let target = null, base = null, preview = null, previewComposite = null, frame = 0, generation = 0;
  let seen = '', historySignature = '', navMap = null, lastPixel = null, lastPoint = null, busy = false;

  function clearPreview(reset = true) {
    ++generation;
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    const hadPreview = !!preview;
    target = null; base = null; preview = null; previewComposite = null;
    if (hadPreview) api.setPreview(null);
    if (reset) { params = {...DEFAULT}; syncControls(); }
    actionButton('apply').disabled = true;
    $('adjust-status').textContent = '滑动参数预览，应用后可撤销。';
  }

  function syncControls() {
    for (const [key] of FIELDS) {
      mount.querySelector(`[data-fine-range="${key}"]`).value = params[key];
      const field = mount.querySelector(`[data-fine-number="${key}"]`);
      if (document.activeElement !== field) field.value = params[key];
    }
  }

  function validTarget() {
    const d = api.getDoc();
    return target && d && d.id === target.docId && d.activeLayer?.id === target.layerId && d.revision === target.revision && !d.activeLayer.locked;
  }

  function ensureTarget() {
    if (target && !validTarget()) clearPreview();
    if (target) return true;
    api.finishPending();
    const d = api.getDoc(), l = d?.activeLayer;
    if (!l) return false;
    if (l.locked) { api.toast('请先解锁当前图层，再进行调整。', true); return false; }
    target = {docId:d.id, layerId:l.id, revision:d.revision};
    base = cloneCanvas(l.canvas);
    return true;
  }

  function displayedComposite() {
    const d = api.getDoc();
    if (!d) return null;
    if (preview && validTarget()) {
      if (!previewComposite) previewComposite = composite({...d, layers:d.layers.map(l=>l.id===target.layerId?{...l,canvas:preview}:l)});
      return previewComposite;
    }
    return api.getComposite(d);
  }

  function renderPreview() {
    frame = 0;
    if (!active || !validTarget()) { clearPreview(); return; }
    try {
      const output = makeCanvas(base.width, base.height), c = output.getContext('2d');
      if (!('filter' in c)) throw new Error('当前浏览器不支持实时滤镜，请使用桌面版 Edge 或 Chrome。');
      c.filter = filterString(params);
      c.drawImage(base, 0, 0);
      c.filter = 'none';
      preview = output; previewComposite = null;
      api.setPreview(output);
      actionButton('apply').disabled = false;
      $('adjust-status').textContent = '正在预览 · 点击“应用调整”保留结果';
      drawHistogram(); refreshView();
      if (lastPoint && section === 'pixel') inspect(lastPoint);
    } catch (error) { clearPreview(); api.toast(error.message, true); }
  }

  function requestPreview() {
    if (!ensureTarget()) { syncControls(); return; }
    if (!frame) frame = requestAnimationFrame(renderPreview);
  }

  function applyPreview() {
    if (frame) { cancelAnimationFrame(frame); frame = 0; renderPreview(); }
    if (!preview || !validTarget()) { clearPreview(); return; }
    const result = preview;
    clearPreview();
    api.commitLayerCanvas(result, '色彩调整');
    seen = ''; refresh(); api.toast('色彩调整已应用，可撤销。');
  }

  function drawHistogram() {
    if (!active || section !== 'adjust') return;
    const source = displayedComposite(), c = $('histogram'), context = c.getContext('2d');
    context.clearRect(0, 0, c.width, c.height);
    if (!source) return;
    const sample = makeCanvas(128,80), s = sample.getContext('2d', {willReadFrequently:true});
    s.drawImage(source,0,0,128,80);
    const pixels = s.getImageData(0,0,128,80).data, bins = new Float32Array(128);
    for(let i=0;i<pixels.length;i+=4) if(pixels[i+3]) bins[Math.min(127,Math.floor((pixels[i]*.2126+pixels[i+1]*.7152+pixels[i+2]*.0722)/2))] += pixels[i+3]/255;
    const max = Math.max(1,...bins);
    context.fillStyle = getComputedStyle(mount).getPropertyValue('--accent').trim() || '#b7d58c';
    for(let i=0;i<128;i++) {const height=Math.sqrt(bins[i]/max)*(c.height-4);context.fillRect(i*2,c.height-height,1.6,height);}
  }

  function renderHistory(force = false) {
    const d = api.getDoc();
    if(!d) return;
    const signature = `${d.id}/${d.historyIndex}/${d.history.length}/${d.revision}`;
    if (!force && signature === historySignature) return;
    historySignature = signature;
    $('history-count').textContent = `${d.historyIndex+1} / ${d.history.length}`;
    $('history-list').innerHTML = d.history.map((step,i)=>`<button type="button" class="fine-history-row ${i===d.historyIndex?'active':''} ${i>d.historyIndex?'future':''}" data-fine-history="${i}" aria-current="${i===d.historyIndex?'step':'false'}"><i>${i===d.historyIndex?'●':'↶'}</i><span>${esc(step.label)}</span><small>${String(i+1).padStart(2,'0')}</small></button>`).join('');
    actionButton('undo').disabled = !d.canUndo;
    actionButton('redo').disabled = !d.canRedo;
  }

  function refresh() {
    const d = api.getDoc(), l = d?.activeLayer;
    if(!d || !l) return;
    const key=layerKey(d);
    if (target && !validTarget()) clearPreview();
    if (seen !== key) {
      seen = key;
      $('target').textContent=l.name;
      $('target').title=l.name;
      $$('[data-fine-range],[data-fine-number],[data-fine-preset]').forEach(el=>el.disabled=l.locked);
      actionButton('sharpen').disabled=l.locked||busy;
      actionButton('apply').disabled=!preview||l.locked;
      if (active) {drawHistogram();refreshView();}
      if(lastPoint&&section==='pixel') inspect(lastPoint);
    }
    renderHistory();
  }

  function refreshView() {
    if (!active) return;
    const d=api.getDoc(), source=displayedComposite();
    if(!d||!source) return;
    const c=$('navigator'), context=c.getContext('2d'), w=c.width, h=c.height;
    context.clearRect(0,0,w,h);
    context.fillStyle='#141a22'; context.fillRect(0,0,w,h);
    const s=Math.min((w-12)/d.width,(h-12)/d.height),x=(w-d.width*s)/2,y=(h-d.height*s)/2;
    navMap={s,x,y};
    context.save();context.beginPath();context.rect(x,y,d.width*s,d.height*s);context.clip();
    context.fillStyle='#303844';context.fillRect(x,y,d.width*s,d.height*s);
    context.fillStyle='#39424f';for(let i=0;i<w;i+=8)for(let j=0;j<h;j+=8)if((i/8+j/8)%2===0)context.fillRect(i,j,8,8);
    context.imageSmoothingEnabled=false;context.drawImage(source,x,y,d.width*s,d.height*s);context.restore();
    const v=api.getView(), z=v.z || 1;
    const vx=clamp(-v.x/z,0,d.width),vy=clamp(-v.y/z,0,d.height),vw=clamp((api.viewport.clientWidth-v.x)/z,0,d.width)-vx,vh=clamp((api.viewport.clientHeight-v.y)/z,0,d.height)-vy;
    context.strokeStyle=getComputedStyle(mount).getPropertyValue('--accent').trim()||'#b7d58c';context.lineWidth=1.5;
    context.strokeRect(x+vx*s,y+vy*s,Math.max(0,vw*s),Math.max(0,vh*s));
    $('nav-size').textContent=`${d.width} × ${d.height} px`;
    $('nav-zoom').textContent=`${Math.round(z*1000)/10}%`;
  }

  function drawLoupeBackground(context, size=176) {
    context.fillStyle='#303844';context.fillRect(0,0,size,size);
    context.fillStyle='#414b58';for(let y=0;y<size;y+=8)for(let x=0;x<size;x+=8)if((x/8+y/8)%2===0)context.fillRect(x,y,8,8);
  }

  function inspect(p) {
    lastPoint=p;
    if(!active||section!=='pixel'||!p) return;
    const d=api.getDoc();
    if(!d) return;
    const x=Math.floor(p.x),y=Math.floor(p.y);
    if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=d.width||y>=d.height){$('coords').textContent='光标位于画布外';return;}
    const source=displayedComposite();
    if(!source) return;
    const sx=Math.max(0,x-5),sy=Math.max(0,y-5),ex=Math.min(d.width,x+6),ey=Math.min(d.height,y+6);
    // Only read this 11×11 neighbourhood, never the full-size image on pointermove.
    const block=source.getContext('2d',{willReadFrequently:true}).getImageData(sx,sy,ex-sx,ey-sy);
    const i=((y-sy)*block.width+x-sx)*4,[r,g,b,a]=block.data.slice(i,i+4);
    const hex='#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase();
    lastPixel={hex,alpha:a};
    $('hex').textContent=hex;$('rgba').textContent=`${r}, ${g}, ${b}, ${a}`;
    $('swatch').style.background=`rgba(${r},${g},${b},${a/255})`;
    $('coords').textContent=`X ${x}  ·  Y ${y}  ·  A ${Math.round(a/255*100)}%`;
    actionButton('use-color').disabled=a===0;actionButton('copy-color').disabled=false;
    const c=$('loupe'),context=c.getContext('2d'),u=c.width/11;
    drawLoupeBackground(context,c.width);
    context.imageSmoothingEnabled=false;
    context.drawImage(source,sx,sy,ex-sx,ey-sy,(sx-x+5)*u,(sy-y+5)*u,(ex-sx)*u,(ey-sy)*u);
    context.beginPath();context.strokeStyle='#ffffff20';context.lineWidth=.6;
    for(let n=0;n<=11;n++){context.moveTo(n*u,0);context.lineTo(n*u,c.height);context.moveTo(0,n*u);context.lineTo(c.width,n*u);}context.stroke();
    context.strokeStyle='#ffffff';context.lineWidth=1.5;context.strokeRect(5*u+.75,5*u+.75,u-1.5,u-1.5);
  }

  function showSection(name='adjust') {
    if(!['adjust','history','pixel'].includes(name)) name='adjust';
    if(name===section) return;
    if(target||frame||preview) clearPreview();
    section=name;
    $$('[data-fine-tab]').forEach(el=>el.setAttribute('aria-selected',String(el.dataset.fineTab===section)));
    $$('[data-fine-section]').forEach(el=>el.hidden=el.dataset.fineSection!==section);
    if(section==='history')renderHistory(true);
    if(section==='adjust')drawHistogram();
    if(section==='pixel'&&lastPoint)inspect(lastPoint);
  }

  const safe = fn => async(...args)=>{try{await fn(...args);}catch(error){api.toast(error?.message||'操作未完成。',true);}};
  mount.addEventListener('click',safe(async event=>{
    const tab=event.target.closest('[data-fine-tab]');if(tab){showSection(tab.dataset.fineTab);return;}
    const preset=event.target.closest('[data-fine-preset]');if(preset){if(preset.dataset.finePreset==='original'){clearPreview();drawHistogram();refreshView();}else{if(!ensureTarget())return;params={...PRESETS[preset.dataset.finePreset]};syncControls();requestPreview();}return;}
    const history=event.target.closest('[data-fine-history]');if(history){clearPreview();api.restoreHistory(+history.dataset.fineHistory);seen='';refresh();return;}
    const button=event.target.closest('[data-fine-action]');if(!button)return;
    switch(button.dataset.fineAction){
      case 'reset':clearPreview();drawHistogram();refreshView();break;
      case 'apply':applyPreview();break;
      case 'use-color':if(lastPixel?.alpha) {api.setColor(lastPixel.hex);api.toast('已设为前景色。');}break;
      case 'copy-color':if(lastPixel){try{await navigator.clipboard.writeText(lastPixel.hex);api.toast('HEX 已复制。');}catch{api.toast(`当前颜色：${lastPixel.hex}；浏览器未允许复制。`);}}break;
      case 'undo':case 'redo':{const d=api.getDoc();clearPreview();api.restoreHistory(d.historyIndex+(button.dataset.fineAction==='undo'?-1:1));seen='';refresh();break;}
      case 'nav-fit':{const d=api.getDoc(),r=api.getState()?.showRulers?24:0,w=api.viewport.clientWidth,h=api.viewport.clientHeight,z=clamp(Math.min((w-r-78)/d.width,(h-r-88)/d.height,1),.02,32);api.setView({z,x:r+(w-r-d.width*z)/2,y:r+(h-r-d.height*z)/2-7,fit:true});refreshView();break;}
      case 'sharpen':{
        if(busy)return;
        api.finishPending();const d=api.getDoc(),l=d?.activeLayer;if(!l||l.locked){api.toast('请先解锁当前图层。',true);return;}
        const key=layerKey(d),source=preview&&validTarget()?preview:l.canvas;
        busy=true;button.disabled=true;button.textContent='正在处理…';
        try{
          await new Promise(resolve=>requestAnimationFrame(()=>resolve()));
          if(!active||key!==layerKey(api.getDoc()))throw new Error('活动图层或工作模式已变化，请重新执行锐化。');
          const output=sharpenCanvas(source,.6);clearPreview();api.commitLayerCanvas(output,'细节锐化');api.toast('锐化已应用，透明度保持不变，可撤销。');
        }finally{busy=false;button.textContent='应用一次锐化';button.disabled=!!api.getDoc()?.activeLayer?.locked;seen='';refresh();}
        break;
      }
    }
  }));
  for(const input of $$('[data-fine-range],[data-fine-number]')){
    input.addEventListener('input',()=>{
      if(!ensureTarget())return;
      const key=input.dataset.fineRange||input.dataset.fineNumber,def=FIELDS.find(f=>f[0]===key),value=Number(input.value);
      if(!Number.isFinite(value))return;
      params[key]=clamp(value,def[2],def[3]);syncControls();requestPreview();
    });
    input.addEventListener('change',()=>{const key=input.dataset.fineRange||input.dataset.fineNumber;input.value=params[key];});
  }
  const nav=$('navigator');let navDrag=false;
  function navPoint(e){if(!navMap)return;const d=api.getDoc(),r=nav.getBoundingClientRect(),x=(e.clientX-r.left)*nav.width/r.width,y=(e.clientY-r.top)*nav.height/r.height,wx=clamp((x-navMap.x)/navMap.s,0,d.width),wy=clamp((y-navMap.y)/navMap.s,0,d.height),v=api.getView();api.setView({...v,x:api.viewport.clientWidth/2-wx*v.z,y:api.viewport.clientHeight/2-wy*v.z,fit:false});refreshView();}
  nav.addEventListener('pointerdown',e=>{if(e.button!==0)return;navDrag=true;nav.setPointerCapture(e.pointerId);navPoint(e);});
  nav.addEventListener('pointermove',e=>{if(navDrag)navPoint(e);});
  nav.addEventListener('pointerup',()=>navDrag=false);nav.addEventListener('pointercancel',()=>navDrag=false);
  nav.addEventListener('keydown',e=>{const delta=e.shiftKey?100:25;if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();const v=api.getView();api.setView({...v,x:v.x+(e.key==='ArrowLeft'?delta:e.key==='ArrowRight'?-delta:0),y:v.y+(e.key==='ArrowUp'?delta:e.key==='ArrowDown'?-delta:0),fit:false});});
  drawLoupeBackground($('loupe').getContext('2d'));
  refresh();
  return {
    refresh, refreshView, inspect, showSection,
    deactivate(){active=false;clearPreview();},
    activate(name){const waking=!active;active=true;if(waking)seen='';if(name)showSection(name);refresh();if(waking)refreshView();}
  };
}

/** Import a legacy .pixelroom document, baking transforms and filters per layer. */
export async function importPixelroom(data) {
  const width=Math.round(Number(data?.width)),height=Math.round(Number(data?.height));
  const valid=(w,h)=>Number.isInteger(w)&&Number.isInteger(h)&&w>=1&&h>=1&&w<=8192&&h<=8192&&w*h<=32*1024*1024;
  if(!data||!valid(width,height)||!Array.isArray(data.layers)||!data.layers.length||data.layers.length>40) throw new Error('不是有效的 Pixelroom 工程，或画布尺寸超出限制。');
  if(width*height*data.layers.length>128*1024*1024) throw new Error('转换后的图层像素量过大，请在 Pixelroom 中合并部分图层再导入。');
  const layers=[],idMap=new Map();let inputPixels=0,totalBytes=0;
  for(const [index,saved] of data.layers.entries()){
    const url=saved.dataURL||saved.dataUrl;
    if(typeof url!=='string'||!url.startsWith('data:image/png;base64,'))throw new Error(`第 ${index+1} 个图层缺少 PNG 数据。`);
    totalBytes+=url.length;if(totalBytes>256*1024*1024)throw new Error('Pixelroom 工程超过 256 MB，请拆分后导入。');
    let header;
    try{header=atob(url.slice(url.indexOf(',')+1).slice(0,44));}catch{throw new Error('PNG 图层数据已损坏。');}
    if(header.length<24||[137,80,78,71,13,10,26,10].some((b,i)=>header.charCodeAt(i)!==b))throw new Error('PNG 图层文件头无效。');
    const bytes=Uint8Array.from(header,c=>c.charCodeAt(0)),view=new DataView(bytes.buffer),iw=view.getUint32(16),ih=view.getUint32(20);
    if(!valid(iw,ih))throw new Error('Pixelroom 图层尺寸超出限制。');
    inputPixels+=iw*ih;if(inputPixels>128*1024*1024)throw new Error('Pixelroom 原图层像素总量超出限制。');
    const image=new Image();image.src=url;try{await image.decode();}catch{throw new Error(`无法解码第 ${index+1} 个图层。`);}
    const canvas=makeCanvas(width,height),c=canvas.getContext('2d');
    const number=(value,fallback,lo,hi)=>Number.isFinite(Number(value))?clamp(Number(value),lo,hi):fallback;
    const sx=number(saved.scaleX,1,-32768,32768)||1,sy=number(saved.scaleY,1,-32768,32768)||1;
    const x=number(saved.x,0,-1000000,1000000),y=number(saved.y,0,-1000000,1000000),rotation=number(saved.rotation,0,-360000,360000)%360;
    const f={...DEFAULT};
    for(const [key,min,max] of [['brightness',0,300],['contrast',0,300],['saturation',0,300],['hue',-360,360],['blur',0,50]])f[key]=number(saved.filters?.[key],DEFAULT[key],min,max);
    if(!('filter' in c)&&Object.keys(DEFAULT).some(k=>f[k]!==DEFAULT[k]))throw new Error('当前浏览器不支持旧工程中的图层滤镜，请使用桌面 Edge 或 Chrome 导入。');
    c.imageSmoothingEnabled=data.smoothing===true;
    c.filter=filterString(f);
    c.translate(x+iw*Math.abs(sx)/2,y+ih*Math.abs(sy)/2);c.rotate(rotation*Math.PI/180);c.scale(sx,sy);c.translate(-iw/2,-ih/2);c.drawImage(image,0,0);
    c.setTransform(1,0,0,1,0,0);c.filter='none';
    const id=uid();idMap.set(saved.id,id);
    layers.push({id,name:String(saved.name||`图层 ${index+1}`).slice(0,120),canvas,visible:saved.visible!==false,locked:!!saved.locked,opacity:number(saved.opacity,1,0,1),blend:BLENDS.has(saved.blend)?saved.blend:'source-over'});
  }
  const importedName=String(data.name||'Pixelroom 作品').replace(/[\\/<>:"|?*\x00-\x1f]/g,'_').replace(/\.(pixelroom|png|jpe?g|webp|gif|bmp)$/i,'').slice(0,116)+'.png';
  const doc=new PaintDocument({name:importedName,width,height});
  doc.layers=layers;doc.activeLayerId=idMap.get(data.activeId)||layers[layers.length-1].id;
  doc.resetHistory('导入 Pixelroom 工程');doc.dirty=true;doc.isDemo=false;
  doc.legacyImportNote='已保留分层、透明度和混合模式；位置、缩放、旋转及滤镜已烘焙到各图层像素。';
  return doc;
}
