# Draw Peninsula maps in the game itself: terrain, roads, river, fords, bridges, place names.
import sys, json, importlib.util
from playwright.sync_api import sync_playwright
spec=importlib.util.spec_from_file_location('m', __file__.replace('render.py','maps.py')); M=importlib.util.module_from_spec(spec); spec.loader.exec_module(M)
keys = sys.argv[1:] or list(M.MAPS)
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
    pg=b.new_page(viewport={'width':1400,'height':760}, device_scale_factor=1)
    pg.add_init_script("localStorage.setItem('fc_htp_seen','1')")
    pg.goto('http://127.0.0.1:4173/'); pg.wait_for_timeout(11000)
    pg.evaluate("document.documentElement.classList.add('title-away')")
    pg.add_style_tag(content="#overlay,#despatch,#hudIcons,#unitOverlay,#spyglassBtn,#ambientLayer,#ambientShadows,#armyPickerPanel,.overlay,#title,#titleScreen{display:none!important}")
    for k in keys:
        m = M.MAPS[k]
        pg.evaluate("""(m)=>Promise.all([import('/js/data-core.js'),import('/js/operations.js'),import('/js/render-board.js')]).then(([d,o,r])=>{
           for(const u of d.state.units) u.removed = true; d.state.viewEdge = null; d.state._corridorView = false;
           o.applyLockedMap({map:{type:'authored', terrain:m.terrain, roads:m.roads, river:m.river||undefined, places:m.places}});
           d.state.viewEdge = null; d.setBoardMode && d.setBoardMode('standard'); r.sizeCanvas && r.sizeCanvas();
           r.cameraTo(9.5,4.5,{zoom:1,durationMs:1}); r.draw(); })""", m)
        pg.wait_for_timeout(2200)
        pg.locator('#board').screenshot(path=f'/tmp/peninsula-{k}.png'); print('drawn', k, flush=True)
    b.close()
