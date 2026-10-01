/* FTT Poomsae — Remote Judge QR / Phone Interface */
let judgePeer = null;
let judgeConnections = {};
let judgeRuntime = { currentSession: "", connected: 0 };
let ctxMatForHeader = Number(new URLSearchParams(location.search).get("mat")) || 1;

function judgeRandomToken(){
  if(window.crypto?.getRandomValues){const a=new Uint32Array(3);crypto.getRandomValues(a);return [...a].map(x=>x.toString(36)).join("");}
  return Math.random().toString(36).slice(2)+Date.now().toString(36);
}
function judgeNewSessionId(){return "S"+Date.now().toString(36)+judgeRandomToken().slice(0,6);}
function judgeIsPhone(){return new URLSearchParams(location.search).get("judge")==="1";}
function judgeParams(){const q=new URLSearchParams(location.search);return {peer:q.get("peer")||"",judge:Number(q.get("j")||0),token:q.get("t")||"",mat:Number(q.get("mat")||0)||1};}
function judgeBaseUrl(){return location.origin+location.pathname;}

function ensureJudgePeer(){
  if(typeof Peer!=="function")return;
  if(judgePeer && !judgePeer.destroyed)return;
  const desired=(STATE.judgeQr?.peerId)||("ftt-poomsae-"+judgeRandomToken().slice(0,12));
  judgePeer=new Peer(desired,{debug:0});
  judgePeer.on("open",id=>{
    STATE.judgeQr=STATE.judgeQr||{peerId:"",tokens:{},deleted:{},sessionId:"",scores:{}};
    STATE.judgeQr.peerId=id;
    STATE.collectorQr=STATE.collectorQr||{peerId:"",token:"",deleted:false}; STATE.collectorQr.peerId=id;
    saveState();
    judgeSendContext();
    if(document.getElementById("judgesQrOverlay")){ openJudgesQR(true); setTimeout(judgeRenderAllQRCodes,50); }
    if(document.getElementById("collectorQrOverlay")){ ensureCollectorQr(); renderCollectorQRCode(); }
  });
  judgePeer.on("connection",conn=>{
    conn.on("open",()=>{
      const data=conn.metadata||{};
      const role=String(data.role||"judge");
      if(role==="collector") {
        const token=String(data.token||"");
        if(!token || token!==String(STATE.collectorQr?.token||"")){conn.close();return;}
        window.collectorConnection=conn;
        conn.on("data",msg=>{ if(msg?.type==="COLLECTOR_SCORES") judgeReceiveCollectorScores(msg); });
        conn.on("close",()=>{if(window.collectorConnection===conn)window.collectorConnection=null;});
        conn.send({type:"COLLECTOR_CONTEXT",...judgeContextPayload()});
        judgeUpdateQrStatuses();
        return;
      }
      const j=Number(data.judge||0), token=String(data.token||"");
      if(!j || STATE.judgeQr?.tokens?.[j]!==token){conn.close();return;}
      judgeConnections[j]=conn;
      conn.on("data",msg=>judgeReceive(msg,j));
      conn.on("close",()=>{delete judgeConnections[j];judgeUpdateQrStatuses();});
      conn.send({type:"CONTEXT",...judgeContextPayload()});
      judgeUpdateQrStatuses();
    });
    conn.on("error",()=>{});
  });
  judgePeer.on("error",e=>{console.warn("Judge peer",e); if(e?.type==="unavailable-id"){ try{judgePeer.destroy()}catch(_){} STATE.judgeQr=STATE.judgeQr||{peerId:"",tokens:{},deleted:{},sessionId:"",scores:{}}; STATE.judgeQr.peerId=""; setTimeout(ensureJudgePeer,250); }});
}
function judgeReceiveCollectorScores(msg){
  if(!msg || msg.type!=="COLLECTOR_SCORES") return;
  if(String(msg.token)!==String(STATE.collectorQr?.token||"")) return;
  if(msg.sessionId!==STATE.judgeQr?.sessionId) return;
  if(STATE.state!==STATES.CALCULATING && STATE.state!==STATES.ROUND_RUNNING) return;
  const incoming=msg.scores||{};
  const count=Number(STATE.judgeCount||0);
  const next={};
  for(let j=1;j<=count;j++){
    const raw=incoming[j]||incoming[String(j)];
    if(!raw) return;
    const a=Number(raw.accuracy), p=Number(raw.presentation);
    const parts=raw.parts||{};
    const vals=[parts.speedPower,parts.rhythmTempo,parts.expressionEnergy].map(Number);
    if(!Number.isFinite(a)||a<0||a>4) return;
    if(vals.some(v=>!Number.isFinite(v)||v<0.5||v>2)) return;
    const presentation=Number((vals[0]+vals[1]+vals[2]).toFixed(1));
    if(Math.abs(presentation-p)>0.001) return;
    next[j]={accuracy:Number(a.toFixed(1)),presentation,parts:{speedPower:vals[0],rhythmTempo:vals[1],expressionEnergy:vals[2]},receivedAt:Date.now(),sessionId:msg.sessionId,source:"collector"};
  }
  STATE.judgeQr.scores=next;
  saveState();
  for(let j=1;j<=count;j++){
    const ai=j-1, s=next[j];
    const acc=document.getElementById(`acc${ai}`), pres=document.getElementById(`pres${ai}`);
    if(acc) acc.value=Number(s.accuracy).toFixed(3);
    if(pres) pres.value=Number(s.presentation).toFixed(3);
  }
  updateJudgeSubmitButton?.();
  judgeUpdateQrStatuses();
  broadcast?.();
}

function judgeReceive(msg,j){
  if(!msg||msg.type!=="SCORE")return;
  if(String(msg.token)!==String(STATE.judgeQr?.tokens?.[j]||""))return;
  if(msg.sessionId!==STATE.judgeQr?.sessionId)return;
  const a=msg.accuracy, p=msg.presentation;
  if(!Number.isFinite(Number(a))||Number(a)<0||Number(a)>4)return;
  const parts=msg.parts||{};
  const vals=[parts.speedPower,parts.rhythmTempo,parts.expressionEnergy].map(Number);
  if(vals.some(v=>!Number.isFinite(v)||v<0.5||v>2))return;
  const presentation=Number((vals[0]+vals[1]+vals[2]).toFixed(1));
  if(Math.abs(presentation-Number(p))>0.001)return;
  STATE.judgeQr.scores[j]={accuracy:Number(a),presentation,parts:{speedPower:vals[0],rhythmTempo:vals[1],expressionEnergy:vals[2]},receivedAt:Date.now(),sessionId:msg.sessionId};
  saveState();
  if(window.collectorConnection?.open){try{window.collectorConnection.send({type:"COLLECTOR_CONTEXT",...judgeContextPayload({scoreReceived:true,judge:j})});}catch(_){} }
  const ai=j-1;
  const acc=document.getElementById(`acc${ai}`),pres=document.getElementById(`pres${ai}`);
  if(acc)acc.value=Number(a).toFixed(3);
  if(pres)pres.value=presentation.toFixed(3);
  updateJudgeSubmitButton?.();
  judgeUpdateQrStatuses();
  renderJudgeRemoteToast?.(j);
}
function judgeContextPayload(extra={}){
  const a=currentAthlete?.();
  const p=currentRoundPoomsae?.();
  return {type:"CONTEXT",sessionId:STATE.judgeQr?.sessionId||"",active:STATE.state===STATES.ROUND_RUNNING||STATE.state===STATES.CALCULATING,scoringOpen:STATE.state===STATES.ROUND_RUNNING||STATE.state===STATES.CALCULATING,round:STATE.currentRound,athlete:a?.name||"",club:a?.club||"",poomsae:WT_DATA.poomsae[p]||p||"",competition:STATE.competitionName||"FTT POOMSAE",matNumber:STATE.matNumber||1,judgeScores:STATE.judgeQr?.scores||{},judgeCount:Number(STATE.judgeCount||0),judgeNames:STATE.judgeNames||{},...extra};
}
function judgeSendContext(extra={}){
  if(!judgeConnections)return;
  const payload=judgeContextPayload(extra);
  Object.values(judgeConnections).forEach(c=>{try{if(c.open)c.send(payload)}catch(e){}});
}
function judgeGenerateTokens(){
  STATE.judgeQr=STATE.judgeQr||{peerId:"",tokens:{},deleted:{},sessionId:"",scores:{}};
  STATE.judgeQr.tokens={};STATE.judgeQr.deleted={};STATE.judgeQr.scores={};
  for(let i=1;i<=Number(STATE.judgeCount||0);i++)STATE.judgeQr.tokens[i]=judgeRandomToken();
  saveState();ensureJudgePeer();openJudgesQR(true);
}
function judgeRegenerateOne(j){
  STATE.judgeQr=STATE.judgeQr||{peerId:"",tokens:{},deleted:{},sessionId:"",scores:{}};
  STATE.judgeQr.tokens[j]=judgeRandomToken();
  STATE.judgeQr.deleted[j]=false;
  delete STATE.judgeQr.scores[j];
  try{judgeConnections[j]?.close()}catch(e){}
  delete judgeConnections[j];saveState();openJudgesQR(true);
}
function judgeDeleteOne(j){
  if(!confirmAction(`DELETE QR FOR JUDGE ${j}?`))return;
  STATE.judgeQr=STATE.judgeQr||{peerId:"",tokens:{},deleted:{},sessionId:"",scores:{}};
  delete STATE.judgeQr.tokens[j];STATE.judgeQr.deleted[j]=true;delete STATE.judgeQr.scores[j];
  try{judgeConnections[j]?.close()}catch(e){} delete judgeConnections[j];
  saveState();openJudgesQR(true);
}
function judgeUpdateQrStatuses(){
  Object.keys(STATE.judgeQr?.tokens||{}).forEach(j=>{const connected=!!judgeConnections[j]?.open, scored=!!STATE.judgeQr?.scores?.[j];const el=document.getElementById(`judgeQrStatus${j}`);if(el){el.textContent=scored?"SCORE RECEIVED":connected?"CONNECTED":"WAITING";el.classList.toggle("connected",connected||scored);}const op=document.querySelector(`.operatorJudgeStatusItem[data-judge="${j}"]`);if(op){op.classList.toggle("online",connected);op.classList.toggle("scored",scored);const st=op.querySelector("span");if(st)st.textContent=scored?"SCORE RECEIVED":connected?"CONNECTED":"WAITING";}});
  const cs=document.getElementById("collectorQrStatus");if(cs)cs.textContent=window.collectorConnection?.open?"CONNECTED":"WAITING";
}
function judgeQrUrl(j){
  const base=judgeBaseUrl();
  const peer=STATE.judgeQr?.peerId||"";
  return `${base}?judge=1&peer=${encodeURIComponent(peer)}&j=${j}&t=${encodeURIComponent(STATE.judgeQr.tokens[j]||"")}&mat=${encodeURIComponent(Number(STATE.matNumber)||1)}`;
}
function openJudgesQR(regenerate=false){
  if(location.protocol==="file:")return alert("JUDGES QR requires the project to be opened from GitHub Pages, Netlify, or a local web server (not directly as a file).");
  if(!STATE.setupComplete)return alert("Complete the Competition Setup first.");
  ensureJudgePeer();
  STATE.judgeQr=STATE.judgeQr||{peerId:"",tokens:{},deleted:{},sessionId:"",scores:{}};
  if(!Object.keys(STATE.judgeQr.tokens||{}).length || Object.keys(STATE.judgeQr.tokens||{}).length!==Number(STATE.judgeCount||0)){
    STATE.judgeQr.tokens={};STATE.judgeQr.deleted={};STATE.judgeQr.scores={};for(let i=1;i<=STATE.judgeCount;i++)STATE.judgeQr.tokens[i]=judgeRandomToken();saveState();
  }
  const old=document.getElementById("judgesQrOverlay");if(old)old.remove();
  const overlay=document.createElement("div");overlay.id="judgesQrOverlay";overlay.className="judgeQrOverlay";
  overlay.innerHTML=`<div class="judgeQrModal"><div class="judgeQrHeader"><div><div class="phaseTag">REMOTE JUDGES</div><h2>JUDGES QR</h2><p>Chaque juge scanne uniquement son QR code avec son téléphone.</p></div><button class="btn" onclick="document.getElementById('judgesQrOverlay')?.remove()">CLOSE</button></div><div class="judgeQrGrid">${Array.from({length:Number(STATE.judgeCount||0)},(_,idx)=>{const j=idx+1;const hasQr=!!STATE.judgeQr.tokens?.[j];return `<div class="judgeQrCard"><div class="judgeQrCardTop"><div><strong>JUDGE ${j}</strong><small class="judgeQrName" data-judge-name="${j}">${esc(STATE.judgeNames?.[j]||"NAME NOT SET")}</small></div><span id="judgeQrStatus${j}" class="judgeQrStatus">${hasQr?(judgeConnections[j]?.open?"CONNECTED":"WAITING"):"QR DELETED"}</span></div>${hasQr?`<div id="judgeQr${j}" class="judgeQrImage"></div><div class="judgeQrHint">SCAN WITH PHONE</div>`:`<div class="judgeQrImage judgeQrDeleted"><span>QR<br>DELETED</span></div><div class="judgeQrHint">GENERATE A NEW CODE</div>`}<label class="judgeQrNameEditor">NOM DU JUGE ${j}<input type="text" value="${esc(STATE.judgeNames?.[j]||"")}" placeholder="Nom et prénom du juge ${j}" oninput="judgeSetName(${j},this.value)"></label><div class="judgeQrActions"><button class="btn" onclick="judgeRegenerateOne(${j})">${hasQr?"CHANGE QR":"GENERATE QR"}</button><button class="btn danger" onclick="judgeDeleteOne(${j})" ${hasQr?"":"disabled"}>DELETE</button></div></div>`}).join("")}</div><div class="judgeQrFooter"><span>PEER CONNECTION: <b>${esc(STATE.judgeQr.peerId||"CONNECTING...")}</b></span><button class="btn primary" onclick="judgeGenerateTokens()">REGENERATE ALL QR</button></div></div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(()=>judgeRenderAllQRCodes());
  setTimeout(()=>{ judgeRenderAllQRCodes(); judgeUpdateQrStatuses(); },250);
}

function judgeRenderAllQRCodes(){
  for(let j=1;j<=Number(STATE.judgeCount||0);j++){
    const box=document.getElementById(`judgeQr${j}`);
    if(!box || !STATE.judgeQr.tokens?.[j]) continue;
    const text=judgeQrUrl(j);
    box.innerHTML="";
    try{
      if(typeof window.QRCode === "function"){
        new QRCode(box,{text,width:190,height:190,colorDark:"#07111d",colorLight:"#ffffff",correctLevel:QRCode.CorrectLevel.M});
        if(box.children.length)continue;
      }
    }catch(e){ console.warn("QRCode library failed",e); }
    // Reliable fallback: render the QR through a public QR image endpoint.
    const img=document.createElement("img");
    img.alt=`QR CODE JUGE ${j}`;
    img.width=190; img.height=190;
    img.referrerPolicy="no-referrer";
    img.src=`https://api.qrserver.com/v1/create-qr-code/?size=190x190&margin=8&data=${encodeURIComponent(text)}`;
    img.onerror=()=>{box.innerHTML='<div style="font-size:12px;text-align:center;color:#667789;padding:25px">QR IMAGE UNAVAILABLE<br><small>Check internet connection</small></div>';};
    box.appendChild(img);
  }
}

function judgePhoneSend(type,data){
  if(window._judgePhoneScoringOpen!==true){judgePhoneToast("SCORING NOT OPEN",true);return;}
  const {peer,judge,token}=judgeParams();
  if(!peer||!judge||!token){judgePhoneToast("Invalid judge link",true);return;}
  if(!window._judgePhoneConn||!window._judgePhoneConn.open){judgePhoneToast("Not connected to operator",true);return;}
  window._judgePhoneConn.send({type,...data,judge,token,sessionId:window._judgePhoneSession||""});
  if(type==="SCORE"){window._judgePhoneSent=true;judgePhoneRenderSent();}
}
function judgePhoneToast(msg,error=false){const el=document.getElementById("judgePhoneToast");if(!el)return;el.textContent=msg;el.className=`judgePhoneToast show ${error?"error":""}`;clearTimeout(window._judgeToastTimer);window._judgeToastTimer=setTimeout(()=>el.classList.remove("show"),1800);}
function judgePhoneRenderSent(){const b=document.getElementById("judgePhoneSend");if(b){b.textContent="✓ SCORE SENT";b.classList.add("sent");}}
function judgePhoneClamp(){window._judgePhoneAcc=Math.max(0,Math.min(4,Math.round((window._judgePhoneAcc+Number(window._judgePhoneDelta||0))*10)/10));window._judgePhoneDelta=0;const el=document.getElementById("judgeAccuracyValue");if(el)el.textContent=window._judgePhoneAcc.toFixed(1);}
function judgePhoneAdjust(delta){if(window._judgePhoneScoringOpen!==true)return;window._judgePhoneDelta=Number(delta)||0;judgePhoneClamp();window._judgePhoneSent=false;judgePhoneRenderReset();}
function judgePhoneSetPart(key,value){if(window._judgePhoneScoringOpen!==true)return;if(!window._judgePhoneParts)window._judgePhoneParts={speedPower:2,rhythmTempo:2,expressionEnergy:2};const next=Math.max(0.5,Math.min(2,Math.round(Number(value)*10)/10));window._judgePhoneParts[key]=next;const control=document.querySelector(`[data-part-control="${key}"]`);if(control)control.innerHTML=judgePhoneBuildValues(key);else{const el=document.querySelector(`[data-part-value="${key}"]`);if(el)el.textContent=next.toFixed(1);}const total=Object.values(window._judgePhoneParts).reduce((s,v)=>s+v,0);const t=document.getElementById("judgePresentationTotal");if(t)t.textContent=total.toFixed(1);window._judgePhoneSent=false;judgePhoneRenderReset();}
function renderJudgeRemoteToast(j){ const box=document.getElementById("judgeQrStatus"+j); if(box){box.textContent="SCORE RECEIVED";box.classList.add("connected");setTimeout(()=>judgeUpdateQrStatuses(),1300);} }
function judgePhoneRenderReset(){const b=document.getElementById("judgePhoneSend");if(b){b.textContent="SEND SCORE";b.classList.remove("sent");}}
function judgePhoneAdjustPart(key,delta){if(window._judgePhoneScoringOpen!==true)return;if(!window._judgePhoneParts)window._judgePhoneParts={speedPower:2,rhythmTempo:2,expressionEnergy:2};const current=Number(window._judgePhoneParts[key]||2);judgePhoneSetPart(key,current+Number(delta||0));}
function judgePhoneBuildValues(key,open=window._judgePhoneScoringOpen!==false){const value=Number(window._judgePhoneParts[key]||2);const locked=!open;return `<button type="button" class="partAdjust partMinus" ${value<=0.5||locked?"disabled":""} onclick="judgePhoneAdjustPart('${key}',-0.1)">−</button><div class="partValue" data-part-value="${key}">${value.toFixed(1)}</div><button type="button" class="partAdjust partPlus" ${value>=2||locked?"disabled":""} onclick="judgePhoneAdjustPart('${key}',0.1)">+</button>`;}
async function judgePhoneFullscreen(){
  try{
    if(!document.fullscreenElement){
      await document.documentElement.requestFullscreen?.();
      try{await screen.orientation?.lock?.("landscape");}catch(_){}
    }else{
      await document.exitFullscreen?.();
    }
    judgePhoneUpdateViewport();
  }catch(e){judgePhoneToast("FULL SCREEN NOT AVAILABLE",true);}
}
function judgePhoneUpdateViewport(){
  const app=document.querySelector(".judgePhoneApp");
  const portrait=window.innerHeight>window.innerWidth;
  document.body.classList.toggle("judgePortrait",portrait);
  if(app) app.classList.toggle("judgeLandscape",!portrait);
  const b=document.getElementById("judgeFsBtn");
  if(b)b.textContent=document.fullscreenElement?"↙":"⛶";
  if(b)b.title=document.fullscreenElement?"Quitter le plein écran":"Plein écran";
}
function judgePhoneOrientationPrompt(){
  const p=document.getElementById("judgeOrientationOverlay");
  if(p)p.classList.toggle("show",window.innerHeight>window.innerWidth);
}
function judgePhoneInitControls(){
  document.addEventListener("fullscreenchange",()=>{judgePhoneUpdateViewport();judgePhoneOrientationPrompt();});
  window.addEventListener("resize",()=>{judgePhoneUpdateViewport();judgePhoneOrientationPrompt();});
  judgePhoneUpdateViewport();judgePhoneOrientationPrompt();
}

function collectorRandomToken(){return judgeRandomToken();}
function collectorQrUrl(){const base=judgeBaseUrl();const peer=STATE.collectorQr?.peerId||STATE.judgeQr?.peerId||"";return `${base}?collector=1&peer=${encodeURIComponent(peer)}&t=${encodeURIComponent(STATE.collectorQr?.token||"")}&mat=${encodeURIComponent(Number(STATE.matNumber)||1)}`;}
function ensureCollectorQr(){STATE.collectorQr=STATE.collectorQr||{peerId:"",token:"",deleted:false};if(!STATE.collectorQr.token)STATE.collectorQr.token=collectorRandomToken();STATE.collectorQr.peerId=STATE.judgeQr?.peerId||STATE.collectorQr.peerId||"";saveState();}
function openCollectorQR(){
  if(location.protocol==="file:")return alert("COLLECTOR QR requires a web server.");
  ensureJudgePeer();
  ensureCollectorQr();
  const old=document.getElementById("collectorQrOverlay");if(old)old.remove();
  const overlay=document.createElement("div");overlay.id="collectorQrOverlay";overlay.className="judgeQrOverlay";
  overlay.innerHTML=`<div class="judgeQrModal collectorModal"><div class="judgeQrHeader"><div><div class="phaseTag">REMOTE COLLECTOR</div><h2>COLLECTOR QR</h2><p>Scannez ce QR avec le téléphone du collecteur.</p></div><button class="btn" onclick="document.getElementById('collectorQrOverlay')?.remove()">CLOSE</button></div><div class="collectorQrCenter"><div id="collectorQrImage" class="judgeQrImage"></div><div class="judgeQrHint">SCAN WITH COLLECTOR PHONE</div><span id="collectorQrStatus" class="judgeQrStatus">${window.collectorConnection?.open?"CONNECTED":"WAITING"}</span><div class="judgeQrActions"><button class="btn" onclick="regenerateCollectorQR()">CHANGE QR</button><button class="btn danger" onclick="deleteCollectorQR()">DELETE</button></div></div></div>`;
  document.body.appendChild(overlay);renderCollectorQRCode();
}
function renderCollectorQRCode(){const box=document.getElementById("collectorQrImage");if(!box)return;box.innerHTML="";try{if(typeof QRCode==="function"){new QRCode(box,{text:collectorQrUrl(),width:220,height:220,colorDark:"#07111d",colorLight:"#fff",correctLevel:QRCode.CorrectLevel.M});if(box.children.length)return;}}catch(e){}const img=document.createElement("img");img.width=220;img.height=220;img.alt="COLLECTOR QR";img.src=`https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=8&data=${encodeURIComponent(collectorQrUrl())}`;box.appendChild(img);}
function regenerateCollectorQR(){ensureCollectorQr();STATE.collectorQr.token=collectorRandomToken();STATE.collectorQr.deleted=false;try{window.collectorConnection?.close()}catch(_){}window.collectorConnection=null;saveState();openCollectorQR();}
function deleteCollectorQR(){if(!confirmAction("DELETE COLLECTOR QR?"))return;STATE.collectorQr.token="";STATE.collectorQr.deleted=true;try{window.collectorConnection?.close()}catch(_){}window.collectorConnection=null;saveState();openCollectorQR();}
function collectorPhoneConnect(p){
  if(typeof Peer!=="function"){collectorPhoneToast("PeerJS unavailable",true);return;}
  const local=new Peer();
  const status=t=>{const e=document.getElementById("collectorConnection");if(e)e.textContent=t;};
  local.on("open",()=>{
    const c=local.connect(p.peer,{reliable:true,metadata:{role:"collector",token:p.token}});
    window._collectorConn=c;
    c.on("open",()=>{status("CONNECTED");collectorPhoneToast("CONNECTED TO OPERATOR");});
    c.on("data",m=>{if(m?.type==="COLLECTOR_CONTEXT")renderCollectorPhoneContext(m);});
    c.on("close",()=>status("DISCONNECTED"));
    c.on("error",()=>status("ERROR"));
  });
  local.on("error",()=>status("DISCONNECTED"));
}
function collectorPhoneToast(msg,error=false){const e=document.getElementById("collectorToast");if(e){e.textContent=msg;e.className=`judgePhoneToast show ${error?"error":""}`;clearTimeout(window._collectorToastTimer);window._collectorToastTimer=setTimeout(()=>e.classList.remove("show"),1800);}}
function collectorPhoneResetForSession(ctx){
  const sid=String(ctx.sessionId||"");
  if(sid!==String(window._collectorSession||"")){
    window._collectorSession=sid;
    window._collectorScores={};
    window._collectorCurrentJudge=1;
    window._collectorScoringOpen=false;
  }
}
function collectorPhoneAdjustAccuracy(delta){
  if(window._collectorScoringOpen!==true)return;
  const j=Number(window._collectorCurrentJudge||1);
  const cur=Number(window._collectorDraft?.accuracy ?? 4);
  window._collectorDraft=window._collectorDraft||{};
  window._collectorDraft.accuracy=Math.max(0,Math.min(4,Math.round((cur+Number(delta||0))*10)/10));
  collectorRenderCurrentJudge();
}
function collectorPhoneAdjustPart(key,delta){
  if(window._collectorScoringOpen!==true)return;
  window._collectorDraft=window._collectorDraft||{accuracy:4,speedPower:2,rhythmTempo:2,expressionEnergy:2};
  const cur=Number(window._collectorDraft[key]??2);
  window._collectorDraft[key]=Math.max(0.5,Math.min(2,Math.round((cur+Number(delta||0))*10)/10));
  collectorRenderCurrentJudge();
}
function collectorSaveCurrentJudge(){
  if(window._collectorScoringOpen!==true)return;
  const j=Number(window._collectorCurrentJudge||1), d=window._collectorDraft||{};
  const parts={speedPower:Number(d.speedPower??2),rhythmTempo:Number(d.rhythmTempo??2),expressionEnergy:Number(d.expressionEnergy??2)};
  const presentation=Number((parts.speedPower+parts.rhythmTempo+parts.expressionEnergy).toFixed(1));
  window._collectorScores=window._collectorScores||{};
  window._collectorScores[j]={accuracy:Number(d.accuracy??4),presentation,parts};
  const total=Number(window._collectorJudgeCount||0);
  if(j<total){window._collectorCurrentJudge=j+1;window._collectorDraft={accuracy:4,speedPower:2,rhythmTempo:2,expressionEnergy:2};collectorRenderCurrentJudge();collectorRenderJudgeProgress();}
  else {collectorRenderJudgeProgress();collectorRenderCurrentJudge();}
}
function collectorSendScores(){
  if(window._collectorScoringOpen!==true)return;
  const total=Number(window._collectorJudgeCount||0), scores=window._collectorScores||{};
  for(let j=1;j<=total;j++) if(!scores[j]){collectorPhoneToast(`ENTER JUDGE ${j} SCORE FIRST`,true);window._collectorCurrentJudge=j;window._collectorDraft={accuracy:4,speedPower:2,rhythmTempo:2,expressionEnergy:2};collectorRenderCurrentJudge();collectorRenderJudgeProgress();return;}
  const c=window._collectorConn;
  if(!c?.open){collectorPhoneToast("NOT CONNECTED TO OPERATOR",true);return;}
  c.send({type:"COLLECTOR_SCORES",token:new URLSearchParams(location.search).get("t")||"",sessionId:window._collectorSession||"",scores});
  window._collectorSent=true;
  const b=document.getElementById("collectorSendScores");if(b){b.textContent="SCORES SENT";b.disabled=true;}
  collectorPhoneToast("ALL SCORES SENT");
}
function collectorRenderJudgeProgress(){
  const list=document.getElementById("collectorJudgeList");if(!list)return;
  const total=Number(window._collectorJudgeCount||0), scores=window._collectorScores||{}, names=window._collectorJudgeNames||{};
  list.innerHTML=Array.from({length:total},(_,i)=>{const j=i+1,done=!!scores[j],active=j===Number(window._collectorCurrentJudge||1);return `<button type="button" class="collectorJudgeRow ${active?"active":""} ${done?"done":""}" onclick="collectorSelectJudge(${j})" ${window._collectorScoringOpen?"":"disabled"}><b>JUDGE ${j}</b><span>${esc(names[j]||"")}</span><em>${done?"READY":"WAITING"}</em></button>`}).join("");
}
function collectorSelectJudge(j){
  if(window._collectorScoringOpen!==true)return;
  j=Number(j)||1;
  const existing=window._collectorScores?.[j];
  window._collectorCurrentJudge=j;
  window._collectorDraft=existing?{accuracy:existing.accuracy,...existing.parts}:{accuracy:4,speedPower:2,rhythmTempo:2,expressionEnergy:2};
  collectorRenderCurrentJudge();collectorRenderJudgeProgress();
}
function collectorRenderCurrentJudge(){
  const box=document.getElementById("collectorCurrentJudge");if(!box)return;
  const j=Number(window._collectorCurrentJudge||1), d=window._collectorDraft||{accuracy:4,speedPower:2,rhythmTempo:2,expressionEnergy:2}, open=window._collectorScoringOpen===true;
  const total=Number(d.speedPower||2)+Number(d.rhythmTempo||2)+Number(d.expressionEnergy||2);
  const escv=v=>Number(v).toFixed(1);
  box.innerHTML=`<div class="collectorCurrentHeader"><strong>JUDGE ${j}</strong><span>${esc(window._collectorJudgeNames?.[j]||"")}</span></div><div class="scoreSectionTitle"><span>ACCURACY</span><small>STARTING SCORE</small></div><div class="judgeAccuracyValue">${escv(d.accuracy||0)}</div><div class="accuracyControls"><div class="accuracyCol"><button type="button" class="accuracyMinus big" ${open?"":"disabled"} onclick="collectorPhoneAdjustAccuracy(-0.3)">−0.3</button><button type="button" class="accuracyPlus small" ${open?"":"disabled"} onclick="collectorPhoneAdjustAccuracy(0.3)">+0.3</button></div><div class="accuracyCol"><button type="button" class="accuracyMinus big" ${open?"":"disabled"} onclick="collectorPhoneAdjustAccuracy(-0.1)">−0.1</button><button type="button" class="accuracyPlus small" ${open?"":"disabled"} onclick="collectorPhoneAdjustAccuracy(0.1)">+0.1</button></div></div><div class="scoreSectionTitle presentationTitle"><span>PRESENTATION</span><small>3 PARAMETERS</small></div>${[["speedPower","SPEED & POWER"],["rhythmTempo","RHYTHM & TEMPO"],["expressionEnergy","EXPRESSION OF ENERGY"]].map(([k,label])=>`<div class="partCard"><b>${label}</b><div class="partControl"><button type="button" class="partAdjust" ${open?"":"disabled"} onclick="collectorPhoneAdjustPart('${k}',-0.1)">−</button><strong>${escv(d[k]||2)}</strong><button type="button" class="partAdjust" ${open?"":"disabled"} onclick="collectorPhoneAdjustPart('${k}',0.1)">+</button></div></div>`).join("")}<div class="presentationTotal"><span>PRESENTATION</span><strong>${total.toFixed(1)}</strong></div><button type="button" class="judgePhoneSend" ${open?"":"disabled"} onclick="collectorSaveCurrentJudge()">${j<Number(window._collectorJudgeCount||0)?"SAVE JUDGE & NEXT":"SAVE JUDGE"}</button>`;
}
function renderCollectorPhoneContext(ctx){
  collectorPhoneResetForSession(ctx);
  const mat=Number(ctx.matNumber)||Number(window._collectorMat)||1, judges=Number(ctx.judgeCount||0), athlete=ctx.athlete||"WAITING FOR NEXT POOMSAE";
  window._collectorJudgeCount=judges;window._collectorJudgeNames=ctx.judgeNames||{};
  const open=ctx.scoringOpen===true;
  if(open && window._collectorScoringOpen!==true){window._collectorScoringOpen=true;window._collectorCurrentJudge=1;window._collectorDraft={accuracy:4,speedPower:2,rhythmTempo:2,expressionEnergy:2};window._collectorScores={};window._collectorSent=false;}
  if(!open){window._collectorScoringOpen=false;window._collectorSent=false;window._collectorScores={};window._collectorCurrentJudge=1;window._collectorDraft={accuracy:4,speedPower:2,rhythmTempo:2,expressionEnergy:2};}
  const matEl=document.getElementById("collectorMat");if(matEl)matEl.textContent=`TAPIS ${mat}`;
  const athleteEl=document.getElementById("collectorAthlete");if(athleteEl)athleteEl.textContent=athlete;
  const stateEl=document.getElementById("collectorState");if(stateEl)stateEl.textContent=open?"SCORING AVAILABLE — PERFORMANCE FINISHED":"WAITING FOR OPERATOR TO FINISH PERFORMANCE";
  const send=document.getElementById("collectorSendScores");if(send){send.disabled=!open||window._collectorSent;send.textContent=window._collectorSent?"SCORES SENT":"SEND SCORES";}
  collectorRenderJudgeProgress();collectorRenderCurrentJudge();
}
function renderCollector(){
  const p=new URLSearchParams(location.search);
  const qrMat=Number(p.get("mat"))||Number(STATE.matNumber)||1;
  window._collectorMat=qrMat;
  window._collectorSession="";window._collectorScores={};window._collectorCurrentJudge=1;window._collectorScoringOpen=false;window._collectorSent=false;
  document.body.innerHTML=`<div class="judgePhoneApp collectorApp"><header class="judgePhoneHeader"><img src="federation_logo_transparent.png"><div><small>FTT POOMSAE · <span id="collectorMat">TAPIS ${esc(qrMat)}</span></small><strong>COLLECTOR</strong></div><span id="collectorConnection" class="judgePhoneConnection">CONNECTING</span></header><main id="collectorMain"><section class="collectorPhoneCard"><div class="phaseTag">COLLECTOR</div><h1 id="collectorMatTitle">TAPIS ${esc(qrMat)}</h1><p id="collectorAthlete">WAITING FOR NEXT POOMSAE</p><div id="collectorState" class="collectorState">WAITING FOR OPERATOR TO FINISH PERFORMANCE</div><div id="collectorJudgeList" class="collectorJudgeList"></div><div id="collectorCurrentJudge" class="collectorCurrentJudge"></div><button id="collectorSendScores" type="button" class="judgePhoneSend collectorSendScores" disabled onclick="collectorSendScores()">SEND SCORES</button></section></main><div id="collectorToast" class="judgePhoneToast"></div></div>`;
  renderCollectorPhoneContext({matNumber:qrMat,athlete:"",scoringOpen:false,judgeCount:STATE.judgeCount||0,judgeScores:{},judgeNames:STATE.judgeNames||{},sessionId:""});
  collectorPhoneConnect({peer:p.get("peer"),token:p.get("t")});
}


function renderJudge(){renderJudgePhone();}
if(judgeIsPhone())renderJudge();
else if(new URLSearchParams(location.search).get("collector")==="1")renderCollector();
else if(!new URLSearchParams(location.search).get("display")) ensureJudgePeer();
function judgeSetName(j,value){
  j=Number(j)||1;
  STATE.judgeNames=STATE.judgeNames||{};
  STATE.judgeNames[j]=String(value||"").trim();
  saveState();
  const name=document.querySelector(`.judgeQrName[data-judge-name="${j}"]`);
  if(name) name.textContent=STATE.judgeNames[j]||"NAME NOT SET";
  const items=document.querySelectorAll(`.operatorJudgeStatusItem[data-judge="${j}"] .operatorJudgeIdentity strong`);
  items.forEach(el=>el.textContent=STATE.judgeNames[j]||"NAME NOT SET");
  const box=document.querySelector(`.judgeBox[data-judge="${j}"] .operatorJudgeName`);
  if(box) box.textContent=STATE.judgeNames[j]||"NAME NOT SET";
  judgeSendContext();
}

