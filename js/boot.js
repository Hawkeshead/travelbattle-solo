const _savedCampaignProgress = loadCampaignProgress();
if(_savedCampaignProgress){
  resumeCampaignFromStorage(_savedCampaignProgress);
} else {
  showModeSelect(true);
}
sizeCanvas();
