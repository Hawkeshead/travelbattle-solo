# Builds data/story/peninsula.json from maps.py and the battle sheets in the
# Grognards Campaign Design doc (Peninsula battle sheets). Coordinates are the
# designed 20 x 10 board; corridor maps are turned by js/story.js.
import json, importlib.util, os
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('m', os.path.join(here, 'maps.py')); M = importlib.util.module_from_spec(spec); spec.loader.exec_module(M)

def sq(m, ch, rows=range(10), cols=range(20)):
    return [[x, y] for y in rows for x in cols if m['terrain'][y][x] in ch]
def rect(x0, x1, y0, y1): return [[x, y] for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]
E = {'type': 'edge'}
def A(a): return {'type': 'area', 'area': a}
def bde(name, units, placement=E, commander=None, tag=None, names=None, **kw):
    b = dict(name=name, units=units, placement=placement)
    if commander: b['commander'] = commander
    if tag: b['tag'] = tag
    if names: b['names'] = [None] + names
    b.update(kw); return b
def side(brigades, text, conds, comb='any', role='hold', start=''):
    return dict(start=start, brigades=brigades, role=role, objective=dict(text=text, combinator=comb, conditions=conds))
B_ = 'BRIGADIER'; I = 'INFANTRY'; G = 'GUARD'; LC = 'LIGHT_CAV'; HC = 'HEAVY_CAV'; ART = 'ARTILLERY'
WIKI = 'https://en.wikipedia.org/wiki/'
battles = []
def battle(id, name, date, kind, turns, hist, url, sides, areas, layout=None, rules=None, needs=None, special='', exits=None, first=None):
    m = M.MAPS[id]
    mp = dict(terrain=m['terrain'], roads=m['roads'], places=m.get('places', []), areas=areas)
    if m.get('river'): mp['river'] = m['river']
    if exits: mp['exits'] = exits
    b = dict(id=id, name=name, date=date, kind=kind, layout=layout or m['layout'], turnLimit=turns, history=hist, sourceUrl=url,
             map=mp, sides=sides, special=special, balance='', rules=rules or {}, needs=needs or [])
    if first: b['firstPlayer'] = first
    battles.append(b)

m = M.MAPS
# ---------- Bailén ----------
battle('bailen', 'Bailén', '19 July 1808', 'Major battle', 10,
  "Dupont's corps, marching back north in the July heat, found Reding's Spaniards across its road at Bailén with Castaños closing behind. Four French attacks failed, the Swiss in French service went over to their countrymen, and Dupont surrendered nearly 18,000 men: the first defeat of a French army in the field.",
  WIKI + 'Battle_of_Bail%C3%A9n',
  {'Spain': side([bde('Reding', [B_, I, I, I, ART], commander='Reding'), bde('Coupigny', [B_, I, I, LC, ART], commander='Coupigny')],
                 'Hold Bailén and a square of the ridge across the road at the end of round 10.',
                 [{'type': 'HOLD_COUNT', 'area': 'bailen', 'count': 1, 'atRound': 10}, {'type': 'HOLD_COUNT', 'area': 'ridge', 'count': 1, 'atRound': 10}], 'all'),
   'France': side([bde('Dupont', [B_, I, I, I, ART], A('french_start'), 'Dupont', names=[None, None, 'Swiss battalion (Reding)', None]),
                   bde('Barbou', [B_, I, I, G, ART], A('french_start'), 'Barbou', names=[None, None, 'Marins de la Garde', None]),
                   bde('Fresia', [B_, HC, LC, LC], A('french_start'), 'Fresia'),
                   bde('Vedel', [B_, I, I], E, 'Vedel', arrives={'round': 8, 'area': 'vedel'})],
                  'Get a unit into Bailén, or break two Spanish Brigades, by the end of round 10.',
                  [{'type': 'ENTERED', 'area': 'bailen', 'byRound': 10}, {'type': 'BREAK_BRIGADES', 'count': 2, 'byRound': 10}], 'any', 'attack')},
  {'bailen': sq(m['bailen'], '#'), 'ridge': sq(m['bailen'], '^'), 'french_start': rect(0, 19, 2, 3), 'vedel': [[19, 8], [19, 9], [18, 9]]},
  rules={}, needs=['heat and thirst (French move one less from round 6)', 'the Swiss go over (round 7)'],
  special='The Rumblar behind the French. Vedel arrives in round 8 behind the Spanish.')
# ---------- Vimeiro ----------
battle('vimeiro', 'Vimeiro', '21 August 1808', 'Major battle', 10,
  "Junot attacked Wellesley's army on the hills around Vimeiro in columns. British skirmishers and two-deep lines on the reverse slopes shot the columns to pieces, a flank attack on the eastern ridge was beaten back too, and Junot asked for terms.",
  WIKI + 'Battle_of_Vimeiro',
  {'Britain': side([bde('Anstruther and Fane', [B_, I, I, I, ART], commander='Fane', names=['95th Rifles', '50th West Kent', '97th Queen\'s Germans', None]),
                    bde('Ferguson', [B_, I, I, I, ART], commander='Ferguson', names=['36th Herefordshire', '40th 2nd Somersetshire', '71st Highland', None])],
                   'No French unit on Vimeiro Hill or in the village at the end of round 10.',
                   [{'type': 'CLEAR_AREA', 'area': 'vimeiro', 'atRound': 10}]),
   'Portugal': side([bde('Trant', [B_, I, LC], commander='Trant')], "Trant's Brigade unbroken at the end of round 10.",
                    [{'type': 'COMMANDER', 'tag': 'trant', 'atRound': 10}]),
   'France': side([bde('Thomières and Charlot', [B_, I, I, I, ART], commander='Thomières'), bde('Kellermann', [B_, G, G, I], commander='Kellermann'),
                   bde('Margaron', [B_, HC, LC], commander='Margaron')],
                  'Take Vimeiro village at any point, or remove four Allied units, by the end of round 10.',
                  [{'type': 'ENTERED', 'area': 'village', 'byRound': 10}, {'type': 'DESTROY', 'unitTypes': [], 'count': 4}], 'any', 'attack')},
  {'vimeiro': sq(m['vimeiro'], '^#', rows=range(4, 9), cols=range(3, 10)), 'village': sq(m['vimeiro'], '#')},
  needs=['reverse slope'])
battles[-1]['sides']['Portugal']['brigades'][0]['tag'] = 'trant'
# ---------- Somosierra ----------
battle('somosierra', 'Somosierra', '30 November 1808', 'Operation', 8,
  "San Juan's Spaniards held the Somosierra pass with four batteries stacked up the zigzag road in the fog. Napoleon sent the Polish Chevau-légers of the Guard straight up it; in minutes they rode over the batteries one after another, at terrible cost, and the road to Madrid lay open.",
  WIKI + 'Battle_of_Somosierra',
  {'Spain': side([bde('San Juan', [B_, I, I, I, ART, ART], A('pass_lower'), 'San Juan'), bde('the summit', [B_, I, I, ART, ART], A('summit_start'), 'Sardén')],
                 'Hold the summit (the last two road squares) at the end of round 8.',
                 [{'type': 'HOLD_COUNT', 'area': 'summit', 'count': 1, 'atRound': 8}]),
   'Poland': side([bde('Polish Chevau-légers', [B_, LC, LC, LC], E, 'Kozietulski', names=['3rd squadron', '1st squadron', '2nd squadron'])],
                  'Get a cavalry unit onto the summit by the end of round 8.', [{'type': 'ENTERED', 'area': 'summit', 'byRound': 8}], 'any', 'attack'),
   'France': side([bde('Ruffin', [B_, I, I, I, ART], E, 'Ruffin'), bde('Savary', [B_, HC, HC], E, 'Savary')],
                  'Get a unit onto the summit by the end of round 8.', [{'type': 'ENTERED', 'area': 'summit', 'byRound': 8}], 'any', 'attack')},
  {'summit': [[18, 3], [19, 3]], 'summit_start': rect(15, 19, 2, 5), 'pass_lower': rect(6, 13, 2, 6)},
  rules={'night': True}, needs=['fog only until round 3 (now night all battle)', 'cavalry on the road only', 'Guard re-roll for the Poles'])
# ---------- Cacabelos ----------
battle('cacabelos', 'The Death of General Colbert', '3 January 1809', 'Operation', 8,
  "Covering Moore's winter retreat to Corunna, Paget's reserve held the bridge over the Cúa at Cacabelos. General Colbert led the French cavalry across and was shot dead by Rifleman Tom Plunket of the 95th at long range; the attack stalled and the rearguard got away.",
  WIKI + 'Battle_of_Cacabelos',
  {'Britain': side([bde("Paget's reserve", [B_, I, I, LC, ART], A('british_start'), 'Edward Paget', names=['95th Rifles', '28th North Gloucestershire', '15th Hussars', None])],
                   'Have three units leave by the Villafranca road (the Coalition edge) by the end of round 8.',
                   [{'type': 'MARCH_OFF', 'count': 3, 'byRound': 8}], 'any', 'escape'),
   'France': side([bde('Colbert', [B_, LC, LC, LC], E, 'Colbert', tag='colbert'), bde('Merle', [B_, I, I, ART], E, 'Merle')],
                  'Remove two British units by the end of round 8, with Colbert still in play.',
                  [{'type': 'DESTROY', 'unitTypes': [], 'count': 2, 'byRound': 8}, {'type': 'COMMANDER', 'tag': 'colbert', 'atRound': 8}], 'all', 'attack')},
  {'british_start': rect(6, 14, 3, 6)}, exits={'british': 'britishEdge'}, needs=["the marksman (the 95th's long shot at a commander)"])
# ---------- Corunna ----------
battle('corunna', 'Corunna', '16 January 1809', 'Major battle', 10,
  "With the transports waiting in the harbour, Moore turned at Corunna to hold off Soult while the army embarked. Elviña was taken and retaken all afternoon; Moore was mortally wounded there, but the French were held and the army got away by sea that night.",
  WIKI + 'Battle_of_Corunna',
  {'Britain': side([bde('Baird', [B_, I, I, I, ART], commander='Baird', names=['42nd Black Watch', '50th West Kent', '4th King\'s Own', None]),
                    bde('Hope', [B_, I, I, G], commander='Hope', names=[None, None, '1st Foot Guards']),
                    bde("Paget's reserve", [B_, I, I], commander='Edward Paget', names=['95th Rifles', '52nd Oxfordshire'])],
                   'No French unit on the Monte Mero ridge, and none in Elviña, at the end of round 10.',
                   [{'type': 'CLEAR_AREA', 'area': 'monte_mero', 'atRound': 10}, {'type': 'CLEAR_AREA', 'area': 'elvina', 'atRound': 10}], 'all'),
   'France': side([bde('Mermet', [B_, I, I, I, ART], commander='Mermet'), bde('Merle', [B_, I, I, I], commander='Merle'),
                   bde('Lahoussaye and Franceschi', [B_, HC, LC, LC], commander='Franceschi'), bde('the great battery', [B_, ART, ART], commander='Soult')],
                  'Hold Elviña at the end of round 10, or break two British Brigades.',
                  [{'type': 'HOLD_AREA', 'area': 'elvina', 'atRound': 10}, {'type': 'BREAK_BRIGADES', 'count': 2, 'byRound': 10}], 'any', 'attack')},
  {'monte_mero': sq(m['corunna'], '^', rows=[7]), 'elvina': sq(m['corunna'], '#', rows=range(4, 8))},
  needs=['the great battery fires over lower ground', 'embarkation from round 7'])
# ---------- Talavera ----------
battle('talavera', 'Talavera', '27 to 28 July 1809', 'Major battle', 10,
  "Wellesley and Cuesta stood side by side north of Talavera, the Spanish behind walls and olive groves, the British in the plain and on the Cerro de Medellín. Victor attacked the Medellín by night and again by day and failed; the Guards' counter-charge went too far and was nearly cut off, but the line held.",
  WIKI + 'Battle_of_Talavera',
  {'Britain': side([bde('Hill', [B_, I, I, I, ART], A('british_start'), 'Hill', names=['29th Worcestershire', '48th Northamptonshire', '66th Berkshire', None]),
                    bde('Sherbrooke', [B_, G, G, I], A('british_start'), 'Sherbrooke', names=['Coldstream Guards', '3rd Foot Guards', 'King\'s German Legion'])],
                   'No French unit on the Cerro de Medellín at the end of round 10.', [{'type': 'CLEAR_AREA', 'area': 'medellin', 'atRound': 10}]),
   'Spain': side([bde('Cuesta', [B_, I, I, I, ART], A('spanish_start'), 'Cuesta')], 'Hold Talavera and its enclosures at the end of round 10.',
                 [{'type': 'HOLD_COUNT', 'area': 'talavera', 'count': 1, 'atRound': 10}]),
   'France': side([bde('Ruffin', [B_, I, I, I], commander='Ruffin'), bde('Lapisse', [B_, I, I, I, ART], commander='Lapisse'),
                   bde('Latour-Maubourg', [B_, HC, HC, LC], commander='Latour-Maubourg'), bde('Sebastiani', [B_, I, I, I, ART], commander='Sebastiani')],
                  'Get a unit onto the Cerro de Medellín at any point, or break two Allied Brigades, by the end of round 10.',
                  [{'type': 'ENTERED', 'area': 'medellin', 'byRound': 10}, {'type': 'BREAK_BRIGADES', 'count': 2, 'byRound': 10}], 'any', 'attack')},
  {'medellin': sq(m['talavera'], '^', rows=range(5, 10)), 'talavera': sq(m['talavera'], '#'),
   'spanish_start': rect(0, 5, 5, 9), 'british_start': rect(8, 19, 6, 9)},
  needs=['night attack in round 1', "the Guards' over-eager charge"])
# ---------- Ocaña ----------
battle('ocana', 'Ocaña', '19 November 1809', 'Major battle', 10,
  "Areizaga's large Spanish army, marching on Madrid, met Soult and King Joseph on the open plain at Ocaña. The Spanish infantry held the first attacks, but Sébastiani's cavalry swept round the Spanish right and the army broke: the worst Spanish defeat of the war.",
  WIKI + 'Battle_of_Oca%C3%B1a',
  {'Spain': side([bde('Zayas', [B_, I, I, I, ART], commander='Zayas'), bde('Lacy', [B_, I, I, I], commander='Lacy'), bde('Freire', [B_, LC, LC], commander='Freire')],
                 'At least two Brigades unbroken at the end of round 10 (the army gets away).', [{'type': 'BRIGADES_UNBROKEN', 'count': 2, 'atRound': 10}]),
   'France': side([bde('Leval and Girard', [B_, I, I, I, ART], commander='Girard'), bde("Mortier's reserve", [B_, I, I, G], commander='Mortier'),
                   bde('Sébastiani and Milhaud', [B_, HC, HC, LC], commander='Sébastiani')],
                  'Break two Spanish Brigades by the end of round 10.', [{'type': 'BREAK_BRIGADES', 'count': 2, 'byRound': 10}], 'any', 'attack')},
  {})
# ---------- The Côa ----------
battle('coa', 'The Côa', '24 July 1810', 'Operation', 8,
  "Craufurd kept the Light Division too long on the wrong bank of the Côa below Almeida, and Ney fell on it with his whole corps. The division fought its way back through the vineyards to the single bridge in the gorge and held it; three French attempts to storm the bridge were shot down.",
  WIKI + 'Battle_of_the_C%C3%B4a',
  {'Britain': side([bde('Beckwith', [B_, I, I, ART], A('allied_start'), 'Beckwith', names=['95th Rifles', '43rd Monmouthshire', None]),
                    bde('Barclay', [B_, I, I], A('allied_start'), 'Barclay', names=['52nd Oxfordshire', '1st Battalion, 95th'])],
                   'Four units across the Côa, and no French unit on the far end of the bridge, at the end of round 8.',
                   [{'type': 'IN_AREA', 'area': 'far_bank', 'count': 4, 'atRound': 8}, {'type': 'CLEAR_AREA', 'area': 'bridge_far', 'atRound': 8}], 'all'),
   'Portugal': side([bde('the Caçadores', [B_, I, I], A('allied_start'), 'Elder', tag='cacadores', names=['1st Caçadores', '3rd Caçadores'])],
                    'Both Caçador battalions across the Côa at the end of round 8.', [{'type': 'IN_AREA', 'area': 'far_bank', 'tag': 'cacadores', 'count': 2, 'atRound': 8}]),
   'France': side([bde('Loison', [B_, I, I, I, ART], E, 'Loison'), bde("Ney's cavalry", [B_, HC, LC, LC], E, 'Lamotte')],
                  'Remove three Allied units, or get a unit over the bridge, by the end of round 8.',
                  [{'type': 'DESTROY', 'unitTypes': [], 'count': 3, 'byRound': 8}, {'type': 'ENTERED', 'area': 'far_bank', 'byRound': 8}], 'any', 'attack')},
  {'far_bank': rect(13, 19, 0, 9), 'bridge_far': [[13, 4]], 'allied_start': rect(6, 11, 0, 9)})
# ---------- Bussaco ----------
battle('bussaco', 'Bussaco', '27 September 1810', 'Major battle', 10,
  "Masséna sent Reynier and Ney straight up the long, steep ridge of Bussaco in the morning mist. Reynier's columns reached the crest and were driven off; Ney's attack climbed into the Light Division, which rose from behind the crest and fired at a few paces. The Portuguese held as well as the British.",
  WIKI + 'Battle_of_Bu%C3%A7aco',
  {'Britain': side([bde('Picton', [B_, I, I, I, ART], A('ridge'), 'Picton', names=['88th Connaught Rangers', '45th Nottinghamshire', '74th Highland', None]),
                    bde('Craufurd', [B_, I, I, I], A('ridge'), 'Craufurd', names=['43rd Monmouthshire', '52nd Oxfordshire', '95th Rifles'])],
                   'No French unit on the crest of the ridge at the end of round 10.', [{'type': 'CLEAR_AREA', 'area': 'crest', 'atRound': 10}]),
   'Portugal': side([bde('Pack', [B_, I, I, I, ART], A('ridge'), 'Pack', tag='pack')], 'Two Portuguese units still on the ridge at the end of round 10.',
                    [{'type': 'IN_AREA', 'area': 'ridge', 'tag': 'pack', 'count': 2, 'atRound': 10}]),
   'France': side([bde('Reynier', [B_, I, I, I, ART], commander='Reynier'), bde('Ney', [B_, I, I, I, I], commander='Ney'), bde('Montbrun', [B_, HC, LC], commander='Montbrun')],
                  'Get a unit onto the crest at any point, or remove four Allied units, by the end of round 10.',
                  [{'type': 'ENTERED', 'area': 'crest', 'byRound': 10}, {'type': 'DESTROY', 'unitTypes': [], 'count': 4}], 'any', 'attack')},
  {'crest': sq(m['bussaco'], '^*#', rows=[6]), 'ridge': sq(m['bussaco'], '^*#', rows=range(6, 10)) + rect(0, 19, 9, 9)},
  needs=['morning mist (rounds 1 and 2)', 'reverse slope', 'steep ridge'])
# ---------- Sabugal ----------
battle('sabugal', 'Sabugal', '3 April 1811', 'Operation', 8,
  "Wellington planned to trap Reynier at Sabugal, but fog and rain threw his columns out. Beckwith's brigade crossed alone and met Reynier's whole corps on a hill; it held off attack after attack, cavalry too, until the rest of the army came up out of the fog.",
  WIKI + 'Battle_of_Sabugal',
  {'Britain': side([bde('Beckwith', [B_, I, I, ART], A('beckwith_start'), 'Beckwith', tag='beckwith', names=['43rd Monmouthshire', '95th Rifles', None]),
                    bde('Picton', [B_, I, I, I], E, 'Picton', arrives={'round': 5})],
                   "Beckwith's Brigade on the hill (a unit on any square of it) at the end of round 8.",
                   [{'type': 'IN_AREA', 'area': 'hill', 'tag': 'beckwith', 'count': 1, 'atRound': 8}]),
   'Portugal': side([bde('the Caçadores', [B_, I, I], A('beckwith_start'), 'Elder', tag='cacadores_s')], 'Their Brigadier still in play at the end of round 8.',
                    [{'type': 'COMMANDER', 'tag': 'cacadores_s', 'atRound': 8}]),
   'France': side([bde('Merle', [B_, I, I, I, ART], commander='Merle'), bde('Heudelet', [B_, I, I, I], commander='Heudelet'), bde("Soult's dragoons", [B_, HC, LC], commander='Pierre Soult')],
                  "Break a Brigade, or clear the hill of Allied units, by the end of round 8.",
                  [{'type': 'BREAK_BRIGADES', 'count': 1, 'byRound': 8}, {'type': 'CLEAR_AREA', 'area': 'hill', 'atRound': 8}], 'any', 'attack')},
  {'hill': sq(m['sabugal'], '^'), 'beckwith_start': rect(5, 15, 5, 6)},
  rules={}, needs=['fog until round 4', 'rain (volleys need 5 or 6) from round 6'])
# ---------- Albuera ----------
battle('albuera', 'Albuera', '16 May 1811', 'Major battle', 10,
  "Soult swung round Beresford's right through the woods onto the hill held by Zayas's Spaniards, who stood. Colborne's brigade was caught in line in a hailstorm by the Vistula Lancers and destroyed; then the Fusilier Brigade went up the hill and fought it out with the French columns until they broke.",
  WIKI + 'Battle_of_Albuera',
  {'Britain': side([bde('Colborne', [B_, I, I, I], commander='Colborne', names=['3rd Buffs', '48th Northamptonshire', '66th Berkshire']),
                    bde('Myers', [B_, I, I, G], commander='Myers', names=['7th Royal Fusiliers', '23rd Royal Welch Fusiliers', '57th West Middlesex'])],
                   'No French unit on the southern hills at the end of round 10.', [{'type': 'CLEAR_AREA', 'area': 'south_hill', 'atRound': 10}]),
   'Spain': side([bde('Zayas', [B_, I, I, I, ART], commander='Zayas', tag='zayas')], "Zayas still in play, with his Brigade, at the end of round 10.",
                 [{'type': 'COMMANDER', 'tag': 'zayas', 'atRound': 10}]),
   'Portugal': side([bde('Harvey', [B_, I, I, ART], commander='Harvey')], 'Hold Albuera village at the end of round 10.',
                    [{'type': 'HOLD_COUNT', 'area': 'albuera', 'count': 1, 'atRound': 10}]),
   'France': side([bde('Girard and Gazan', [B_, I, I, I, I, ART], commander='Girard'), bde('Werlé', [B_, I, I, I], commander='Werlé'),
                   bde('Latour-Maubourg', [B_, HC, HC, LC], commander='Latour-Maubourg', names=[None, None, 'Vistula Lancers'])],
                  'Break two Allied Brigades, or have a unit on the southern hills at the end of round 10.',
                  [{'type': 'BREAK_BRIGADES', 'count': 2, 'byRound': 10}, {'type': 'IN_AREA', 'area': 'south_hill', 'count': 1, 'atRound': 10}], 'any', 'attack')},
  {'south_hill': sq(m['albuera'], '^'), 'albuera': sq(m['albuera'], '#')},
  needs=['hailstorm in round 4', "'die hard' re-roll for the 57th"])
# ---------- El Bodón ----------
battle('elbodon', 'El Bodón', '25 September 1811', 'Operation', 10,
  "Montbrun's cavalry caught Colville's brigade on the heights at El Bodón. The 5th Foot charged the cavalry and took back the guns; then the 5th and 77th, with the 21st Portuguese, formed squares and marched six miles back to Fuenteguinaldo with the French horse riding round them, and were never broken.",
  WIKI + 'Battle_of_El_Bod%C3%B3n',
  {'Britain': side([bde('Colville', [B_, I, I, ART], A('allied_start'), 'Colville', names=['5th Northumberland', '77th East Middlesex', None]),
                    bde('Alten', [B_, LC, LC], A('allied_start'), 'Victor Alten', names=['11th Light Dragoons', '1st KGL Hussars'])],
                   'Three units leave by the Fuenteguinaldo end by the end of round 10.', [{'type': 'MARCH_OFF', 'count': 3, 'byRound': 10}], 'any', 'escape'),
   'Portugal': side([bde('the 21st Line', [B_, I, ART], A('allied_start'), 'Harvey', tag='p21', names=['21st Line', None])],
                    'The 21st Line leaves by the Fuenteguinaldo end by the end of round 10.', [{'type': 'MARCH_OFF', 'count': 1, 'mustIncludeTag': 'p21', 'byRound': 10}], 'any', 'escape'),
   'France': side([bde('Montbrun', [B_, HC, HC, LC, LC], E, 'Montbrun'), bde('Wathier', [B_, HC, LC, LC], E, 'Wathier')],
                  'Remove three Allied units by the end of round 10.', [{'type': 'DESTROY', 'unitTypes': [], 'count': 3, 'byRound': 10}], 'any', 'attack')},
  {'allied_start': rect(4, 7, 0, 9)}, exits={'british': 'britishEdge'}, needs=['squares on the march'])
# ---------- Arroyo dos Molinos ----------
battle('arroyo', 'Arroyo dos Molinos', '28 October 1811', 'Operation', 8,
  "Hill marched through the night and rain and fell on Girard's division at dawn as it formed up to leave Arroyo dos Molinos. The 71st and 92nd came into the village with the pipes playing \"Hey, Johnnie Cope\"; Girard's men fled up the Sierra behind it, and most of the division was killed or taken.",
  WIKI + 'Battle_of_Arroyo_dos_Molinos',
  {'Britain': side([bde('Howard', [B_, I, I, G], commander='Howard', names=['50th West Kent', '71st Highland', '92nd Gordon Highlanders']),
                    bde('Long', [B_, LC, LC], commander='Long', names=['9th Light Dragoons', '13th Light Dragoons'])],
                   'Two squares of the village held, and four French units removed, by the end of round 8.',
                   [{'type': 'HOLD_COUNT', 'area': 'village', 'count': 2, 'atRound': 8}, {'type': 'DESTROY', 'unitTypes': [], 'count': 4}], 'all', 'attack'),
   'Portugal': side([bde('Ashworth', [B_, I, I], commander='Ashworth')], 'Hold the Mérida road at the end of round 8.', [{'type': 'HOLD_AREA', 'area': 'merida', 'atRound': 8}]),
   'Spain': side([bde('Morillo', [B_, I, LC], commander='Morillo', tag='morillo')], 'Morillo still in play at the end of round 8.', [{'type': 'COMMANDER', 'tag': 'morillo', 'atRound': 8}]),
   'France': side([bde('Girard', [B_, I, I, I, ART], A('french_start'), 'Girard'), bde('Bron', [B_, LC, LC], A('french_start'), 'Bron')],
                  'Four units leave over the Sierra (the French edge) by the end of round 8.', [{'type': 'MARCH_OFF', 'count': 4, 'byRound': 8}], 'any', 'escape')},
  {'village': sq(m['arroyo'], '#'), 'merida': [[19, 3]], 'french_start': rect(6, 14, 2, 4)},
  exits={'french': 'frenchEdge'}, first='british', needs=['surprise (no French fire in round 1)', 'rain until round 3', 'only infantry climb the Sierra'])
# ---------- Salamanca ----------
battle('salamanca', 'Salamanca', '22 July 1812', 'Major battle', 10,
  "Marmont, racing to cut Wellington off from Portugal, let his left wing stretch out along the heights south of Salamanca. Wellington struck: Pakenham hit the head of the column, Le Marchant's heavy dragoons rode down Maucune's infantry, and though Pack's Portuguese were thrown back from the Greater Arapile, they pinned its defenders. Forty thousand men were beaten in forty minutes.",
  WIKI + 'Battle_of_Salamanca',
  {'Britain': side([bde('Pakenham', [B_, I, I, I, ART], commander='Pakenham', names=['45th Nottinghamshire', '74th Highland', '88th Connaught Rangers', None]),
                    bde('Leith', [B_, I, I, I], commander='Leith', names=['1st Royal Scots', '4th King\'s Own', '44th East Essex']),
                    bde('Le Marchant', [B_, HC, HC], commander='Le Marchant', names=['3rd Dragoons', '5th Dragoon Guards'])],
                   'Break two French Brigades by the end of round 10.', [{'type': 'BREAK_BRIGADES', 'count': 2, 'byRound': 10}], 'any', 'attack'),
   'Portugal': side([bde('Pack', [B_, I, I, I], commander='Pack', tag='pack_s')], "A unit next to the Greater Arapile at the end of any round, and Pack in play at the end of round 10.",
                    [{'type': 'IN_AREA', 'area': 'arapile_ring', 'count': 1}, {'type': 'COMMANDER', 'tag': 'pack_s', 'atRound': 10}], 'all', 'attack'),
   'France': side([bde('Thomières', [B_, I, I, I, ART], commander='Thomières'), bde('Maucune', [B_, I, I, I], commander='Maucune'),
                   bde('Clausel', [B_, I, I, I, ART], commander='Clausel'), bde('Boyer', [B_, HC, LC], commander='Boyer')],
                  'Two Brigades unbroken, and the Greater Arapile still French, at the end of round 10.',
                  [{'type': 'BRIGADES_UNBROKEN', 'count': 2, 'atRound': 10}, {'type': 'CONTROL_AREA', 'area': 'greater', 'atRound': 10}], 'all')},
  {'greater': [[11, 4], [12, 4], [11, 5], [12, 5]], 'arapile_ring': [[10, 3], [11, 3], [12, 3], [13, 3], [10, 4], [13, 4], [10, 5], [13, 5], [10, 6], [11, 6], [12, 6], [13, 6]]},
  needs=["Le Marchant's charge (+1 against infantry not in square from round 4)"])
# ---------- García Hernández ----------
battle('garcia-hernandez', 'García Hernández', '23 July 1812', 'Operation', 6,
  "The day after Salamanca, Bock's heavy dragoons of the King's German Legion caught Foy's rearguard on a slope near García Hernández. A dying French horse fell into the front of a square, the dragoons rode through the gap and broke it, then broke a second: one of the few times cavalry broke formed infantry.",
  WIKI + 'Battle_of_Garc%C3%ADa_Hern%C3%A1ndez',
  {'Britain': side([bde('Bock', [B_, HC, HC, HC], commander='Bock', names=['1st KGL Dragoons', '2nd KGL Dragoons', '1st KGL Dragoons, 2nd squadrons']),
                    bde('Anson', [B_, LC, LC], commander='Anson', names=['11th Light Dragoons', '16th Light Dragoons'])],
                   'Break two French infantry units by the end of round 6.', [{'type': 'DESTROY', 'unitTypes': ['INFANTRY'], 'count': 2, 'byRound': 6}], 'any', 'attack'),
   'France': side([bde("Foy's rearguard", [B_, I, I, I, ART], A('foy_start'), 'Foy', names=['6e Léger', '69e Ligne', '76e Ligne', None]),
                   bde('Curto', [B_, LC, LC], A('foy_start'), 'Curto')],
                  'Three units leave by the French end by the end of round 6.', [{'type': 'MARCH_OFF', 'count': 3, 'byRound': 6}], 'any', 'escape')},
  {'foy_start': rect(2, 7, 0, 9)}, exits={'french': 'frenchEdge'}, needs=['the dead horse (one re-roll against a square)'])
# ---------- Vitoria ----------
battle('vitoria', 'Vitoria', '21 June 1813', 'Major battle', 12,
  "King Joseph's army stood in the Zadorra valley west of Vitoria, with its baggage and the loot of five years jammed on the roads behind it. Wellington attacked from four directions over the Zadorra bridges and round the north; the French army broke and fled, leaving everything behind.",
  WIKI + 'Battle_of_Vitoria',
  {'Britain': side([bde('the Light Division', [B_, I, I, I], commander='Kempt', names=['43rd Monmouthshire', '52nd Oxfordshire', '95th Rifles']),
                    bde('Picton', [B_, I, I, I, ART], commander='Picton', names=['88th Connaught Rangers', '45th Nottinghamshire', '74th Highland', None]),
                    bde('Graham', [B_, I, I, LC], commander='Graham', arrives={'round': 5, 'area': 'graham'})],
                   'Take the knoll of Arinez at any point, and break two French Brigades, by the end of round 12.',
                   [{'type': 'ENTERED', 'area': 'arinez', 'byRound': 12}, {'type': 'BREAK_BRIGADES', 'count': 2, 'byRound': 12}], 'all', 'attack'),
   'Spain': side([bde('Morillo', [B_, I, I, I], A('puebla'), 'Morillo')], 'Hold a square of the Puebla heights at the end of round 12.',
                 [{'type': 'HOLD_COUNT', 'area': 'puebla', 'count': 1, 'atRound': 12}]),
   'Portugal': side([bde('Ashworth', [B_, I, I, ART], commander='Ashworth', tag='ashworth')], 'Three units across the Zadorra by the end of round 12.',
                    [{'type': 'IN_AREA', 'area': 'north_bank', 'tag': 'ashworth', 'count': 3, 'atRound': 12}], 'any', 'attack'),
   'France': side([bde('Gazan', [B_, I, I, I, ART], commander='Gazan'), bde("D'Erlon", [B_, I, I, I, ART], commander="d'Erlon"),
                   bde('Reille', [B_, I, I, HC], commander='Reille'), bde('Villatte', [B_, I, I, G], commander='Villatte')],
                  'Six units leave by the road to France (the French edge) by the end of round 12.', [{'type': 'MARCH_OFF', 'count': 6, 'byRound': 12}], 'any', 'escape')},
  {'arinez': [[9, 3], [10, 3]], 'puebla': sq(m['vitoria'], '^', cols=range(0, 2)), 'north_bank': rect(0, 19, 0, 3),
   'graham': [[19, 2], [19, 3], [18, 2]]},
  exits={'french': 'frenchEdge'}, needs=['the baggage (stops Allied units for a round)'])
# ---------- Toulouse ----------
battle('toulouse', 'Toulouse', '10 April 1814', 'Major battle', 12,
  "Soult held Toulouse behind the Garonne and the canal, with his strongest works on the Calvinet ridge. Freire's Spaniards attacked its northern end and were thrown back; Beresford marched along the marshy valley under fire and stormed the southern end. Napoleon had already abdicated: the news had not reached either army.",
  WIKI + 'Battle_of_Toulouse_(1814)',
  {'Britain': side([bde('Beresford', [B_, I, I, I, I, ART], commander='Beresford'), bde("Picton's feint", [B_, I, I], commander='Picton')],
                   'Hold two of the southern redoubts at the end of round 12.', [{'type': 'HOLD_COUNT', 'area': 'south_redoubts', 'count': 2, 'atRound': 12}], 'any', 'attack'),
   'Spain': side([bde('Freire', [B_, I, I, I, ART], commander='Freire', tag='freire')], "A unit next to the northern redoubts at the end of any round, and Freire still in play at the end of round 12.",
                 [{'type': 'IN_AREA', 'area': 'near_north', 'count': 1}, {'type': 'COMMANDER', 'tag': 'freire', 'atRound': 12}], 'all', 'attack'),
   'France': side([bde('Harispe and Villatte', [B_, I, I, I, ART, ART], A('french_start'), 'Harispe'), bde('Darmagnac and Taupin', [B_, I, I, I], A('french_start'), 'Taupin'),
                   bde("Soult's reserve", [B_, I, LC], A('french_start'), 'Soult')],
                  'Hold the northern redoubt, and have two Brigades unbroken, at the end of round 12.',
                  [{'type': 'HOLD_AREA', 'area': 'north_redoubt', 'atRound': 12}, {'type': 'BRIGADES_UNBROKEN', 'count': 2, 'atRound': 12}], 'all')},
  {'north_redoubt': [[8, 3]], 'south_redoubts': [[11, 3], [14, 3]], 'near_north': [[7, 2], [8, 2], [9, 2], [7, 3], [9, 3], [7, 4], [8, 4], [9, 4]],
   'french_start': rect(2, 16, 2, 4)},
  needs=['redoubts give +1', 'the Ers marsh (one square a move)'])

ROUTES = {
  'Britain': ['vimeiro', ['cacabelos', 'corunna'], 'bussaco', ['sabugal', 'elbodon', 'arroyo'], 'salamanca', 'garcia-hernandez', 'vitoria', 'toulouse'],
  'Portugal': ['vimeiro', 'coa', 'bussaco', ['sabugal', 'albuera'], ['elbodon', 'arroyo'], 'salamanca', 'vitoria'],
  'Spain': ['bailen', 'somosierra', ['talavera', 'ocana'], ['albuera', 'arroyo'], 'vitoria', 'toulouse'],
  'France': ['vimeiro', 'somosierra', ['cacabelos', 'corunna'], 'coa', 'bussaco', ['albuera', 'elbodon'], 'salamanca', 'vitoria'],
}
# ---- special rules built so far (engine-rules storyRule), and what each battle still waits for ----
RULES = {
  'bailen': ({'slow': [{'side': 'blue', 'fromRound': 6}], 'turncoat': {'round': 7, 'unit': 'Swiss battalion (Reding)', 'joinTag': 'reding'}}, []),
  'vimeiro': ({'reverseSlope': {'side': 'red'}}, []),
  'somosierra': ({'night': {'untilRound': 3}}, ['cavalry on the road only', 'Guard re-roll for the Poles']),
  'cacabelos': ({}, ["the marksman (the 95th's long shot at a commander)"]),
  'corunna': ({}, ['the great battery fires over lower ground', 'embarkation from round 7']),
  'talavera': ({'night': {'round': 1}}, ["the Guards' over-eager charge"]),
  'ocana': ({}, []),
  'coa': ({}, []),
  'bussaco': ({'night': {'untilRound': 2}, 'reverseSlope': {'side': 'red'}, 'slow': [{'area': 'ridge_hills', 'max': 1}]}, []),
  'sabugal': ({'night': {'untilRound': 4}}, ['rain (volleys) from round 6']),
  'albuera': ({'night': {'round': 4}, 'chargeBonus': [{'type': 'LIGHT_CAV', 'round': 4, 'label': 'Charging out of the hail'}, {'type': 'HEAVY_CAV', 'round': 4, 'label': 'Charging out of the hail'}]}, ["'die hard' re-roll for the 57th"]),
  'elbodon': ({}, ['squares on the march']),
  'arroyo': ({'noFire': {'side': 'blue', 'untilRound': 1}}, ['rain until round 3', 'only infantry climb the Sierra']),
  'salamanca': ({'chargeBonus': [{'type': 'HEAVY_CAV', 'side': 'red', 'fromRound': 4, 'vsNotSquare': True, 'label': "Le Marchant's charge"}]}, []),
  'garcia-hernandez': ({}, ['the dead horse (one re-roll against a square)']),
  'vitoria': ({}, ['the baggage (stops Allied units for a round)']),
  'toulouse': ({'works': {'area': 'redoubts'}, 'slow': [{'area': 'ers', 'max': 1}]}, []),
}
for b in battles:
    r, n = RULES[b['id']]; b['rules'] = r; b['needs'] = n
B = {b['id']: b for b in battles}
B['bailen']['sides']['Spain']['brigades'][0]['tag'] = 'reding'
B['bussaco']['map']['areas']['ridge_hills'] = sq(m['bussaco'], '^', rows=range(6, 9))
B['toulouse']['map']['areas']['redoubts'] = [[8, 3], [11, 3], [14, 3]]
B['toulouse']['map']['areas']['ers'] = sq(m['toulouse'], ':', cols=range(16, 20))

# ---- BALANCE, pass 1 (simulator, 4 matches each, Coalition lead / France) ----
def obj(bid, nation, conds, text, comb=None):
    o = B[bid]['sides'][nation]['objective']; o['conditions'] = conds; o['text'] = text
    if comb: o['combinator'] = comb
# Bailen 25/25: either Bailen or the ridge is enough for Spain
obj('bailen', 'Spain', [{'type': 'HOLD_COUNT', 'area': 'bailen', 'count': 1, 'atRound': 10}, {'type': 'HOLD_COUNT', 'area': 'ridge', 'count': 1, 'atRound': 10}],
    'Hold Bailén, or a square of the ridge across the road, at the end of round 10.', 'any')
# Vimeiro 0/100: the village is what the British must keep; France needs the village and three kills
obj('vimeiro', 'Britain', [{'type': 'CLEAR_AREA', 'area': 'village', 'atRound': 10}], 'No French unit in Vimeiro village at the end of round 10.')
obj('vimeiro', 'France', [{'type': 'ENTERED', 'area': 'village', 'byRound': 10}, {'type': 'DESTROY', 'unitTypes': [], 'count': 3}],
    'Get into Vimeiro village and remove three Allied units by the end of round 10.', 'all')
# Somosierra 100/0: the summit is the last four squares of the road; ten rounds; a fourth squadron of Poles
B['somosierra']['map']['areas']['summit'] = [[16, 3], [17, 3], [18, 3], [19, 3]]
B['somosierra']['turnLimit'] = 10
for n in ('Spain', 'Poland', 'France'):
    for c in B['somosierra']['sides'][n]['objective']['conditions']:
        for k in ('atRound', 'byRound'):
            if c.get(k) == 8: c[k] = 10
    B['somosierra']['sides'][n]['objective']['text'] = B['somosierra']['sides'][n]['objective']['text'].replace('round 8', 'round 10').replace('the last two road squares', 'the last four road squares')
pol = B['somosierra']['sides']['Poland']['brigades'][0]; pol['units'] = pol['units'] + [LC]; pol['names'] = pol['names'] + ['4th squadron']
# Cacabelos 0/100: two units away is enough; France needs three kills
obj('cacabelos', 'Britain', [{'type': 'MARCH_OFF', 'count': 2, 'byRound': 8}], 'Have two units leave by the Villafranca road by the end of round 8.')
obj('cacabelos', 'France', [{'type': 'DESTROY', 'unitTypes': [], 'count': 3, 'byRound': 8}, {'type': 'COMMANDER', 'tag': 'colbert', 'atRound': 8}],
    'Remove three British units by the end of round 8, with Colbert still in play.', 'all')
# Talavera 100/0 and Albuera 100/0 and Ocana 100/0: France breaks one Brigade (or reaches its place)
obj('talavera', 'France', [{'type': 'ENTERED', 'area': 'medellin', 'byRound': 10}, {'type': 'BREAK_BRIGADES', 'count': 1, 'byRound': 10}],
    'Get a unit onto the Cerro de Medellín at any point, or break one Allied Brigade, by the end of round 10.')
obj('albuera', 'France', [{'type': 'BREAK_BRIGADES', 'count': 1, 'byRound': 10}, {'type': 'IN_AREA', 'area': 'south_hill', 'count': 1, 'atRound': 10}],
    'Break one Allied Brigade, or have a unit on the southern hills at the end of round 10.')
obj('ocana', 'France', [{'type': 'BREAK_BRIGADES', 'count': 1, 'byRound': 10}], 'Break one Spanish Brigade by the end of round 10.')
# The Coa 0/0: three across for Britain, one for Portugal; France two kills or across
obj('coa', 'Britain', [{'type': 'IN_AREA', 'area': 'far_bank', 'count': 3, 'atRound': 8}, {'type': 'CLEAR_AREA', 'area': 'bridge_far', 'atRound': 8}],
    'Three units across the Côa, and no French unit on the far end of the bridge, at the end of round 8.', 'all')
obj('coa', 'Portugal', [{'type': 'IN_AREA', 'area': 'far_bank', 'tag': 'cacadores', 'count': 1, 'atRound': 8}], 'A Caçador battalion across the Côa at the end of round 8.')
obj('coa', 'France', [{'type': 'DESTROY', 'unitTypes': [], 'count': 2, 'byRound': 8}, {'type': 'ENTERED', 'area': 'far_bank', 'byRound': 8}],
    'Remove two Allied units, or get a unit over the bridge, by the end of round 8.')
# Sabugal 0/100: France must break two Brigades
obj('sabugal', 'France', [{'type': 'BREAK_BRIGADES', 'count': 2, 'byRound': 8}, {'type': 'CLEAR_AREA', 'area': 'hill', 'atRound': 8}],
    'Break two Allied Brigades, or clear the hill of Allied units, by the end of round 8.')
# El Bodon 25/100: two away for Britain; France four kills
obj('elbodon', 'Britain', [{'type': 'MARCH_OFF', 'count': 2, 'byRound': 10}], 'Two units leave by the Fuenteguinaldo end by the end of round 10.')
obj('elbodon', 'France', [{'type': 'DESTROY', 'unitTypes': [], 'count': 4, 'byRound': 10}], 'Remove four Allied units by the end of round 10.')
# Arroyo 50/0: three French units away is enough
obj('arroyo', 'France', [{'type': 'MARCH_OFF', 'count': 3, 'byRound': 8}], 'Three units leave over the Sierra (the French edge) by the end of round 8.')
# Salamanca 0/75: break one French Brigade, and remove four units
obj('salamanca', 'Britain', [{'type': 'BREAK_BRIGADES', 'count': 1, 'byRound': 10}, {'type': 'DESTROY', 'unitTypes': [], 'count': 4}],
    'Break one French Brigade and remove four French units by the end of round 10.', 'all')
# Garcia Hernandez 0/50: eight rounds
B['garcia-hernandez']['turnLimit'] = 8
obj('garcia-hernandez', 'Britain', [{'type': 'DESTROY', 'unitTypes': ['INFANTRY'], 'count': 2, 'byRound': 8}], 'Break two French infantry units by the end of round 8.')
obj('garcia-hernandez', 'France', [{'type': 'MARCH_OFF', 'count': 3, 'byRound': 8}], 'Three units leave by the French end by the end of round 8.')
# Vitoria 50/100: France must get eight units away; Portugal two across
obj('vitoria', 'France', [{'type': 'MARCH_OFF', 'count': 8, 'byRound': 12}], 'Eight units leave by the road to France (the French edge) by the end of round 12.')
obj('vitoria', 'Portugal', [{'type': 'IN_AREA', 'area': 'north_bank', 'tag': 'ashworth', 'count': 2, 'atRound': 12}], 'Two units across the Zadorra at the end of round 12.')
# Toulouse 25/75: one southern redoubt is enough
obj('toulouse', 'Britain', [{'type': 'HOLD_COUNT', 'area': 'south_redoubts', 'count': 1, 'atRound': 12}], 'Hold a southern redoubt at the end of round 12.')

# ---- BALANCE, pass 2 ----
# Talavera, Albuera: France reached the water and stopped (one fight in ten
# rounds). Its objective becomes what it did on the day: get across in force.
B['talavera']['map']['areas']['south_bank'] = [[x, y] for y in range(10) for x in range(20) if (y >= 5 if 6 <= x <= 12 else y >= 4)]
obj('talavera', 'France', [{'type': 'ENTERED', 'area': 'medellin', 'byRound': 10}, {'type': 'IN_AREA', 'area': 'south_bank', 'count': 4, 'atRound': 10}],
    'Get a unit onto the Cerro de Medellín at any point, or have four units across the Portiña at the end of round 10.')
B['albuera']['map']['areas']['south_bank'] = [[x, y] for y in range(6, 10) for x in range(20)]
obj('albuera', 'France', [{'type': 'BREAK_BRIGADES', 'count': 1, 'byRound': 10}, {'type': 'IN_AREA', 'area': 'south_bank', 'count': 3, 'atRound': 10}],
    'Break one Allied Brigade, or have three units across the Albuera stream at the end of round 10.')

# Somosierra 100/0: the Spanish infantry packed the pass; on the day the guns were the obstacle
sj = B['somosierra']['sides']['Spain']['brigades']
sj[0]['units'] = [B_, I, I, ART, ART]; sj[1]['units'] = [B_, I, ART, ART]

out = {'$comment': "The Peninsula campaign's battles (Grognards Campaign Design doc, Peninsula battle sheets; maps in tools/maps/peninsula/maps.py). Built by tools/maps/peninsula/build.py.",
       'schemaVersion': 1, 'campaign': 'peninsula', 'name': 'The Peninsula', 'years': '1808 to 1814',
       'intro': "1808. Napoleon has put his brother on the throne of Spain, and Spain has risen. Britain sends an army to Portugal. Six years of war across the Peninsula follow, from Bailén to the walls of Toulouse.",
       'battles': battles, 'routes': ROUTES}
json.dump(out, open(os.path.join(here, '..', '..', '..', 'data', 'story', 'peninsula.json'), 'w'), ensure_ascii=False, indent=1)
print('built', len(battles), 'battles')
