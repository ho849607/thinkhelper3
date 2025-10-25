// /static/app.js
(function () {
  "use strict";

  // ===== helpers / constants =====
  const SUGG_MODES = { LOCAL: "local", LLM: "llm", HYBRID: "hybrid" };
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
  const TOKEN_RE = /[A-Za-z0-9가-힣ぁ-ゔァ-ヴー一-龠々〆ヵヶ]+(?:[._-][A-Za-z0-9가-힣ぁ-ゔァ-ヴー一-龠々〆ヵヶ]+)*/g;
  const escapeHtml = (s)=> String(s ?? "").replace(/[&<>"']/g, m => ({"&":"&amp;","<":"&lt;","&gt;":"&gt;","\"":"&quot;","'":"&#39;"}[m]));

  function safeOpen(url){
    try{
      const a = document.createElement("a");
      a.href = url; a.target="_blank"; a.rel="noopener noreferrer";
      document.body.appendChild(a); a.click(); a.remove();
      // 팝업차단 폴백
      if (document.hasFocus()) { /* ok */ } else { window.open(url,"_blank","noopener,noreferrer") || (location.href=url); }
    }catch{ window.open(url,"_blank","noopener,noreferrer") || (location.href=url); }
  }

  // ===== runtime config (from <body data-*>) =====
  const BODY = document.body;
  const TERMS_URL_DEFAULT   = BODY?.dataset?.termsUrl   || "https://docs.google.com/document/d/1TLZ2m52s1mAd8BPzXDBQuXF6QZ_hLDZOyX6Y8TKALnE/edit?usp=sharing";
  const PRIVACY_URL_DEFAULT = BODY?.dataset?.privacyUrl || "https://docs.google.com/document/d/1kmFzmp3ddJOKOp1TPsvsNzAuBKt6M0Vm0N_G5BIOZEE/edit?usp=sharing";

  const REQUIRE_PLUS = true;
  const DEV_HOST = /^(localhost|127\.0\.0\.1|::1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)$/;
  const isDevHost = () => DEV_HOST.test(location.hostname);

  // API BASE: 같은 오리진 기본. 필요시 index.html에서 window.TH_API_BASE로 주입
  // const API_BASE = window.TH_API_BASE ?? ""; // <-- 기존 코드 주석 처리
  const API_BASE = "http://54.250.162.208:8000"; // ★★★★★ 네 EC2 서버 주소로 수정 ★★★★★

  // ===== fetch wrappers =====
  async function apiGet(path){
    return fetch(API_BASE + path, { method: "GET", credentials: API_BASE ? "omit" : "include" });
  }
  async function apiPost(path, body){
    return fetch(API_BASE + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept-Language": state.lang || "ko",
        "X-Client-Timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Seoul",
        ...(state.session?.plusKey ? {"X-Plus-Key": state.session.plusKey} : {})
      },
      credentials: API_BASE ? "omit" : "include",
      body: JSON.stringify(body || {})
    });
  }

  // ===== i18n (축약) =====
  const I18N = {
    ko: { status:{copied:"복사됨", offlineNo:"오프라인: 로컬 검색 결과 없음", offlineFail:"오프라인 검색 실패"},
          plan:{free:"FREE", plus:"PLUS", trial:"TRIAL"},
          limit:{ near:(dt)=>`토큰 한도가 거의 도달했어요.\n${dt} 이후 자동 복원됩니다.`,
                  hit:(dt)=>`무료 토큰 한도를 모두 사용했어요.\n${dt} 이후 자동 복원됩니다.`}
    },
    en: { status:{copied:"Copied", offlineNo:"Offline: No local results", offlineFail:"Offline search failed"},
          plan:{free:"FREE", plus:"PLUS", trial:"TRIAL"},
          limit:{ near:(dt)=>`You're close to the free token limit.\nResets around ${dt}.`,
                  hit:(dt)=>`Free token limit reached.\nResets around ${dt}.`}
    }
  };
  const I18N_TEXT = {
    ko: { "chat.title":"Chat","chat.inputPh":"Enter로 전송 (Shift+Enter 줄바꿈)"},
    en: { "chat.title":"Chat","chat.inputPh":"Press Enter to send (Shift+Enter for newline)"},
  };
  function applyI18n(){
    const lang = (state.lang || "ko").slice(0,2);
    const dict = I18N_TEXT[lang] || I18N_TEXT.ko;
    $$("[data-i18n]").forEach(el=>{ const k=el.getAttribute("data-i18n"); if (dict[k]) el.textContent=dict[k]; });
    $$("[data-i18n-ph]").forEach(el=>{ const k=el.getAttribute("data-i18n-ph"); if (dict[k]) el.setAttribute("placeholder", dict[k]); });
  }

  // ===== state =====
  const state = {
    lang: (localStorage.getItem("th.lang") || navigator.language || "ko").slice(0,2),
    theme: localStorage.getItem("th.theme") || "light",
    suggOn: (localStorage.getItem("th.suggOn") ?? "1") === "1",
    suggPersonal: (localStorage.getItem("th.suggPersonal") ?? "0") === "1",
    suggEngine: localStorage.getItem("th.suggEngine") || SUGG_MODES.HYBRID,

    session: { user: null, plusKey: localStorage.getItem("th.plusKey") || "" },
    plan: "free",
    consent: localStorage.getItem("th.consent")==="1",

    editor: null,
    sugg: { open:false, items:[], active:0, mode:"editor", prefix:"", anchor:{x:0,y:0} },

    // chats/docs (간단)
    currentChatId: localStorage.getItem('th.chat.current') || '',
  };
  window.state = state;

  // ===== UI smalls =====
  function flashStatus(text, ms=1800){
    const st=$("#status"); if (!st) return;
    $("#statusText").textContent = text; st.style.display="block";
    clearTimeout(flashStatus._t); flashStatus._t = setTimeout(()=> st.style.display="none", ms);
  }
  window.flashStatus = flashStatus;

  // ===== consent (첫 방문 즉시) =====
  function showConsentModal(){
    const m = $("#consentModal"); if (!m) return;
    m.style.display="flex";
    $("#consentClose")?.addEventListener("click", ()=> m.style.display="none");
    $("#consentCancel")?.addEventListener("click", ()=> m.style.display="none");
    $("#consentAgree")?.addEventListener("click", ()=>{
      const ok = $("#chkTerms")?.checked && $("#chkPrivacy")?.checked && $("#chkBilling")?.checked;
      if (!ok){ alert("모든 항목에 동의해주세요."); return; }
      localStorage.setItem("th.consent","1"); state.consent=true; m.style.display="none";
      flashStatus("동의가 저장되었습니다");
    });
  }

  // ===== theme / menus / help =====
  function bindMenus(){
    const pairs = [["fileMenu","fileDrop"],["insertMenu","insertDrop"],["toolsMenu","toolsDrop"],["langMenu","langDrop"],["settingsMenu","settingsDrop"]];
    pairs.forEach(([btnId, dropId])=>{
      const btn=$("#"+btnId), drop=$("#"+dropId);
      if (!btn||!drop) return;
      btn.addEventListener("click",(e)=>{ e.stopPropagation(); $$(".dropdown").forEach(x=>x.style.display="none"); drop.style.display = (drop.style.display==="block"?"none":"block"); });
    });
    document.addEventListener("click", ()=> $$(".dropdown").forEach(x=> x.style.display="none"));
  }
  function bindTheme(){
    const apply = () => document.body.classList.toggle("dark", state.theme === "dark");
    apply();
    $("#themeBtn")?.addEventListener("click", ()=>{ state.theme=(state.theme==="dark"?"light":"dark"); localStorage.setItem("th.theme",state.theme); apply(); });
  }
  function bindHelp(){
    $("#termsLink")?.setAttribute("href", TERMS_URL_DEFAULT);
    $("#privacyLink")?.setAttribute("href", PRIVACY_URL_DEFAULT);
    const modal = $("#helpModal"), btn=$("#helpBtn"), close=$("#helpClose");
    btn?.addEventListener("click", ()=> modal.style.display="flex");
    close?.addEventListener("click", ()=> modal.style.display="none");
    modal?.addEventListener("click",(e)=>{ if (e.target===modal) modal.style.display="none"; });
  }

  // ===== paywall =====
  function hasAccess(){ return isDevHost() || state.plan==="plus" || state.plan==="trial"; }
  function updatePlanBadge(plan){
    const badge = $("#quotaBadge"); if (!badge) return;
    if (plan) state.plan = plan;
    const dict = (I18N[state.lang]||I18N.ko).plan;
    if (state.plan === "plus"){ badge.textContent = dict.plus; badge.classList.add("on"); }
    else if (state.plan === "trial"){ badge.textContent = dict.trial; badge.classList.add("on"); }
    else { badge.textContent = dict.free; badge.classList.remove("on"); }
  }

  // ===== editor =====
  async function initEditor(){
    if (!window.ClassicEditor){
      $("#editor").innerHTML = "<textarea id='fallbackArea' style='width:100%;min-height:54vh' placeholder='기본 입력 모드'></textarea>";
      bindFallbackArea(); flashStatus("에디터 기본 모드로 시작"); return;
    }
    try{
      state.editor = await ClassicEditor.create($("#editor"), { placeholder:"Start typing…" });
      bindEditorSuggest();
    }catch(e){
      $("#editor").innerHTML = "<textarea id='fallbackArea' style='width:100%;min-height:54vh' placeholder='기본 입력 모드'></textarea>";
      bindFallbackArea(); console.warn("CKEditor init failed:", e);
    }
  }
  function stripHtml(html){ const d=document.createElement("div"); d.innerHTML=html||""; return d.textContent||""; }
  function getBodyHtml(){ return state.editor ? state.editor.getData() : ($("#editor")?.innerHTML || ""); }
  function bindFallbackArea(){
    const ta=$("#fallbackArea"); if(!ta) return;
    ta.addEventListener("input", ()=> autoSaveLocal());
  }

  // ===== storage: local vs cloud =====
  const DOC_ID_KEY   = "th.doc.id";
  const DOC_HTML_KEY = "th.doc.html";
  let currentDocId   = localStorage.getItem(DOC_ID_KEY) || "";

  let _localSaveT=null, _cloudSaveT=null;
  function autoSaveLocal(){ clearTimeout(_localSaveT); _localSaveT = setTimeout(()=> localStorage.setItem(DOC_HTML_KEY, getBodyHtml()), 1000); }
  async function saveToCloud(force=false){
    if (!state.session.user){
      if (force) flashStatus("로그인 후 클라우드로 저장됩니다. 현재는 PC에 저장됩니다.");
      autoSaveLocal(); return;
    }
    const payload = { id: currentDocId || undefined, title: document.title || "Untitled", html: getBodyHtml() };
    try{
      const res = await apiPost("/save", payload);
      const data = await res.json();
      if (res.ok && data?.id){
        currentDocId = data.id; localStorage.setItem(DOC_ID_KEY, currentDocId);
        if (force) flashStatus("클라우드 저장됨");
      } else if (force) flashStatus("클라우드 저장 실패");
    }catch{ if (force) flashStatus("네트워크 오류로 저장 실패"); }
  }
  function autoSaveCloud(){ clearTimeout(_cloudSaveT); _cloudSaveT = setTimeout(()=> saveToCloud(false), 1500); }

  // ===== search & suggestions (요약 버전) =====
  const SUGG_EL = $("#suggList");
  function caretRectFromInput(input){ const r = input.getBoundingClientRect(); return {left: r.left+8, top: r.top+8, bottom: r.bottom-8}; }
  function caretClientRect(){
    if (state.editor?.ui?.getEditableElement){
      const root = state.editor.ui.getEditableElement(); const r = root.getBoundingClientRect();
      return { left: r.left + 8, top: r.top + 8, bottom: r.bottom - 8 };
    }
    const sel=window.getSelection(); if(!sel||sel.rangeCount===0) return {left:16,top:64,bottom:72};
    const rects=sel.getRangeAt(0).getClientRects(); if(rects&&rects.length) return rects[rects.length-1];
    return {left:16,top:64,bottom:72};
  }
  function localSuggest(prefix, context, k=8, plainForIndex=""){
    const plain = (plainForIndex||stripHtml(getBodyHtml())).toLowerCase();
    const tokens = (plain.match(TOKEN_RE)||[]).map(x=>x.toLowerCase());
    const freq = new Map(); for(const t of tokens) freq.set(t,(freq.get(t)||0)+1);
    const completions=[]; const p=(prefix||"").toLowerCase();
    for(const [tok,c] of freq){ if(tok.startsWith(p)&&tok!==p) completions.push([tok,c]); }
    completions.sort((a,b)=>b[1]-a[1]);
    return { completions: completions.slice(0,k).map(v=>v[0]), next:[], phrases:[] };
  }
  function hideSugg(){ state.sugg.open=false; SUGG_EL.style.display="none"; SUGG_EL.setAttribute("aria-hidden","true"); }
  function renderSugg(){
    const {items, active, anchor} = state.sugg;
    SUGG_EL.innerHTML = items.map((it,i)=>`<li data-idx="${i}" ${i===active?'data-active="1"':''} role="option" aria-selected="${i===active?'true':'false'}"><span class="kind">${it.type}</span><span>${escapeHtml(it.value)}</span></li>`).join("");
    SUGG_EL.style.display="block"; SUGG_EL.setAttribute("aria-hidden","false");
    SUGG_EL.style.left = Math.max(8, anchor.x) + "px"; SUGG_EL.style.top = Math.max(48, anchor.y + 6) + "px";
    $$("#suggList li").forEach(li=> li.addEventListener("mousedown",(e)=>{ e.preventDefault(); accept(+li.dataset.idx); }));
  }
  function accept(i){
    const it = state.sugg.items[i ?? state.sugg.active]; if (!it) return;
    const tail = it.value.slice(state.sugg.prefix.length);
    if (state.sugg.mode==="editor" && state.editor){
      state.editor.model.change(writer=>{ state.editor.model.insertContent(writer.createText(tail)); });
    }
    hideSugg();
  }
  function suggestNow(mode, plain, rect){
    if (!state.suggOn) return hideSugg();
    const base = (mode==="search") ? plain : stripHtml(getBodyHtml());
    const tokens = (base.slice(-200).match(TOKEN_RE)||[]);
    const prefix = (mode==="search" ? (plain||"") : (tokens.pop()||""));
    if (!prefix) return hideSugg();
    const local = localSuggest(prefix, "", 10, base);
    const items = (local.completions||[]).map(v=>({type:"완성", value:v}));
    if (!items.length) return hideSugg();
    state.sugg = { open:true, items, active:0, mode, prefix, anchor: rect||caretClientRect() };
    renderSugg();
  }
  function onEditorKeydown(e){
    if (e.isComposing) return;
    const key=(e.key||"").toLowerCase();
    if ((e.ctrlKey||e.metaKey) && key===" "){ e.preventDefault(); suggestNow("editor", stripHtml(getBodyHtml()), caretClientRect()); return; }
    setTimeout(()=> suggestNow("editor", stripHtml(getBodyHtml()), caretClientRect()), 0);
  }
  function bindEditorSuggest(){
    if (!state.editor) return;
    const view = state.editor.editing.view;
    view.document.on('keydown', (evt,data)=>{
      if ((data.ctrlKey||data.metaKey) && (data.key||"").toLowerCase()===" "){ data.preventDefault(); evt.stop(); suggestNow("editor", stripHtml(getBodyHtml()), caretClientRect()); }
      setTimeout(()=> suggestNow("editor", stripHtml(getBodyHtml()), caretClientRect()), 0);
    });
    state.editor.model.document.on('change:data', ()=>{ autoSaveLocal(); autoSaveCloud(); });
  }

  // ===== Chat (간략) =====
  async function sendChat(){
    if (!hasAccess()){ flashStatus("PLUS/체험 전용입니다."); return; }
    const ta=$("#chatInput"); const text=(ta?.value||"").trim(); if(!text) return;
    appendMsg("user", text); ta.value="";
    try{
      // ★★★★★ 여기가 API_BASE를 사용해 EC2 서버와 통신하는 부분 ★★★★★
      const res = await apiPost("/ask", { question:text, id: state.currentChatId || "" });
      const data = await res.json();
      const reply = data?.answer || "(no response)";
      appendMsg("assistant", reply);
      updatePlanBadge(data?.plan || state.plan);
    }catch(e){ // e -> CORS 에러가 여기서 잡힐 확률이 높음
      console.error("Chat API failed:", e); // 에러 로그 추가
      appendMsg("assistant","서버 연결에 실패했습니다. (CORS 오류?)"); 
    }
  }
  function appendMsg(role, text){
    const log=$("#chatLog");
    const div=document.createElement("div");
    div.className = "msg " + (role==="user"?"user": role==="assistant"?"ai":"sys");
    div.innerHTML = `<span class="bubble">${escapeHtml(text)}</span>`;
    log.appendChild(div); log.scrollTop = log.scrollHeight;
  }

  // ===== Google Login (GIS OAuth Code Flow) =====
  function initGoogleLogin(){
    const clientId = document.body?.dataset?.googleClientId;
    const btn = $("#googleBtn");
    if (!clientId || !btn || !window.google?.accounts?.oauth2) return;

    const codeClient = google.accounts.oauth2.initCodeClient({
      client_id: clientId,
      scope: 'openid email profile',
      ux_mode: 'popup',
      callback: async (resp) => {
        if (!resp.code){ flashStatus("로그인 취소됨"); return; }
        try{
          const r = await apiPost("/auth/google", { code: resp.code });
          const j = await r.json();
          if (!r.ok) throw new Error(j?.error || "auth failed");
          state.session.user = j.user || { email: j.email };
          updatePlanBadge(j.plan || state.plan);
          flashStatus("Google 로그인 완료");
          // 로그인 성공 시 즉시 클라우드 자동저장 시도
          saveToCloud(false);
        }catch(e){ console.warn(e); flashStatus("로그인 실패"); }
      }
    });

    btn.addEventListener("click", ()=> codeClient.requestCode());
  }

  // ===== Naver Blog / X share =====
  function shareTextAndUrl(){
    const title = document.title || "ThinkHelper";
    const text  = stripHtml(getBodyHtml()).replace(/\s+/g," ").trim().slice(0, 240);
    const url   = location.href;
    return { title, text, url };
  }
  function openNaverShare(){
    const { title, url } = shareTextAndUrl();
    const encUrl = encodeURIComponent(url);
    const encTitle = encodeURIComponent(title);
    // 1차: 네이버 공식 share
    const u1 = `https://share.naver.com/web/shareView?url=${encUrl}&title=${encTitle}`;
    // 2차(폴백): 블로그 오픈API 공유
    const u2 = `https://blog.naver.com/openapi/share?url=${encUrl}&title=${encTitle}`;
    safeOpen(u1);
    // 일부 환경에서 차단되면 2~3초 후 폴백도 시도
    setTimeout(()=> safeOpen(u2), 1200);
  }
  function openXShare(){
    const { text, url } = shareTextAndUrl();
    const u = `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
    safeOpen(u);
  }

  // ===== PayPal (SDK 동적 로드 + 구독 버튼 랜더) =====
  function loadPayPalAndRender(){
    const clientId = document.body?.dataset?.paypalClientId;
    if (!clientId) return;
    const env = (document.body?.dataset?.paypalEnv || "live").toLowerCase();
    const scriptId="pp-sdk";
    if (!document.getElementById(scriptId)){
      const s=document.createElement("script");
      s.id=scriptId;
      s.src=`https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&vault=true&intent=subscription&components=buttons`;
      if (env==="sandbox") s.src += "&debug=true";
      s.onload=renderButtons;
      document.head.appendChild(s);
    } else {
      renderButtons();
    }

    function renderButtons(){
      const plan = document.body?.dataset?.paypalPlan;
      const targets = ["#paypal-button-container", `#paypal-button-container-${plan}`];
      targets.forEach(sel=>{
        const el = document.querySelector(sel);
        if (!el || !window.paypal?.Buttons) return;
        try{
          paypal.Buttons({
            style:{ shape:'rect', color:'gold', layout:'vertical', label:'subscribe' },
            createSubscription: (_, actions)=> actions.subscription.create({ plan_id: plan }),
            onApprove: async (data)=> {
              // 구독 승인 토큰을 서버에 검증 요청
              try{
                const r = await apiPost("/paypal/subscribed", { subscriptionID: data.subscriptionID });
                const j = await r.json();
                if (r.ok){ state.plan="plus"; updatePlanBadge("plus"); flashStatus("구독 활성화!"); }
                else throw new Error(j?.error || "verify failed");
              }catch(e){ alert("구독 확인 실패: "+e.message); }
            }
          }).render(el);
        }catch(e){ console.warn("PayPal render fail for", sel, e); }
      });
    }
  }

  // ===== init =====
  document.addEventListener("DOMContentLoaded", async ()=>{
    bindMenus(); bindTheme(); bindHelp(); applyI18n();
    await initEditor();

    // 개인정보 동의: 첫 방문이면 즉시 노출
    if (!state.consent) showConsentModal();

    // 구글 로그인 초기화
    initGoogleLogin();

    // PayPal 버튼(모달/하단 모두) 구성
    loadPayPalAndRender();

    // 공유 버튼
    $("#toolbarShareNaver")?.addEventListener("click", openNaverShare);
    $("#toolbarShareX")?.addEventListener("click", openXShare);

    // 저장 버튼
    $("#saveBtn")?.addEventListener("click", ()=> saveToCloud(true));

    // 채팅
    $("#chatBtn")?.addEventListener("click", ()=>{
      const p=$("#chatPanel"); if(!p) return;
      p.style.display = (p.style.display==="flex"?"none":"flex"); if (p.style.display==="flex") $("#chatInput")?.focus();
    });
    $("#chatClose")?.addEventListener("click", ()=> $("#chatPanel").style.display="none");
    $("#chatInput")?.addEventListener("keydown",(e)=>{ if(!e.isComposing && e.key==="Enter" && !e.shiftKey){ e.preventDefault(); sendChat(); } });

    // 에디터 자동저장
    if (state.editor){
      state.editor.model.document.on('change:data', ()=>{ autoSaveLocal(); saveToCloud(false); });
      const cached = localStorage.getItem(DOC_HTML_KEY);
      if (cached) state.editor.setData(cached);
    }
  });

})();
