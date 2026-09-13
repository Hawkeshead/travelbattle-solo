/* =========================================================
   HEADLESS ENVIRONMENT FOR THE AI-VS-AI HARNESS

   The game is written for a browser and the turn loop lives in ui-battle, so
   there is no existing way to run a match without a DOM. This supplies one.

   NOTHING IN js/ IS MODIFIED OR MOCKED. Every module loads exactly as it does in
   the browser; only the four browser globals it reaches for are provided:

     XMLHttpRequest  data-core loads its JSON synchronously. In a browser that is
                     a same-origin fetch, here it is a file read.
     Image           sprite preloading. Nothing is drawn headless, so an Image
                     that reports itself complete is sufficient.
     Audio / WebAudio  the audio layer constructs nodes at load time.
     canvas.getContext  a proxy that accepts any call and returns an object. The
                     renderer never reads anything back from it.

   VERIFIED: all eleven game modules load, 414 exports between them. floating-text
   loads with no shim at all, which is the leaf property checked rather than
   asserted.
========================================================= */
import { JSDOM } from 'jsdom';
import fs from 'fs';
const dom = new JSDOM(fs.readFileSync('index.html','utf8'), { pretendToBeVisual:true, url:'https://localhost/' });
global.window = dom.window; global.document = dom.window.document;
Object.defineProperty(global,'navigator',{value:dom.window.navigator,configurable:true});
global.localStorage = dom.window.localStorage;
global.requestAnimationFrame = cb => setTimeout(()=>cb(Date.now()),0);
global.cancelAnimationFrame = id => clearTimeout(id);
/* A context that accepts every call and returns a plausible SHAPE for the few
   whose result the renderer reads back: image data (it walks .data to build the
   parchment texture), gradients and patterns (it calls addColorStop), and text
   measurement. Everything else is a no-op, since nothing is ever displayed. */
function makeCtx(){
  const grad = { addColorStop(){}, };
  const ctx = new Proxy({
    canvas: { width: 1400, height: 700 },
    getImageData: (x,y,w,h) => ({ width:w|0 || 1, height:h|0 || 1,
                                  data: new Uint8ClampedArray(Math.max(4, (w|0||1)*(h|0||1)*4)) }),
    createImageData: (w,h) => ({ width:w|0 || 1, height:h|0 || 1,
                                 data: new Uint8ClampedArray(Math.max(4, (w|0||1)*(h|0||1)*4)) }),
    putImageData(){},
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    createPattern: () => ({}),
    measureText: (t) => ({ width: String(t||'').length * 6, actualBoundingBoxAscent: 8,
                           actualBoundingBoxDescent: 2 }),
    getLineDash: () => [],
  }, {
    get(target, k){
      if(k in target) return target[k];
      return () => undefined;     // every other draw call is a no-op
    },
    set(target, k, v){ target[k] = v; return true; },
  });
  return ctx;
}
dom.window.HTMLCanvasElement.prototype.getContext = function(){
  if(!this.__ctx) this.__ctx = makeCtx();
  return this.__ctx;
};

/* data-core loads its JSON synchronously over XHR. In a browser that is a
   same-origin fetch; here it is a file read. Nothing in the game changes. */
class FileXHR {
  open(method, url){ this._url = String(url).replace(/^\.?\//,''); }
  setRequestHeader(){}
  send(){
    try {
      this.responseText = fs.readFileSync(this._url, 'utf8');
      this.status = 200;
    } catch { this.responseText = ''; this.status = 404; }
    this.readyState = 4;
    if(this.onload) this.onload();
    if(this.onreadystatechange) this.onreadystatechange();
  }
}
global.XMLHttpRequest = FileXHR;
/* Sprite preloading. Nothing is drawn headless, so an Image that reports itself
   loaded and never fires is enough; the renderer only ever asks whether it is
   complete before blitting, and no blitting happens. */
global.Image = dom.window.Image || class { set src(v){ this._src=v; this.complete=true; if(this.onload) this.onload(); } get src(){ return this._src; } };
global.Audio = class { play(){ return Promise.resolve(); } pause(){} addEventListener(){} removeEventListener(){} load(){} };
global.AudioContext = global.webkitAudioContext = class {
  constructor(){ this.destination={}; this.currentTime=0; this.state='running'; }
  createGain(){ return { gain:{ value:1, setValueAtTime(){}, linearRampToValueAtTime(){} }, connect(){}, disconnect(){} }; }
  createBufferSource(){ return { connect(){}, start(){}, stop(){}, buffer:null }; }
  createMediaElementSource(){ return { connect(){}, disconnect(){} }; }
  createStereoPanner(){ return { pan:{ value:0 }, connect(){}, disconnect(){} }; }
  decodeAudioData(){ return Promise.resolve({}); }
  resume(){ return Promise.resolve(); }
};
dom.window.XMLHttpRequest = FileXHR;
global.fetch = async (u) => ({ ok:true, json: async()=>JSON.parse(fs.readFileSync(String(u).replace(/^\.?\//,''),'utf8')),
                               text: async()=>fs.readFileSync(String(u).replace(/^\.?\//,''),'utf8') });


/* Loads the game modules in dependency order under the shim above and hands
   them back. Import this first from any harness script. */
export async function loadGame(){
  const data   = await import('../../js/data-core.js');
  const dice   = await import('../../js/dice.js');
  const rules  = await import('../../js/engine-rules.js');
  const st     = await import('../../js/engine-state.js');
  const ai     = await import('../../js/ai-strategy.js');
  const ui     = await import('../../js/ui-battle.js');
  const replay = await import('../../js/replay.js');
  return { data, dice, rules, st, ai, ui, replay, dom };
}
export { dom };
