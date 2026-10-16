/* =========================================================
   HOW TO PLAY (Matthew, 16 Oct 2026)

   A swipe-through deck of thirteen cards, each a short clip recorded in the
   game itself (assets/tutorial/*.webp) with two or three lines of rules and a
   tip. Opened from "How to Play" on the title screen and from the battle
   menu. Swipe, tap Next or Back, tap a dot to jump, Skip goes to the last card;
   the last card's button closes the deck. Rules text matches the Rules Digest.
   Purely presentation: no game state is touched.
========================================================= */
const CARDS = [
  ['card1_turn', 'Your turn', 'Every turn has three phases. Move your units, then fire your guns and volleys, then fight every enemy you are touching.', 'Tap the leather despatch case to end each phase. Tap it again to confirm.'],
  ['card2_army', 'Your army', 'Infantry hold the line; the Guard are elite and may re-roll once in a fight. Cavalry move two squares and charge, and heavy cavalry also re-roll. Artillery fires up to six squares.', 'Your Brigadier never fights. His job is keeping his Brigade together.'],
  ['card3_command', 'Stay in command', 'A unit can only move while it touches its Brigadier, or another unit of his Brigade that does. Break the chain and the units beyond it are stuck.', 'Tap Spot Men on a Brigadier\u2019s card to see who is in command and who is cut off.'],
  ['card4_fight', 'Fighting', 'Both sides roll a die and keep the best one. Bonuses add to it, and the bigger number wins by the difference.', 'Win by 1: they fall back. By 2: they run and must rally. By 3 or more: they are destroyed. A draw carries on next turn.'],
  ['card5_turned', 'Turned around', 'A good volley, or losing a fight by one, turns a unit around. It spends its next turn turning back, and anyone attacking it meanwhile gets +1.', 'Volley first, then charge in. Turned again while still turned, it stays turned another turn.'],
  ['card6_charge', 'Cavalry charge', 'Cavalry gallop up to two squares and crash in. Against infantry not in square they roll an extra die, and a charge wins a drawn fight.', 'Cavalry cannot charge uphill, and cannot ride into woods or villages.'],
  ['card7_square', 'Form square', 'Infantry in square are a fortress against horse: they get the extra die and the cavalry lose theirs.', 'But a square cannot move, and enemy infantry and guns hit it harder. Form it when cavalry come, drop it when they go.'],
  ['card8_column', 'Attack column', 'Two battalions on one square make a column, and a column attacks with an extra die. A battalion pushed back onto a friendly battalion falls in beside it as a column.', 'Keep columns away from enemy guns: they hit a column harder, and a shot that destroys one battalion takes both.'],
  ['card9_guns', 'The guns', 'To hit, roll at least the range: a 4 at four squares. Then roll again for the effect. Woods, villages and hills in the way block the shot, unless your gun is on a hill.', 'Keep firing at the same square and the crew zero in: +1, then +2. A red medallion marks a ranged square.'],
  ['card10_ambush', 'Woods and ambush', 'Infantry in woods are harder to beat and can lie hidden. The first enemy to walk next to them is ambushed, and you choose how to spring it.', 'Caught cavalry lose their extra die. Hidden units cannot volley, and nor can a unit in the turn it leaves its wood.'],
  ['card11_village', 'Villages', 'Infantry defending a village roll an extra die, cavalry can never attack it, and shots against it are weaker.', 'A gun in a village is safe from horse. Villages also count as road.'],
  ['card12_hill', 'Hills', 'A unit on a hill wins a drawn fight against attackers below it, and cavalry cannot charge up at it.', 'A gun on a hill fires over everything in front of it. Put one there early.'],
  ['card13_rally', 'Rally and victory', 'A unit that runs must rally: 4 or more, or 3 for Guard and heavy cavalry. If it fails, its Brigadier can spend his one Leadership Roll to keep it in the field.', 'A Brigade breaks when all its fighting units are gone. Break two enemy Brigades to win.'],
];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let root = null, at = 0;
export function openHowToPlay(){
  if(root){ root.classList.add('show'); go(0); return; }
  root = document.createElement('div');
  root.id = 'howToPlay';
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'How to Play');
  root.innerHTML = `<div class="htp-frame"><div class="htp-sheet">
    <button class="htp-skip" type="button">Skip</button>
    <button class="htp-close" type="button" aria-label="Close">\u00d7</button>
    <div class="htp-track">${CARDS.map(([img, t, a, b], i) => `
      <section class="htp-card" aria-label="${i + 1} of ${CARDS.length}">
        <figure class="htp-plate"><img alt="${esc(t)}" data-src="assets/tutorial/${img}.webp"></figure>
        <div class="htp-words"><h2>${esc(t)}</h2><p>${esc(a)}</p><p class="htp-tip">${esc(b)}</p></div>
      </section>`).join('')}</div>
    <div class="htp-bar"><button class="htp-btn htp-prev" type="button">Back</button>
      <div class="htp-dots">${CARDS.map((_, i) => `<button class="htp-dot" type="button" aria-label="Card ${i + 1}"></button>`).join('')}</div>
      <button class="htp-btn htp-next" type="button">Next</button></div>
  </div></div>`;
  document.body.appendChild(root);
  const track = root.querySelector('.htp-track');
  root.querySelector('.htp-prev').onclick = () => go(at - 1);
  root.querySelector('.htp-next').onclick = () => (at === CARDS.length - 1 ? closeHowToPlay() : go(at + 1));
  root.querySelector('.htp-skip').onclick = () => go(CARDS.length - 1);
  root.querySelector('.htp-close').onclick = closeHowToPlay;
  root.querySelectorAll('.htp-dot').forEach((d, i) => d.onclick = () => go(i));
  let x0 = null;
  track.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
  track.addEventListener('touchend', e => {
    if(x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if(Math.abs(dx) > 40) go(at + (dx < 0 ? 1 : -1));
  });
  document.addEventListener('keydown', e => {
    if(!root || !root.classList.contains('show')) return;
    if(e.key === 'ArrowRight') go(at + 1);
    else if(e.key === 'ArrowLeft') go(at - 1);
    else if(e.key === 'Escape') closeHowToPlay();
  });
  requestAnimationFrame(() => { root.classList.add('show'); go(0); });
}
export function closeHowToPlay(){ if(root) root.classList.remove('show'); }

/* Shows card i; loads its clip and the next one's (the clips are a few
   hundred KB each, so only what is about to be seen is fetched). */
function go(i){
  at = Math.max(0, Math.min(CARDS.length - 1, i));
  root.querySelector('.htp-track').style.transform = `translateX(${-at * 100}%)`;
  root.querySelectorAll('.htp-dot').forEach((d, j) => d.setAttribute('aria-current', j === at ? 'true' : 'false'));
  root.querySelector('.htp-prev').disabled = at === 0;
  root.querySelector('.htp-next').textContent = at === CARDS.length - 1 ? 'To battle' : 'Next';
  const imgs = root.querySelectorAll('.htp-plate img');
  for(const j of [at, at + 1]) if(imgs[j] && !imgs[j].src) imgs[j].src = imgs[j].dataset.src;
}
