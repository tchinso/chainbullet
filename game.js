/* Mobile Vertical Bullet-Shmup — reworked
 * Cooldowns -> remaining-timer model (no Game.time drift)
 * Intermission freeze, enemy stat tables, CC stasis, bench regen 10%/s
 */
(() => {
  'use strict';

  // ===== DOM helpers & canvas bootstrap =====
  const $ = sel => document.querySelector(sel);
  const canvas = $('#game');
  const ctx = canvas.getContext('2d', { alpha: false });
  const stage = $('#stage');

  const DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  let vw = 0, vh = 0;
  function resize() {
    const rect = stage.getBoundingClientRect();
    let w = rect.width, h = rect.height;
    const target = 9/16;
    if (w / h > target) w = h * target; else h = w / target;
    vw = w; vh = h;
    canvas.width = Math.round(vw * DPR); canvas.height = Math.round(vh * DPR);
    canvas.style.width = `${vw}px`; canvas.style.height = `${vh}px`;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener('resize', resize, { passive: true });
  resize();

  // ===== Time =====
  let last = performance.now();

  // ===== Utils =====
  const TAU = Math.PI * 2;
  const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
  const rand = (a=1,b)=> (b===undefined? Math.random()*a : a + Math.random()*(b-a));
  const dist = (x1,y1,x2,y2)=>Math.hypot(x1-x2,y1-y2);
  const angleTo = (x1,y1,x2,y2)=>Math.atan2(y2-y1,x2-x1);
  const circleHit = (x1,y1,r1,x2,y2,r2)=> dist(x1,y1,x2,y2) <= (r1+r2);

  const formatTime = (t)=>`${Math.floor(t/60).toString().padStart(2,'0')}:${Math.floor(t%60).toString().padStart(2,'0')}`;
  const f1 = (x)=> (Math.round(x*10)/10).toFixed(1);

  // ===== Game State =====
  const Game = {
    level:1,
    time:0,                   // per-level timer (UI용)
    running:false,
    paused:false,
    over:false,
    win:false,

    // world & entities
    enemies:[], bullets:[], ebullets:[], effects:[],
    team:[], currentIdx:0,

    // flow flags
    nextLevelReady:false, levelGoal:false,
    inBuffChoice:false,      // 버프 선택 중 월드 절대정지
    spawningStopped:false,   // 레벨 클리어 직후 스폰 차단
    stasisTimer:0,           // CC 스킬: 적/적탄 일시정지(초)

    // swap cooldown (remaining seconds)
    swapCdRemain:0,

    setTime(t){ this.time = t; $('#time').textContent = formatTime(t); }
  };

  // ===== Buffs (동일) =====
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
    const bag = ALL_BUFFS.filter(b=> !Game.buffs?.some(x=>x.id===b.id) || ['atk+20','hp+30','move+10','tp+50'].includes(b.id));
    while (picks.length<n && bag.length){
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

  // ===== Roles & Characters =====
  const ROLES = {
    tank: { name:'탱/힐', color:'#4cd964', hp:140, speed:155, rof:5.5, bullet:{ dmg:6, speed:680, spread:8, pellets:4 }, skill:{
      name:'팀 힐+가드', cost:100, cd:14, cast:(self)=>{
        Game.team.forEach(c=>{
          const heal = Math.round(c.maxHP*0.25);
          c.hp = clamp(c.hp + heal, 0, c.maxHP);
          c.guardTime = Math.max(c.guardTime, 2.5);
        });
        spawnText(self.x, self.y-24, '힐링!', '#7CFC00');
      }
    }},
    dps:  { name:'딜러', color:'#66d9ef', hp:90, speed:180, rof:10.0, bullet:{ dmg:7, speed:900, spread:1, pellets:1 }, skill:{
      name:'버스트 사격', cost:100, cd:10, cast:(self)=>{
        self.burstTime = Math.max(self.burstTime, 3.0);
        spawnText(self.x, self.y-24, '버스트!', '#66d9ef');
      }
    }},
    cc:   { name:'CC', color:'#ffd166', hp:110, speed:165, rof:6.5, bullet:{ dmg:8, speed:720, spread:10, pellets:1 }, skill:{
      // 변경: 6초간 모든 적/적탄 정지. cd 6초
      name:'시간 정지', cost:100, cd:6, cast:(self)=>{
        Game.stasisTimer = Math.max(Game.stasisTimer, 6.0);
        spawnText(self.x, self.y-24, '정지!', '#ffd166');
      }
    }},
  };

  class Character {
    constructor(role, portraitUrl){
      const tpl = ROLES[role];
      this.role = role; this.name = tpl.name; this.color = tpl.color;
      this.maxHP = tpl.hp; this.hp = this.maxHP;
      this.baseMove = tpl.speed; this.moveSpeedMul = 1;
      this.atkMul = 1; this.crit = 0.05;
      this.bullet = JSON.parse(JSON.stringify(tpl.bullet));
      this.pierce = 0;

      this.tp = 0; this.tpMax = 100; this.tpGainMul = 1;

      // remaining-timer model
      this.skill = Object.assign({}, tpl.skill);
      this.skillCdMul = 1;
      this.skillCdRemain = 0;

      this.guardTime = 0;
      this.burstTime = 0;
      this.portraitUrl = portraitUrl;

      this.x = vw/2; this.y = vh*0.7;
    }
    get alive(){ return this.hp > 0; }
    regen(dt){
      if (this.hp <= 0) return;
      // 대기 중 재생률은 외부에서 i!==current 조건으로 호출
      this.hp = clamp(this.hp + dt * this.maxHP * 0.10, 0, this.maxHP);
    }
    trySkill(){
      const cost = this.skill.cost;
      if (this.tp >= cost && this.skillCdRemain <= 0){
        this.tp = Math.max(0, this.tp - cost);
        this.skillCdRemain = this.skill.cd * this.skillCdMul;
        this.skill.cast(this);
        flashButton(skillBtn, '#ffd166');
      }
    }
    gainTP(hits=1, kill=false){
      const base = (hits * 3) + (kill? 10: 0);
      this.tp = clamp(this.tp + base * this.tpGainMul, 0, this.tpMax);
    }
  }

  // ===== Team setup =====
  Game.team = [
    new Character('tank', 'https://picsum.photos/seed/tank/200/200'),
    new Character('dps',  'https://picsum.photos/seed/dps/200/200'),
    new Character('cc',   'https://picsum.photos/seed/cc/200/200'),
  ];
  Game.currentIdx = 0;
  let cur = Game.team[0];

  // ===== Entities =====
  class Bullet {
    constructor(x,y,vx,vy,dmg,pierce=0,owner='player'){
      this.x=x; this.y=y; this.vx=vx; this.vy=vy;
      this.r = 6; this.dmg=dmg; this.owner=owner;
      this.pierce=pierce; this.passed=0; this.dead=false;
    }
    update(dt){
      this.x += this.vx * dt; this.y += this.vy * dt;
      if (this.x<-40||this.y<-40||this.x>vw+40||this.y>vh+40) this.dead=true;
    }
    render(){
      ctx.beginPath();
      ctx.fillStyle = (this.owner==='player') ? '#e8faff' : '#ff7676';
      ctx.arc(this.x, this.y, this.r, 0, TAU); ctx.fill();
    }
  }

  const Effects = {
    spark(x,y, col='#fff'){ Game.effects.push({t:0, life:0.18, x,y, col, draw(e){ ctx.fillStyle=e.col; ctx.fillRect(e.x-1, e.y-1, 2,2);} , upd(e,dt){ e.t+=dt; }}); },
    hit(x,y){ for(let i=0;i<6;i++){ Effects.spark(x+rand(-6,6), y+rand(-6,6), '#ffd166'); } },
  };
  function spawnText(x,y, text, col='#fff'){
    Game.effects.push({ text, x, y, vy:-22, t:0, life:1.0, col,
      upd(e,dt){ e.t+=dt; e.y += e.vy*dt; },
      draw(e){ ctx.fillStyle = `rgba(255,255,255,${1-e.t/e.life})`;
        ctx.font='14px sans-serif';
        ctx.fillText(text, e.x-ctx.measureText(text).width/2, e.y);
      }
    });
  }

  // ===== Enemy stat tables =====
  function enemyHP(type, lv){
    const base = 20 + (lv * 10);
    if (type==='shooter') return base + 12;
    if (type==='bomber')  return base - 16;
    return base; // chaser
  }
  function enemySPD(type, lv){
    const base = 60 + (lv * 6);
    if (type==='shooter') return base + 6;
    if (type==='bomber')  return base - 8;
    return base; // chaser
  }
  function dmgShooterBullet(lv){
    if (lv<=5) return 6; if (lv<=10) return 7; if (lv<=15) return 8; return 9;
  }
  function dmgBomberExplode(lv){
    if (lv<=4) return 24; if (lv<=8) return 26; if (lv<=12) return 28; if (lv<=16) return 30; return 32;
  }
  function dmgChaserTouch(lv){
    if (lv<=3) return 10; if (lv<=6) return 11; if (lv<=9) return 12; if (lv<=12) return 13;
    if (lv<=15) return 14; if (lv<=18) return 15; return 16;
  }
  function bossBulletDmg(lv, kind){ // kind: 'fan'|'ring'|'spiral'
    if (lv===5){
      if (kind==='fan') return 8; if (kind==='ring') return 7; return 5.5;
    }
    if (lv===10){
      if (kind==='fan') return 10; if (kind==='ring') return 9; return 7.5;
    }
    if (lv===15){
      if (kind==='fan') return 13; if (kind==='ring') return 12; return 10.5;
    }
    // fallback
    return 8;
  }

  class Enemy {
    constructor(type, x, y, hp, speed){
      this.type=type; this.x=x; this.y=y; this.hp=hp; this.maxHP=hp;
      this.speed=speed; this.r = (type==='boss'? 30 : (type==='elite'? 18 : 14));
      this.fireCooldown = rand(0.6,1.2);
      this.t = 0; this.phase=0;
    }
    damage(d){
      this.hp -= d;
      Effects.hit(this.x,this.y);
      if (this.hp <= 0){
        cur.gainTP(0, true);
        spawnText(this.x,this.y,'+TP','#7CFC00');
        return (this.dead=true);
      }
    }
    update(dt){
      this.t += dt;

      // movement
      const ang = angleTo(this.x,this.y, cur.x, cur.y);
      const spd = this.speed;

      if (this.type==='shooter'){
        const d = dist(this.x,this.y,cur.x,cur.y);
        if (d > 170){ this.x += Math.cos(ang)*spd*dt; this.y += Math.sin(ang)*spd*dt; }
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
            playerHit(dmgBomberExplode(Game.level)); this.dead=true; Effects.hit(this.x,this.y);
          }
        } else if (this.type==='boss'){
          bossPattern(this);
        } else if (this.type==='shooter'){
          const dmg = dmgShooterBullet(Game.level);
          shootAt(this.x,this.y, cur.x,cur.y, 280, dmg, 'enemy');
        }
      }

      // collide with player (bomber은 위 폭발 로직이 우선)
      if (this.type!=='bomber' && circleHit(this.x,this.y,this.r, cur.x,cur.y, 16)){
        const touch = (this.type==='chaser') ? dmgChaserTouch(Game.level) : 10;
        playerHit(touch);
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
    const lv = Game.level;
    const p = (lv%20===0)? 'final' : ['fan','ring','spiral'][b.phase%3];

    if (p==='fan'){
      const dmg = bossBulletDmg(lv, 'fan');
      const a = angleTo(b.x,b.y, cur.x,cur.y);
      for(let i=-2;i<=2;i++) shootDir(b.x,b.y, a+i*0.18, 320, dmg, 'enemy');
    } else if (p==='ring'){
      const dmg = bossBulletDmg(lv, 'ring');
      for(let i=0;i<14;i++){ shootDir(b.x,b.y, i*(TAU/14), 260, dmg, 'enemy'); }
    } else if (p==='spiral'){
      const dmg = bossBulletDmg(lv, 'spiral');
      b._s = (b._s||0)+1.2;
      for(let i=0;i<8;i++) shootDir(b.x,b.y, (i*TAU/8)+b._s*0.15, 300, dmg, 'enemy');
    } else if (p==='final'){
      // 스펙: final spiral 13, final aimed 10.5
      for(let i=0;i<18;i++) shootDir(b.x,b.y, (i*TAU/18)+Math.random()*0.1, 300+Math.random()*80, 13, 'enemy'); // spiral-ish
      const a = angleTo(b.x,b.y, cur.x,cur.y);
      for(let i=-1;i<=1;i++) shootDir(b.x,b.y, a+i*0.08, 420, 10.5, 'enemy'); // aimed
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

  // ===== Level / Spawning =====
  let spawnTimer=0, boss=null;
  function setupLevel(lv){
    Game.level = lv; $('#lvl').textContent = lv;
    Game.setTime(0);
    Game.enemies.length=0; Game.bullets.length=0; Game.ebullets.length=0; Game.effects.length=0;
    Game.over=false; Game.levelGoal=false; Game.nextLevelReady=false; Game.spawningStopped=false; boss=null;

    cur.x = vw/2; cur.y = vh*0.78;

    Game.levelDuration = (lv<5? 35 : lv<10? 45 : lv<15? 55 : lv<20? 65 : 75);
    spawnTimer = 0;

    // 진입 회복 (5/10/15/20 → 30%, 그 외 20%)
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

    // 타입 분포는 기존 로직 유지
    let type='chaser';
    const r = Math.random();
    if (r < (0.15+lv*0.01)) type='shooter';
    else if (r < (0.22+lv*0.015)) type='bomber';

    const hp = Math.round(enemyHP(type, lv));
    const sp = enemySPD(type, lv);
    Game.enemies.push(new Enemy(type, x,y, hp, sp));
  }

  function ensureBoss(){
    if (boss) return;
    const lv = Game.level;
    if (lv%5===0){
      const hp = 600 + (40 * lv * lv); // 스펙 반영
      boss = new Enemy('boss', vw/2, vh*0.2, hp, 30 + lv*2);
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
        Game.spawningStopped = true;     // 즉시 스폰 차단
        showBuffChoice();                 // 월드 정지 & 선택
      }
    } else {
      if (boss && boss.dead){
        Game.win = true;
        showScreen('#winScreen');
        Game.running=false;
      }
    }
  }

  function showScreen(sel){ const el = document.querySelector(sel); el.style.display='flex'; }
  function hideScreen(sel){ const el = document.querySelector(sel); el.style.display='none'; }

  function showBuffChoice(){
    // 월드 절대정지 (타이머/시간도 멈춤)
    Game.inBuffChoice = true;

    const choices = rollBuffs(3);
    const wrap = $('#buffChoices'); wrap.innerHTML='';
    choices.forEach(b=>{
      const el = document.createElement('div'); el.className='pick';
      el.innerHTML = `<div style="font-weight:700; margin-bottom:6px">${b.name}</div><div class="muted">${b.desc}</div>`;
      el.addEventListener('click', ()=>{
        addBuff(b);
        Game.inBuffChoice = false;       // 해제
        hideScreen('#buffScreen');
        nextLevel();
      }, { passive: true });
      wrap.appendChild(el);
    });
    showScreen('#buffScreen');
  }
  $('#skipBuffBtn').addEventListener('click', ()=>{
    Game.inBuffChoice = false;
    hideScreen('#buffScreen');
    nextLevel();
  });

  function nextLevel(){ setupLevel(Game.level+1); }

  // ===== Player damage & death swap =====
  function playerHit(dmg){
    if (cur.guardTime>0) return;
    cur.hp -= dmg;
    if (cur.hp <= 0){
      cur.hp = 0;
      const next = Game.team.findIndex((c,i)=> i!==Game.currentIdx && c.alive);
      if (next>=0){
        switchTo(next, /*fromDeath*/true);
        spawnText(cur.x, cur.y, '교대!', '#fff');
      } else {
        Game.over = true;
        Game.running=false;
        showScreen('#overScreen');
      }
    }
    updateTeamBar();
  }

  // ===== HUD: portraits & switching =====
  const teamBar = $('#team-bar');
  function positionTeamBar(){
    teamBar.style.position = 'absolute';
    teamBar.style.left = '12px';
    teamBar.style.bottom = `${Math.round(Math.max(90, vh*0.12))}px`;
    teamBar.style.justifyContent = 'flex-start';
  }
  window.addEventListener('resize', positionTeamBar, { passive:true });

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
        <div class="role" style="border-color:${ROLES[c.role].color}; color:${ROLES[c.role].color}">${ROLES[c.role].name}</div>`;
      p.addEventListener('touchstart', (e)=>{ e.preventDefault(); requestSwitch(i); }, { passive:false });
      p.addEventListener('click', ()=> requestSwitch(i));
      teamBar.appendChild(p);
    });
    positionTeamBar();
  }

  function canSwitchNow(){ return Game.swapCdRemain <= 0; }
  function requestSwitch(i){
    if (i===Game.currentIdx) return;
    if (!canSwitchNow()){
      spawnText(cur.x, cur.y - 30, `교대 대기 ${f1(Game.swapCdRemain)}s`, '#ffd166');
      return;
    }
    switchTo(i, /*fromDeath*/false);
  }
  function switchTo(i, fromDeath=false){
    if (i===Game.currentIdx) return;
    Game.currentIdx = i; cur = Game.team[i];
    // 교체 무적
    cur.guardTime = Math.max(cur.guardTime, 1.2);
    // 수동 교체만 5초 쿨다운
    if (!fromDeath) Game.swapCdRemain = Math.max(Game.swapCdRemain, 5.0);
    updateTeamBar();
    updateSkillReadyHint();
  }

  // ===== Controls =====
  const stickZone = $('#stick-zone');
  const attackBtn = $('#attackBtn');
  const skillBtn = $('#skillBtn');
  const stickRoot = $('#stick'); const knob = stickRoot.querySelector('.knob');

  let joyId = null, joyBase = {x:0,y:0}, joyVec={x:0,y:0}, joyActive=false;
  let atkId = null, sklId = null;
  let firing=false;

  function localPos(el, touch){ const r = el.getBoundingClientRect(); return { x: touch.clientX - r.left, y: touch.clientY - r.top }; }
  function showStick(x,y){ stickRoot.style.display='block'; stickRoot.style.left=`${x-70}px`; stickRoot.style.top=`${y-70}px`; }
  function hideStick(){ stickRoot.style.display='none'; }

  // joystick
  stickZone.addEventListener('touchstart', (e)=>{
    for (const t of e.changedTouches){
      if (joyId===null){
        joyId=t.identifier; joyActive=true;
        const p=localPos(stickZone,t); joyBase={x:p.x,y:p.y}; showStick(p.x,p.y);
      }
    }
  }, { passive:false });
  window.addEventListener('touchmove', (e)=>{
    for (const t of e.changedTouches){
      if (t.identifier===joyId){
        const p=localPos(stickZone,t);
        let dx=p.x-joyBase.x, dy=p.y-joyBase.y; const m=Math.hypot(dx,dy), R=50;
        if (m>R){ dx=dx/m*R; dy=dy/m*R; }
        knob.style.transform = `translate(${dx}px, ${dy}px)`; joyVec={x:dx/R, y:dy/R};
      }
    }
    e.preventDefault();
  }, { passive:false });
  window.addEventListener('touchend', (e)=>{
    for (const t of e.changedTouches){
      if (t.identifier===joyId){ joyId=null; joyActive=false; joyVec={x:0,y:0}; knob.style.transform='translate(0,0)'; hideStick(); }
      if (t.identifier===atkId){ atkId=null; firing=false; attackBtn.classList.remove('glow'); }
      if (t.identifier===sklId){ sklId=null; }
    }
  });

  attackBtn.addEventListener('touchstart', (e)=>{
    if (atkId!==null) return;
    const t=e.changedTouches[0]; atkId=t.identifier; firing=true; attackBtn.classList.add('glow');
    e.preventDefault();
  }, { passive:false });
  attackBtn.addEventListener('touchend', (e)=>{
    for (const t of e.changedTouches){ if (t.identifier===atkId){ atkId=null; firing=false; attackBtn.classList.remove('glow'); } }
  });

  skillBtn.addEventListener('touchstart', (e)=>{
    if (sklId!==null) return;
    const t=e.changedTouches[0]; sklId=t.identifier;
    cur.trySkill();
    e.preventDefault();
  }, { passive:false });
  skillBtn.addEventListener('touchend', (e)=>{
    for (const t of e.changedTouches){ if (t.identifier===sklId){ sklId=null; } }
  });

  // Desktop debug
  const Keys = new Set();
  window.addEventListener('keydown', (e)=>{
    Keys.add(e.code);
    if (e.code==='KeyJ') firing=true;
    if (e.code==='KeyK') cur.trySkill();
    if (e.code==='Digit1') requestSwitch(0);
    if (e.code==='Digit2') requestSwitch(1);
    if (e.code==='Digit3') requestSwitch(2);
    if (e.code==='Escape') togglePause();
  });
  window.addEventListener('keyup', (e)=>{
    Keys.delete(e.code);
    if (e.code==='KeyJ') firing=false;
  });
  const key = code => Keys.has(code);

  // Pause
  $('#pauseBtn').addEventListener('click', togglePause);
  $('#resumeBtn').addEventListener('click', togglePause);
  $('#restartBtn').addEventListener('click', ()=>{ hideScreen('#pauseScreen'); startRun(true); });
  $('#retryBtn').addEventListener('click', ()=>{ hideScreen('#overScreen'); startRun(true); });
  $('#againBtn').addEventListener('click', ()=>{ hideScreen('#winScreen'); startRun(true); });

  function togglePause(){
    if (!Game.running && !Game.paused) return;
    Game.paused = !Game.paused;
    if (Game.paused){ showScreen('#pauseScreen'); }
    else { hideScreen('#pauseScreen'); last = performance.now(); loop(); }
  }

  // Skill ready outline
  function updateSkillReadyHint(){
    const ready = (cur.tp >= cur.skill.cost) && (cur.skillCdRemain <= 0);
    if (ready){
      skillBtn.style.outline = '2px solid #4cd964';
      skillBtn.style.outlineOffset = '3px';
    } else {
      skillBtn.style.outline = '';
      skillBtn.style.outlineOffset = '';
    }
  }

  // ===== Collision, combat, rendering =====
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

  function hpColor(p){ const h = Math.round(120 * p); return `hsl(${h}, 85%, 55%)`; }
  function drawHPRing(cx, cy, radius, ratio){
    ctx.beginPath(); ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 4; ctx.arc(cx, cy, radius, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.strokeStyle = hpColor(ratio); ctx.lineWidth = 5; ctx.lineCap = 'round';
    const start = -Math.PI/2; ctx.arc(cx, cy, radius, start, start + TAU * ratio); ctx.stroke();
  }
  function drawPlayer(c){
    ctx.save(); ctx.translate(c.x, c.y);
    ctx.fillStyle = c.color; ctx.beginPath(); ctx.arc(0,0, 16, 0, TAU); ctx.fill();
    if (c.guardTime>0){ ctx.strokeStyle='rgba(255,255,255,.75)'; ctx.lineWidth=2; ctx.beginPath(); ctx.arc(0,0, 20, 0, TAU*(c.guardTime/2.5)); ctx.stroke(); }
    ctx.restore();
    drawHPRing(c.x, c.y, 24, clamp(c.hp / c.maxHP, 0, 1));
  }

  function attackThink(dt){
    if (!firing && !key('KeyJ')) return;
    cur._rof = (cur._rof||0) - dt * (cur.burstTime>0? 3.0 : 1.0);
    const rof = ROLES[cur.role].rof;
    if (cur._rof <= 0){
      let target=null, best=1e9;
      for (const e of Game.enemies){ const d=(e.x-cur.x)*(e.x-cur.x) + (e.y-cur.y)*(e.y-cur.y); if (d<best){ best=d; target=e; } }
      if (target){
        const base = ROLES[cur.role].bullet;
        const pellets = base.pellets || 1;
        for (let i=0;i<pellets;i++){
          const angle = angleTo(cur.x,cur.y, target.x, target.y) + rand(-1,1)*base.spread*(Math.PI/180);
          const b = shootDir(cur.x,cur.y, angle, base.speed, base.dmg, 'player');
          b.pierce = cur.pierce;
        }
        flashButton(attackBtn, '#66d9ef');
      }
      cur._rof = 1/rof;
    }
  }

  // ===== Core Loop =====
  function loop(now=performance.now()){
    if (!Game.running) return;
    const rawDt = Math.min(0.033, (now - last)/1000); last = now;

    // hard pauses
    if (Game.paused){ requestAnimationFrame(loop); return; }
    if (Game.inBuffChoice){ // 버프 선택 중: 월드 완전 정지 (시간/타이머 포함)
      requestAnimationFrame(loop); return;
    }

    // world dt
    const dt = rawDt;

    // UI time
    Game.setTime(Game.time + dt);

    // Clear BG
    ctx.fillStyle = '#0b0f13'; ctx.fillRect(0,0, vw, vh);

    // timers — remaining model
    Game.swapCdRemain = Math.max(0, Game.swapCdRemain - dt);
    Game.team.forEach((c,i)=>{
      c.skillCdRemain = Math.max(0, c.skillCdRemain - dt);
      if (i!==Game.currentIdx) c.regen(dt); // 벤치 10%/s
      c.guardTime = Math.max(0, c.guardTime - dt);
      c.burstTime = Math.max(0, c.burstTime - dt);
    });

    // stasis (적/적탄만 정지)
    const enemyDt = (Game.stasisTimer>0)? 0 : dt;
    if (Game.stasisTimer>0) Game.stasisTimer = Math.max(0, Game.stasisTimer - dt);

    // movement
    const base = cur.baseMove * cur.moveSpeedMul;
    const slow = (firing ? 0.6 : 1.0);
    const speed = base * slow;
    let mx = joyVec.x, my = joyVec.y;
    if (!joyActive){
      mx = (key('ArrowRight')||key('KeyD')?1:0) - (key('ArrowLeft')||key('KeyA')?1:0);
      my = (key('ArrowDown')||key('KeyS')?1:0) - (key('ArrowUp')||key('KeyW')?1:0);
    }
    const mag = Math.hypot(mx,my) || 1;
    cur.x = clamp(cur.x + mx/mag*speed*dt, 16, vw-16);
    cur.y = clamp(cur.y + my/mag*speed*dt, 16, vh-16);

    // attack
    attackThink(dt);

    // spawn
    if (!Game.spawningStopped){
      if (Game.level%5!==0){
        spawnTimer -= dt;
        const rate = (Game.time < Game.levelDuration)? (0.9 - 0.4*clamp(Game.time/Game.levelDuration,0,1)) : 999;
        if (spawnTimer<=0 && Game.time < Game.levelDuration){ spawnEnemy(); spawnTimer = rate; }
      } else {
        ensureBoss();
        spawnTimer -= dt;
        if (spawnTimer<=0){ spawnEnemy(); spawnTimer = 1.2; }
      }
    }

    // update bullets
    for (const b of Game.bullets) b.update(dt);
    for (const b of Game.ebullets) b.update(enemyDt); // 스테이시스 적용

    // collisions (스테이시스 중엔 적탄 위치가 고정되어 충돌도 고정)
    if (enemyDt>0) handleCollisions();
    else {
      // 플레이어탄은 계속 날아가므로 적 피격만 검사
      // (원한다면 완전 정지를 위해 아래 한 줄을 주석 해제)
      // /* skip player->enemy hits during stasis? keep as is for now */
      handleCollisions();
    }

    // update enemies/effects
    for (const e of Game.enemies) if (enemyDt>0) e.update(enemyDt);
    for (const fx of Game.effects){ if (fx.upd) fx.upd(fx,dt); }

    // culling
    Game.bullets = Game.bullets.filter(b=>!b.dead);
    Game.ebullets = Game.ebullets.filter(b=>!b.dead);
    Game.effects = Game.effects.filter(fx=> (fx.life? fx.t<fx.life : !fx.dead));
    Game.enemies = Game.enemies.filter(e=>!e.dead);

    // draw
    drawPlayer(cur);
    for (const e of Game.enemies) e.render();
    for (const b of Game.bullets) b.render();
    for (const b of Game.ebullets) b.render();
    for (const fx of Game.effects){ if (fx.draw) fx.draw(fx); }

    // HUD pulse
    if ((now|0)%3===0) updateTeamBar();
    updateSkillReadyHint();

    // flow
    checkLevelClear();

    requestAnimationFrame(loop);
  }

  function flashButton(el, col){
    el.style.boxShadow = `0 0 16px ${col}, inset 0 0 12px ${col}66`;
    setTimeout(()=>{ el.style.boxShadow=''; }, 80);
  }

  // ===== Start =====
  function startRun(reset=false){
    if (reset){
      Game.buffs = []; renderBuffIcons();
      Game.team = [
        new Character('tank', Game.team[0].portraitUrl),
        new Character('dps',  Game.team[1].portraitUrl),
        new Character('cc',   Game.team[2].portraitUrl),
      ];
      cur = Game.team[0]; Game.currentIdx=0;
      Game.swapCdRemain = 0;
      updateTeamBar(); updateSkillReadyHint();
    }
    setupLevel(1);
    Game.running=true; Game.paused=false; Game.win=false; Game.over=false; Game.inBuffChoice=false; Game.stasisTimer=0;
    last = performance.now(); requestAnimationFrame(loop);
  }

  // kick off
  startRun(true);
})();
