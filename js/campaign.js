import { CAMPAIGNS, SCENARIOS, SIDES, SIDE_LABEL, state } from './data-core.js';
import { log } from './engine-state.js';
import { beginBoardSetup, showModeSelect } from './ui-menus.js';

/* =========================================================
   CAMPAIGN MODE — chains Battles and Operations per the Hub's actual
   branching structure. Since "New Battle" already does a full page
   reload (the safest way to guarantee clean state), campaign progress
   is persisted to localStorage and picked back up on the next load,
   rather than trying to hand-reset every field in memory.
========================================================= */
export const CAMPAIGN_STORAGE_KEY = 'tbCampaignProgress';
export function saveCampaignProgress(){
  if(!state.campaign){ localStorage.removeItem(CAMPAIGN_STORAGE_KEY); return; }
  try {
    localStorage.setItem(CAMPAIGN_STORAGE_KEY, JSON.stringify({
      campaignId: state.campaign.id,
      flowIndex: state.campaignFlowIndex,
      lastWinner: state.campaignLastWinner,
      record: state.campaignRecord,
      mode: state.mode, aiSide: state.aiSide, aiDifficulty: state.aiDifficulty
    }));
  } catch(e){ /* storage unavailable — campaign just won't survive a reload, not fatal */ }
}
export function loadCampaignProgress(){
  try {
    const raw = localStorage.getItem(CAMPAIGN_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch(e){ return null; }
}
export function clearCampaignProgress(){ try{ localStorage.removeItem(CAMPAIGN_STORAGE_KEY); }catch(e){} }

export function showCampaignMenu(){
  document.getElementById('overlayTitle').textContent = 'Campaigns';
  document.getElementById('overlayText').innerHTML =
    'A linear sequence of historical Battles, with the winner of each choosing which Operation comes next. Your side and opponent are chosen once, at the start.';
  let extra = document.getElementById('modeChoices');
  extra.innerHTML = '';
  extra.style.display = 'flex';
  extra.style.flexDirection = 'column';
  extra.style.gap = '6px';
  for(const camp of CAMPAIGNS){
    const b = document.createElement('button');
    b.style.textAlign = 'left';
    b.textContent = `${camp.name} (${camp.years})`;
    b.onclick = ()=>{ showCampaignBrief(camp); };
    extra.appendChild(b);
  }
  const backBtn = document.createElement('button');
  backBtn.textContent = '← Back';
  backBtn.onclick = ()=>{ showModeSelect(); };
  extra.appendChild(backBtn);
  document.getElementById('overlay').classList.add('show');
}

export function showCampaignBrief(camp){
  document.getElementById('overlayTitle').textContent = camp.name;
  document.getElementById('overlayText').innerHTML = camp.brief;
  let extra = document.getElementById('modeChoices');
  extra.innerHTML = '';
  extra.style.display = 'flex';
  const beginBtn = document.createElement('button');
  beginBtn.className = 'primary';
  beginBtn.textContent = 'Begin Campaign';
  beginBtn.onclick = ()=>{ extra.style.display='none'; showCampaignModeSelect(camp); };
  const backBtn = document.createElement('button');
  backBtn.textContent = '← Back';
  backBtn.onclick = ()=>{ showCampaignMenu(); };
  extra.appendChild(beginBtn);
  extra.appendChild(backBtn);
  document.getElementById('overlay').classList.add('show');
}

export function showCampaignModeSelect(camp){
  document.getElementById('overlayTitle').textContent = 'How will you play this Campaign?';
  document.getElementById('overlayText').innerHTML = 'This choice applies for the whole campaign, not just one battle.';
  let extra = document.getElementById('modeChoices');
  extra.innerHTML = '';
  extra.style.display = 'flex';
  const hotseatBtn = document.createElement('button');
  hotseatBtn.className = 'primary';
  hotseatBtn.textContent = 'Hotseat (2 players)';
  hotseatBtn.onclick = ()=>{ state.mode='hotseat'; extra.style.display='none'; startCampaign(camp); };
  const aiBtn = document.createElement('button');
  aiBtn.textContent = 'vs AI Opponent';
  aiBtn.onclick = ()=>{
    extra.style.display='none';
    document.getElementById('overlayTitle').textContent = 'Choose Your Side';
    document.getElementById('overlayText').innerHTML = 'This is who you\'ll play as for the whole campaign.';
    let extra2 = document.getElementById('modeChoices');
    extra2.innerHTML=''; extra2.style.display='flex';
    const redBtn = document.createElement('button');
    redBtn.className='primary'; redBtn.textContent='Play Britain';
    redBtn.onclick = ()=>{ state.mode='ai'; state.aiSide=SIDES.BLUE; extra2.style.display='none'; showCampaignDifficultySelect(camp); };
    const blueBtn = document.createElement('button');
    blueBtn.textContent='Play France';
    blueBtn.onclick = ()=>{ state.mode='ai'; state.aiSide=SIDES.RED; extra2.style.display='none'; showCampaignDifficultySelect(camp); };
    extra2.appendChild(redBtn); extra2.appendChild(blueBtn);
  };
  extra.appendChild(hotseatBtn);
  extra.appendChild(aiBtn);
  document.getElementById('overlay').classList.add('show');
}

export function showCampaignDifficultySelect(camp){
  document.getElementById('overlayTitle').textContent = 'Choose AI Difficulty';
  document.getElementById('overlayText').innerHTML = 'Applies for the whole campaign.';
  let extra = document.getElementById('modeChoices');
  extra.innerHTML = ''; extra.style.display = 'flex'; extra.style.flexWrap = 'wrap';
  const mk = (label, value, primary)=>{
    const b = document.createElement('button');
    if(primary) b.className = 'primary';
    b.textContent = label;
    b.onclick = ()=>{ state.aiDifficulty = value; extra.style.display='none'; startCampaign(camp); };
    return b;
  };
  extra.appendChild(mk('Easy','easy',false));
  extra.appendChild(mk('Medium','medium',true));
  extra.appendChild(mk('Hard','hard',false));
  document.getElementById('overlay').classList.add('show');
}

export function startCampaign(camp){
  state.campaign = camp;
  state.campaignFlowIndex = 0;
  state.campaignLastWinner = null;
  state.campaignRecord = [];
  saveCampaignProgress();
  runCampaignStep();
}

export function runCampaignStep(){
  const step = state.campaign.flow[state.campaignFlowIndex];
  if(!step){ showCampaignComplete(); clearCampaignProgress(); return; }
  document.getElementById('overlay').classList.remove('show');
  if(step.type==='battle'){
    state.scenario = null;
    document.getElementById('overlayTitle').textContent = step.name;
    document.getElementById('overlayText').innerHTML = `<b>${step.date}</b><br><br>${step.intro}`;
    let extra = document.getElementById('modeChoices');
    extra.innerHTML = ''; extra.style.display = 'flex';
    const beginBtn = document.createElement('button');
    beginBtn.className = 'primary';
    beginBtn.textContent = 'Begin Battle';
    beginBtn.onclick = ()=>{ extra.style.display='none'; document.getElementById('overlay').classList.remove('show'); beginBoardSetup(); };
    extra.appendChild(beginBtn);
    document.getElementById('overlay').classList.add('show');
  } else if(step.type==='branch'){
    showCampaignBranchChoice(step);
  }
}

export function showCampaignBranchChoice(step){
  const chooser = state.campaignLastWinner || SIDES.RED; // fallback if somehow undecided
  const isHumanChoosing = !(state.mode==='ai' && chooser===state.aiSide);
  if(!isHumanChoosing){
    // AI picks between whichever options are actually available
    const available = step.options.filter(o=>!o.locked);
    const choice = available[Math.floor(Math.random()*available.length)];
    log(`${SIDE_LABEL[chooser]} (AI) chooses the next Operation: ${choice.name}.`, 'system');
    beginChosenOperation(choice);
    return;
  }
  document.getElementById('overlayTitle').textContent = `${SIDE_LABEL[chooser]} Chooses`;
  document.getElementById('overlayText').innerHTML = 'You won the last engagement — pick which Operation comes next.';
  let extra = document.getElementById('modeChoices');
  extra.innerHTML = ''; extra.style.display = 'flex'; extra.style.flexDirection = 'column'; extra.style.gap = '6px';
  for(const opt of step.options){
    const b = document.createElement('button');
    if(opt.locked){
      b.textContent = `${opt.name} (coming soon — needs VIP mission mechanics)`;
      b.disabled = true;
    } else {
      b.textContent = `${opt.name}${opt.missionArchetype ? ' — '+opt.missionArchetype : ''}`;
      b.onclick = ()=>{ extra.style.display='none'; beginChosenOperation(opt); };
    }
    extra.appendChild(b);
  }
  document.getElementById('overlay').classList.add('show');
}

export function beginChosenOperation(opt){
  const scenario = SCENARIOS.find(s=>s.id===opt.operationId);
  if(!scenario){ log(`Could not find Operation data for ${opt.name} — skipping.`, 'system'); advanceCampaignStep(); return; }
  state.scenario = scenario;
  document.getElementById('overlay').classList.remove('show');
  beginBoardSetup();
}

export function advanceCampaignStep(){
  state.campaignFlowIndex++;
  saveCampaignProgress();
  runCampaignStep();
}

export function showCampaignComplete(){
  const wins = state.campaignRecord.filter(r=>r===SIDES.RED).length;
  const lwins = state.campaignRecord.length - wins;
  document.getElementById('overlayTitle').textContent = `${state.campaign.name} Complete`;
  document.getElementById('overlayText').innerHTML =
    `The campaign has run its course. Britain won ${wins} engagement${wins===1?'':'s'}; France won ${lwins}.`;
  const modeChoices = document.getElementById('modeChoices');
  if(modeChoices) modeChoices.style.display = 'none';
  document.getElementById('overlayBtn').style.display = 'inline-block';
  document.getElementById('overlayBtn').textContent = 'Done';
  document.getElementById('overlayBtn').onclick = ()=>{ state.campaign=null; location.reload(); };
  document.getElementById('overlay').classList.add('show');
}

export function resumeCampaignFromStorage(progress){
  const camp = CAMPAIGNS.find(c=>c.id===progress.campaignId);
  if(!camp){ clearCampaignProgress(); showModeSelect(); return; }
  state.campaign = camp;
  state.campaignFlowIndex = progress.flowIndex;
  state.campaignLastWinner = progress.lastWinner;
  state.campaignRecord = progress.record || [];
  state.mode = progress.mode;
  state.aiSide = progress.aiSide;
  state.aiDifficulty = progress.aiDifficulty;
  runCampaignStep();
}

