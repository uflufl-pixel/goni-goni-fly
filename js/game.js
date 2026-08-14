/* ============================================================
   GALAGA  —  HTML5 Canvas / Vanilla JS
   기능: 편대 진입/스윙, 급강하 공격, 캡처-구출 & 더블 함선,
         보너스 스테이지, 모바일 터치 조작, 무적시간 밸런싱
   상태: TITLE → PLAYING → (PAUSED) → GAMEOVER → TITLE
   ============================================================ */
(function () {
  "use strict";

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;

  // ---- 밸런싱 상수 ---------------------------------------------
  const TUNE = {
    diveBase: 0.0013, diveLevel: 0.0004,   // 급강하 시작 확률(프레임당) — 레벨 램프는 완만히
    fireBase: 0.00035, fireLevel: 0.0001,  // 편대 사격 확률
    tractorChance: 0.0016,                 // 보스 견인빔 확률
    respawnInvuln: 1.6,                    // 부활 무적(초)
    dockInvuln: 1.2,                       // 도킹/피격 후 무적
  };

  // ---- 게임 상태 ------------------------------------------------
  const STATE = { TITLE: "TITLE", PLAYING: "PLAYING", PAUSED: "PAUSED", GAMEOVER: "GAMEOVER" };
  let state = STATE.TITLE;

  let score = 0;
  let hiScore = Number(localStorage.getItem("galaga_hi") || 0);
  let lives = 3;
  let level = 1;
  let playTime = 0; // 누적 플레이 시간(초) — 시간 경과 난이도용
  // 시간 난이도 계수: 시작 0 → 5분 0.5 → 10분 1.0 → 이후 최대 1.5
  function timeTier() { return Math.min(1.5, playTime / 600); }

  // ---- 입력 (키보드) --------------------------------------------
  const keys = { left: false, right: false, fire: false };

  window.addEventListener("keydown", (e) => {
    ensureAudio();
    switch (e.code) {
      case "ArrowLeft": keys.left = true; e.preventDefault(); break;
      case "ArrowRight": keys.right = true; e.preventDefault(); break;
      case "Space": keys.fire = true; e.preventDefault(); break;
      case "KeyP":
        if (state === STATE.PLAYING) state = STATE.PAUSED;
        else if (state === STATE.PAUSED) state = STATE.PLAYING;
        break;
      case "Enter":
        if (state === STATE.TITLE || state === STATE.GAMEOVER) startGame();
        break;
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "ArrowLeft") keys.left = false;
    if (e.code === "ArrowRight") keys.right = false;
    if (e.code === "Space") keys.fire = false;
  });

  // ---- 입력 (터치/포인터) --------------------------------------
  // 상대 드래그: 손가락 이동량 × 감도만큼 함선이 즉시 이동(지연 없음, 데드존 없음).
  const TOUCH_SENS = 1.3; // 터치 이동 배율 (1=1:1, 클수록 빠름)
  let pointerActive = false, pointerX = null, touchFire = false, lastDragX = 0;
  function canvasX(clientX) {
    const r = canvas.getBoundingClientRect();
    return (clientX - r.left) * (W / r.width);
  }
  function grabPointer(clientX) {
    pointerActive = true; touchFire = true;
    pointerX = canvasX(clientX);
    lastDragX = pointerX; // 짚는 순간엔 이동량 0 → 튀지 않음
  }
  canvas.addEventListener("pointerdown", (e) => {
    ensureAudio();
    if (state === STATE.TITLE || state === STATE.GAMEOVER) { startGame(); return; }
    if (state === STATE.PAUSED) { state = STATE.PLAYING; return; }
    grabPointer(e.clientX);
    e.preventDefault();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (pointerActive) { pointerX = canvasX(e.clientX); e.preventDefault(); }
  });
  window.addEventListener("pointerup", () => { pointerActive = false; touchFire = false; });
  window.addEventListener("pointercancel", () => { pointerActive = false; touchFire = false; });

  // ---- 사운드 (WebAudio 간이 효과음) ----------------------------
  let audioCtx = null;
  function ensureAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch (e) { /* 무시 */ }
  }
  function beep(freq, dur, type, vol) {
    if (!audioCtx) return;
    try {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = type || "square";
      o.frequency.value = freq;
      g.gain.value = vol == null ? 0.05 : vol;
      o.connect(g); g.connect(audioCtx.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
      o.stop(audioCtx.currentTime + dur);
    } catch (e) { /* 무시 */ }
  }
  const sfx = {
    shoot: () => beep(880, 0.08, "square", 0.04),
    hit: () => beep(160, 0.15, "sawtooth", 0.06),
    playerDie: () => { beep(120, 0.4, "sawtooth", 0.08); beep(80, 0.5, "triangle", 0.06); },
    dive: () => beep(300, 0.12, "triangle", 0.03),
    tractor: () => beep(220, 0.5, "sine", 0.04),
    dock: () => { beep(660, 0.1, "square", 0.06); beep(990, 0.12, "square", 0.06); },
    power: () => { beep(620, 0.07, "square", 0.05); beep(1040, 0.12, "square", 0.05); },
    laser: () => beep(1300, 0.05, "sawtooth", 0.025),
  };

  // ---- 배경: 갈대밭 노을 ----------------------------------------
  let bgTime = 0;
  // 노을 하늘 그라데이션 (위: 어스름 보라 → 아래: 주황·금빛 지평선)
  const skyGrad = ctx.createLinearGradient(0, 0, 0, H);
  skyGrad.addColorStop(0.00, "#241a44");
  skyGrad.addColorStop(0.28, "#533063");
  skyGrad.addColorStop(0.48, "#9c4a59");
  skyGrad.addColorStop(0.64, "#d76b45");
  skyGrad.addColorStop(0.80, "#ef9350");
  skyGrad.addColorStop(0.92, "#f6bd69");
  skyGrad.addColorStop(1.00, "#f8d79a");

  // 떠다니는 갈대 솜털
  const fluff = [];
  for (let i = 0; i < 46; i++) {
    fluff.push({
      x: Math.random() * W, y: Math.random() * H,
      s: Math.random() * 1.8 + 0.6, vx: Math.random() * 10 + 4,
      bob: Math.random() * Math.PI * 2, bobA: Math.random() * 8 + 4,
    });
  }

  // 갈대밭: 원경/근경 2겹으로 풍성하게. 각 갈대는 줄기 곡선 + 잎사귀 여러 장 + 이삭.
  function makeReedLayer(count, minH, maxH, color, seedColor, swayBase) {
    const arr = [];
    for (let i = 0; i < count; i++) {
      const lean = (Math.random() * 0.5 + 0.2) * (Math.random() < 0.5 ? -1 : 1);
      const nLeaves = 2 + (Math.random() * 3 | 0);
      const leaves = [];
      for (let k = 0; k < nLeaves; k++) {
        leaves.push({
          frac: 0.22 + Math.random() * 0.55,
          dir: Math.random() < 0.5 ? -1 : 1,
          len: 9 + Math.random() * 16,
          droop: 0.3 + Math.random() * 0.5,
        });
      }
      arr.push({
        x: -6 + i * (W + 12) / (count - 1) + (Math.random() * 20 - 10),
        h: minH + Math.random() * (maxH - minH),
        phase: Math.random() * Math.PI * 2, lean,
        seed: Math.random() < 0.9, color, seedColor,
        swayA: swayBase + Math.random() * 3,
        headLen: 13 + Math.random() * 14, headW: 2.4 + Math.random() * 2,
        leaves,
      });
    }
    return arr;
  }
  // 원경(연하고 촘촘·짧음) → 근경(진하고 큼·큼직) 순으로 그린다.
  // 고니(y≈H-104)보다 확실히 아래에 오도록 갈대 키를 낮춘다.
  const reedsBack = makeReedLayer(42, 14, 38, "#4a3352", "#5a3f60", 4);
  const reedsFront = makeReedLayer(30, 24, 64, "#1e1524", "#2f2038", 3);

  function updateAtmosphere(dt) {
    bgTime += dt;
    for (const f of fluff) { f.x += f.vx * dt; if (f.x > W + 2) f.x = -2; }
  }

  function drawReedLayer(layer, lw) {
    ctx.lineCap = "round";
    for (const rd of layer) {
      const baseY = H + 2, topY = H - rd.h;
      const sway = Math.sin(bgTime * 1.2 + rd.phase) * rd.swayA + rd.lean * rd.h * 0.16;
      const topX = rd.x + sway;
      // 줄기
      ctx.strokeStyle = rd.color; ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(rd.x, baseY);
      ctx.quadraticCurveTo((rd.x + topX) / 2 + rd.lean * 5, baseY - rd.h * 0.5, topX, topY);
      ctx.stroke();
      // 잎사귀 (여러 장, 아래로 휘어짐)
      ctx.lineWidth = Math.max(1, lw - 0.6);
      for (const lf of rd.leaves) {
        const ly = baseY - rd.h * lf.frac;
        const lx = rd.x + sway * (1 - lf.frac);
        ctx.beginPath();
        ctx.moveTo(lx, ly);
        ctx.quadraticCurveTo(lx + lf.dir * lf.len * 0.8, ly - lf.len * 0.4,
                             lx + lf.dir * lf.len, ly + lf.len * lf.droop);
        ctx.stroke();
      }
      // 이삭(씨앗 머리) — 길쭉하게, 끝에 잔털
      if (rd.seed) {
        ctx.save();
        ctx.translate(topX, topY);
        ctx.rotate(rd.lean * 0.28);
        ctx.fillStyle = rd.seedColor;
        ctx.beginPath();
        ctx.ellipse(0, -rd.headLen / 2, rd.headW, rd.headLen / 2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = rd.seedColor; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, -rd.headLen); ctx.lineTo(0, -rd.headLen - 5); ctx.stroke();
        ctx.restore();
      }
    }
  }

  function drawBackground() {
    // 하늘
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, W, H);
    // 떠다니는 솜털
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = "#ffe9c8";
    for (const f of fluff) {
      const yy = f.y + Math.sin(bgTime + f.bob) * f.bobA;
      ctx.fillRect(f.x, yy, f.s, f.s);
    }
    ctx.globalAlpha = 1;
    // 바닥 그림자 (갈대 뿌리 안착)
    const groundH = 60, gg = ctx.createLinearGradient(0, H - groundH, 0, H);
    gg.addColorStop(0, "rgba(30,20,36,0)");
    gg.addColorStop(1, "rgba(26,17,32,0.5)");
    ctx.fillStyle = gg; ctx.fillRect(0, H - groundH, W, groundH);
    // 갈대밭 (원경 → 근경)
    ctx.globalAlpha = 0.7; drawReedLayer(reedsBack, 1.6); ctx.globalAlpha = 1;
    drawReedLayer(reedsFront, 2.4);
    ctx.lineWidth = 1;
  }

  // ---- 플레이어 -------------------------------------------------
  // 기본 함선 폭 32(중심 = x+16). 더블 함선은 폭 64(중심 = x+32, 함선 두 대).
  const player = {
    x: W / 2 - 16, y: H - 104, w: 32, h: 26,   // 갈대밭 위로 올려 시야 확보
    speed: 260, cooldown: 0, alive: true, respawn: 0,
    dual: false, invuln: 0,
    weaponLevel: 1, laserTime: 0, rapidTime: 0, shield: false, // 파워업 상태
  };
  function setDual(on) {
    const cx = player.x + player.w / 2;
    player.dual = on;
    player.w = on ? 64 : 32;
    player.x = cx - player.w / 2;
    clampPlayer();
  }
  function clampPlayer() { player.x = Math.max(6, Math.min(W - player.w - 6, player.x)); }

  let playerBullets = [];
  let enemyBullets = [];
  let enemies = [];
  let particles = [];
  let captive = null;   // 포획된 함선 {state:'held'|'falling', x, y, boss, vy}
  let items = [];       // 떨어지는 파워업 아이템
  // 아이템 종류: P 무기강화 · R 속사 · L 레이저 · D 보호막 · + 추가목숨
  const ITEM_DEFS = {
    power:  { color: "#ff5d7a", label: "P" },
    rapid:  { color: "#ffd24a", label: "R" },
    laser:  { color: "#57e6c8", label: "L" },
    shield: { color: "#6aa8ff", label: "D" },
    life:   { color: "#8affa0", label: "+" },
  };

  // ---- 편대(Formation) ------------------------------------------
  const formation = { offsetX: 0, dir: 1, cols: 8, rows: 4, cellW: 42, cellH: 38, top: 70, swing: 30 };
  function formationX(col) {
    const totalW = (formation.cols - 1) * formation.cellW;
    return W / 2 - totalW / 2 + col * formation.cellW + formation.offsetX;
  }
  function formationY(row) { return formation.top + row * formation.cellH; }

  function enemyDef(row) {
    if (row === 0) return { type: "crane", color: "#eef2f6", hp: 2, score: 150 }; // 두루미(보스)
    if (row === 1) return { type: "goose", color: "#b98a5a", hp: 1, score: 80 };  // 기러기
    return { type: "bird", color: "#8bb0d6", hp: 1, score: 50 };                  // 철새
  }

  function spawnWave(lvl) {
    enemies = [];
    for (let r = 0; r < formation.rows; r++) {
      for (let c = 0; c < formation.cols; c++) {
        const def = enemyDef(r);
        const fromLeft = (r + c) % 2 === 0;
        enemies.push({
          col: c, row: r,
          x: fromLeft ? -40 : W + 40, y: -30 - r * 20, w: 30, h: 24,
          type: def.type, color: def.color, hp: def.hp, score: def.score,
          state: "entering",         // entering|formation|diving|tractor|returning
          t: (r * formation.cols + c) * 0.05,
          diveT: 0, divePath: null,
          fireChance: TUNE.fireBase + lvl * TUNE.fireLevel,
          hasCaptive: false,
          alive: true,
        });
      }
    }
  }

  // ---- 파티클(폭발) ---------------------------------------------
  function explode(x, y, color, n) {
    for (let i = 0; i < (n || 14); i++) {
      const a = Math.random() * Math.PI * 2, sp = Math.random() * 140 + 40;
      particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.5 + Math.random() * 0.3, t: 0, color });
    }
  }

  // ---- 시작/레벨 진행 -------------------------------------------
  function startGame() {
    ensureAudio();
    score = 0; lives = 3; level = 1; playTime = 0;
    playerBullets = []; enemyBullets = []; particles = []; captive = null; items = [];
    setDual(false);
    player.x = W / 2 - player.w / 2; player.alive = true; player.respawn = 0; player.invuln = TUNE.respawnInvuln;
    player.weaponLevel = 1; player.laserTime = 0; player.rapidTime = 0; player.shield = false;
    spawnWave(level);
    state = STATE.PLAYING;
  }
  function nextLevel() {
    level++;
    spawnWave(level);
  }

  // ---- 업데이트 -------------------------------------------------
  function update(dt) {
    updateAtmosphere(dt);
    if (state !== STATE.PLAYING) return;
    playTime += dt;

    updatePlayer(dt);

    // 편대 스윙
    formation.offsetX += formation.dir * 18 * dt;
    if (Math.abs(formation.offsetX) > formation.swing) {
      formation.dir *= -1;
      formation.offsetX = Math.sign(formation.offsetX) * formation.swing;
    }
    updateEnemies(dt);
    if (enemies.length === 0) nextLevel();

    updateCaptive(dt);
    updateItems(dt);
    if (player.alive && player.laserTime > 0) updateLaser(dt);
    updateBullets(dt);
    updateParticles(dt);
    checkCollisions();
  }

  function updatePlayer(dt) {
    if (player.invuln > 0) player.invuln -= dt;
    if (player.laserTime > 0) player.laserTime -= dt;
    if (player.rapidTime > 0) player.rapidTime -= dt;

    if (player.alive) {
      // 키보드 이동
      if (keys.left) player.x -= player.speed * dt;
      if (keys.right) player.x += player.speed * dt;
      // 터치 이동: 지난 프레임 이후 손가락 이동량 × 감도만큼 즉시 이동 (지연 없음)
      if (pointerActive && pointerX != null) {
        player.x += (pointerX - lastDragX) * TOUCH_SENS;
        lastDragX = pointerX;
      }
      clampPlayer();

      // 자동발사: 레이저 활성 중엔 빔(updateLaser 처리), 아니면 쿨다운마다 탄 발사
      player.cooldown -= dt;
      if (player.laserTime <= 0 && player.cooldown <= 0) {
        firePlayer();
        player.cooldown = fireCooldown();
      }
    } else {
      player.respawn -= dt;
      if (player.respawn <= 0 && lives > 0) {
        player.alive = true;
        player.x = W / 2 - player.w / 2;
        player.invuln = TUNE.respawnInvuln;
      }
    }
  }
  // 무기 레벨: 1 단발 → 2 연사 → 3 2연발 → 4~5 확산탄(+속사)
  function fireCooldown() {
    const cd = [0.26, 0.19, 0.17, 0.15, 0.12][player.weaponLevel - 1] || 0.12;
    return player.rapidTime > 0 ? cd * 0.55 : cd;
  }
  function firePlayer() {
    const origins = player.dual ? [player.x + 16, player.x + 48] : [player.x + 16];
    const speed = 520 * (player.rapidTime > 0 ? 1.3 : 1);
    const lvl = player.weaponLevel;
    const shot = (cx, vx) => playerBullets.push({ x: cx - 2, y: player.y, w: 4, h: 12, v: -speed, vx: vx || 0 });
    for (const ox of origins) {
      if (lvl <= 2) shot(ox, 0);
      else if (lvl === 3) { shot(ox - 6, 0); shot(ox + 6, 0); }
      else { shot(ox, 0); shot(ox, -150); shot(ox, 150); } // 확산탄
    }
    sfx.shoot();
  }

  function updateEnemies(dt) {
    const tf = timeTier(); // 시간 경과 난이도(0~1.5)
    let diving = enemies.filter((e) => e.state === "diving" || e.state === "tractor").length;
    const maxDivers = Math.min(5, (level < 2 ? 1 : 2) + Math.floor(tf * 2)); // 시간 지날수록 동시 급강하 증가

    for (const e of enemies) {
      if (!e.alive) continue;
      const tx = formationX(e.col), ty = formationY(e.row);

      if (e.state === "entering") {
        e.t -= dt;
        if (e.t <= 0) {
          e.x += (tx - e.x) * Math.min(1, dt * 4);
          e.y += (ty - e.y) * Math.min(1, dt * 4);
          if (Math.abs(e.x - tx) < 2 && Math.abs(e.y - ty) < 2) e.state = "formation";
        }
      } else if (e.state === "formation") {
        e.x = tx; e.y = ty;
        // 보스: 견인빔 시도
        if (e.type === "crane" && !captive && !player.dual && player.alive &&
            diving < maxDivers && Math.random() < TUNE.tractorChance * (1 + tf)) {
          e.state = "tractor"; e.tractorT = 0; e.captureT = 0; e.beamOn = false;
          diving++; sfx.tractor();
        } else if (diving < maxDivers && Math.random() < (TUNE.diveBase + level * TUNE.diveLevel) * (1 + tf * 2)) {
          e.state = "diving"; e.diveT = 0;
          e.divePath = { startX: e.x, dir: e.x < W / 2 ? 1 : -1 };
          diving++; sfx.dive();
        } else if (player.alive && Math.random() < e.fireChance * (1 + tf * 1.8)) {
          enemyBullets.push({ x: e.x + e.w / 2 - 2, y: e.y + e.h, w: 4, h: 10, v: 220 * (1 + tf * 0.3) });
        }
      } else if (e.state === "diving") {
        e.diveT += dt;
        e.y += 190 * (1 + tf * 0.4) * dt;
        e.x = e.divePath.startX + Math.sin(e.diveT * 4) * 90 * e.divePath.dir;
        if (player.alive && Math.random() < 0.02 * (1 + tf))
          enemyBullets.push({ x: e.x + e.w / 2 - 2, y: e.y + e.h, w: 4, h: 10, v: 260 * (1 + tf * 0.3) });
        if (e.y > H + 30) { e.y = -30; e.state = "entering"; e.t = 0; }
      } else if (e.state === "tractor") {
        e.tractorT += dt;
        const hoverY = 220;
        e.y += Math.sign(hoverY - e.y) * Math.min(Math.abs(hoverY - e.y), 120 * dt);
        if (player.alive) {
          const tgtX = player.x + player.w / 2 - e.w / 2;
          e.x += (tgtX - e.x) * Math.min(1, dt * 1.2);
        }
        e.beamOn = e.tractorT > 0.6 && e.tractorT < 2.6;
        if (e.beamOn && player.alive && player.invuln <= 0 && !captive && !player.dual) {
          const halfW = 24 + (H - e.y - e.h) * 0.12;
          if (Math.abs((player.x + player.w / 2) - (e.x + e.w / 2)) < halfW) {
            e.captureT += dt;
            if (e.captureT > 0.7) capturePlayer(e);
          } else e.captureT = 0;
        }
        if (e.tractorT > 2.8) { e.state = "returning"; e.beamOn = false; }
      } else if (e.state === "returning") {
        e.x += (tx - e.x) * Math.min(1, dt * 3);
        e.y += (ty - e.y) * Math.min(1, dt * 3);
        if (Math.abs(e.x - tx) < 3 && Math.abs(e.y - ty) < 3) e.state = "formation";
      }

      // 포획한 함선을 보스 위에 매달아 이동
      if (e.hasCaptive && captive && captive.state === "held") {
        captive.x = e.x + (e.w - 32) / 2;
        captive.y = e.y - 26;
      }
    }
  }

  // ---- 캡처-구출 ------------------------------------------------
  function capturePlayer(boss) {
    lives--;
    player.alive = false;
    player.laserTime = 0; player.rapidTime = 0;
    explode(player.x + player.w / 2, player.y + player.h / 2, "#e8eef4", 20);
    sfx.playerDie();
    captive = { state: "held", x: boss.x, y: boss.y - 26, boss: boss, vy: 0 };
    boss.hasCaptive = true;
    boss.state = "returning";
    if (lives <= 0) state = STATE.GAMEOVER;
    else player.respawn = 1.4;
  }
  function releaseCaptive() {
    if (!captive) return;
    captive.state = "falling"; captive.boss = null; captive.vy = 120;
  }
  function updateCaptive(dt) {
    if (!captive || captive.state !== "falling") return;
    captive.y += captive.vy * dt;
    captive.x += Math.sin(captive.y * 0.03) * 0.6;
    // 플레이어가 밑에서 받아내면 더블 함선으로 도킹
    if (player.alive && player.invuln <= 0) {
      const capRect = { x: captive.x, y: captive.y, w: 32, h: 26 };
      if (rectHit(capRect, player)) {
        captive = null;
        setDual(true);
        player.invuln = TUNE.dockInvuln;
        score += 1000;
        sfx.dock();
        return;
      }
    }
    if (captive.y > H) captive = null; // 놓침
  }

  function updateBullets(dt) {
    for (const b of playerBullets) { b.y += b.v * dt; b.x += (b.vx || 0) * dt; }
    for (const b of enemyBullets) b.y += b.v * dt;
    playerBullets = playerBullets.filter((b) => b.y + b.h > 0 && b.x > -12 && b.x < W + 12);
    enemyBullets = enemyBullets.filter((b) => b.y < H);
  }

  // ---- 아이템 / 파워업 -----------------------------------------
  function maybeDropItem(x, y, e) {
    const chance = e.type === "crane" ? 0.15 : e.type === "goose" ? 0.07 : 0.05;
    if (Math.random() > chance) return;
    const r = Math.random();
    const type = r < 0.40 ? "power" : r < 0.66 ? "rapid" : r < 0.85 ? "laser" : r < 0.96 ? "shield" : "life";
    items.push({ x: x - 9, y: y - 9, w: 18, h: 18, type, vy: 80 + Math.random() * 30, sway: Math.random() * Math.PI * 2 });
  }
  function applyItem(type) {
    switch (type) {
      case "power": player.weaponLevel = Math.min(5, player.weaponLevel + 1); score += 200; break;
      case "rapid": player.rapidTime = Math.min(12, (player.rapidTime > 0 ? player.rapidTime : 0) + 7); score += 150; break;
      case "laser": player.laserTime = Math.min(12, (player.laserTime > 0 ? player.laserTime : 0) + 6); score += 150; break;
      case "shield": player.shield = true; score += 150; break;
      case "life": lives = Math.min(9, lives + 1); score += 100; break;
    }
    sfx.power();
  }
  function updateItems(dt) {
    for (const it of items) {
      it.y += it.vy * dt;
      it.x += Math.sin(it.y * 0.04 + it.sway) * 0.6;
      if (player.alive && !it.dead && rectHit(it, player)) { it.dead = true; applyItem(it.type); }
    }
    items = items.filter((it) => !it.dead && it.y < H + 20);
  }
  // 레이저: 고니 위 세로 기둥에 겹친 적에게 초당 다단 히트
  function updateLaser(dt) {
    const origins = player.dual ? [player.x + 16, player.x + 48] : [player.x + 16];
    let tick = false;
    for (const e of enemies) {
      if (!e.alive) continue;
      e.laserCd = (e.laserCd || 0) - dt;
      if (e.laserCd > 0) continue;
      for (const ox of origins) {
        if (e.x < ox + 5 && e.x + e.w > ox - 5 && e.y < player.y) {
          e.hp--; e.laserCd = 0.1; tick = true;
          explode(e.x + e.w / 2, e.y + e.h / 2, "#57e6c8", 4);
          if (e.hp <= 0) {
            e.alive = false; score += e.score;
            if (e.hasCaptive) releaseCaptive();
            explode(e.x + e.w / 2, e.y + e.h / 2, e.color, e.type === "crane" ? 22 : 14);
            maybeDropItem(e.x + e.w / 2, e.y + e.h / 2, e);
          }
          break;
        }
      }
    }
    if (tick) sfx.laser();
    enemies = enemies.filter((e) => e.alive);
  }
  function updateParticles(dt) {
    for (const p of particles) { p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.96; p.vy *= 0.96; }
    particles = particles.filter((p) => p.t < p.life);
  }

  function rectHit(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function checkCollisions() {
    // 플레이어 총알 vs 적
    for (const b of playerBullets) {
      if (b.dead) continue;
      for (const e of enemies) {
        if (!e.alive) continue;
        if (rectHit(b, e)) {
          b.dead = true;
          e.hp--;
          if (e.hp <= 0) {
            e.alive = false;
            score += e.score;
            if (e.hasCaptive) releaseCaptive();
            explode(e.x + e.w / 2, e.y + e.h / 2, e.color, e.type === "crane" ? 22 : 14);
            maybeDropItem(e.x + e.w / 2, e.y + e.h / 2, e);
            sfx.hit();
          } else {
            explode(e.x + e.w / 2, e.y + e.h / 2, "#ffffff", 5);
          }
          break;
        }
      }
    }
    playerBullets = playerBullets.filter((b) => !b.dead);
    enemies = enemies.filter((e) => e.alive);

    // 무적/사망 중엔 플레이어 피격 검사 생략
    if (!player.alive || player.invuln > 0) {
      enemyBullets = enemyBullets.filter((b) => !b.dead);
      finalizeScore();
      return;
    }

    // 적 총알 vs 플레이어
    for (const b of enemyBullets) {
      if (rectHit(b, player)) { b.dead = true; hitPlayer(); break; }
    }
    enemyBullets = enemyBullets.filter((b) => !b.dead);

    // 급강하 적 몸통 vs 플레이어
    if (player.alive && player.invuln <= 0) {
      for (const e of enemies) {
        if ((e.state === "diving" || e.state === "tractor") && rectHit(e, player)) {
          e.alive = false;
          if (e.hasCaptive) releaseCaptive();
          explode(e.x + e.w / 2, e.y + e.h / 2, e.color, 16);
          hitPlayer();
          break;
        }
      }
      enemies = enemies.filter((e) => e.alive);
    }
    finalizeScore();
  }
  function finalizeScore() {
    if (score > hiScore) { hiScore = score; localStorage.setItem("galaga_hi", hiScore); }
  }

  // 피격: 더블 함선이면 한 대만 잃고, 단일이면 목숨 소모
  function hitPlayer() {
    if (player.shield) {   // 보호막이 한 방 막아준다
      player.shield = false;
      player.invuln = TUNE.dockInvuln;
      explode(player.x + player.w / 2, player.y + 12, "#6aa8ff", 18);
      sfx.hit();
      return;
    }
    if (player.dual) {
      setDual(false);
      player.invuln = TUNE.dockInvuln;
      explode(player.x + player.w / 2, player.y, "#e8eef4", 12);
      sfx.hit();
      return;
    }
    lives--;
    player.alive = false;
    player.laserTime = 0; player.rapidTime = 0;
    player.weaponLevel = Math.max(1, player.weaponLevel - 1); // 사망 시 무기 한 단계 하락
    explode(player.x + player.w / 2, player.y + player.h / 2, "#e8eef4", 24);
    sfx.playerDie();
    if (lives <= 0) state = STATE.GAMEOVER;
    else player.respawn = 1.2;
  }

  // ---- 렌더링 ---------------------------------------------------
  // 주인공: 흰색 고니(백조) — 위를 향해 난다. color 지정 시 포획된(주황) 고니.
  function drawSwan(cx, top, color) {
    const body = color || "#ffffff";
    const wing = color || "#dfe7f0";
    // 몸통
    ctx.fillStyle = body;
    ctx.fillRect(cx - 6, top + 11, 12, 9);
    // 날개 (양쪽으로 펼침)
    ctx.fillStyle = wing;
    ctx.fillRect(cx - 15, top + 12, 10, 6);
    ctx.fillRect(cx + 5, top + 12, 10, 6);
    // 날개 끝 강조
    ctx.fillStyle = color || "#b9c6d6";
    ctx.fillRect(cx - 15, top + 12, 3, 6);
    ctx.fillRect(cx + 12, top + 12, 3, 6);
    // 꼬리
    ctx.fillStyle = body;
    ctx.fillRect(cx - 2, top + 19, 4, 5);
    // 긴 목 (S자로 앞으로 굽음 — 고니 특징)
    ctx.fillRect(cx - 1, top + 4, 4, 8);
    ctx.fillRect(cx + 1, top + 1, 3, 5);
    // 머리
    ctx.fillRect(cx + 1, top - 1, 5, 4);
    // 부리 (주황)
    ctx.fillStyle = "#ff9a3c";
    ctx.fillRect(cx + 5, top, 3, 3);
    // 눈
    ctx.fillStyle = "#222";
    ctx.fillRect(cx + 3, top, 1, 1);
  }
  function drawPlayer() {
    if (!player.alive) return;
    if (player.invuln > 0 && Math.floor(player.invuln * 12) % 2 === 0) return; // 무적 깜빡임
    const top = player.y;
    if (player.dual) { drawSwan(player.x + 16, top); drawSwan(player.x + 48, top); }
    else drawSwan(player.x + 16, top);
    // 보호막 링
    if (player.shield) {
      ctx.save();
      ctx.strokeStyle = "rgba(106,168,255,0.85)"; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(player.x + player.w / 2, top + 12, player.w / 2 + 6, 20, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
  function drawCaptive() {
    if (!captive) return;
    drawSwan(captive.x + 16, captive.y, "#ff8a5a"); // 포획된 고니는 주황빛
  }
  // 레이저빔: 고니 위로 뻗는 밝은 청록 기둥
  function drawLaser() {
    if (player.laserTime <= 0 || !player.alive) return;
    const origins = player.dual ? [player.x + 16, player.x + 48] : [player.x + 16];
    const flick = 0.55 + Math.random() * 0.25;
    for (const ox of origins) {
      ctx.save();
      ctx.globalAlpha = flick * 0.4; ctx.fillStyle = "#57e6c8";
      ctx.fillRect(ox - 9, 0, 18, player.y + 8);
      ctx.globalAlpha = flick; ctx.fillStyle = "#d6fff5";
      ctx.fillRect(ox - 3, 0, 6, player.y + 8);
      ctx.restore();
    }
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function drawItems() {
    for (const it of items) {
      const d = ITEM_DEFS[it.type];
      const bob = Math.sin((it.y + it.x) * 0.12) * 1.5;
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.5)"; ctx.shadowBlur = 4;
      ctx.fillStyle = "rgba(18,14,26,0.85)"; roundRect(it.x, it.y + bob, it.w, it.h, 4); ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = d.color; roundRect(it.x, it.y + bob, it.w, it.h, 4); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = d.color; ctx.font = "bold 12px 'Courier New', monospace";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(d.label, it.x + it.w / 2, it.y + bob + it.h / 2 + 1);
      ctx.textBaseline = "alphabetic";
    }
  }

  function drawEnemy(e) {
    const { x, y, w, h, color, type } = e;
    // 견인빔
    if (e.beamOn) {
      const cx = x + w / 2, halfTop = 6, halfBot = 24 + (H - y - h) * 0.12;
      ctx.fillStyle = "rgba(127,214,255,0.16)";
      ctx.beginPath();
      ctx.moveTo(cx - halfTop, y + h); ctx.lineTo(cx + halfTop, y + h);
      ctx.lineTo(cx + halfBot, H); ctx.lineTo(cx - halfBot, H);
      ctx.closePath(); ctx.fill();
    }
    const cx = x + w / 2;
    if (type === "crane") {
      // 두루미(보스): 흰 몸 · 검은 날개끝 · 붉은 정수리 · 아래로 뻗은 목 · 위로 트는 다리
      ctx.fillStyle = "#8a8a8a";                          // 다리 (뒤로 뻗음)
      ctx.fillRect(cx - 1, y, 1, 6); ctx.fillRect(cx + 1, y, 1, 6);
      ctx.fillStyle = "#eef2f6";                          // 몸통 + 날개
      ctx.fillRect(cx - 5, y + 6, 10, 9);
      ctx.fillRect(x, y + 7, 8, 5); ctx.fillRect(x + w - 8, y + 7, 8, 5);
      ctx.fillStyle = "#1a1a1a";                          // 검은 날개끝
      ctx.fillRect(x, y + 7, 3, 5); ctx.fillRect(x + w - 3, y + 7, 3, 5);
      ctx.fillStyle = "#eef2f6";                          // 목 · 머리
      ctx.fillRect(cx - 2, y + 14, 4, 7); ctx.fillRect(cx - 2, y + 20, 5, 4);
      ctx.fillStyle = "#e63a3a"; ctx.fillRect(cx - 1, y + 18, 3, 2); // 붉은 정수리
      ctx.fillStyle = "#333"; ctx.fillRect(cx, y + 23, 2, 2);        // 부리
    } else if (type === "goose") {
      // 기러기: 갈색 몸 · 진한 날개끝 · 어두운 목/머리 · 주황 부리
      ctx.fillStyle = "#7c5a34"; ctx.fillRect(cx - 2, y + 2, 4, 4);  // 꼬리
      ctx.fillStyle = "#b98a5a";                          // 몸통 + 날개
      ctx.fillRect(cx - 6, y + 6, 12, 9);
      ctx.fillRect(x + 1, y + 8, 7, 5); ctx.fillRect(x + w - 8, y + 8, 7, 5);
      ctx.fillStyle = "#7c5a34";                          // 진한 날개끝
      ctx.fillRect(x + 1, y + 8, 3, 5); ctx.fillRect(x + w - 4, y + 8, 3, 5);
      ctx.fillStyle = "#5c4326";                          // 어두운 목 · 머리
      ctx.fillRect(cx - 2, y + 14, 4, 6); ctx.fillRect(cx - 2, y + 19, 5, 4);
      ctx.fillStyle = "#e8a24a"; ctx.fillRect(cx - 1, y + 22, 3, 2); // 부리
    } else {
      // 철새: 멀리 나는 작은 새 실루엣 (V자 날개)
      ctx.fillStyle = "#8bb0d6";
      ctx.fillRect(cx - 1, y + 4, 2, 4);                  // 꼬리
      ctx.fillRect(cx - 3, y + 8, 6, 8);                  // 몸통
      ctx.fillRect(cx - 2, y + 15, 4, 4);                 // 머리
      ctx.fillRect(cx - 12, y + 6, 4, 3); ctx.fillRect(cx + 8, y + 6, 4, 3);   // 바깥 날개
      ctx.fillRect(cx - 8, y + 8, 4, 3); ctx.fillRect(cx + 4, y + 8, 4, 3);
      ctx.fillRect(cx - 4, y + 10, 3, 3); ctx.fillRect(cx + 1, y + 10, 3, 3);  // 안쪽 날개
      ctx.fillStyle = "#e8c24a"; ctx.fillRect(cx - 1, y + 18, 2, 2);           // 부리
    }
  }

  function drawBullets() {
    // 아군 총알: 흰색
    ctx.fillStyle = "#ffffff";
    for (const b of playerBullets) ctx.fillRect(b.x, b.y, b.w, b.h);
    // 적 총알: 어두운 외곽 + 선명한 마젠타 코어 + 밝은 하이라이트 → 노을 위에서도 잘 보인다
    for (const b of enemyBullets) {
      ctx.fillStyle = "rgba(8,0,6,0.9)";                       // 어두운 테두리
      ctx.fillRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4);
      ctx.fillStyle = "#ff2f6b";                               // 선명한 마젠타 코어
      ctx.fillRect(b.x - 1, b.y, b.w + 2, b.h);
      ctx.fillStyle = "#ffe1ec";                               // 밝은 하이라이트
      ctx.fillRect(b.x, b.y, b.w, 3);
    }
  }
  function drawParticles() {
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, 1 - p.t / p.life);
      ctx.fillStyle = p.color; ctx.fillRect(p.x, p.y, 3, 3);
    }
    ctx.globalAlpha = 1;
  }

  function drawHUD() {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.6)"; ctx.shadowBlur = 3; ctx.shadowOffsetY = 1;
    ctx.fillStyle = "#fff"; ctx.font = "14px 'Courier New', monospace";
    ctx.textAlign = "left"; ctx.fillText("SCORE " + score, 10, 22);
    ctx.textAlign = "center"; ctx.fillStyle = "#ffe37a"; ctx.fillText("HI " + hiScore, W / 2, 22);
    ctx.textAlign = "right"; ctx.fillStyle = "#a9e4ff";
    ctx.fillText("LV " + level, W - 10, 22);
    ctx.textAlign = "left";
    for (let i = 0; i < lives; i++) {
      const bx = 10 + i * 22, by = H - 22;
      ctx.fillStyle = "#f4f8ff"; ctx.fillRect(bx + 6, by, 4, 14); ctx.fillRect(bx, by + 8, 16, 6);
    }
    // 파워 상태 (무기 레벨 + 활성 버프)
    ctx.font = "12px 'Courier New', monospace";
    ctx.fillStyle = "#ff9db0"; ctx.fillText("PWR " + player.weaponLevel, 10, 40);
    let sx = 80;
    if (player.laserTime > 0) { ctx.fillStyle = "#57e6c8"; ctx.fillText("L" + Math.ceil(player.laserTime), sx, 40); sx += 30; }
    if (player.rapidTime > 0) { ctx.fillStyle = "#ffd24a"; ctx.fillText("R" + Math.ceil(player.rapidTime), sx, 40); sx += 30; }
    if (player.shield) { ctx.fillStyle = "#6aa8ff"; ctx.fillText("D", sx, 40); }
    // 경과 시간 (난이도 상승 지표)
    const mm = Math.floor(playTime / 60), ss = Math.floor(playTime % 60);
    ctx.textAlign = "right"; ctx.fillStyle = timeTier() >= 1 ? "#ff9db0" : "#cdbce0";
    ctx.fillText("TIME " + mm + ":" + String(ss).padStart(2, "0"), W - 10, 40);
    ctx.restore();
  }

  function centerText(lines, baseY) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.shadowColor = "rgba(0,0,0,0.6)"; ctx.shadowBlur = 5; ctx.shadowOffsetY = 1;
    lines.forEach((ln, i) => {
      ctx.font = ln.size + "px 'Courier New', monospace";
      ctx.fillStyle = ln.color || "#fff";
      ctx.fillText(ln.text, W / 2, baseY + i * (ln.gap || 34));
    });
    ctx.restore();
  }

  function draw() {
    drawBackground();

    if (state === STATE.TITLE) {
      centerText([{ text: "날아라 고니고니", size: 26, color: "#ffd24a" }], H / 2 - 92);
      centerText([
        { text: "she's gone~~~y", size: 40, color: "#7fd6ff", gap: 60 },
        { text: "화면 터치로 시작", size: 18, color: "#fff", gap: 34 },
      ], H / 2 - 40);
      centerText([{ text: "HI-SCORE  " + hiScore, size: 14, color: "#fff6df" }], H - 70);
      return;
    }

    for (const e of enemies) drawEnemy(e);
    drawLaser();
    drawCaptive();
    drawBullets();
    drawItems();
    drawPlayer();
    drawParticles();
    drawHUD();

    if (state === STATE.PAUSED) {
      ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(0, 0, W, H);
      centerText([{ text: "일시정지", size: 32, color: "#fff", gap: 40 },
                  { text: "터치로 계속", size: 16, color: "#7a8bd0" }], H / 2);
    }
    if (state === STATE.GAMEOVER) {
      ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(0, 0, W, H);
      centerText([
        { text: "GAME OVER", size: 40, color: "#ff5a8a", gap: 50 },
        { text: "SCORE " + score, size: 22, color: "#fff", gap: 34 },
        { text: "터치로 재시작", size: 16, color: "#7a8bd0" },
      ], H / 2 - 30);
    }
  }

  // ---- 메인 루프 ------------------------------------------------
  let last = performance.now();
  function loop(now) {
    let dt = (now - last) / 1000; last = now;
    if (dt > 0.05) dt = 0.05;
    update(dt);
    draw();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
