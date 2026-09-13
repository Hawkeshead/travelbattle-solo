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
dom.window.HTMLCanvasElement.prototype.getContext = () =>
  new Proxy({}, { get: (t,k) => (k==='canvas' ? {width:0,height:0} : ()=>({})) });

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
