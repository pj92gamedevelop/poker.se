// simcore.js — single-file worker core (no external deps)
// Contains:
// - deck + parsing
// - fast-ish 7-card evaluator (by 5-card enumeration)
// - range sampler (top X% approximation)
// - villain response model (exploit blend)
// - EV estimation for Call / Raise sizes (Fold = 0)

const RANKS = "23456789TJQKA";
const SUITS = "cdhs";
const RANK_VAL = Object.fromEntries([...RANKS].map((r,i)=>[r,i+2]));

// ---------- Card helpers ----------
function parseCard(cs){
  // "As" -> {r:14,s:"s", id:...}
  const r = cs[0], s = cs[1];
  return { r: RANK_VAL[r], s, str: cs };
}
function cardId(c){
  // 52 unique ids
  const rIndex = RANKS.indexOf(c.str[0]);
  const sIndex = SUITS.indexOf(c.str[1]);
  return rIndex*4 + sIndex;
}
function buildDeck(excludeSet){
  const deck = [];
  for (const r of RANKS){
    for (const s of SUITS){
      const str = r + s;
      if (excludeSet.has(str)) continue;
      deck.push(parseCard(str));
    }
  }
  return deck;
}
function pickRandom(deck){
  const i = (Math.random() * deck.length) | 0;
  return deck.splice(i,1)[0];
}

// ---------- 5-card evaluator ----------
/*
Hand rank encoding: higher is better
category order:
8 straight flush
7 four
6 full house
5 flush
4 straight
3 trips
2 two pair
1 pair
0 high
We return {cat, kickers[]} and map to a single number for compare.
*/
function eval5(cards){
  // cards: array of 5 {r,s}
  const ranks = cards.map(c=>c.r).sort((a,b)=>b-a);
  const suits = cards.map(c=>c.s);

  const isFlush = suits.every(s=>s===suits[0]);

  // Count ranks
  const freq = new Map();
  for (const r of ranks) freq.set(r, (freq.get(r)||0)+1);

  // sort by (count desc, rank desc)
  const groups = [...freq.entries()]
    .map(([r,c])=>({r,c}))
    .sort((a,b)=> (b.c-a.c) || (b.r-a.r));

  // Straight check (handle wheel A-5)
  let uniq = [...new Set(ranks)].sort((a,b)=>b-a);
  let isStraight = false;
  let topStraight = 0;

  if (uniq.length === 5){
    // normal
    if (uniq[0]-uniq[4] === 4){
      isStraight = true;
      topStraight = uniq[0];
    } else {
      // wheel A5432 => ranks [14,5,4,3,2]
      const wheel = [14,5,4,3,2];
      if (wheel.every(x=>uniq.includes(x))){
        isStraight = true;
        topStraight = 5;
      }
    }
  }

  // Straight flush
  if (isFlush && isStraight){
    return packRank(8, [topStraight]);
  }

  // Four
  if (groups[0].c === 4){
    const four = groups[0].r;
    const kicker = groups[1].r;
    return packRank(7, [four, kicker]);
  }

  // Full house
  if (groups[0].c === 3 && groups[1].c === 2){
    return packRank(6, [groups[0].r, groups[1].r]);
  }

  // Flush
  if (isFlush){
    return packRank(5, ranks);
  }

  // Straight
  if (isStraight){
    return packRank(4, [topStraight]);
  }

  // Trips
  if (groups[0].c === 3){
    const trip = groups[0].r;
    const kickers = groups.slice(1).map(g=>g.r).sort((a,b)=>b-a);
    return packRank(3, [trip, ...kickers]);
  }

  // Two pair
  if (groups[0].c === 2 && groups[1].c === 2){
    const hi = Math.max(groups[0].r, groups[1].r);
    const lo = Math.min(groups[0].r, groups[1].r);
    const kicker = groups[2].r;
    return packRank(2, [hi, lo, kicker]);
  }

  // Pair
  if (groups[0].c === 2){
    const pair = groups[0].r;
    const kickers = groups.slice(1).map(g=>g.r).sort((a,b)=>b-a);
    return packRank(1, [pair, ...kickers]);
  }

  // High card
  return packRank(0, ranks);
}

function packRank(cat, kickers){
  // convert to a single integer for fast compare
  // cat in [0..8], kickers ranks up to 14
  // base-15 digits
  let v = cat;
  for (const k of kickers) v = v*15 + k;
  return v;
}

// ---------- 7-card evaluator by 5-card enumeration ----------
function bestOf7(cards7){
  let best = -1;
  // enumerate 21 combos
  const c = cards7;
  for (let a=0;a<3;a++){
    for (let b=a+1;b<4;b++){
      for (let d=b+1;d<5;d++){
        for (let e=d+1;e<6;e++){
          for (let f=e+1;f<7;f++){
            const v = eval5([c[a],c[b],c[d],c[e],c[f]]);
            if (v > best) best = v;
          }
        }
      }
    }
  }
  return best;
}

// ---------- Hand strength ordering for "top X%" ranges ----------
const HAND_ORDER = (() => {
  // Generate 169 starting-hand classes ordered roughly by strength.
  // This is a heuristic ordering (not solver-perfect), but good for range approximation.
  // Format: "AKs", "AQo", "TT", etc.
  const ranks = [...RANKS].reverse(); // A..2
  const list = [];

  // Pairs strongest to weakest
  for (const r of ranks) list.push(r+r);

  // Suited broadways then offsuit broadways, then suited connectors, etc.
  const idx = (r) => ranks.indexOf(r);
  function addNonPairs(suited){
    for (let i=0;i<ranks.length;i++){
      for (let j=i+1;j<ranks.length;j++){
        const hi = ranks[i], lo = ranks[j];
        const gap = idx(lo) - idx(hi);
        const broadway = "AKQJT".includes(hi) && "AKQJT".includes(lo);
        const name = hi+lo+(suited ? "s":"o");
        const score =
          (broadway ? 500 : 0)
          + (suited ? 80 : 0)
          + (14 - RANK_VAL[hi])*6
          + (14 - RANK_VAL[lo])*4
          - Math.abs(gap)*10;
        list.push({name, score});
      }
    }
    list.sort((a,b)=>b.score-a.score);
    return list.map(x=>x.name);
  }

  const suited = addNonPairs(true);
  const offsuit = addNonPairs(false);

  // Merge: pairs, suited, offsuit (with some interleaving to feel realistic)
  const merged = [];
  for (const p of list.filter(x=>typeof x === "string")) merged.push(p);
  for (let i=0;i<Math.max(suited.length, offsuit.length);i++){
    if (i < suited.length) merged.push(suited[i]);
    if (i < offsuit.length && i % 2 === 0) merged.push(offsuit[i]); // interleave
  }

  // Dedup 169
  const seen = new Set();
  const out = [];
  for (const x of merged){
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
    if (out.length === 169) break;
  }
  return out;
})();

function pctToHandClasses(pct){
  // pct 5..60 -> take top N% of 169 classes
  const n = Math.max(1, Math.round((pct/100) * 169));
  return HAND_ORDER.slice(0, n);
}

function sampleStartingHand(deck, allowedClasses){
  // allowedClasses: array of "AKs","AQo","TT"
  // pick a class uniformly, then pick an actual 2-card combo consistent with class from deck
  // This is a simplification (true combo-weight differs).
  for (let tries=0; tries<40; tries++){
    const cls = allowedClasses[(Math.random()*allowedClasses.length)|0];

    if (cls.length === 2){
      // pair: pick two of same rank different suits
      const r = cls[0];
      const candidates = deck.filter(c => c.str[0] === r);
      if (candidates.length < 2) continue;
      const c1 = candidates[(Math.random()*candidates.length)|0];
      // remove c1 then pick c2
      const idx1 = deck.indexOf(c1);
      deck.splice(idx1,1);
      const candidates2 = deck.filter(c => c.str[0] === r);
      if (candidates2.length < 1){
        deck.splice(idx1,0,c1);
        continue;
      }
      const c2 = candidates2[(Math.random()*candidates2.length)|0];
      const idx2 = deck.indexOf(c2);
      deck.splice(idx2,1);
      return [c1,c2];
    } else {
      const hi = cls[0], lo = cls[1], suited = cls[2] === "s";
      const hiCards = deck.filter(c => c.str[0] === hi);
      const loCards = deck.filter(c => c.str[0] === lo);
      if (hiCards.length < 1 || loCards.length < 1) continue;

      if (suited){
        // need same suit
        const suits = ["c","d","h","s"].sort(()=>Math.random()-0.5);
        let chosen = null;
        for (const s of suits){
          const a = hiCards.find(c=>c.s===s);
          const b = loCards.find(c=>c.s===s);
          if (a && b){ chosen = [a,b]; break; }
        }
        if (!chosen) continue;
        // remove them
        deck.splice(deck.indexOf(chosen[0]),1);
        deck.splice(deck.indexOf(chosen[1]),1);
        return chosen;
      } else {
        // offsuit: different suit
        const a = hiCards[(Math.random()*hiCards.length)|0];
        // choose b with suit != a.s
        const bCandidates = loCards.filter(c=>c.s !== a.s);
        if (bCandidates.length < 1) continue;
        const b = bCandidates[(Math.random()*bCandidates.length)|0];
        deck.splice(deck.indexOf(a),1);
        deck.splice(deck.indexOf(b),1);
        return [a,b];
      }
    }
  }

  // fallback: random 2 cards
  return [pickRandom(deck), pickRandom(deck)];
}

// ---------- Villain response model ----------
function villainParams(type){
  // These are intentionally simple + interpretable.
  // callBias: >0 calls wider, <0 folds more
  // raiseBias: >0 raises more
  // bluffBias: >0 bluffs more (only used if reraises enabled)
  switch(type){
    case "Nit":     return { callBias:-0.55, raiseBias:-0.30, bluffBias:-0.60 };
    case "Station": return { callBias:+0.70, raiseBias:-0.25, bluffBias:-0.70 };
    case "Maniac":  return { callBias:+0.35, raiseBias:+0.70, bluffBias:+0.75 };
    case "Trappy":  return { callBias:+0.10, raiseBias:+0.20, bluffBias:-0.15 };
    case "Reg":     return { callBias:+0.00, raiseBias:+0.10, bluffBias:+0.05 };
    default:        return { callBias:+0.05, raiseBias:+0.05, bluffBias:+0.00 };
  }
}

// sigmoid helper
function sigmoid(x){ return 1 / (1 + Math.exp(-x)); }

// Rough “continue vs bet” probability from required equity.
// We approximate villain equity by sampling runouts vs hero hand (ignoring other villains).
function continueProb(reqEq, villEq, callBias, exploitBlend, multiwayCount){
  // multiway: people generally continue a bit tighter vs bets in big multiway (except stations)
  const multiwayPenalty = Math.max(0, (multiwayCount - 2) * 0.06);
  const base = (villEq - reqEq) - multiwayPenalty;

  // exploit blend scales the bias
  const b = callBias * exploitBlend;

  // convert margin into probability
  // wider (Station) => shifts right (more call)
  const p = sigmoid((base + b) * 6.0);
  return Math.max(0, Math.min(1, p));
}

function raiseProb(villEq, reqEq, raiseBias, exploitBlend){
  // only used when reraises ON (very rough)
  const margin = villEq - reqEq;
  const b = raiseBias * exploitBlend;
  const p = sigmoid((margin + b) * 5.0) * 0.35; // keep rare
  return Math.max(0, Math.min(0.35, p));
}

// Estimate villain equity vs hero hand by quick Monte Carlo runouts (small samples).
function estimateEquityVsHero(villHand, heroHand, boardCards, deadSet, samples){
  // returns winProb (including ties/2 treated as half win)
  let wins = 0, ties = 0, total = 0;

  const known = [...heroHand, ...villHand, ...boardCards].map(c=>c.str);
  const baseDead = new Set([...deadSet, ...known]);

  const need = 5 - boardCards.length;
  if (need < 0) return 0.5;

  for (let i=0;i<samples;i++){
    const deck = buildDeck(baseDead);
    const runout = boardCards.slice();
    for (let k=0;k<need;k++){
      runout.push(pickRandom(deck));
    }
    const hBest = bestOf7([...heroHand, ...runout]);
    const vBest = bestOf7([...villHand, ...runout]);
    total++;
    if (vBest > hBest) wins++;
    else if (vBest === hBest) ties++;
  }
  return (wins + ties*0.5) / Math.max(1,total);
}

// ---------- EV simulation ----------
function showdownEV(heroHand, villHands, boardCards, deadSet){
  // complete board and evaluate among remaining players
  const need = 5 - boardCards.length;
  const deck = buildDeck(deadSet);
  const runout = boardCards.slice();
  for (let k=0;k<need;k++) runout.push(pickRandom(deck));

  const heroBest = bestOf7([...heroHand, ...runout]);
  let best = heroBest;
  let winners = 1; // hero included
  let heroIsWinner = true;

  for (const vh of villHands){
    const vBest = bestOf7([...vh, ...runout]);
    if (vBest > best){
      best = vBest;
      winners = 1;
      heroIsWinner = false;
    } else if (vBest === best){
      winners += 1;
      if (best !== heroBest) heroIsWinner = false;
    }
  }

  if (!heroIsWinner) return 0;
  return 1 / winners; // hero share of pot
}

function simulateAction(payload, actionKind, raiseSize, progressCb, shouldStop){
  const iters = payload.iters;
  const exploit = payload.exploit;
  const reraises = payload.reraises;

  const hero = payload.hero.map(parseCard);
  const board = payload.board.map(parseCard);

  const pot0 = payload.pot;
  const toCall = payload.toCall;
  const heroStack = payload.heroStack;

const opps = Array.isArray(payload.opponents) ? payload.opponents : [];
const aliveOpps = opps.filter(o => o && o.inhand !== false);


  const deadSetBase = new Set([...payload.hero, ...payload.board]);

  // Precompute allowed classes per opponent
  const oppAllowed = aliveOpps.map(o => ({
    ...o,
    classes: pctToHandClasses(o.tight || 22),
    params: villainParams(o.villain || "Unknown"),
  }));

  let evSum = 0;

  // EV convention: chip EV of action relative to folding (fold=0).
  // We assume if you call/raise you pay that cost now, and win share of pot at showdown.
  // Pot contributions from villains are modeled by call decisions. No side pots in v1.

  const chunk = Math.max(200, Math.floor(iters/25));

  for (let i=1;i<=iters;i++){
    if (shouldStop && shouldStop()) throw new Error("stopped");

    // fresh dead set and deck
    const dead = new Set(deadSetBase);
    const deck = buildDeck(dead);

    // sample opponent hands
    const oppHands = [];
    for (const o of oppAllowed){
      const hand = sampleStartingHand(deck, o.classes);
      oppHands.push(hand);
      dead.add(hand[0].str);
      dead.add(hand[1].str);
    }

    // decide which opponents continue based on action
    let heroCost = 0;
    let pot = pot0;

    if (actionKind === "call"){
      heroCost = Math.min(heroStack, toCall);
      pot += heroCost;
    } else if (actionKind === "raise"){
      const raise = Math.min(heroStack, raiseSize);
      heroCost = raise;
      pot += heroCost;
    } else {
      // fold
      evSum += 0;
      continue;
    }

    const continuing = [];

    // required equity for villains to continue:
    // if hero calls, villains are assumed already in. We still model "fold to bet" only on raise.
    if (actionKind === "call"){
      // everyone remains (v1 assumption)
      continuing.push(...oppHands);
      // EV = share*pot - cost
      const share = showdownEV(hero, continuing, board, dead);
      evSum += share*pot - heroCost;
    } else {
      // raise: villains decide to continue (call/fold; optional re-raise)
      const multiwayCount = 1 + oppHands.length;
      for (let j=0;j<oppHands.length;j++){
        const o = oppAllowed[j];
        const vh = oppHands[j];
        const params = o.params;

        // villain calling price: assume they call the raise amount (simplified).
        const price = raiseSize; // rough; in reality price is raiseSize - amountAlreadyPutIn
        const reqEq = price / Math.max(1, (pot0 + heroCost + price));

        // estimate villain equity vs hero quickly
        const villEq = estimateEquityVsHero(vh, hero, board, dead, 18);

        // decide call
        const pCont = continueProb(reqEq, villEq, params.callBias, exploit, multiwayCount);
        const r = Math.random();

        if (r < pCont){
          // maybe re-raise if enabled
          if (reraises){
            const pRaise = raiseProb(villEq, reqEq, params.raiseBias, exploit);
            if (Math.random() < pRaise){
              // re-raise modeled as "villain continues and adds extra" (very rough)
              const extra = Math.round(raiseSize * 0.8);
              pot += price + extra;
              continuing.push(vh);
              continue;
            }
          }
          // call
          pot += price;
          continuing.push(vh);
        } else {
          // fold => nothing added
        }
      }

      // if all fold, hero wins immediately
      if (continuing.length === 0){
        evSum += pot - heroCost;
      } else {
        const share = showdownEV(hero, continuing, board, dead);
        evSum += share*pot - heroCost;
      }
    }

    if (progressCb && (i % chunk === 0)){
      const pct = Math.round((i / iters) * 100);
      progressCb(pct, `${actionKind.toUpperCase()} — ${i.toLocaleString()}/${iters.toLocaleString()} sims`);
    }
  }

  return evSum / Math.max(1,iters);
}

// run all actions
function runAll(payload, progressCb, shouldStop){
  const sizes = payload.raiseSizes;

  // Fold EV = 0 by definition here
  progressCb && progressCb(1, "CALL — starting…");
  const evCall = simulateAction(payload, "call", 0, progressCb, shouldStop);

  progressCb && progressCb(1, "RAISE 33% — starting…");
  const evR33 = simulateAction(payload, "raise", sizes.r33, progressCb, shouldStop);

  progressCb && progressCb(1, "RAISE 75% — starting…");
  const evR75 = simulateAction(payload, "raise", sizes.r75, progressCb, shouldStop);

  progressCb && progressCb(1, "RAISE 125% — starting…");
  const evR125 = simulateAction(payload, "raise", sizes.r125, progressCb, shouldStop);

  progressCb && progressCb(1, "CUSTOM — starting…");
  const evRC = simulateAction(payload, "raise", sizes.rcustom, progressCb, shouldStop);

  return { call: evCall, r33: evR33, r75: evR75, r125: evR125, rcustom: evRC };
}
