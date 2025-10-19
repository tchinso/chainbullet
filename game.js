/* Mobile Vertical Bullet-Shmup — from-scratch engine
 * Design adheres to 'HTML5 기반 모바일 슈팅 게임 개발 계획서.txt'
 * - Portrait 9:16 canvas, virtual joystick, attack & skill buttons
 * - 3 characters (Tank/Healer, DPS, CC/Debuff) with instant swap
 * - Auto-aim while attack is held; slower move speed during firing
 * - TP gauge charges on hit/kill; skill consumes TP
 * - 20 levels, waves, boss at 5/10/15 and final boss at 20
 * - Roguelike buffs: choose 1 of 3 after clearing a level (except L20)
 * - HTML/CSS HUD overlay with portraits, HP/TP, buffs, timer
 */
(() => {
  'use strict';

  // ===== Canvas bootstrap (DPR-aware) =====
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const canvas = $('#game');
  const ctx = canvas.getContext('2d', { alpha: false });
  const stage = $('#stage');

  const DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  let vw = 0, vh = 0, cw = 0, ch = 0;
  function resize() {
    // Keep 9:16 aspect inside #stage
    const rect = stage.getBoundingClientRect();
    let w = rect.width, h = rect.height;
    // Enforce portrait aspect
    const target = 9/16;
    if (w / h > target) w = h * target; else h = w / target;
    vw = w; vh = h;
    cw = Math.round(vw * DPR); ch = Math.round(vh * DPR);
    canvas.width = cw; canvas.height = ch;
    canvas.style.width = `${vw}px`; canvas.style.height = `${vh}px`;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener('resize', resize, { passive: true });
  resize();

  // ===== Global time =====
  let last = performance.now();
  let acc = 0;

  // ===== Utility =====
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a=1, b) => (b===undefined? Math.random()*a : a + Math.random()*(b-a));
  const h2 = (x,y)=>x*x+y*y;
  const dist = (x1,y1,x2,y2)=>Math.hypot(x1-x2,y1-y2);
  const angleTo = (x1,y1,x2,y2)=>Math.atan2(y2-y1,x2-x1);
  function circleHit(x1,y1,r1,x2,y2,r2){ return dist(x1,y1,x2,y2) <= (r1+r2); }

  // ===== Game State =====
  const Game = {
    paused:false,
    level:1,
    time:0, // seconds within current level
    running:false,
    over:false,
    win:false,
    enemies:[],
    bullets:[],
    ebullets:[],
    effects:[],
    pickups:[],
    team:[],
    currentIdx:0,
    buffs:[],
    nextLevelReady:false,
    levelGoal:false, // true when boss defeated & all waves done
    rngSeed: (Math.random()*1e9)|0,
    setTime(t){ this.time = t; $('#time').textContent = formatTime(t); },
  };

  // ===== Buffs =====
  const ALL_BUFFS = [
    { id:'atk+20', name:'공격력 +20%', desc:'모든 캐릭터의 공격력 20% 증가', apply:t=> t.forEach(c=> c.atkMul*=1.2) },
    { id:'hp+30',  name:'최대 HP +30%', desc:'모든 캐릭터 최대 체력 30% 증가', apply:t=> t.forEach(c=>{ c.maxHP=Math.round(c.maxHP*1.3); c.hp=Math.min(c.maxHP, c.hp+Math.round(c.maxHP*0.3)); updateTeamBar(); }) },
    { id:'move+10',name:'이동속도 +10%', desc:'이동속도 10% 증가', apply:t=> t.forEach(c=> c.moveSpeedMul*=1.1) },
    { id:'tp+50',  name:'TP 획득 +50%', desc:'적 적중/처치 시 TP 획득량 50% 증가', apply:t=> t.forEach(c=> c.tpGainMul*=1.5) },
    { id:'cd-30',  name:'스킬 쿨다운 -30%', desc:'스킬 재사용 대기시간 30% 감소', apply:t=> t.forEach(c=> c.skillCdMul*=0.7) },
    { id:'pierce', name:'탄환 관통', desc:'탄환이 1회 관통', apply:t=> t.forEach(c=> c.pierce+=1) },
    { id:'crit+15',name:'치명타 +15%', desc:'치명타 확률 15%p 증가', apply:t=> t.forEach(c=> c.crit+=0.15) },
  ];
  function rollBuffs(n=3){
    const picks = [];
    const bag = ALL_BUFFS.filter(b=> !Game.buffs.some(x=>x.id===b.id) || ['atk+20','hp+30','move+10','tp+50'].includes(b.id));
    while (picks.length < n && bag.length){
      const i = (Math.random()*bag.length)|0;
      picks.push(bag.splice(i,1)[0]);
    }
    return picks;
  }
  function addBuff(buff){
    Game.buffs.push(buff);
    buff.apply(Game.team);
    renderBuffIcons();
  }
  function renderBuffIcons(){
    const wrap = $('#buffIcons'); wrap.innerHTML='';
    Game.buffs.forEach(b=>{
      const el = document.createElement('div'); el.className='buff'; el.title=b.name;
      el.style.background = '#2c3e50';
      wrap.appendChild(el);
    });
  }

  // ===== Characters =====
  const ROLES = {
    tank:  { name:'탱/힐', color:'#4cd964', hp:140, speed:155, rof:5.5, bullet: { dmg:9, speed:680, spread:8, pellets:4 }, skill:{
      name:'팀 힐+가드', cost:100, cd:14, cast:(self)=>{
        Game.team.forEach(c=>{
          const heal = Math.round(c.maxHP*0.25);
          c.hp = clamp(c.hp + heal, 0, c.maxHP);
          c.guardTime = Math.max(c.guardTime, 2.5);
        });
        spawnText(self.x, self.y-24, '힐링!', '#7CFC00');
      }
    }},
    dps:   { name:'딜러', color:'#66d9ef', hp:90,  speed:180, rof:10.0, bullet: { dmg:7, speed:900, spread:1, pellets:1 }, skill:{
      name:'버스트 사격', cost:100, cd:10, cast:(self)=>{
        self.burstTime = Math.max(self.burstTime, 3.0);
        spawnText(self.x, self.y-24, '버스트!', '#66d9ef');
      }
    }},
    cc:    { name:'CC/디버프', color:'#ffd166', hp:110, speed:165, rof:6.5, bullet: { dmg:8, speed:720, spread:10, pellets:1 }, skill:{
      name:'감속 필드', cost:100, cd:12, cast: (self)=>{
        Effects.slowField(self.x, self.y, 130, 8.0, 0.45);
      }
    }},
  };

  class Character {
    constructor(role, portraitUrl){
      const tpl = ROLES[role];
      this.role = role;
      this.name = tpl.name;
      this.color = tpl.color;
      this.maxHP = tpl.hp;
      this.hp = this.maxHP;
      this.baseMove = tpl.speed;
      this.moveSpeedMul = 1;
      this.atkMul = 1;
      this.bullet = JSON.parse(JSON.stringify(tpl.bullet));
      this.pierce = 0;
      this.crit = 0.05;
      this.tp = 0; this.tpMax = 100; // ★ 변경: TP 최대치 100
      this.tpGainMul = 1;
      this.skill = Object.assign({}, tpl.skill);
      this.skillCdMul = 1;
      this.skillReadyAt = 0;
      this.guardTime = 0;
      this.burstTime = 0;
      this.portraitUrl = portraitUrl;
      this.x = cw/2/DPR; this.y = ch*0.7/DPR;
    }
    get alive(){ return this.hp > 0; }
    regen(dt){
      // === FIX 1: 죽은 캐릭터는 벤치에서 부활하지 않음 ===
      if (this.hp <= 0) return;
      this.hp = clamp(this.hp + dt * this.maxHP * 0.02, 0, this.maxHP);
    }
    trySkill(time){
      if (this.tp >= this.skill.cost && time >= this.skillReadyAt){
        this.tp = Math.max(0, this.tp - this.skill.cost);
        const cd = this.skill.cd * this.skillCdMul;
        this.skillReadyAt = time + cd;
        this.skill.cast(this);
        flashButton(skillBtn, '#ffd166');
      }
    }
    gainTP(hits=1, kill=false){
      const base = (hits * 3) + (kill? 10: 0);
      this.tp = clamp(this.tp + base * this.tpGainMul, 0, this.tpMax);
    }
    drawBars(x, y, w){ /* DOM HUD가 그려줌 */ }
  }

  // Team setup
  Game.team = [
    new Character('tank', 'https://picsum.photos/seed/tank/200/200'),
    new Character('dps',  'https://picsum.photos/seed/dps/200/200'),
    new Character('cc',   'https://picsum.photos/seed/cc/200/200'),
  ];

  // ===== Player control state =====
  let cur = Game.team[0];
  Game.currentIdx = 0;
  let moveX=0, moveY=0, firing=false;

  // ===== Entities =====
  class Bullet {
    constructor(x,y,vx,vy, dmg, pierce=0, owner='player'){
      this.x=x; this.y=y; this.vx=vx; this.vy=vy;
      this.r = 6; this.dmg=dmg; this.owner=owner; this.dead=false;
      this.pierce=pierce; this.passed=0;
    }
    update(dt){
      this.x += this.vx * dt; this.y += this.vy * dt;
      if (this.x<-40||this.y<-40||this.x>vw+40||this.y>vh+40) this.dead=true;
    }
    render(){
      ctx.beginPath();
      if (this.owner==='player'){ ctx.fillStyle='#e8faff'; ctx.arc(this.x, this.y, this.r, 0, TAU); ctx.fill(); }
      else { ctx.fillStyle='#ff7676'; ctx.arc(this.x, this.y, this.r, 0, TAU); ctx.fill(); }
    }
  }

  const Effects = {
    spark(x,y, col='#fff'){ Game.effects.push({t:0, life:0.18, x,y, col, draw(e){ ctx.fillStyle=e.col; ctx.fillRect(e.x-1, e.y-1, 2,2);} , upd(e,dt){ e.t+=dt; }}); },
    hit(x,y){ for(let i=0;i<6;i++){ Effects.spark(x+rand(-6,6), y+rand(-6,6), '#ffd166'); } },
    slowField(x,y, radius, life, slow){
      Game.effects.push({ type:'slowField', x,y, r:radius, t:0, life, slow,
        upd(e,dt){ e.t+=dt; },
        draw(e){
          const a = 0.25 * (1 - e.t/e.life);
          ctx.fillStyle = `rgba(120,200,255,${a})`;
          ctx.beginPath(); ctx.arc(e.x,e.y,e.r,0,TAU); ctx.fill();
          ctx.strokeStyle = `rgba(120,200,255,${a*1.8})`; ctx.lineWidth=2; ctx.stroke();
        }
      });
    }
  };
  function spawnText(x,y, text, col='#fff'){
    Game.effects.push({ text, x, y, vy:-22, t:0, life:1.0, col,
      upd(e,dt){ e.t+=dt; e.y += e.vy*dt; },
      draw(e){ ctx.fillStyle = `rgba(255,255,255,${1-e.t/e.life})`; ctx.font='14px sans-serif'; ctx.fillText(text, e.x-ctx.measureText(text).width/2, e.y); }
    });
  }

  class Enemy {
    constructor(type, x, y, hp, speed){
      this.type=type; this.x=x; this.y=y; this.hp=hp; this.maxHP=hp; this.speed=speed; this.r = (type==='boss'? 30 : (type==='elite'? 18 : 14));
      this.fireCooldown = rand(0.6, 1.2);
      this.t = 0;
      this.slowMul = 1;
      this.phase = 0;
    }
    damage(d){
      this.hp -= d;
      Effects.hit(this.x,this.y);
      if (this.hp <= 0){
        // TP to current char
        cur.gainTP(0, true);
        spawnText(this.x,this.y,'+TP','#7CFC00');
        Game.levelKillCount = (Game.levelKillCount||0)+1;
        return (this.dead=true);
      }
    }
    update(dt){
      this.t += dt;
      // slow field effect
      this.slowMul = 1;
      for (const e of Game.effects){
        if (e.type==='slowField'){
          const inside = dist(this.x,this.y,e.x,e.y) <= e.r;
          if (inside) this.slowMul = Math.min(this.slowMul, e.slow);
        }
      }
      // movement
      const ang = angleTo(this.x,this.y, cur.x, cur.y);
      const spd = this.speed * this.slowMul;
      if (this.type==='shooter'){
        const d = dist(this.x,this.y,cur.x,cur.y);
        if (d > 170) { this.x += Math.cos(ang)*spd*dt; this.y += Math.sin(ang)*spd*dt; }
      } else if (this.type==='bomber'){
        this.x += Math.cos(ang)*spd*dt; this.y += Math.sin(ang)*spd*dt;
      } else if (this.type==='boss'){
        this.x += Math.cos(this.t*0.7)*40*dt;
      } else {
        this.x += Math.cos(ang)*spd*dt; this.y += Math.sin(ang)*spd*dt;
      }

      // attack
      this.fireCooldown -= dt * (this.type==='boss'? 1.2 : 1);
      if (this.fireCooldown <= 0){
        this.fireCooldown = (this.type==='boss'? 0.4 : rand(0.8,1.6));
        if (this.type==='bomber'){
          if (dist(this.x,this.y,cur.x,cur.y) < 36){
            playerHit(24); this.dead=true; Effects.hit(this.x,this.y);
          }
        } else if (this.type==='boss'){
          bossPattern(this);
        } else if (this.type==='shooter'){
          shootAt(this.x,this.y, cur.x,cur.y, 280, 6, 'enemy');
        }
      }

      // collide with player
      if (circleHit(this.x,this.y,this.r, cur.x,cur.y, 16)){
        playerHit(this.type==='bomber'? 28 : 10);
        const a = angleTo(this.x,this.y,cur.x,cur.y);
        this.x -= Math.cos(a)*10; this.y -= Math.sin(a)*10;
      }

      if (this.x<-60||this.y<-120||this.x>vw+60||this.y>vh+120) this.dead=true;
    }
    render(){
      ctx.beginPath();
      ctx.fillStyle = (this.type==='boss')? '#ff3b3b' : (this.type==='elite'?'#f5a623':'#b388ff');
      ctx.arc(this.x,this.y,this.r,0,TAU); ctx.fill();
      if (this.type!=='bomber'){
        const w = this.r*1.8;
        ctx.fillStyle='rgba(0,0,0,.4)'; ctx.fillRect(this.x-w/2, this.y-this.r-10, w, 4);
        ctx.fillStyle='#ff6b6b'; ctx.fillRect(this.x-w/2, this.y-this.r-10, w*(this.hp/this.maxHP), 4);
      }
    }
  }

  function bossPattern(b){
    const p = (Game.level%20===0)? 'final' : ['fan','ring','spiral'][b.phase%3];
    if (p==='fan'){
      const a = angleTo(b.x,b.y, cur.x,cur.y);
      for(let i=-2;i<=2;i++) shootDir(b.x,b.y, a+i*0.18, 320, 7, 'enemy');
    } else if (p==='ring'){
      for(let i=0;i<14;i++){ shootDir(b.x,b.y, i*(TAU/14), 260, 6, 'enemy'); }
    } else if (p==='spiral'){
      b._s = (b._s||0)+1.2;
      for(let i=0;i<8;i++) shootDir(b.x,b.y, (i*TAU/8)+b._s*0.15, 300, 5.5, 'enemy');
    } else if (p==='final'){
      for(let i=0;i<18;i++) shootDir(b.x,b.y, (i*TAU/18)+Math.random()*0.1, 300+Math.random()*80, 6.5, 'enemy');
      const a = angleTo(b.x,b.y, cur.x,cur.y);
      for(let i=-1;i<=1;i++) shootDir(b.x,b.y, a+i*0.08, 420, 8, 'enemy');
    }
    b.phase++;
  }

  // ===== Shooting helpers =====
  function shootDir(x,y, ang, spd, dmg, owner){
    const vx = Math.cos(ang)*spd, vy=Math.sin(ang)*spd;
    const b = new Bullet(x,y, vx,vy, dmg, 0, owner);
    if (owner==='player') Game.bullets.push(b); else Game.ebullets.push(b);
    return b;
  }
  function shootAt(x,y, tx,ty, spd, dmg, owner){
    return shootDir(x,y, angleTo(x,y,tx,ty), spd, dmg, owner);
  }

  // ===== Spawning & Level =====
  let waveTimer=0, spawnTimer=0, boss=null;
  function setupLevel(lv){
    Game.level = lv; $('#lvl').textContent = lv;
    Game.setTime(0); Game.enemies.length=0; Game.bullets.length=0; Game.ebullets.length=0; Game.effects.length=0;
    Game.over=false; Game.levelGoal=false; Game.nextLevelReady=false; boss=null;
    Game.levelKillCount = 0;

    cur.x = vw/2; cur.y = vh*0.78;

    Game.levelDuration = (lv<5? 35 : lv<10? 45 : lv<15? 55 : lv<20? 65 : 75);
    waveTimer = 0; spawnTimer = 0;

    // === CHANGE: 레벨 진입 회복량 — 5/10/15/20는 30%, 나머지는 20% ===
    const milestone = (lv===5 || lv===10 || lv===15 || lv===20);
    const healPct = milestone ? 0.30 : 0.20;
    Game.team.forEach(c=> c.hp = clamp(c.hp + c.maxHP*healPct, 0, c.maxHP));
    if (milestone) { spawnText(cur.x, cur.y-36, '+30% HP', '#4cd964'); }

    hideScreen('#buffScreen'); renderBuffIcons(); updateTeamBar();
  }

  function spawnEnemy(){
    const side = (Math.random()*4)|0;
    const m = 24;
    const x = side===0? rand(m,vw-m): side===1? rand(m,vw-m): side===2? -m : vw+m;
    const y = side===0? -m: side===1? vh+m : side===2? rand(m,vh-m) : rand(m,vh-m);
    const lv = Game.level;
    let type='chaser';
    const r = Math.random();
    if (r < (0.15+lv*0.01)) type='shooter';
    else if (r < (0.22+lv*0.015)) type='bomber';
    const hp = Math.round(20 + lv*5 + (type==='bomber'? -8 : type==='shooter'? 6 : 0));
    const sp = 60 + lv*6 + (type==='bomber'? 40 : type==='shooter'? -10 : 0);
    Game.enemies.push(new Enemy(type, x,y, hp, sp));
  }

  function ensureBoss(){
    if (boss) return;
    const lv = Game.level;
    if (lv%5===0){
      boss = new Enemy('boss', vw/2, vh*0.2, 600 + lv*120, 30 + lv*2);
      boss.r = 36 + lv*0.8;
      Game.enemies.push(boss);
    }
  }

  function checkLevelClear(){
    if (Game.level<20){
      if (Game.level%5===0){
        if (boss && boss.dead){
          if (Game.enemies.filter(e=>!e.dead && e.type!=='boss').length===0){
            Game.levelGoal = true;
          }
        }
      } else {
        if (Game.time >= Game.levelDuration && Game.enemies.every(e=>e.dead)){
          Game.levelGoal = true;
        }
      }
      if (Game.levelGoal && !Game.nextLevelReady){
        Game.nextLevelReady = true;
        showBuffChoice();
      }
    } else {
      if (boss && boss.dead){
        Game.win = true;
        showScreen('#winScreen');
        Game.running=false;
      }
    }
  }

  function showBuffChoice(){
    const choices = rollBuffs(3);
    const wrap = $('#buffChoices'); wrap.innerHTML='';
    choices.forEach(b=>{
      const el = document.createElement('div'); el.className='pick';
      el.innerHTML = `<div style="font-weight:700; margin-bottom:6px">${b.name}</div><div class="muted">${b.desc}</div>`;
      el.addEventListener('click', ()=>{
        addBuff(b);
        hideScreen('#buffScreen');
        nextLevel();
      }, { passive: true });
      wrap.appendChild(el);
    });
    showScreen('#buffScreen');
  }

  function nextLevel(){
    setupLevel(Game.level+1);
  }

  // ===== Player damage =====
  function playerHit(dmg){
    if (cur.guardTime>0) return;
    cur.hp -= dmg;
    // === FIX 2: 사망 즉시 HP를 0으로 고정 (음수 방지) ===
    if (cur.hp <= 0){
      cur.hp = 0;
      // if there is another alive teammate, swap; else game over
      const next = Game.team.findIndex((c,i)=> i!==Game.currentIdx && c.alive);
      if (next>=0){
        switchTo(next);
        spawnText(cur.x, cur.y, '교대!', '#fff');
      } else {
        Game.over = true;
        Game.running=false;
        showScreen('#overScreen');
      }
    }
    updateTeamBar();
  }

  // ===== Portrait HUD & switching =====
  const teamBar = $('#team-bar');

  // 왼쪽 아래 배치 헬퍼 (조이스틱과 겹치지 않도록 vh 비율로 띄움)
  function positionTeamBar(){
    teamBar.style.position = 'absolute';
    teamBar.style.left = '12px';
    teamBar.style.bottom = `${Math.round(Math.max(90, vh*0.12))}px`;
    teamBar.style.justifyContent = 'flex-start';
  }

  function updateTeamBar(){
    teamBar.innerHTML='';
    Game.team.forEach((c,i)=>{
      const p = document.createElement('div');
      p.className='portrait'+(i===Game.currentIdx?' current':'');
      const hpPct = clamp(Math.round((c.hp/c.maxHP)*100), 0, 100);
      const tpPct = clamp(Math.round((c.tp/c.tpMax)*100), 0, 100);
      p.innerHTML = `<img src="${c.portraitUrl}" alt="p${i}" />
        <div class="hpbar"><div class="fill" style="width:${hpPct}%"></div></div>
        <div class="gauge"><div class="fill" style="width:${tpPct}%"></div></div>
        <div class="role" style="border-color:${c.color}; color:${c.color}">${ROLES[c.role].name}</div>`;
      p.addEventListener('touchstart', (e)=>{ e.preventDefault(); switchTo(i); }, { passive:false });
      p.addEventListener('click', ()=> switchTo(i));
      teamBar.appendChild(p);
    });
    // 위치 보정은 매번 안전하게
    positionTeamBar();
  }
  function switchTo(i){
    if (i===Game.currentIdx) return;
    Game.currentIdx = i; cur = Game.team[i];
    cur.guardTime = Math.max(cur.guardTime, 1.2);
    updateTeamBar();
    updateSkillReadyHint(); // ★ 스킬 준비 테두리 즉시 갱신
  }
  updateTeamBar();
  window.addEventListener('resize', positionTeamBar, { passive:true });

  // ===== Touch Controls =====
  const stickZone = $('#stick-zone');
  const attackBtn = $('#attackBtn');
  const skillBtn = $('#skillBtn');
  const stickRoot = $('#stick'); const knob = stickRoot.querySelector('.knob');

  let joyId = null, joyBase = {x:0,y:0}, joyVec={x:0,y:0}, joyActive=false;
  let atkId = null, sklId = null;

  function localPos(el, touch){
    const r = el.getBoundingClientRect();
    return { x: touch.clientX - r.left, y: touch.clientY - r.top };
  }
  function showStick(x,y){ stickRoot.style.display='block'; stickRoot.style.left=`${x-70}px`; stickRoot.style.top=`${y-70}px`; }
  function hideStick(){ stickRoot.style.display='none'; }

  // Movement zone
  stickZone.addEventListener('touchstart', (e)=>{
    for (const t of e.changedTouches){
      if (joyId===null){
        joyId = t.identifier;
        joyActive = true;
        const p = localPos(stickZone, t);
        joyBase = {x:p.x, y:p.y};
        showStick(p.x, p.y);
      }
    }
  }, { passive:false });
  window.addEventListener('touchmove', (e)=>{
    for (const t of e.changedTouches){
      if (t.identifier===joyId){
        const p = localPos(stickZone, t);
        let dx = p.x - joyBase.x, dy = p.y - joyBase.y;
        const m = Math.hypot(dx,dy), R=50;
        if (m>R){ dx = dx/m*R; dy = dy/m*R; }
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
        joyVec = { x: dx/R, y: dy/R };
      }
    }
    e.preventDefault();
  }, { passive:false });
  window.addEventListener('touchend', (e)=>{
    for (const t of e.changedTouches){
      if (t.identifier===joyId){
        joyId=null; joyActive=false; joyVec={x:0,y:0}; knob.style.transform='translate(0,0)'; hideStick();
      }
      if (t.identifier===atkId){ atkId=null; firing=false; attackBtn.classList.remove('glow'); }
      if (t.identifier===sklId){ sklId=null; }
    }
  });

  // Attack & Skill buttons
  attackBtn.addEventListener('touchstart', (e)=>{
    if (atkId!==null) return;
    const t = e.changedTouches[0]; atkId = t.identifier; firing=true; attackBtn.classList.add('glow');
    e.preventDefault();
  }, { passive:false });
  attackBtn.addEventListener('touchend', (e)=>{
    for (const t of e.changedTouches){
      if (t.identifier===atkId){ atkId=null; firing=false; attackBtn.classList.remove('glow'); }
    }
  });

  skillBtn.addEventListener('touchstart', (e)=>{
    if (sklId!==null) return;
    const t = e.changedTouches[0]; sklId = t.identifier;
    cur.trySkill(Game.time);
    e.preventDefault();
  }, { passive:false });
  skillBtn.addEventListener('touchend', (e)=>{
    for (const t of e.changedTouches){
      if (t.identifier===sklId){ sklId=null; }
    }
  });

  // Desktop debug
  window.addEventListener('keydown', (e)=>{
    if (e.code==='KeyJ') firing=true;
    if (e.code==='KeyK') cur.trySkill(Game.time);
    if (e.code==='Digit1') switchTo(0);
    if (e.code==='Digit2') switchTo(1);
    if (e.code==='Digit3') switchTo(2);
    if (e.code==='Escape') togglePause();
  });
  window.addEventListener('keyup', (e)=>{
    if (e.code==='KeyJ') firing=false;
  });

  // Pause
  $('#pauseBtn').addEventListener('click', togglePause);
  $('#resumeBtn').addEventListener('click', togglePause);
  $('#restartBtn').addEventListener('click', ()=>{ hideScreen('#pauseScreen'); startRun(true); });
  $('#retryBtn').addEventListener('click', ()=>{ hideScreen('#overScreen'); startRun(true); });
  $('#againBtn').addEventListener('click', ()=>{ hideScreen('#winScreen'); startRun(true); });
  $('#skipBuffBtn').addEventListener('click', ()=>{ hideScreen('#buffScreen'); nextLevel(); });

  function togglePause(){
    if (!Game.running && !Game.paused) return;
    Game.paused = !Game.paused;
    if (Game.paused){ showScreen('#pauseScreen'); } else { hideScreen('#pauseScreen'); last = performance.now(); loop(); }
  }

  // ★★★ 스킬 버튼 테두리 업데이트 (TP≥100 & 쿨타임 완료 시 초록 테두리) ★★★
  function updateSkillReadyHint(){
    const ready = (cur.tp >= 100) && (Game.time >= cur.skillReadyAt);
    // 얇은 초록색 외곽선만 사용해서 다른 이펙트와 충돌 없음
    if (ready){
      skillBtn.style.outline = '2px solid #4cd964';
      skillBtn.style.outlineOffset = '3px';
    } else {
      skillBtn.style.outline = '';
      skillBtn.style.outlineOffset = '';
    }
  }

  // ===== Core Loop =====
  function loop(now=performance.now()){
    if (!Game.running) return;
    const dt = Math.min(0.033, (now - last)/1000); last = now;
    if (Game.paused){ requestAnimationFrame(loop); return; }

    Game.setTime(Game.time + dt);

    ctx.fillStyle = '#0b0f13';
    ctx.fillRect(0,0, vw, vh);

    Game.team.forEach((c,i)=>{ if (i!==Game.currentIdx) c.regen(dt); c.guardTime = Math.max(0, c.guardTime - dt); c.burstTime = Math.max(0, c.burstTime - dt); });

    const base = cur.baseMove * cur.moveSpeedMul;
    const slow = firing ? 0.6 : 1.0;
    const speed = base * slow;
    let mx = joyVec.x, my = joyVec.y;
    if (!joyActive){
      mx = (key('ArrowRight')||key('KeyD')?1:0) - (key('ArrowLeft')||key('KeyA')?1:0);
      my = (key('ArrowDown')||key('KeyS')?1:0) - (key('ArrowUp')||key('KeyW')?1:0);
    }
    const mag = Math.hypot(mx,my) || 1;
    cur.x = clamp(cur.x + mx/mag*speed*dt, 16, vw-16);
    cur.y = clamp(cur.y + my/mag*speed*dt, 16, vh-16);

    attackThink(dt);

    if (Game.level%5!==0){
      spawnTimer -= dt;
      const rate = lerp(0.9, 0.5, clamp(Game.time/Game.levelDuration,0,1));
      if (spawnTimer<=0 && Game.time < Game.levelDuration){
        spawnEnemy();
        spawnTimer = rate;
      }
    } else {
      ensureBoss();
      spawnTimer -= dt;
      if (spawnTimer<=0){
        spawnEnemy(); spawnTimer = 1.2;
      }
    }

    for (const b of Game.bullets) b.update(dt);
    for (const b of Game.ebullets) b.update(dt);

    handleCollisions();

    for (const e of Game.enemies) e.update(dt);

    for (const fx of Game.effects){ if (fx.upd) fx.upd(fx,dt); }

    Game.bullets = Game.bullets.filter(b=>!b.dead);
    Game.ebullets = Game.ebullets.filter(b=>!b.dead);
    Game.effects = Game.effects.filter(fx=> (fx.life? fx.t<fx.life : !fx.dead));
    Game.enemies = Game.enemies.filter(e=>!e.dead);

    drawPlayer(cur);              // <- 플레이어 본체
    for (const e of Game.enemies) e.render();
    for (const b of Game.bullets) b.render();
    for (const b of Game.ebullets) b.render();
    for (const fx of Game.effects){ if (fx.draw) fx.draw(fx); }

    if ((now|0)%3===0) updateTeamBar();

    // ★ 프레임마다 스킬 테두리 갱신
    updateSkillReadyHint();

    checkLevelClear();

    requestAnimationFrame(loop);
  }

  function handleCollisions(){
    // player bullets -> enemies
    for (const b of Game.bullets){
      for (const e of Game.enemies){
        if (circleHit(b.x,b.y,b.r, e.x,e.y,e.r)){
          let dmg = b.dmg * cur.atkMul;
          if (Math.random() < cur.crit) dmg *= 1.8;
          const dead = e.damage(dmg);
          b.passed++;
          if (b.passed > b.pierce) b.dead = true;
          cur.gainTP(1, dead);
          if (dead) spawnText(e.x,e.y,'+TP','#7CFC00');
          break;
        }
      }
    }
    // enemy bullets -> player
    for (const b of Game.ebullets){
      if (circleHit(b.x,b.y,b.r, cur.x,cur.y, 16)){
        if (cur.guardTime<=0) playerHit(b.dmg);
        b.dead=true;
      }
    }
  }

  function attackThink(dt){
    if (!firing && !key('KeyJ')) return;
    cur._rof = (cur._rof||0) - dt * (cur.burstTime>0? 3.0 : 1.0);
    const rof = ROLES[cur.role].rof;
    if (cur._rof <= 0){
      let target=null, best=1e9;
      for (const e of Game.enemies){ const d=h2(e.x-cur.x, e.y-cur.y); if (d<best){ best=d; target=e; } }
      if (target){
        const base = ROLES[cur.role].bullet;
        const pellets = base.pellets || 1;
        for (let i=0;i<pellets;i++){
          const angle = angleTo(cur.x,cur.y, target.x, target.y) + (pellets>1? rand(-1,1)*base.spread*(Math.PI/180) : rand(-1,1)*base.spread*(Math.PI/180));
          const speed = base.speed;
          const b = shootDir(cur.x,cur.y, angle, speed, base.dmg, 'player');
          b.pierce = cur.pierce;
        }
        flashButton(attackBtn, '#66d9ef');
      }
      cur._rof = 1/rof;
    }
  }

  // === NEW: HP 링 색상 & 렌더러 ===
  function hpColor(p){ // p: 0..1
    const h = Math.round(120 * p); // 120=green, 0=red
    return `hsl(${h}, 85%, 55%)`;
  }
  function drawHPRing(cx, cy, radius, ratio){
    // 배경 링
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,.14)';
    ctx.lineWidth = 4;
    ctx.arc(cx, cy, radius, 0, TAU);
    ctx.stroke();
    // 체력 비율 링 (12시 방향 시작)
    ctx.beginPath();
    ctx.strokeStyle = hpColor(ratio);
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    const start = -Math.PI/2;
    ctx.arc(cx, cy, radius, start, start + TAU * ratio);
    ctx.stroke();
  }

  function drawPlayer(c){
    ctx.save();
    ctx.translate(c.x, c.y);
    // 본체
    ctx.fillStyle = c.color;
    ctx.beginPath();
    ctx.arc(0,0, 16, 0, TAU); ctx.fill();

    // 가드 링(내부)
    if (c.guardTime>0){
      ctx.strokeStyle='rgba(255,255,255,.75)'; ctx.lineWidth=2;
      ctx.beginPath(); ctx.arc(0,0, 20, 0, TAU*(c.guardTime/2.5)); ctx.stroke();
    }
    ctx.restore();

    // === NEW: 체력 비율 테두리(외부) ===
    drawHPRing(c.x, c.y, 24, clamp(c.hp / c.maxHP, 0, 1));
  }

  // ===== Keys (desktop) =====
  const Keys = new Set();
  window.addEventListener('keydown', e=>Keys.add(e.code));
  window.addEventListener('keyup', e=>Keys.delete(e.code));
  const key = code => Keys.has(code);

  // ===== Screens =====
  function showScreen(sel){ const el = $(sel); el.style.display='flex'; }
  function hideScreen(sel){ const el = $(sel); el.style.display='none'; }

  function flashButton(el, col){
    el.style.boxShadow = `0 0 16px ${col}, inset 0 0 12px ${col}66`;
    setTimeout(()=>{ el.style.boxShadow=''; }, 80);
  }

  function formatTime(t){
    const s = Math.floor(t%60).toString().padStart(2,'0');
    const m = Math.floor(t/60).toString().padStart(2,'0');
    return `${m}:${s}`;
  }

  // ===== Start Game =====
  function startRun(reset=false){
    if (reset){
      Game.buffs.length=0; renderBuffIcons();
      Game.team = [
        new Character('tank', Game.team[0].portraitUrl),
        new Character('dps',  Game.team[1].portraitUrl),
        new Character('cc',   Game.team[2].portraitUrl),
      ];
      cur = Game.team[0]; Game.currentIdx=0;
      updateTeamBar();
      updateSkillReadyHint(); // 초기 상태 반영
    }
    setupLevel(1);
    Game.running=true; Game.paused=false; Game.win=false; Game.over=false;
    last = performance.now(); requestAnimationFrame(loop);
  }

  // kick off
  startRun(true);
})();
