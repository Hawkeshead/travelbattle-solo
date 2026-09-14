/* =========================================================
   CHECKING OUT AN OLD AI TO PLAY AGAINST THE NEW ONE

   Given a git ref, writes that commit's ai-strategy.js and ai-tactics.js into
   js/ under suffixed names and returns the module path to import.

   WHY INTO js/ AND NOT A TEMP DIRECTORY. The copy has to import the same
   data-core, engine-rules and engine-state instances the live game is using, or
   the two AIs play on two different boards. ESM resolves by path, so a copy
   sitting anywhere else gets its own instances of everything it imports. Putting
   it beside the originals is what makes './data-core.js' mean the same file.

   The copy's own import of ai-tactics is rewritten to point at the matching old
   copy, so the pair stays internally consistent: an old strategy calling the
   current tactics would be neither version.

   These files are build artefacts, gitignored, and removed after a run.
========================================================= */
import { execFileSync } from 'node:child_process';
import fs from 'fs';
import path from 'path';

const JS_DIR = path.resolve(process.cwd(), 'js');
const AI_FILES = ['ai-strategy.js', 'ai-tactics.js'];

function slug(ref){ return ref.replace(/[^A-Za-z0-9]/g, '_'); }

export function materialiseVersion(ref){
  const tag = slug(ref);
  const written = [];
  for(const f of AI_FILES){
    let src;
    try {
      src = execFileSync('git', ['show', `${ref}:js/${f}`], { cwd: process.cwd(), encoding: 'utf8' });
    } catch {
      throw new Error(`cannot read js/${f} at ref '${ref}' — is the ref right, and did the file exist then?`);
    }
    /* Keep the pair together: the old strategy must call the old tactics. */
    src = src.replace(/from '\.\/ai-tactics\.js'/g, `from './ai-tactics__${tag}.js'`);
    const dest = path.join(JS_DIR, f.replace('.js', `__${tag}.js`));
    fs.writeFileSync(dest, src);
    written.push(dest);
  }
  return { tag, entry: `../../js/ai-strategy__${tag}.js`, written };
}

export function cleanVersions(){
  for(const f of fs.readdirSync(JS_DIR)){
    if(/^ai-(strategy|tactics)__/.test(f)) fs.unlinkSync(path.join(JS_DIR, f));
  }
}

export function describeRef(ref){
  try {
    return execFileSync('git', ['log', '-1', '--format=%h %s', ref],
      { cwd: process.cwd(), encoding: 'utf8' }).trim();
  } catch { return ref; }
}
