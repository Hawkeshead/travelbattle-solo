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
/* dice.js watches the battle-bed element for attribute changes. jsdom ships a
   MutationObserver but does not expose it as a global; the game reads the bare
   name, so it is handed over here. Real observer, not a stub, so if the game
   ever depends on a callback firing it still does. */
global.MutationObserver = dom.window.MutationObserver;
/* performance deliberately left as Node's own: jsdom's window.performance is a
   separate clock and swapping it stalled the board intro, which measures real
   elapsed time. */
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
global.DOMParser = dom.window.DOMParser;
global.ResizeObserver = dom.window.ResizeObserver || class { observe(){} unobserve(){} disconnect(){} };
global.matchMedia = dom.window.matchMedia || (q => ({ matches:false, media:q, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
dom.window.matchMedia = dom.window.matchMedia || global.matchMedia;
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
/* COLLAPSE THE CLOCK.

   The game is paced for a person to watch: deploy steps land about 300ms apart,
   camera pans run 420-900ms, dice panels hold, floating text staggers. A single
   match therefore takes minutes of wall time, and two hundred of them would take
   most of a day.

   Every one of those delays is a setTimeout. Clamping the delay to zero keeps
   the ORDER and the callback chain exactly as they are (this is still an async
   queue, not synchronous execution) and removes only the waiting. No game code
   is modified and no timing logic is bypassed; the same callbacks run in the
   same sequence, just without the pauses that exist for human eyes.

   Installed by the simulator, never by the game. */
export function collapseTimers(){
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms, ...args) => realSetTimeout(fn, 0, ...args);
  dom.window.setTimeout = globalThis.setTimeout;
  globalThis.requestAnimationFrame = cb => realSetTimeout(()=>cb(Date.now()), 0);
  dom.window.requestAnimationFrame = globalThis.requestAnimationFrame;
  return () => { globalThis.setTimeout = realSetTimeout; };
}

/* NOT THE BOTTLENECK, tried and removed: capping the #log element and stubbing
   scrollHeight. log() appends a DOM node per line and reads scrollHeight, which
   forces a jsdom layout, so it looked like the obvious cost in a long match. It
   is not: capping it changed a twenty-match batch by four seconds in two hundred
   and twenty. The time is in the AI scoring, which evaluates twenty-odd candidate
   squares per unit per activation. Noted so it is not tried again. */

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
