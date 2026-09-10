/* SchoolOpvangCheck — app (versie 2)
   Registreert voor- en naschoolse opvang, leest de factuur in, vergelijkt
   beide en stelt bij afwijkingen een bezwaar op.
   Gegevens staan in een Google Sheet; deze app praat ermee via Apps Script.
   Zonder verbinding blijft alles werken: wijzigingen wachten op dit toestel. */
(function () {
"use strict";

/* ======================= hulpjes ======================= */
var DAGEN = ["zondag","maandag","dinsdag","woensdag","donderdag","vrijdag","zaterdag"];
var DAGKORT = ["zo","ma","di","wo","do","vr","za"];
var MAANDEN = ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"];
var MAAND3 = MAANDEN.map(function(m){ return m.slice(0,3); });

function pad(n){ return (n<10?"0":"")+n; }
function toMin(t){ if(!t) return null; var p=String(t).split(":"); if(p.length<2) return null; return (+p[0])*60+(+p[1]); }
function fromMin(m){ m=Math.max(0,Math.round(m)); return pad(Math.floor(m/60))+":"+pad(m%60); }
function uur(t){ return t ? String(t).replace(":","u") : "—"; }
function duur(m){ if(m==null) return "—"; m=Math.round(m); var h=Math.floor(m/60), r=m%60; return h>0?(h+"u"+pad(r)):(r+" min"); }
function eur(v){ if(v==null||isNaN(v)) return "—"; return "€ "+(Math.round(v*100)/100).toFixed(2).replace(".",","); }
function isoVan(d){ return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate()); }
function isoToday(){ return isoVan(new Date()); }
function nowTime(){ var d=new Date(); return pad(d.getHours())+":"+pad(d.getMinutes()); }
function parseISO(s){ var p=String(s).split("-"); return new Date(+p[0], +p[1]-1, +p[2], 12,0,0); }
function wdVan(iso){ return String(parseISO(iso).getDay()); }
function dateLong(iso){ var d=parseISO(iso); return DAGEN[d.getDay()]+" "+d.getDate()+" "+MAANDEN[d.getMonth()]; }
function dateShort(iso){ var d=parseISO(iso); return DAGKORT[d.getDay()]+" "+pad(d.getDate())+"/"+pad(d.getMonth()+1); }
function dateBrief(iso){ var d=parseISO(iso); return d.getDate()+" "+MAANDEN[d.getMonth()]+" "+d.getFullYear(); }
function dagenInMaand(j,m){ return new Date(j,m+1,0).getDate(); }
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
function initials(n){ if(!n) return "?"; var p=String(n).trim().split(/\s+/); return (p[0][0]+(p[1]?p[1][0]:"")).toUpperCase(); }
function el(id){ return document.getElementById(id); }
function toast(m){ var t=document.createElement("div"); t.className="toast"; t.textContent=m;
  document.body.appendChild(t); setTimeout(function(){ t.remove(); }, 3000); }

/* ======================= periodes ======================= */
function periodeStart(iso, D){
  var p=String(iso).split("-"), j=+p[0], m=+p[1]-1, d=+p[2];
  var dd = Math.min(Math.max(1, D||1), dagenInMaand(j,m));
  if(d < dd){ m-=1; if(m<0){ m=11; j-=1; } }
  dd = Math.min(Math.max(1, D||1), dagenInMaand(j,m));
  return j+"-"+pad(m+1)+"-"+pad(dd);
}
function periodeVerschuif(start, delta, D){
  var p=start.split("-"), j=+p[0], m=+p[1]-1+delta;
  j += Math.floor(m/12); m = ((m%12)+12)%12;
  var dd = Math.min(Math.max(1, D||1), dagenInMaand(j,m));
  return j+"-"+pad(m+1)+"-"+pad(dd);
}
function periodeEinde(start, D){
  var vol = periodeVerschuif(start, 1, D), p=vol.split("-");
  var d = new Date(+p[0], +p[1]-1, +p[2]); d.setDate(d.getDate()-1);
  return isoVan(d);
}
function periodeLabel(start, D){
  var p=start.split("-");
  if((D||1)===1) return MAANDEN[+p[1]-1]+" "+p[0];
  var e=periodeEinde(start,D).split("-");
  return (+p[2])+" "+MAAND3[+p[1]-1]+" – "+(+e[2])+" "+MAAND3[+e[1]-1]+" "+e[0];
}

/* ======================= opslag op dit toestel ======================= */
var LS = {
  get:function(k,d){ try{ var v=localStorage.getItem(k); return v==null?d:JSON.parse(v); }catch(e){ return d; } },
  set:function(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); }catch(e){} },
  del:function(k){ try{ localStorage.removeItem(k); }catch(e){} }
};

/* ======================= standaardinstellingen ======================= */
var STANDAARD = {
  kindNaam:"", schoolNaam:"GBS Jongslag, Dilbeek", opvangNaam:"Ferm Kinderopvang",
  lesStart:  {"1":"08:30","2":"08:30","3":"08:30","4":"08:30","5":"08:30"},
  lesEinde:  {"1":"15:30","2":"15:30","3":"12:00","4":"15:30","5":"15:30"},
  middagVan: {"1":"12:05","2":"12:05","3":"","4":"12:05","5":"12:05"},
  middagTot: {"1":"13:05","2":"13:05","3":"","4":"13:05","5":"13:05"},
  opvangOpen:"07:00", opvangSluit:"18:00",
  registratieModus:"ophalen",
  gratisMinutenOchtend:15, gratisMinutenAvond:15,
  tariefHalfuur:1.40, sociaalTarief:false, sociaalFactor:0.20,
  administratiebijdrage:20.50, toeslagLaat:7.50, toeslagActief:true,
  afrondingPer:"dagdeel", maandbudget:60,
  ophalers:["Mama","Papa","Oma langs mama","Oma langs papa","Tante"],
  gpsActief:false, schoolLat:null, schoolLon:null, gpsRadius:250,
  periodeStartDag:1, rapportDag:1,
  ouderNaam:"", ouderAdres:"", ouderEmail:"", opvangEmail:"mijn.kinderopvang@samenferm.be"
};

var state = {
  cfg: JSON.parse(JSON.stringify(STANDAARD)),
  regs: {}, facturen: {},
  wie:null, token:null,
  hPeriode:null, rPeriode:null, fPeriode:null,
  sync:"ok", syncMsg:"bijgewerkt",
  concept:null           // factuur in bewerking (nog niet bewaard)
};

/* ======================= verbinding ======================= */
var outbox = [];
function apiUrl(){ return (window.OPVANG_API||"").trim(); }
function apiKlaar(){ var u=apiUrl(); return u && u.indexOf("PLAK-HIER")!==0; }

function haal(){
  if(!apiKlaar()) return Promise.reject(new Error("geen-url"));
  return fetch(apiUrl()+"?token="+encodeURIComponent(state.token)+"&t="+Date.now())
    .then(function(r){ return r.json(); })
    .then(function(j){ if(!j.ok) throw new Error(j.fout||"fout"); return j.data; });
}
function post(payload){
  return fetch(apiUrl(), {method:"POST", headers:{"Content-Type":"text/plain;charset=utf-8"},
    body: JSON.stringify(payload)}).then(function(r){ return r.json(); });
}
function stuur(opdrachten){
  return post({token:state.token, actie:"batch", data:opdrachten})
    .then(function(j){ if(!j.ok) throw new Error(j.fout||"fout"); return j.data; });
}

function zetSync(s,msg){ state.sync=s; state.syncMsg=msg;
  var d=el("syncdot"); if(d){ d.setAttribute("data-s",s); el("syncmsg").textContent=msg; } }

function neemOver(data){
  if(!data) return;
  var cfg = JSON.parse(JSON.stringify(STANDAARD));
  if(data.instellingen) for(var k in cfg){ if(data.instellingen[k]!==undefined && data.instellingen[k]!==null) cfg[k]=data.instellingen[k]; }
  state.cfg = cfg;
  var regs={}; (data.registraties||[]).forEach(function(r){ if(r && r.datum) regs[r.datum]=r; });
  state.regs = regs;
  var f={}; (data.facturen||[]).forEach(function(x){ if(x && x.periode) f[x.periode]=x; });
  state.facturen = f;
  LS.set("soc.cache", data);
  herstelPeriodes();
}
function herstelPeriodes(){
  var D=+state.cfg.periodeStartDag||1, nu=periodeStart(isoToday(),D);
  if(!state.hPeriode) state.hPeriode=nu;
  if(!state.rPeriode) state.rPeriode=nu;
  if(!state.fPeriode) state.fPeriode=periodeVerschuif(nu,-1,D);
}
function duw(actie,data){
  outbox.push({actie:actie,data:data}); LS.set("soc.outbox", outbox); render(); flush();
}
var flushBezig=false;
function flush(){
  if(flushBezig) return Promise.resolve();
  if(!outbox.length){ if(state.sync!=="fout") zetSync("ok","bijgewerkt"); return Promise.resolve(); }
  if(!navigator.onLine){ zetSync("wacht", outbox.length+" wachten op verbinding"); return Promise.resolve(); }
  flushBezig=true;
  var pakket=outbox.slice();
  zetSync("wacht","bezig met bewaren…");
  return stuur(pakket).then(function(data){
    outbox = outbox.slice(pakket.length); LS.set("soc.outbox", outbox);
    neemOver(data);
    zetSync(outbox.length?"wacht":"ok", outbox.length? outbox.length+" wachten":"bewaard");
    render();
  }).catch(function(){ zetSync("wacht", outbox.length+" wachten — geen verbinding"); })
    .then(function(){ flushBezig=false; });
}
function ververs(stil){
  if(!navigator.onLine){ zetSync("wacht","offline — lokale kopie"); return Promise.resolve(); }
  return haal().then(function(data){
    if(outbox.length) return;
    neemOver(data); render(); if(!stil) zetSync("ok","bijgewerkt");
  }).catch(function(e){
    if(String(e.message)==="token"){ vergeetSleutel("Die sleutel klopt niet."); return; }
    zetSync("fout","niet bereikbaar");
  });
}

/* ======================= berekening ======================= */
function modus(){ return state.cfg.registratieModus || "ophalen"; }
function doetOchtend(){ return modus()!=="ophalen"; }
function doetAvond(){ return modus()!=="afzetten"; }

function lesUren(iso, reg){
  var wd = wdVan(iso), c = state.cfg;
  return {
    start: (reg && reg.lesStart) || (c.lesStart||{})[wd] || "",
    einde: (reg && reg.lesEinde) || (c.lesEinde||{})[wd] || ""
  };
}

function bereken(reg, cfg){
  cfg = cfg || state.cfg;
  var u = lesUren(reg.datum, reg);
  var r = {lesStart:u.start, lesEinde:u.einde, ochtendMin:0, ochtendBetaal:0,
           avondMin:0, avondBetaal:0, halfuren:0, kost:0, toeslag:0, totaal:0,
           ochtendVan:"", ochtendTot:"", avondVan:"", avondTot:""};
  var m = cfg.registratieModus||"ophalen";
  if(m!=="ophalen" && reg.ochtendTijd && u.start){
    var af=toMin(reg.ochtendTijd);
    var tot = reg.ochtendEind ? Math.min(toMin(reg.ochtendEind), toMin(u.start)) : toMin(u.start);
    r.ochtendMin = Math.max(0, tot-af);
    r.ochtendBetaal = Math.max(0, tot-(+cfg.gratisMinutenOchtend||0)-af);
    r.ochtendVan = reg.ochtendTijd; r.ochtendTot = fromMin(tot);
  }
  if(m!=="afzetten" && reg.avondTijd && u.einde){
    var op=toMin(reg.avondTijd), ein=toMin(u.einde);
    r.avondMin = Math.max(0, op-ein);
    r.avondBetaal = Math.max(0, op-ein-(+cfg.gratisMinutenAvond||0));
    r.avondVan = u.einde; r.avondTot = reg.avondTijd;
    if(cfg.toeslagActief){
      var s=toMin(cfg.opvangSluit);
      if(s!=null && op>s) r.toeslag = Math.ceil((op-s)/30)*(+cfg.toeslagLaat||0);
    }
  }
  r.halfuren = (cfg.afrondingPer==="dag")
    ? Math.ceil((r.ochtendBetaal+r.avondBetaal)/30)
    : Math.ceil(r.ochtendBetaal/30)+Math.ceil(r.avondBetaal/30);
  r.kost = r.halfuren*(+cfg.tariefHalfuur||0)*(cfg.sociaalTarief?(+cfg.sociaalFactor||0.2):1);
  r.totaal = r.kost + r.toeslag;
  r.opvangMin = r.ochtendMin + r.avondMin;
  r.betaalMin = r.ochtendBetaal + r.avondBetaal;
  return r;
}

function periodeData(start){
  var D=+state.cfg.periodeStartDag||1, einde=periodeEinde(start,D);
  var lijst = Object.keys(state.regs).filter(function(k){ return k>=start && k<=einde; }).sort();
  var rows = lijst.map(function(k){ return {reg:state.regs[k], b:bereken(state.regs[k])}; });
  var som = {dagen:rows.length, opvangMin:0, betaalMin:0, ochtend:0, avond:0,
             halfuren:0, kost:0, toeslag:0, totaal:0, vroeg:null, laat:null};
  rows.forEach(function(x){
    som.opvangMin+=x.b.opvangMin; som.betaalMin+=x.b.betaalMin;
    som.ochtend+=x.b.ochtendMin; som.avond+=x.b.avondMin;
    som.halfuren+=x.b.halfuren; som.kost+=x.b.kost; som.toeslag+=x.b.toeslag; som.totaal+=x.b.totaal;
    var e = toMin(x.reg.ochtendTijd)!=null ? toMin(x.reg.ochtendTijd) : toMin(x.reg.avondTijd);
    var l = toMin(x.reg.avondTijd)!=null ? toMin(x.reg.avondTijd) : toMin(x.reg.ochtendTijd);
    if(e!=null && (som.vroeg==null||e<som.vroeg)) som.vroeg=e;
    if(l!=null && (som.laat==null||l>som.laat)) som.laat=l;
  });
  return {rows:rows, som:som, start:start, einde:einde};
}

/* ======================= opstarten ======================= */
function boot(){
  var m = (location.hash||"").match(/[#&]t=([^&]+)/);
  if(m){
    state.token = decodeURIComponent(m[1]); LS.set("soc.token", state.token);
    LS.set("ow.token", state.token);
    history.replaceState(null, "", location.pathname+location.search);
  } else {
    state.token = LS.get("soc.token", null) || LS.get("ow.token", null);
    if(state.token) LS.set("soc.token", state.token);
  }
  if(!state.token){ toonPoort(); return; }
  start();
}
function toonPoort(fout){
  el("gate").hidden=false; el("app").hidden=true;
  if(fout) el("gate-fout").textContent=fout;
  el("gate-ok").onclick=function(){
    var v=el("gate-token").value.trim(); if(!v) return;
    state.token=v; LS.set("soc.token",v); el("gate").hidden=true; start();
  };
  el("gate-token").addEventListener("keydown", function(e){ if(e.key==="Enter") el("gate-ok").click(); });
}
function vergeetSleutel(reden){ LS.del("soc.token"); LS.del("ow.token"); state.token=null;
  el("app").hidden=true; toonPoort(reden||""); }

function start(){
  el("app").hidden=false; el("gate").hidden=true;
  state.wie = LS.get("soc.wie", null) || LS.get("ow.wie", null);
  outbox = LS.get("soc.outbox", []) || [];
  var cache = LS.get("soc.cache", null) || LS.get("ow.cache", null);
  if(cache) neemOver(cache); else herstelPeriodes();
  bindStatic(); render(); tick(); setInterval(tick, 20000);
  ververs();
  setInterval(function(){ if(document.visibilityState==="visible") ververs(true); }, 90000);
  document.addEventListener("visibilitychange", function(){ if(document.visibilityState==="visible"){ flush(); ververs(true); } });
  window.addEventListener("online", function(){ flush(); ververs(); });
  window.addEventListener("offline", function(){ zetSync("wacht","offline"); });
  if("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(function(){});
  flush();
}
function tick(){ var c=el("clock"); if(c) c.textContent = nowTime().replace(":","u"); }

/* ======================= vaste bindingen ======================= */
var TABS = ["registreren","historiek","rapport","factuur","instellingen"];
function bindStatic(){
  TABS.forEach(function(t){ el("tab-"+t).onclick = function(){ setTab(t); }; });
  el("whochip").onclick=function(){ setTab("registreren"); state.wie=null; LS.set("soc.wie",null); render(); window.scrollTo(0,0); };
  var D=function(){ return +state.cfg.periodeStartDag||1; };
  el("h-prev").onclick=function(){ state.hPeriode=periodeVerschuif(state.hPeriode,-1,D()); renderHistoriek(); };
  el("h-next").onclick=function(){ state.hPeriode=periodeVerschuif(state.hPeriode, 1,D()); renderHistoriek(); };
  el("r-prev").onclick=function(){ state.rPeriode=periodeVerschuif(state.rPeriode,-1,D()); renderRapport(); };
  el("r-next").onclick=function(){ state.rPeriode=periodeVerschuif(state.rPeriode, 1,D()); renderRapport(); };
  el("fc-prev").onclick=function(){ state.fPeriode=periodeVerschuif(state.fPeriode,-1,D()); state.concept=null; renderFactuur(); };
  el("fc-next").onclick=function(){ state.fPeriode=periodeVerschuif(state.fPeriode, 1,D()); state.concept=null; renderFactuur(); };
  el("btn-add").onclick = voegToe;
  el("btn-save-detail").onclick = bewaarDetail;
  el("btn-del-vandaag").onclick=function(){
    var iso=isoToday();
    if(state.regs[iso] && confirm("De registratie van vandaag verwijderen?")){
      delete state.regs[iso]; duw("verwijder",{datum:iso}); toast("Verwijderd."); }
  };
  el("btn-csv").onclick=exportCSV; el("btn-pdf").onclick=exportPDF;
  el("btn-print").onclick=function(){ window.print(); };
  el("btn-sync").onclick=function(){ flush().then(function(){ return ververs(); }).then(function(){ toast("Bijgewerkt."); }); };
  el("btn-backup").onclick=backup;
  el("btn-forget").onclick=function(){ if(confirm("De sleutel van dit toestel wissen?")) vergeetSleutel(); };
  el("btn-ophaler-add").onclick=function(){
    var v=el("s-nieuw").value.trim(); if(!v) return;
    if(state.cfg.ophalers.indexOf(v)<0){ state.cfg.ophalers=state.cfg.ophalers.concat([v]); bewaarCfg(); }
    el("s-nieuw").value="";
  };
  el("btn-gps-set").onclick=zetSchoolGPS;

  /* factuur */
  el("btn-kies").onclick=function(){ el("filepdf").click(); };
  el("btn-foto").onclick=function(){ el("filecam").click(); };
  el("btn-manueel").onclick=function(){ startConcept(""); toast("Vul de gegevens zelf in."); };
  el("filepdf").onchange=function(e){ leesBestand(e.target.files[0]); e.target.value=""; };
  el("filecam").onchange=function(e){ leesBestand(e.target.files[0]); e.target.value=""; };
  var dz=el("dropzone");
  ["dragenter","dragover"].forEach(function(t){ dz.addEventListener(t,function(e){ e.preventDefault(); dz.classList.add("over"); }); });
  ["dragleave","drop"].forEach(function(t){ dz.addEventListener(t,function(e){ e.preventDefault(); dz.classList.remove("over"); }); });
  dz.addEventListener("drop", function(e){ if(e.dataTransfer.files && e.dataTransfer.files[0]) leesBestand(e.dataTransfer.files[0]); });
  el("btn-regel-add").onclick=function(){
    if(!state.concept) return;
    state.concept.regels.push({datum:state.fPeriode, van:"", tot:"", minuten:null, bedrag:null, dagdeel:"avond"});
    renderConceptRegels();
  };
  el("btn-fac-bewaar").onclick=bewaarFactuur;
  el("btn-fac-weg").onclick=function(){
    var p=state.fPeriode;
    if(confirm("De factuurgegevens van deze periode wissen?")){
      delete state.facturen[p]; state.concept=null; duw("factuurWeg",{periode:p}); toast("Gewist.");
    }
  };
  el("btn-brief-kopie").onclick=function(){
    var t=el("brieftekst").innerText;
    if(navigator.clipboard) navigator.clipboard.writeText(t).then(function(){ toast("Gekopieerd."); },function(){ toast("Kopiëren lukte niet."); });
  };
  el("btn-brief-mail").onclick=function(){
    var t=el("brieftekst").innerText;
    var onderwerp = (t.match(/^Onderwerp:\s*(.+)$/m)||[])[1] || "Vraag tot nazicht van de opvangfactuur";
    var body = t.replace(/^Onderwerp:.*\n+/m, "");
    location.href = "mailto:"+encodeURIComponent(state.cfg.opvangEmail||"")+
      "?subject="+encodeURIComponent(onderwerp)+"&body="+encodeURIComponent(body);
  };
  el("btn-brief-pdf").onclick=briefPDF;

  /* instellingen */
  var tekst={"s-kind":"kindNaam","s-school":"schoolNaam","s-opvang":"opvangNaam","s-open":"opvangOpen",
             "s-sluit":"opvangSluit","s-oudernaam":"ouderNaam","s-ouderadres":"ouderAdres",
             "s-ouderemail":"ouderEmail","s-opvangemail":"opvangEmail","s-modus":"registratieModus",
             "s-afronding":"afrondingPer"};
  var getal={"s-gratis-o":"gratisMinutenOchtend","s-gratis-a":"gratisMinutenAvond","s-tarief":"tariefHalfuur",
             "s-admin":"administratiebijdrage","s-toeslag":"toeslagLaat","s-budget":"maandbudget",
             "s-startdag":"periodeStartDag","s-rapportdag":"rapportDag"};
  document.addEventListener("change", function(ev){
    var id=ev.target && ev.target.id; if(!id) return;
    if(tekst[id]){ state.cfg[tekst[id]]=ev.target.value; bewaarCfg(); }
    else if(getal[id]){
      var v = ev.target.value===""?0:+ev.target.value;
      if(id==="s-startdag"||id==="s-rapportdag") v=Math.min(28,Math.max(1,Math.round(v)||1));
      state.cfg[getal[id]]=v;
      if(id==="s-startdag"){ state.hPeriode=periodeStart(isoToday(),v); state.rPeriode=state.hPeriode;
        state.fPeriode=periodeVerschuif(state.hPeriode,-1,v); }
      bewaarCfg();
    }
    else if(id==="s-sociaal"){ state.cfg.sociaalTarief=ev.target.checked; bewaarCfg(); }
    else if(id==="s-toeslagaan"){ state.cfg.toeslagActief=ev.target.checked; bewaarCfg(); }
    else if(id==="s-gps"){ state.cfg.gpsActief=ev.target.checked; bewaarCfg(); }
  });
}
function setTab(t){
  TABS.forEach(function(x){
    el("tab-"+x).setAttribute("aria-selected", x===t?"true":"false");
    el("panel-"+x).classList.toggle("on", x===t);
  });
  window.scrollTo(0,0);
}
function bewaarCfg(){ duw("instellingen", state.cfg); }

/* ======================= render ======================= */
function render(){
  renderChrome(); renderRegistreren(); renderHistoriek(); renderRapport(); renderFactuur(); renderInstellingen();
}
function banner(kind,titel,tekst){
  var dot = kind==="warn"?"▲":(kind==="bad"?"●":(kind==="good"?"✓":"i"));
  return '<div class="banner '+kind+'"><span>'+dot+'</span><div><span class="bt">'+esc(titel)+'</span>'+esc(tekst)+'</div></div>';
}
function renderChrome(){
  var c=state.cfg;
  el("brandsub").textContent = (c.kindNaam? c.kindNaam+" · ":"")+(c.schoolNaam||"registratie en factuurcontrole");
  el("whoname").textContent = state.wie||"niemand";
  el("whoinit").textContent = initials(state.wie);
  var h="";
  if(!apiKlaar()) h += banner("bad","De app is nog niet verbonden","In config.js staat nog geen web-app-URL van Apps Script.");
  if(outbox.length) h += banner("warn", outbox.length+" wijziging"+(outbox.length===1?"":"en")+" wachten",
    "Ze staan veilig op dit toestel en vertrekken zodra er weer verbinding is.");
  el("topbanners").innerHTML = h ? '<div class="stack">'+h+'</div>' : "";
  zetSync(state.sync, state.syncMsg);
}

/* ---------- registreren ---------- */
function renderRegistreren(){
  var iso=isoToday(), c=state.cfg, u=lesUren(iso, state.regs[iso]);
  el("todaydate").textContent = dateLong(iso);
  var stukken=[];
  if(u.start) stukken.push("lessen van "+uur(u.start));
  if(u.einde) stukken.push("tot "+uur(u.einde));
  el("todayschool").textContent = stukken.length
    ? stukken.join(" ")+" · opvang "+uur(c.opvangOpen)+"–"+uur(c.opvangSluit)
    : "Geen lesdag ingesteld voor "+DAGEN[parseISO(iso).getDay()]+".";

  var slot=el("registerslot"), reg=state.regs[iso];

  if(!state.wie){
    slot.innerHTML = '<div style="margin-top:18px"><div class="label" style="margin-bottom:8px">Wie ben jij?</div>'+
      '<div class="people">'+ c.ophalers.map(function(n){
        return '<button class="person" type="button" data-n="'+esc(n)+'">'+esc(n)+'</button>'; }).join("")+'</div>'+
      '<div class="hint" style="margin-top:10px">Deze keuze blijft op dit toestel bewaard, zodat registreren daarna één druk op de knop is.</div></div>';
    Array.prototype.forEach.call(slot.querySelectorAll(".person"), function(b){
      b.onclick=function(){ state.wie=b.getAttribute("data-n"); LS.set("soc.wie",state.wie); render(); };
    });
    el("detailcard").style.display="none"; renderHerinnering(); return;
  }

  var knoppen="";
  if(doetOchtend()){
    knoppen += (reg && reg.ochtendTijd)
      ? '<button class="bigbtn done" type="button" data-a="ochtend"><span>✓ Afgezet om '+esc(uur(reg.ochtendTijd))+'</span>'+
        '<small>door '+esc(reg.ochtendDoor||"—")+' · tik om het uur op nu te zetten</small></button>'
      : '<button class="bigbtn ochtend" type="button" data-a="ochtend"><span>Afzetten registreren</span>'+
        '<small>voorschoolse opvang · '+esc(uur(nowTime()))+'</small></button>';
  }
  if(doetAvond()){
    knoppen += (reg && reg.avondTijd)
      ? '<button class="bigbtn done" type="button" data-a="avond"><span>✓ Opgehaald om '+esc(uur(reg.avondTijd))+'</span>'+
        '<small>door '+esc(reg.avondDoor||"—")+' · tik om het uur op nu te zetten</small></button>'
      : '<button class="bigbtn" type="button" data-a="avond"><span>Ophalen registreren</span>'+
        '<small>naschoolse opvang · '+esc(uur(nowTime()))+'</small></button>';
  }
  slot.innerHTML = '<div class="btnpaar">'+knoppen+'</div>';
  Array.prototype.forEach.call(slot.querySelectorAll("[data-a]"), function(b){
    b.onclick=function(){ registreerNu(b.getAttribute("data-a")); };
  });

  if(reg && (reg.ochtendTijd || reg.avondTijd)){
    el("detailcard").style.display="";
    bouwDetailVelden(reg);
    zetVeld("d-opm", reg.opmerking||"");
    el("d-gps").innerHTML = gpsTekst(reg);
    el("d-receipt").innerHTML = bonHTML(reg);
  } else el("detailcard").style.display="none";

  bouwToevoegVelden();
  renderHerinnering();
}

function opties(sel){
  return state.cfg.ophalers.map(function(n){ return '<option'+(n===sel?" selected":"")+'>'+esc(n)+'</option>'; }).join("");
}

function bouwDetailVelden(reg){
  var h='<div class="grid3">';
  if(doetOchtend()){
    h += '<div class="field"><label for="d-otijd">Afgezet om</label><input type="time" id="d-otijd" value="'+esc(reg.ochtendTijd||"")+'"></div>'+
         '<div class="field"><label for="d-odoor">Afgezet door</label><select id="d-odoor">'+opties(reg.ochtendDoor||state.wie)+'</select></div>'+
         '<div class="field"><label for="d-oeind">Naar de klas om</label><input type="time" id="d-oeind" value="'+esc(reg.ochtendEind||"")+'"></div>';
  }
  if(doetAvond()){
    h += '<div class="field"><label for="d-atijd">Opgehaald om</label><input type="time" id="d-atijd" value="'+esc(reg.avondTijd||"")+'"></div>'+
         '<div class="field"><label for="d-adoor">Opgehaald door</label><select id="d-adoor">'+opties(reg.avondDoor||state.wie)+'</select></div>';
  }
  h += '<div class="field"><label for="d-lstart">Lessen van (alleen vandaag)</label><input type="time" id="d-lstart" value="'+esc(reg.lesStart||"")+'"></div>'+
       '<div class="field"><label for="d-leinde">Lessen tot (alleen vandaag)</label><input type="time" id="d-leinde" value="'+esc(reg.lesEinde||"")+'"></div></div>';
  el("detailvelden").innerHTML=h;
}

function bouwToevoegVelden(){
  var h = '<div class="field"><label for="a-datum">Datum</label><input type="date" id="a-datum" value="'+isoToday()+'"></div>';
  if(doetOchtend()) h += '<div class="field"><label for="a-otijd">Afgezet om</label><input type="time" id="a-otijd"></div>';
  if(doetAvond())   h += '<div class="field"><label for="a-atijd">Opgehaald om</label><input type="time" id="a-atijd" value="'+nowTime()+'"></div>';
  h += '<div class="field"><label for="a-door">Door</label><select id="a-door">'+opties(state.wie)+'</select></div>';
  var box=el("a-velden");
  if(box.getAttribute("data-modus")!==modus()){ box.innerHTML=h; box.setAttribute("data-modus",modus()); }
}

function gpsTekst(reg){
  if(!reg.gps) return state.cfg.gpsActief ? '<span class="muted">Geen positie vastgelegd.</span>' : "";
  if(reg.gps.fout) return '<span class="pill warn">GPS niet beschikbaar</span>';
  if(reg.gps.afstand==null) return '<span class="pill">Positie bewaard</span>';
  var m=Math.round(reg.gps.afstand), ok = m<=(state.cfg.gpsRadius||250);
  return '<span class="pill '+(ok?"good":"warn")+'">'+(ok?"✓ aan de school":"⚠ ver van de school")+' — '+
    (m<1000? m+" m":(m/1000).toFixed(1).replace(".",",")+" km")+'</span>';
}

function bonHTML(reg){
  var b=bereken(reg), c=state.cfg, L=[];
  if(!b.lesStart && !b.lesEinde)
    return '<div class="hint">Voor '+DAGEN[parseISO(reg.datum).getDay()]+' zijn geen lesuren ingesteld. Vul die in bij Instellingen.</div>';
  if(b.ochtendMin>0 || reg.ochtendTijd){
    L.push(["kop","Voorschools",""]);
    L.push(["","Afgezet om", uur(reg.ochtendTijd)]);
    L.push(["","Lessen beginnen om", uur(b.lesStart)]);
    L.push(["","In de opvang", duur(b.ochtendMin)]);
    L.push(["","Vrij kwartier","− "+c.gratisMinutenOchtend+" min"]);
    L.push(["","Aangerekend", duur(b.ochtendBetaal)]);
  }
  if(b.avondMin>0 || reg.avondTijd){
    L.push(["kop","Naschools",""]);
    L.push(["","Lessen gedaan om", uur(b.lesEinde)]);
    L.push(["","Opgehaald om", uur(reg.avondTijd)]);
    L.push(["","In de opvang", duur(b.avondMin)]);
    L.push(["","Vrij kwartier","− "+c.gratisMinutenAvond+" min"]);
    L.push(["","Aangerekend", duur(b.avondBetaal)]);
  }
  L.push(["kop","Samen",""]);
  L.push(["","Begonnen halve uren", b.halfuren+" × "+eur(c.tariefHalfuur*(c.sociaalTarief?c.sociaalFactor:1))]);
  if(b.toeslag>0) L.push(["","Toeslag na "+uur(c.opvangSluit), eur(b.toeslag)]);
  var h = L.map(function(x){
    return '<div class="line'+(x[0]==="kop"?" kop":"")+'"><span>'+esc(x[1])+'</span><span class="v">'+esc(x[2])+'</span></div>'; }).join("");
  return h+'<div class="line total"><span>Geschatte kost deze dag</span><span class="v">'+esc(eur(b.totaal))+'</span></div>';
}

function renderHerinnering(){
  var s=el("reminderslot"); s.innerHTML="";
  var iso=isoToday(), reg=state.regs[iso], u=lesUren(iso,reg), nu=toMin(nowTime());
  var open=[];
  if(doetOchtend() && u.start && !(reg&&reg.ochtendTijd) && nu>toMin(u.start)) open.push("het afzetten");
  if(doetAvond() && u.einde && !(reg&&reg.avondTijd) && nu>toMin(u.einde)+30) open.push("het ophalen");
  if(!open.length) return;
  s.innerHTML = banner("warn","Nog niets geregistreerd vandaag",
    "Voor "+dateLong(iso)+" staat "+open.join(" en ")+" nog niet in de app.");
}

function registreerNu(deel){
  var iso=isoToday(), oud=state.regs[iso]||{datum:iso};
  var reg = {
    datum: iso,
    ochtendTijd: oud.ochtendTijd||"", ochtendDoor: oud.ochtendDoor||"", ochtendEind: oud.ochtendEind||"",
    avondTijd: oud.avondTijd||"", avondDoor: oud.avondDoor||"",
    opmerking: oud.opmerking||"", lesStart: oud.lesStart||"", lesEinde: oud.lesEinde||"",
    gps: oud.gps||null, bewaardDoor: state.wie||"", bewaardOp: new Date().toISOString()
  };
  if(deel==="ochtend"){ reg.ochtendTijd=nowTime(); reg.ochtendDoor=state.wie||reg.ochtendDoor; }
  else { reg.avondTijd=nowTime(); reg.avondDoor=state.wie||reg.avondDoor; }
  state.regs[iso]=reg; duw("registratie", reg);
  toast(deel==="ochtend" ? "Afzetten geregistreerd om "+uur(reg.ochtendTijd) : "Ophalen geregistreerd om "+uur(reg.avondTijd));
  if(state.cfg.gpsActief) meetGPS(iso);
}

function meetGPS(iso){
  if(!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(function(pos){
    var reg=state.regs[iso]; if(!reg) return;
    var g={lat:pos.coords.latitude, lon:pos.coords.longitude, afstand:null};
    if(state.cfg.schoolLat!=null && state.cfg.schoolLon!=null)
      g.afstand=haversine(g.lat,g.lon,state.cfg.schoolLat,state.cfg.schoolLon);
    reg.gps=g; duw("registratie",reg);
  }, function(){
    var reg=state.regs[iso]; if(!reg) return; reg.gps={fout:true}; duw("registratie",reg);
  }, {enableHighAccuracy:true, timeout:8000, maximumAge:60000});
}
function haversine(a1,o1,a2,o2){
  var R=6371000,t=Math.PI/180,dLat=(a2-a1)*t,dLon=(o2-o1)*t;
  var h=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(a1*t)*Math.cos(a2*t)*Math.sin(dLon/2)*Math.sin(dLon/2);
  return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));
}
function zetSchoolGPS(){
  if(!navigator.geolocation){ toast("GPS is hier niet beschikbaar."); return; }
  navigator.geolocation.getCurrentPosition(function(pos){
    state.cfg.schoolLat=pos.coords.latitude; state.cfg.schoolLon=pos.coords.longitude;
    bewaarCfg(); toast("Schoolpoort vastgelegd.");
  }, function(){ toast("Positie niet gevonden — sta locatie toe."); }, {enableHighAccuracy:true, timeout:8000});
}

function bewaarDetail(){
  var iso=isoToday(), reg=state.regs[iso]; if(!reg) return;
  if(el("d-otijd")){ reg.ochtendTijd=el("d-otijd").value; reg.ochtendDoor=el("d-odoor").value; reg.ochtendEind=el("d-oeind").value; }
  if(el("d-atijd")){ reg.avondTijd=el("d-atijd").value; reg.avondDoor=el("d-adoor").value; }
  reg.lesStart=el("d-lstart").value; reg.lesEinde=el("d-leinde").value;
  reg.opmerking=el("d-opm").value;
  reg.bewaardDoor=state.wie||""; reg.bewaardOp=new Date().toISOString();
  duw("registratie",reg); toast("Bewaard.");
}

function voegToe(){
  var datum=el("a-datum").value; if(!datum){ toast("Vul een datum in."); return; }
  var ot = el("a-otijd") ? el("a-otijd").value : "";
  var at = el("a-atijd") ? el("a-atijd").value : "";
  if(!ot && !at){ toast("Vul minstens één uur in."); return; }
  var bestaat = state.regs[datum];
  if(bestaat && !confirm("Voor "+dateLong(datum)+" bestaat al een registratie. Overschrijven?")) return;
  var wie = el("a-door").value;
  var reg={datum:datum, ochtendTijd:ot, ochtendDoor: ot?wie:"", ochtendEind:"",
           avondTijd:at, avondDoor: at?wie:"", opmerking:"", lesStart:"", lesEinde:"",
           gps:null, bewaardDoor:state.wie||"", bewaardOp:new Date().toISOString()};
  state.regs[datum]=reg; duw("registratie",reg);
  state.hPeriode = periodeStart(datum, +state.cfg.periodeStartDag||1);
  toast("Toegevoegd.");
}

function zetVeld(id,v){ var e=el(id); if(e && document.activeElement!==e) e.value=(v==null?"":v); }

/* ---------- historiek ---------- */
function renderHistoriek(){
  var D=+state.cfg.periodeStartDag||1;
  el("h-label").textContent = periodeLabel(state.hPeriode,D);
  var pd=periodeData(state.hPeriode), body=el("h-body");
  var n=Object.keys(state.regs).length;
  el("h-lede").textContent = n===0 ? "Nog geen registraties." : n+" geregistreerde dag"+(n===1?"":"en")+" in totaal.";
  if(!pd.rows.length){
    body.innerHTML='<div class="empty"><div class="big">Geen registraties in deze periode</div>Blader naar een andere periode, of voeg een dag toe bij Registreren.</div>';
    return;
  }
  var ko = doetOchtend(), ka = doetAvond();
  var h='<div class="tablewrap"><table><thead><tr><th>Dag</th>'+
    (ko?'<th>Afgezet</th>':'')+(ka?'<th>Opgehaald</th>':'')+
    '<th>Door</th><th class="n">In opvang</th><th class="n">½ uren</th><th class="n">Kost</th><th></th></tr></thead><tbody>';
  pd.rows.forEach(function(x){
    var r=x.reg,b=x.b;
    h += '<tr data-iso="'+esc(r.datum)+'"><td>'+esc(dateShort(r.datum))+'</td>'+
      (ko?'<td class="num">'+esc(uur(r.ochtendTijd))+'</td>':'')+
      (ka?'<td class="num">'+esc(uur(r.avondTijd))+'</td>':'')+
      '<td>'+esc(r.avondDoor||r.ochtendDoor||"—")+(r.opmerking?'<span class="opm">'+esc(r.opmerking)+'</span>':"")+'</td>'+
      '<td class="n">'+esc(duur(b.opvangMin))+'</td><td class="n">'+b.halfuren+'</td>'+
      '<td class="n">'+esc(eur(b.totaal))+'</td>'+
      '<td class="n"><button class="rowbtn" data-edit="'+esc(r.datum)+'">wijzig</button></td></tr>';
  });
  body.innerHTML = h+'</tbody></table></div>';
  Array.prototype.forEach.call(body.querySelectorAll("[data-edit]"), function(b){
    b.onclick=function(){ openEdit(b.getAttribute("data-edit")); };
  });
}

function openEdit(iso){
  var reg=state.regs[iso]; if(!reg) return;
  var tr=el("h-body").querySelector('tr[data-iso="'+iso+'"]'); if(!tr) return;
  var nxt=tr.nextElementSibling;
  if(nxt && nxt.classList.contains("editrow")){ nxt.remove(); return; }
  var open=el("h-body").querySelector("tr.editrow"); if(open) open.remove();
  var row=document.createElement("tr"); row.className="editrow";
  var td=document.createElement("td"); td.colSpan=8; td.style.whiteSpace="normal";
  var h='<div class="grid3">';
  if(doetOchtend()) h+='<div class="field"><label>Afgezet om</label><input type="time" class="e-ot" value="'+esc(reg.ochtendTijd||"")+'"></div>'+
    '<div class="field"><label>Naar de klas om</label><input type="time" class="e-oe" value="'+esc(reg.ochtendEind||"")+'"></div>';
  if(doetAvond()) h+='<div class="field"><label>Opgehaald om</label><input type="time" class="e-at" value="'+esc(reg.avondTijd||"")+'"></div>';
  h+='<div class="field"><label>Door</label><select class="e-wie">'+opties(reg.avondDoor||reg.ochtendDoor)+'</select></div>'+
     '<div class="field"><label>Lessen van (deze dag)</label><input type="time" class="e-ls" value="'+esc(reg.lesStart||"")+'"></div>'+
     '<div class="field"><label>Lessen tot (deze dag)</label><input type="time" class="e-le" value="'+esc(reg.lesEinde||"")+'"></div></div>'+
     '<div class="field" style="margin-top:10px"><label>Opmerking</label><input type="text" class="e-opm" value="'+esc(reg.opmerking||"")+'"></div>'+
     '<div class="row spread" style="margin-top:12px">'+
       '<button class="btn ghost sm e-del" type="button">Deze dag verwijderen</button>'+
       '<button class="btn primary sm e-ok" type="button">Bewaren</button></div>';
  td.innerHTML=h; row.appendChild(td); tr.parentNode.insertBefore(row, tr.nextSibling);
  td.querySelector(".e-ok").onclick=function(){
    if(td.querySelector(".e-ot")){ reg.ochtendTijd=td.querySelector(".e-ot").value; reg.ochtendEind=td.querySelector(".e-oe").value; }
    if(td.querySelector(".e-at")) reg.avondTijd=td.querySelector(".e-at").value;
    var wie=td.querySelector(".e-wie").value;
    if(reg.avondTijd) reg.avondDoor=wie; if(reg.ochtendTijd && !reg.ochtendDoor) reg.ochtendDoor=wie;
    reg.lesStart=td.querySelector(".e-ls").value; reg.lesEinde=td.querySelector(".e-le").value;
    reg.opmerking=td.querySelector(".e-opm").value;
    reg.bewaardDoor=state.wie||""; reg.bewaardOp=new Date().toISOString();
    if(!reg.ochtendTijd && !reg.avondTijd){ delete state.regs[iso]; duw("verwijder",{datum:iso}); toast("Dag leeg — verwijderd."); return; }
    duw("registratie",reg); toast("Bewaard.");
  };
  td.querySelector(".e-del").onclick=function(){
    if(confirm("De registratie van "+dateLong(iso)+" verwijderen?")){
      delete state.regs[iso]; duw("verwijder",{datum:iso}); toast("Verwijderd."); }
  };
}

/* ---------- rapport ---------- */
function renderRapport(){
  var D=+state.cfg.periodeStartDag||1, c=state.cfg;
  var start=state.rPeriode, lbl=periodeLabel(start,D), pd=periodeData(start), s=pd.som;
  el("r-label").textContent=lbl;
  el("r-title").textContent="Rapport — "+lbl;
  el("r-sub").textContent=(c.kindNaam? c.kindNaam+", ":"")+(c.schoolNaam||"")+
    " · periode "+dateShort(pd.start)+" t.e.m. "+dateShort(pd.einde);

  var kpis = kpi("Opvangdagen", String(s.dagen), s.dagen?"met een registratie":"nog niets geregistreerd")+
    kpi("Totale opvangduur", duur(s.opvangMin), doetOchtend()&&doetAvond()
      ? duur(s.ochtend)+" voorschools · "+duur(s.avond)+" naschools" : "buiten de lesuren")+
    kpi("Aangerekende tijd", duur(s.betaalMin), s.halfuren+" begonnen halve uren")+
    kpi("Geschatte kost", eur(s.totaal), s.toeslag>0? "incl. "+eur(s.toeslag)+" toeslag"
      : "aan "+eur(c.tariefHalfuur*(c.sociaalTarief?c.sociaalFactor:1))+" per half uur")+
    kpi("Eerste registratie", s.vroeg!=null? uur(fromMin(s.vroeg)):"—","vroegste uur")+
    kpi("Laatste registratie", s.laat!=null? uur(fromMin(s.laat)):"—","laatste uur");
  el("r-kpis").innerHTML='<div class="kpis">'+kpis+'</div>';

  var fac = state.facturen[start];
  var bud=el("r-budget"); bud.innerHTML="";
  if(s.dagen>0 && c.maandbudget>0){
    bud.innerHTML = (s.totaal>c.maandbudget)
      ? banner("bad","Boven het budget","De geschatte kost van "+eur(s.totaal)+" ligt "+eur(s.totaal-c.maandbudget)+" boven je budget van "+eur(c.maandbudget)+".")
      : banner("good","Binnen het budget","Nog "+eur(c.maandbudget-s.totaal)+" te gaan tot je budget van "+eur(c.maandbudget)+".");
  }
  if(fac && fac.bedrag!=null){
    var v=fac.bedrag-s.totaal;
    bud.innerHTML += (Math.abs(v)<0.51)
      ? banner("good","De factuur klopt","Het verschil met je eigen registratie is "+eur(Math.abs(v))+".")
      : banner(v>0?"bad":"info", v>0?"De factuur ligt hoger dan je registratie":"De factuur ligt lager dan je registratie",
          "Verschil: "+eur(Math.abs(v))+". Kijk het na op het tabblad Factuur.");
  }
  if(pd.start.slice(5,7)==="09" || pd.einde.slice(5,7)==="09"){
    bud.innerHTML += banner("info","Administratiebijdrage",
      "De opvang rekent eenmaal per schooljaar "+eur(c.administratiebijdrage)+" administratiekosten aan. Die zit niet in het bedrag hierboven.");
  }

  var facPerDag = {};
  if(fac) (fac.regels||[]).forEach(function(r){
    if(!r.datum) return;
    facPerDag[r.datum] = (facPerDag[r.datum]||0) + (regelMinuten(r)||0);
  });
  el("r-legend").innerHTML = fac
    ? '<span class="e"><i></i>eigen registratie</span><span class="f"><i></i>factuur</span>'
    : '<span class="e"><i></i>aangerekende tijd volgens je eigen registratie</span>';

  var chart=el("r-chart");
  if(!pd.rows.length){
    chart.innerHTML='<div class="empty"><div class="big">Geen registraties in deze periode</div>Registreer een dag, of blader naar een andere periode.</div>';
    el("r-table").innerHTML="";
  } else {
    var max = Math.max.apply(null, pd.rows.map(function(x){
      return Math.max(x.b.betaalMin||0, facPerDag[x.reg.datum]||0); }).concat([30]));
    chart.innerHTML = pd.rows.map(function(x){
      var eigen=Math.round((x.b.betaalMin||0)/max*100);
      var f = facPerDag[x.reg.datum];
      var balken = '<div class="cb" style="width:'+eigen+'%"></div>';
      if(f!=null) balken += '<div class="cb f" style="width:'+Math.round(f/max*100)+'%"></div>';
      return '<div class="crow" title="'+esc(dateLong(x.reg.datum)+" — "+duur(x.b.betaalMin)+" aangerekend"+
             (f!=null? ", factuur "+duur(f):"")+", "+eur(x.b.totaal))+'">'+
        '<div class="cd">'+esc(dateShort(x.reg.datum))+'</div>'+
        '<div class="ct">'+balken+'</div>'+
        '<div class="cv">'+esc(duur(x.b.betaalMin))+'</div></div>';
    }).join("");

    var ko=doetOchtend(), ka=doetAvond();
    var h='<div class="tablewrap"><table><thead><tr><th>Dag</th>'+
      (ko?'<th>Afgezet</th>':'')+'<th>Lessen</th>'+(ka?'<th>Opgehaald</th>':'')+
      '<th>Door</th><th class="n">In opvang</th><th class="n">Aangerekend</th><th class="n">½ uren</th><th class="n">Kost</th></tr></thead><tbody>';
    pd.rows.forEach(function(x){
      var r=x.reg,b=x.b;
      h+='<tr><td>'+esc(dateShort(r.datum))+'</td>'+
        (ko?'<td class="num">'+esc(uur(r.ochtendTijd))+'</td>':'')+
        '<td class="num muted">'+esc(uur(b.lesStart))+"–"+esc(uur(b.lesEinde))+'</td>'+
        (ka?'<td class="num">'+esc(uur(r.avondTijd))+'</td>':'')+
        '<td>'+esc(r.avondDoor||r.ochtendDoor||"—")+(r.opmerking?'<span class="opm">'+esc(r.opmerking)+'</span>':"")+'</td>'+
        '<td class="n">'+esc(duur(b.opvangMin))+'</td><td class="n">'+esc(duur(b.betaalMin))+'</td>'+
        '<td class="n">'+b.halfuren+'</td><td class="n">'+esc(eur(b.totaal))+'</td></tr>';
    });
    var leeg = (ko?1:0)+(ka?1:0)+2;
    h+='</tbody><tfoot><tr><td colspan="'+leeg+'"><strong>Totaal</strong></td>'+
      '<td class="n"><strong>'+esc(duur(s.opvangMin))+'</strong></td>'+
      '<td class="n"><strong>'+esc(duur(s.betaalMin))+'</strong></td>'+
      '<td class="n"><strong>'+s.halfuren+'</strong></td>'+
      '<td class="n"><strong>'+esc(eur(s.totaal))+'</strong></td></tr></tfoot></table></div>';
    el("r-table").innerHTML=h;
  }
}
function kpi(k,v,s){ return '<div class="kpi"><div class="k">'+esc(k)+'</div><div class="v">'+esc(v)+'</div><div class="s">'+esc(s)+'</div></div>'; }

/* ======================= FACTUUR ======================= */
function regelMinuten(r){
  if(r.minuten!=null && r.minuten!=="") return +r.minuten;
  var v=toMin(r.van), t=toMin(r.tot);
  if(v!=null && t!=null) return Math.max(0,t-v);
  return null;
}

function renderFactuur(){
  var D=+state.cfg.periodeStartDag||1, start=state.fPeriode, lbl=periodeLabel(start,D);
  el("fc-label").textContent=lbl;
  el("fc-title").textContent="Factuur — "+lbl;
  var einde=periodeEinde(start,D);
  el("fc-sub").textContent="Periode "+dateShort(start)+" t.e.m. "+dateShort(einde)+
    (state.facturen[start] ? " · factuur bewaard" : " · nog geen factuur ingelezen");

  if(!state.concept && state.facturen[start]){
    var f=state.facturen[start];
    state.concept={periode:start, nummer:f.nummer||"", factuurdatum:f.factuurdatum||"",
      bedrag:f.bedrag, halfuren:f.halfuren, dagen:f.dagen, opmerking:f.opmerking||"",
      kind:state.cfg.kindNaam||"", regels:(f.regels||[]).slice(), bron:f.bron||"manueel", tekst:""};
  }
  if(state.concept && state.concept.periode!==start) state.concept=null;

  var c=state.concept;
  el("fc-gegevens").style.display = c ? "" : "none";
  if(c){
    zetVeld("fg-nummer", c.nummer); zetVeld("fg-datum", c.factuurdatum);
    zetVeld("fg-bedrag", c.bedrag==null?"":c.bedrag);
    zetVeld("fg-kind", c.kind||state.cfg.kindNaam||"");
    zetVeld("fg-halfuren", c.halfuren==null?"":c.halfuren);
    zetVeld("fg-dagen", c.dagen==null?"":c.dagen);
    zetVeld("fg-opm", c.opmerking||"");
    el("fc-ruw").textContent = c.tekst || "(geen ruwe tekst — handmatig ingevuld of eerder bewaard)";
    renderConceptRegels();
  }
  renderVergelijking();
}

function renderConceptRegels(){
  var c=state.concept; if(!c) return;
  var box=el("fg-regels");
  if(!c.regels.length){
    box.innerHTML='<div class="hint">Nog geen aangerekende momenten gevonden. Voeg ze hieronder toe, of vul enkel het totaalbedrag in — dan vergelijkt de app alleen de bedragen.</div>';
    el("fg-regeltel").textContent=""; return;
  }
  var h='<div class="tablewrap"><table><thead><tr><th>Datum</th><th>Van</th><th>Tot</th><th class="n">Minuten</th><th class="n">Bedrag</th><th>Dagdeel</th><th></th></tr></thead><tbody>';
  c.regels.forEach(function(r,i){
    h+='<tr><td><input type="date" data-i="'+i+'" data-f="datum" value="'+esc(r.datum||"")+'" style="border:0;background:transparent;font-family:var(--mono);font-size:13px;width:135px"></td>'+
      '<td><input type="time" data-i="'+i+'" data-f="van" value="'+esc(r.van||"")+'" style="border:0;background:transparent;font-family:var(--mono);font-size:13px;width:90px"></td>'+
      '<td><input type="time" data-i="'+i+'" data-f="tot" value="'+esc(r.tot||"")+'" style="border:0;background:transparent;font-family:var(--mono);font-size:13px;width:90px"></td>'+
      '<td class="n">'+(regelMinuten(r)==null?"—":regelMinuten(r))+'</td>'+
      '<td class="n"><input type="number" step="0.01" data-i="'+i+'" data-f="bedrag" value="'+(r.bedrag==null?"":r.bedrag)+'" style="border:0;background:transparent;font-family:var(--mono);font-size:13px;width:75px;text-align:right"></td>'+
      '<td>'+esc(r.dagdeel||"—")+'</td>'+
      '<td class="n"><button class="rowbtn" data-weg="'+i+'">wis</button></td></tr>';
  });
  box.innerHTML=h+'</tbody></table></div>';
  var som=c.regels.reduce(function(a,r){ return a+(r.bedrag||0); },0);
  el("fg-regeltel").textContent = c.regels.length+" lijnen · samen "+eur(som);
  Array.prototype.forEach.call(box.querySelectorAll("input[data-i]"), function(inp){
    inp.onchange=function(){
      var i=+inp.getAttribute("data-i"), f=inp.getAttribute("data-f");
      c.regels[i][f] = (f==="bedrag") ? (inp.value===""?null:+inp.value) : inp.value;
      if(f==="van" && inp.value) c.regels[i].dagdeel = toMin(inp.value)<720 ? "ochtend":"avond";
      if(f==="van"||f==="tot") c.regels[i].minuten=null;
      renderConceptRegels();
    };
  });
  Array.prototype.forEach.call(box.querySelectorAll("[data-weg]"), function(b){
    b.onclick=function(){ c.regels.splice(+b.getAttribute("data-weg"),1); renderConceptRegels(); };
  });
}

function startConcept(tekst, herkend){
  var start=state.fPeriode;
  state.concept = {
    periode:start,
    nummer:(herkend&&herkend.nummer)||"",
    factuurdatum:(herkend&&herkend.datum)||"",
    bedrag:(herkend&&herkend.bedrag!=null)?herkend.bedrag:null,
    kind:(herkend&&herkend.kind)||state.cfg.kindNaam||"",
    halfuren:null, dagen:(herkend&&herkend.regels)? telDagen(herkend.regels):null,
    opmerking:"", regels:(herkend&&herkend.regels)||[],
    bron:(herkend&&herkend.bron)||"manueel", tekst:tekst||""
  };
  renderFactuur();
  el("fc-gegevens").scrollIntoView({behavior:"smooth", block:"start"});
}
function telDagen(regels){
  var d={}; regels.forEach(function(r){ if(r.datum) d[r.datum]=1; });
  var n=Object.keys(d).length; return n||null;
}

/* ---------- bestand inlezen ---------- */
function status(html){ el("fc-status").innerHTML = html; }

function leesBestand(file){
  if(!file) return;
  if(file.size > 12*1024*1024){ status(banner("bad","Bestand te groot","Kies een bestand van minder dan 12 MB.")); return; }
  status(banner("info","Bezig met lezen…", file.name+" wordt uitgelezen. Dat duurt bij een foto tot een halve minuut."));
  var isPdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name);
  var route = isPdf ? tekstUitPdf(file) : Promise.reject(new Error("geen pdf"));
  route.then(function(tekst){
    if(tekst && tekst.replace(/\s/g,"").length > 120) return tekst;
    throw new Error("te weinig tekst");
  }).catch(function(){
    status(banner("info","Bezig met herkennen…","De app laat Google er tekst van maken. Even geduld."));
    return tekstViaServer(file);
  }).then(function(tekst){
    var herkend = parseFactuur(tekst, state.fPeriode);
    startConcept(tekst, herkend);
    if(herkend.soort==="herinnering"){ status(herinneringHTML(herkend)); return; }
    var n = herkend.regels.length;
    status(banner(n? "good":"warn", n? "Factuur gelezen" : "Factuur gelezen, maar geen dagen gevonden",
      n ? n+" aangerekende momenten gevonden"+(herkend.bedrag!=null? ", totaal "+eur(herkend.bedrag):"")+". Kijk hieronder na of alles klopt."
        : "De tekst is binnen, maar de app herkende er geen opvangmomenten in. Vul ze hieronder zelf aan, of stuur me deze factuur door zodat de herkenning erop afgestemd kan worden."));
  }).catch(function(e){
    status(banner("bad","Inlezen mislukt", String(e && e.message || e)+". Je kan de gegevens hieronder ook handmatig invullen."));
    startConcept("");
  });
}

function herinneringHTML(h){
  var rijen = h.openstaand.map(function(r){
    var laat = r.vervaldatum && r.vervaldatum < isoToday();
    return '<tr><td class="num">'+esc(r.factuur||"—")+'</td>'+
      '<td>'+esc(r.datum? dateBrief(r.datum):"—")+'</td>'+
      '<td>'+esc(r.omschrijving||"—")+'</td>'+
      '<td>'+esc(r.vervaldatum? dateBrief(r.vervaldatum):"—")+
        (laat? ' <span class="pill warn">vervallen</span>':'')+'</td>'+
      '<td class="n">'+esc(eur(r.saldo!=null? r.saldo : r.bedrag))+'</td></tr>';
  }).join("");
  return banner("warn","Dit is een herinnering, geen detailfactuur",
      "Er staan geen opvangmomenten in dit document, alleen openstaande facturen. Voor de controle heb je de factuur zelf nodig — die met de dagen en uren erop.")+
    (rijen ? '<div class="tablewrap" style="margin-top:12px"><table style="min-width:520px"><thead><tr>'+
      '<th>Factuur</th><th>Datum</th><th>Omschrijving</th><th>Vervaldag</th><th class="n">Openstaand</th>'+
      '</tr></thead><tbody>'+rijen+'</tbody></table></div>'+
      '<div class="hint" style="margin-top:10px">Zoek deze factuurnummers op in je mailbox: dát zijn de bestanden die de app kan uitlezen.</div>'
      : "");
}

function tekstUitPdf(file){
  if(!window.pdfjsLib) return Promise.reject(new Error("pdf.js niet geladen"));
  return zetWorker().then(function(){
    return file.arrayBuffer();
  }).then(function(buf){
    return window.pdfjsLib.getDocument({data:buf}).promise;
  }).then(function(pdf){
    var taken=[];
    for(var i=1;i<=pdf.numPages;i++) taken.push(pdf.getPage(i).then(function(p){ return p.getTextContent(); }));
    return Promise.all(taken);
  }).then(function(pagina){
    return pagina.map(function(tc){
      var regels=[], vorigeY=null, buf=[];
      tc.items.forEach(function(it){
        var y = it.transform ? Math.round(it.transform[5]) : 0;
        if(vorigeY!==null && Math.abs(y-vorigeY)>3){ regels.push(buf.join(" ")); buf=[]; }
        buf.push(it.str); vorigeY=y;
      });
      if(buf.length) regels.push(buf.join(" "));
      return regels.join("\n");
    }).join("\n");
  });
}
var workerKlaar=null;
function zetWorker(){
  if(workerKlaar) return workerKlaar;
  var url="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  workerKlaar = fetch(url).then(function(r){ return r.text(); }).then(function(code){
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code],{type:"text/javascript"}));
  }).catch(function(){ /* zonder worker werkt pdf.js trager, maar werkt het */ });
  return workerKlaar;
}

function tekstViaServer(file){
  if(!apiKlaar()) return Promise.reject(new Error("de app is niet verbonden"));
  return file.arrayBuffer().then(function(buf){
    var b=new Uint8Array(buf), s="", stap=0x8000;
    for(var i=0;i<b.length;i+=stap) s += String.fromCharCode.apply(null, b.subarray(i,i+stap));
    return post({token:state.token, actie:"ocr",
      data:{naam:file.name, mime:file.type||"application/pdf", base64:btoa(s)}});
  }).then(function(j){
    if(!j.ok) throw new Error(j.fout||"herkenning mislukt");
    if(!j.tekst || !j.tekst.trim()) throw new Error("er kwam geen tekst uit dit bestand");
    return j.tekst;
  });
}

/* ---------- factuur ontleden ---------- */
var RE_TIJD = /([01]?\d|2[0-3])[:.uh]([0-5]\d)/g;
var RE_BEDRAG = /(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})/g;

function normDatum(d,m,j, valPeriode){
  d=+d; m=+m;
  if(j==null || j===""){
    var p=String(valPeriode||isoToday()).split("-");
    j = +p[0];
    if(m > +p[1] + 1) j -= 1;           // december op een januarifactuur
  } else { j=+j; if(j<100) j += 2000; }
  if(!(m>=1&&m<=12&&d>=1&&d<=31)) return "";
  return j+"-"+pad(m)+"-"+pad(d);
}

function zoekDatumTekst(s, valPeriode){
  var m = s.match(/(\d{1,2})[\/\-\.](\d{1,2})(?:[\/\-\.](\d{2,4}))?/);
  if(m) return normDatum(m[1],m[2],m[3],valPeriode);
  var n = s.match(new RegExp("(\\d{1,2})\\s+("+MAANDEN.join("|")+"|"+MAAND3.join("|")+")\\.?\\s*(\\d{4})?","i"));
  if(n){
    var naam=n[2].toLowerCase().slice(0,3), idx=MAAND3.indexOf(naam);
    if(idx>=0) return normDatum(n[1], idx+1, n[3], valPeriode);
  }
  return "";
}

function bedragUit(s){
  RE_BEDRAG.lastIndex=0; var uit=[], m;
  while((m=RE_BEDRAG.exec(s))!==null) uit.push(+(m[1].replace(/\./g,"")+"."+m[2]));
  return uit;
}

/**
 * Leest de tekst van een document van de opvang. Herkent twee soorten:
 * een gewone factuur met opvangmomenten, en een herinnering of aanmaning
 * met een lijst openstaande facturen.
 */
function parseFactuur(tekst, valPeriode){
  var t = String(tekst||"").replace(/ /g," ").replace(/\r/g,"");
  var uit = {soort:"factuur", nummer:"", datum:"", kind:"", klantnummer:"", bedrag:null,
             regels:[], openstaand:[], bron:"herkend"};

  var heeftUren = /\b([01]?\d|2[0-3])[:.uh][0-5]\d\b/.test(t);
  if(/herinnering|aanmaning|ingebrekestelling/i.test(t) && !heeftUren) uit.soort = "herinnering";

  /* nummer: "Factuurnummer: ...", "Nummer : 1A10368898" */
  var mn = t.match(/factuu?r\s*(?:nummer|nr\.?|n[°r]\.?)\s*[:#]?\s*([A-Z0-9][A-Z0-9\/\-]{3,24})/i)
        || t.match(/\bnummer\s*[:#]\s*([A-Z0-9][A-Z0-9\/\-]{3,24})/i);
  if(mn) uit.nummer = mn[1].replace(/[.,;]$/,"");

  var mkl = t.match(/klantnummer\s*[:#]?\s*(\d{4,12})/i);
  if(mkl) uit.klantnummer = mkl[1];

  var md = t.match(/factuurdatum\s*[:]?\s*([^\n]{6,30})/i) || t.match(/\bdatum\s*[:]?\s*([^\n]{6,30})/i);
  if(md) uit.datum = zoekDatumTekst(md[1], valPeriode);

  var mk = t.match(/(?:naam\s+kind|kind|leerling)\s*[:]\s*([A-Za-zÀ-ÿ' \-]{3,40})/i);
  if(mk) uit.kind = mk[1].trim();
  else if(state.cfg.kindNaam && t.toLowerCase().indexOf(state.cfg.kindNaam.toLowerCase())>=0) uit.kind = state.cfg.kindNaam;

  /* totaal, of het openstaande saldo op een herinnering */
  var beste=null, mt;
  var reTot=/(?:totaal(?:\s+te\s+betalen)?|te\s+betalen|eindtotaal|totaalbedrag|openstaande?\s+saldo(?:\s+van)?|saldo\s+van)[^\d\n]{0,40}(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})/gi;
  while((mt=reTot.exec(t))!==null){
    var w=+(mt[1].replace(/\./g,"")+"."+mt[2]);
    if(beste==null || w>beste) beste=w;
  }
  if(beste!=null) uit.bedrag = beste;

  var lijnen = t.split("\n");

  /* ---- herinnering: tabel met openstaande facturen ---- */
  if(uit.soort==="herinnering"){
    lijnen.forEach(function(lijn){
      var s=lijn.trim();
      if(s.length<12) return;
      if(/^factuur\s+datum|rekeningnummer|klantnummer|inningskosten/i.test(s)) return;
      var mf = s.match(/^(\d{8,12})\s+(\d{1,2}[\-\/\.]\d{1,2}[\-\/\.]\d{2,4})\s+(.*)$/);
      if(!mf) return;
      var rest = mf[3];
      var datums = rest.match(/\d{1,2}[\-\/\.]\d{1,2}[\-\/\.]\d{2,4}/g) || [];
      var bedragen = bedragUit(rest);
      uit.openstaand.push({
        factuur: mf[1],
        datum: zoekDatumTekst(mf[2], valPeriode),
        vervaldatum: datums.length ? zoekDatumTekst(datums[datums.length-1], valPeriode) : "",
        omschrijving: rest.replace(/\d{1,2}[\-\/\.]\d{1,2}[\-\/\.]\d{2,4}/g,"").replace(/[\d.]*\d,\d{2}/g,"").trim().slice(0,60),
        bedrag: bedragen.length ? bedragen[0] : null,
        saldo: bedragen.length ? bedragen[bedragen.length-1] : null
      });
    });
    if(uit.bedrag==null && uit.openstaand.length)
      uit.bedrag = uit.openstaand.reduce(function(a,r){ return a+(r.saldo||0); },0);
    return uit;
  }

  /* ---- gewone factuur: lijnen met een datum en uren of een bedrag ---- */
  lijnen.forEach(function(lijn){
    var s = lijn.trim();
    if(s.length < 6) return;
    if(/totaal|btw|te betalen|iban|bic|rekeningnummer|klantnummer|ondernemingsnummer|pagina|herinnering|saldo/i.test(s)
       && !/\d{1,2}[:.uh]\d{2}/.test(s)) return;
    var datum = zoekDatumTekst(s, valPeriode);
    if(!datum) return;

    RE_TIJD.lastIndex=0; var tijden=[], mm;
    while((mm=RE_TIJD.exec(s))!==null) tijden.push(pad(+mm[1])+":"+mm[2]);
    var bedragen = bedragUit(s);
    if(!tijden.length && !bedragen.length) return;

    var van = tijden[0]||"", tot = tijden[1]||"";
    var minuten = null;
    if(van && tot) minuten = Math.max(0, toMin(tot)-toMin(van));
    var bedrag = bedragen.length ? bedragen[bedragen.length-1] : null;
    if(uit.bedrag!=null && bedrag===uit.bedrag && bedragen.length===1 && !van) return;

    uit.regels.push({datum:datum, van:van, tot:tot, minuten:minuten, bedrag:bedrag,
                     dagdeel: van ? (toMin(van)<720?"ochtend":"avond") : "avond", ruw:s.slice(0,160)});
  });

  var gezien={};
  uit.regels.forEach(function(r){
    var s=[r.datum,r.van,r.tot,r.bedrag].join("|");
    if(gezien[s]) r.dubbel=true;
    gezien[s]=1;
  });
  return uit;
}

function bewaarFactuur(){
  var c=state.concept; if(!c) return;
  c.nummer=el("fg-nummer").value; c.factuurdatum=el("fg-datum").value;
  c.bedrag = el("fg-bedrag").value===""?null:+el("fg-bedrag").value;
  c.kind = el("fg-kind").value;
  c.halfuren = el("fg-halfuren").value===""?null:+el("fg-halfuren").value;
  c.dagen = el("fg-dagen").value===""?null:+el("fg-dagen").value;
  c.opmerking = el("fg-opm").value;
  var obj={periode:c.periode, nummer:c.nummer, factuurdatum:c.factuurdatum, bedrag:c.bedrag,
           halfuren:c.halfuren, dagen:c.dagen||telDagen(c.regels), opmerking:c.opmerking,
           regels:c.regels, bron:c.bron};
  state.facturen[c.periode]=obj;
  if(c.kind && !state.cfg.kindNaam){ state.cfg.kindNaam=c.kind; duw("instellingen", state.cfg); }
  duw("factuur", obj);
  toast("Factuur bewaard.");
  renderVergelijking();
  el("fc-vergelijk").scrollIntoView({behavior:"smooth", block:"start"});
}

/* ---------- vergelijken ---------- */
function vergelijking(start){
  var D=+state.cfg.periodeStartDag||1, einde=periodeEinde(start,D);
  var fac = state.facturen[start];
  if(!fac) return null;
  var perDag = {};
  Object.keys(state.regs).forEach(function(k){
    if(k>=start && k<=einde) perDag[k]={reg:state.regs[k], fac:[]};
  });
  (fac.regels||[]).forEach(function(r){
    if(!r.datum) return;
    if(!perDag[r.datum]) perDag[r.datum]={reg:null, fac:[]};
    perDag[r.datum].fac.push(r);
  });
  var dagen = Object.keys(perDag).sort();
  var uit = {fac:fac, dagen:[], afwijkingen:[], eigenTotaal:0, facTotaal:0, facMinuten:0, eigenMinuten:0};

  dagen.forEach(function(d){
    var p=perDag[d], b = p.reg ? bereken(p.reg) : null;
    var fMin=0, fBedrag=0, fVanO=null, fTotO=null, fVanA=null, fTotA=null;
    p.fac.forEach(function(r){
      var m=regelMinuten(r); if(m!=null) fMin+=m;
      if(r.bedrag!=null) fBedrag+=r.bedrag;
      var v=toMin(r.van), t=toMin(r.tot);
      if(r.dagdeel==="ochtend"){
        if(v!=null&&(fVanO==null||v<fVanO)) fVanO=v;
        if(t!=null&&(fTotO==null||t>fTotO)) fTotO=t;
      } else {
        if(v!=null&&(fVanA==null||v<fVanA)) fVanA=v;
        if(t!=null&&(fTotA==null||t>fTotA)) fTotA=t;
      }
    });
    var eigenMin = b ? b.betaalMin : 0;
    uit.eigenTotaal += b? b.totaal : 0;
    uit.facTotaal += fBedrag; uit.facMinuten += fMin; uit.eigenMinuten += eigenMin;

    var punten=[];
    if(!p.reg && p.fac.length){
      punten.push({zwaar:true, tekst:"aangerekend zonder eigen registratie ("+
        (fMin? duur(fMin):"")+(fBedrag? (fMin?", ":"")+eur(fBedrag):"")+")"});
    }
    if(p.reg && !p.fac.length && eigenMin>0){
      punten.push({zwaar:false, tekst:"wel geregistreerd ("+duur(eigenMin)+"), niet terug te vinden op de factuur"});
    }
    if(p.reg && p.fac.length){
      if(b.ochtendVan && fVanO!=null){
        var vo = toMin(b.ochtendVan)-fVanO;
        if(vo>=5) punten.push({zwaar:true, tekst:"'s ochtends aangerekend vanaf "+uur(fromMin(fVanO))+", terwijl hij pas om "+uur(b.ochtendVan)+" werd afgezet — "+vo+" minuten te veel"});
        else if(vo<=-5) punten.push({zwaar:false, tekst:"'s ochtends "+Math.abs(vo)+" minuten later aangerekend dan geregistreerd"});
      }
      if(b.avondTot && fTotA!=null){
        var va = fTotA-toMin(b.avondTot);
        if(va>=5) punten.push({zwaar:true, tekst:"'s avonds aangerekend tot "+uur(fromMin(fTotA))+", terwijl hij om "+uur(b.avondTot)+" werd opgehaald — "+va+" minuten te veel"});
        else if(va<=-5) punten.push({zwaar:false, tekst:"'s avonds "+Math.abs(va)+" minuten minder aangerekend dan geregistreerd"});
      }
      if(b.avondVan && fVanA!=null){
        var vb = toMin(b.avondVan)-fVanA;
        if(vb>=5) punten.push({zwaar:true, tekst:"'s avonds aangerekend vanaf "+uur(fromMin(fVanA))+", terwijl de lessen pas om "+uur(b.avondVan)+" gedaan waren — "+vb+" minuten te veel"});
      }
      if(fMin && Math.abs(fMin-eigenMin)>=10 && !punten.length)
        punten.push({zwaar:true, tekst:"factuur rekent "+duur(fMin)+" aan, eigen registratie komt op "+duur(eigenMin)});
      if(p.fac.filter(function(r){ return r.dubbel; }).length)
        punten.push({zwaar:true, tekst:"dezelfde lijn staat meer dan één keer op de factuur"});
      if(fBedrag && b.totaal && Math.abs(fBedrag-b.totaal)>=0.5 && !punten.length)
        punten.push({zwaar:true, tekst:"bedrag verschilt: factuur "+eur(fBedrag)+" tegenover "+eur(b.totaal)+" volgens eigen berekening"});
    }
    uit.dagen.push({datum:d, reg:p.reg, b:b, fac:p.fac, fMin:fMin, fBedrag:fBedrag, punten:punten});
    punten.forEach(function(pt){ uit.afwijkingen.push({datum:d, zwaar:pt.zwaar, tekst:pt.tekst}); });
  });
  if(fac.bedrag!=null) uit.facTotaalOpFactuur = fac.bedrag;
  return uit;
}

function renderVergelijking(){
  var start=state.fPeriode, v=vergelijking(start);
  el("fc-vergelijk").style.display = v ? "" : "none";
  el("fc-brief").style.display = (v && v.afwijkingen.length) ? "" : "none";
  if(!v) return;
  var D=+state.cfg.periodeStartDag||1;
  el("fc-vsub").textContent = periodeLabel(start,D)+" · "+v.dagen.length+" dagen bekeken";

  var opFactuur = v.facTotaalOpFactuur!=null ? v.facTotaalOpFactuur : v.facTotaal;
  var verschil = opFactuur - v.eigenTotaal;
  var zwaar = v.afwijkingen.filter(function(a){ return a.zwaar; }).length;
  var kop;
  if(!v.afwijkingen.length) kop = banner("good","Geen afwijkingen gevonden",
    "De factuur komt overeen met je eigen registraties"+(Math.abs(verschil)>=0.01? " (verschil "+eur(Math.abs(verschil))+")":"")+".");
  else kop = banner(zwaar?"bad":"warn", v.afwijkingen.length+" afwijking"+(v.afwijkingen.length===1?"":"en")+" gevonden",
    (zwaar? zwaar+" daarvan zijn dagen waarop meer werd aangerekend dan geregistreerd. ":"")+
    "Op het totaal ligt de factuur "+(verschil>=0? eur(verschil)+" hoger":eur(-verschil)+" lager")+
    " dan je eigen berekening — een lager totaal sluit een fout op een afzonderlijke dag niet uit.");

  el("fc-samenvatting").innerHTML = kop+
    '<div class="kpis" style="margin-top:14px">'+
      kpi("Eigen registratie", eur(v.eigenTotaal), duur(v.eigenMinuten)+" aangerekende tijd")+
      kpi("Op de factuur", eur(opFactuur), v.facMinuten? duur(v.facMinuten)+" aangerekende tijd":"geen lijnen ingelezen")+
      kpi("Verschil op het totaal", (verschil>=0?"+ ":"− ")+eur(Math.abs(verschil)),
          verschil>0? "factuur ligt hoger":(verschil<0?"factuur ligt lager":"exact gelijk"))+
    '</div>';

  var h='<div class="tablewrap"><table><thead><tr><th>Dag</th><th>Eigen registratie</th><th>Op de factuur</th>'+
    '<th class="n">Eigen</th><th class="n">Factuur</th><th class="n">Verschil</th></tr></thead><tbody>';
  v.dagen.forEach(function(d){
    var eigenTekst = d.reg
      ? [(d.reg.ochtendTijd? "afgezet "+uur(d.reg.ochtendTijd):""),
         (d.reg.avondTijd? "opgehaald "+uur(d.reg.avondTijd):"")].filter(Boolean).join(" · ")
      : "—";
    var facTekst = d.fac.length
      ? d.fac.map(function(r){ return (r.van?uur(r.van):"?")+"–"+(r.tot?uur(r.tot):"?"); }).join(" · ")
      : "—";
    var vm = d.fMin - (d.b? d.b.betaalMin:0);
    h+='<tr'+(d.punten.length?' class="afwijking"':'')+'><td>'+esc(dateShort(d.datum))+'</td>'+
      '<td>'+esc(eigenTekst)+'</td><td>'+esc(facTekst)+'</td>'+
      '<td class="n">'+esc(d.b? duur(d.b.betaalMin):"—")+'</td>'+
      '<td class="n">'+esc(d.fMin? duur(d.fMin):"—")+'</td>'+
      '<td class="n">'+(d.fMin||d.b? (vm>0?"+":"")+vm+" min":"—")+'</td></tr>';
  });
  el("fc-tabel").innerHTML=h+'</tbody></table></div>';

  el("fc-afwijkingen").innerHTML = v.afwijkingen.length
    ? v.afwijkingen.map(function(a,i){
        return '<div class="stap"><span class="nr">'+(i+1)+'</span><div><strong>'+esc(dateBrief(a.datum))+'</strong> — '+esc(a.tekst)+'</div></div>'; }).join("")
    : '<div class="hint">Niets gevonden dat afwijkt.</div>';

  if(v.afwijkingen.length) el("brieftekst").textContent = maakBrief(v, start);
}

/* ---------- bezwaarbrief ---------- */
function maakBrief(v, start){
  var c=state.cfg, D=+c.periodeStartDag||1, lbl=periodeLabel(start,D), f=v.fac;
  var opFactuur = v.facTotaalOpFactuur!=null ? v.facTotaalOpFactuur : v.facTotaal;
  var verschil = opFactuur - v.eigenTotaal;
  var zwaar = v.afwijkingen.filter(function(a){ return a.zwaar; });
  var lijst = (zwaar.length? zwaar : v.afwijkingen);

  var r=[];
  r.push("Onderwerp: Vraag tot nazicht van opvangfactuur"+(f.nummer? " "+f.nummer:"")+" — "+lbl);
  r.push("");
  r.push("Geachte");
  r.push("");
  r.push("Ik ontving jullie factuur"+(f.nummer? " "+f.nummer:"")+
    (f.factuurdatum? " van "+dateBrief(f.factuurdatum):"")+" voor de opvang van "+
    (c.kindNaam||"ons kind")+" in "+lbl+", voor een bedrag van "+eur(opFactuur)+".");
  r.push("");
  r.push("Wij houden zelf bij op welk moment "+(c.kindNaam||"hij")+" bij de opvang wordt "+
    (doetOchtend()&&doetAvond()? "afgezet en opgehaald" : (doetOchtend()? "afgezet":"opgehaald"))+
    ". Bij het vergelijken van die registratie met jullie factuur stel ik "+
    (lijst.length===1? "één verschil":lijst.length+" verschillen")+" vast:");
  r.push("");
  lijst.slice(0,25).forEach(function(a){
    r.push("- "+dateBrief(a.datum)+": "+a.tekst+".");
  });
  if(lijst.length>25) r.push("- (en nog "+(lijst.length-25)+" gelijkaardige vaststellingen)");
  r.push("");
  if(Math.abs(verschil)>=0.01){
    r.push("Samen komt onze eigen berekening uit op "+eur(v.eigenTotaal)+
      " tegenover "+eur(opFactuur)+" op de factuur, een verschil van "+eur(Math.abs(verschil))+
      " (op basis van "+eur(c.tariefHalfuur*(c.sociaalTarief?c.sociaalFactor:1))+
      " per begonnen half uur, na het vrije kwartier).");
    r.push("");
  }
  r.push("Zou je deze punten willen nakijken en, waar ze bevestigd worden, een gecorrigeerde factuur willen bezorgen? Ik ga er daarbij van uit dat het om een registratiefout gaat en niet om de tarieven zelf.");
  r.push("");
  r.push("Het zou me ook helpen te weten hoe de aanwezigheden bij jullie precies geregistreerd worden — op welk moment het aanrekenen begint en stopt. Dan kunnen we onze eigen opvolging daarop afstemmen en dit soort vragen in de toekomst vermijden.");
  r.push("");
  r.push("Ik hoor graag van je.");
  r.push("");
  r.push("Met vriendelijke groeten,");
  r.push(c.ouderNaam||"");
  if(c.ouderAdres) r.push(c.ouderAdres);
  if(c.ouderEmail) r.push(c.ouderEmail);
  return r.join("\n");
}

function briefPDF(){
  if(!(window.jspdf && window.jspdf.jsPDF)){ toast("PDF is nu niet beschikbaar — kopieer de tekst."); return; }
  var doc=new window.jspdf.jsPDF({unit:"mm", format:"a4"});
  var tekst = el("brieftekst").innerText.replace(/^Onderwerp:\s*(.+)\n+/m, function(_,o){ return ""; });
  var onderwerp = (el("brieftekst").innerText.match(/^Onderwerp:\s*(.+)$/m)||[])[1]||"";
  var L=20, y=24, breed=170;
  doc.setFont("helvetica","bold"); doc.setFontSize(12);
  if(onderwerp){ doc.text(doc.splitTextToSize(onderwerp, breed), L, y); y+=10; }
  doc.setFont("helvetica","normal"); doc.setFontSize(11);
  var regels = doc.splitTextToSize(tekst.trim(), breed);
  regels.forEach(function(r){
    if(y>276){ doc.addPage(); y=24; }
    doc.text(r, L, y); y+=5.6;
  });
  doc.save("bezwaar-"+state.fPeriode+".pdf");
}

/* ---------- instellingen ---------- */
function renderInstellingen(){
  var c=state.cfg;
  zetVeld("s-kind",c.kindNaam); zetVeld("s-school",c.schoolNaam); zetVeld("s-opvang",c.opvangNaam);
  zetVeld("s-open",c.opvangOpen); zetVeld("s-sluit",c.opvangSluit);
  zetVeld("s-gratis-o",c.gratisMinutenOchtend); zetVeld("s-gratis-a",c.gratisMinutenAvond);
  zetVeld("s-tarief",c.tariefHalfuur); zetVeld("s-admin",c.administratiebijdrage);
  zetVeld("s-toeslag",c.toeslagLaat); zetVeld("s-budget",c.maandbudget);
  zetVeld("s-startdag",c.periodeStartDag); zetVeld("s-rapportdag",c.rapportDag);
  zetVeld("s-oudernaam",c.ouderNaam); zetVeld("s-ouderadres",c.ouderAdres);
  zetVeld("s-ouderemail",c.ouderEmail); zetVeld("s-opvangemail",c.opvangEmail);
  if(document.activeElement!==el("s-modus")) el("s-modus").value = c.registratieModus||"ophalen";
  if(document.activeElement!==el("s-afronding")) el("s-afronding").value = c.afrondingPer||"dagdeel";
  el("s-sociaal").checked=!!c.sociaalTarief;
  el("s-toeslagaan").checked=!!c.toeslagActief;
  el("s-gps").checked=!!c.gpsActief;
  el("s-gpsinfo").textContent = (c.schoolLat!=null)
    ? "Schoolpoort vastgelegd op "+(+c.schoolLat).toFixed(5)+", "+(+c.schoolLon).toFixed(5)+"."
    : "Nog geen positie vastgelegd.";
  el("s-storage").textContent = "Sleutel bewaard op dit toestel. "+
    (outbox.length? outbox.length+" wijziging(en) wachten op verbinding." : "Alles is doorgestuurd naar het Sheet.");

  el("s-modusuitleg").textContent = modus()==="ophalen"
    ? "Alleen het ophalen wordt geregistreerd. De opvangtijd loopt van het einde van de lessen tot het uur van afhaling."
    : (modus()==="afzetten"
      ? "Alleen het afzetten wordt geregistreerd. De opvangtijd loopt van het uur van afzetten tot het begin van de lessen."
      : "Beide momenten worden geregistreerd en apart berekend: 's ochtends tot het begin van de lessen, 's avonds vanaf het einde.");

  var D=+c.periodeStartDag||1, nu=periodeStart(isoToday(),D);
  el("s-perioduitleg").textContent = (D===1)
    ? "De periode loopt van de 1e tot de laatste dag van de maand. Het rapport vertrekt op dag "+c.rapportDag+" en gaat over de vorige maand."
    : "De huidige periode loopt van "+dateLong(nu)+" t.e.m. "+dateLong(periodeEinde(nu,D))+". Het rapport vertrekt op dag "+c.rapportDag+" en gaat over de vorige, afgesloten periode.";

  bouwUrenTabel();

  el("s-ophalers").innerHTML = c.ophalers.map(function(n,i){
    return '<div class="row spread" style="border-bottom:1px solid var(--line); padding:7px 0">'+
      '<span>'+esc(n)+'</span><button class="rowbtn" data-del="'+i+'">verwijderen</button></div>'; }).join("");
  Array.prototype.forEach.call(el("s-ophalers").querySelectorAll("[data-del]"), function(b){
    b.onclick=function(){
      var i=+b.getAttribute("data-del");
      state.cfg.ophalers = state.cfg.ophalers.filter(function(_,j){ return j!==i; });
      bewaarCfg();
    };
  });
}

function bouwUrenTabel(){
  var box=el("s-uren"), c=state.cfg;
  if(!box.getAttribute("data-built")){
    var h='<div class="tablewrap"><table style="min-width:560px"><thead><tr>'+
      '<th>Dag</th><th>Lessen van</th><th>Lessen tot</th><th>Middag van</th><th>Middag tot</th></tr></thead><tbody>';
    [1,2,3,4,5].forEach(function(d){
      h+='<tr><td>'+DAGEN[d]+'</td>'+
        ['lesStart','lesEinde','middagVan','middagTot'].map(function(f){
          return '<td><input type="time" data-d="'+d+'" data-f="'+f+'" style="border:0;background:transparent;font-family:var(--mono);font-size:13px;width:100px"></td>';
        }).join("")+'</tr>';
    });
    box.innerHTML=h+'</tbody></table></div>';
    box.setAttribute("data-built","1");
    Array.prototype.forEach.call(box.querySelectorAll("input[data-d]"), function(inp){
      inp.onchange=function(){
        var d=inp.getAttribute("data-d"), f=inp.getAttribute("data-f");
        if(!state.cfg[f]) state.cfg[f]={};
        if(inp.value) state.cfg[f][d]=inp.value; else delete state.cfg[f][d];
        bewaarCfg();
      };
    });
  }
  Array.prototype.forEach.call(box.querySelectorAll("input[data-d]"), function(inp){
    if(document.activeElement===inp) return;
    var d=inp.getAttribute("data-d"), f=inp.getAttribute("data-f");
    inp.value = (c[f]&&c[f][d]) || "";
  });
}

/* ---------- export ---------- */
function bewaarBestand(naam, inhoud, type){
  var blob=new Blob([inhoud],{type:type}), url=URL.createObjectURL(blob);
  var a=document.createElement("a"); a.href=url; a.download=naam;
  document.body.appendChild(a); a.click();
  setTimeout(function(){ URL.revokeObjectURL(url); a.remove(); },1500);
}
function csvVal(v){ var s=String(v==null?"":v); return /[";\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; }

function exportCSV(){
  var D=+state.cfg.periodeStartDag||1, pd=periodeData(state.rPeriode), s=pd.som, c=state.cfg;
  var uit=[];
  uit.push(["SchoolOpvangCheck — eigen registratie", periodeLabel(pd.start,D), c.kindNaam||"", c.schoolNaam||""].map(csvVal).join(";"));
  uit.push(["Periode", pd.start, "t.e.m.", pd.einde].map(csvVal).join(";"));
  uit.push("");
  uit.push(["Datum","Dag","Lessen van","Lessen tot","Afgezet","Naar klas","Opgehaald","Door",
            "Voorschools (min)","Naschools (min)","Aangerekend (min)","Halve uren","Kost (EUR)","Toeslag (EUR)","Totaal (EUR)","Opmerking"].join(";"));
  pd.rows.forEach(function(x){
    var r=x.reg,b=x.b;
    uit.push([r.datum, DAGEN[parseISO(r.datum).getDay()], b.lesStart, b.lesEinde,
      r.ochtendTijd, r.ochtendEind, r.avondTijd, (r.avondDoor||r.ochtendDoor||""),
      b.ochtendMin, b.avondMin, b.betaalMin, b.halfuren,
      b.kost.toFixed(2).replace(".",","), b.toeslag.toFixed(2).replace(".",","), b.totaal.toFixed(2).replace(".",","),
      r.opmerking||""].map(csvVal).join(";"));
  });
  uit.push(["TOTAAL","","","","","","","", s.ochtend, s.avond, s.betaalMin, s.halfuren,
    s.kost.toFixed(2).replace(".",","), s.toeslag.toFixed(2).replace(".",","), s.totaal.toFixed(2).replace(".",","), ""].map(csvVal).join(";"));
  var f=state.facturen[pd.start];
  if(f && f.bedrag!=null){
    uit.push("");
    uit.push(["Factuur"+(f.nummer? " "+f.nummer:"")+" (EUR)", String(f.bedrag).replace(".",",")].map(csvVal).join(";"));
    uit.push(["Verschil (factuur - eigen)", (f.bedrag-s.totaal).toFixed(2).replace(".",",")].map(csvVal).join(";"));
  }
  bewaarBestand("opvang-"+pd.start+".csv", "﻿"+uit.join("\r\n"), "text/csv;charset=utf-8");
}

function backup(){
  bewaarBestand("schoolopvangcheck-reservekopie-"+isoToday()+".json",
    JSON.stringify({versie:2, instellingen:state.cfg, registraties:state.regs, facturen:state.facturen}, null, 2),
    "application/json");
}

function exportPDF(){
  if(!(window.jspdf && window.jspdf.jsPDF)){ toast("PDF is nu niet beschikbaar — gebruik Afdrukken."); return; }
  var D=+state.cfg.periodeStartDag||1, c=state.cfg, pd=periodeData(state.rPeriode), s=pd.som;
  var doc=new window.jspdf.jsPDF({unit:"mm", format:"a4"});
  var L=16, W=210, y=20;
  doc.setFont("helvetica","bold"); doc.setFontSize(16);
  doc.text("SchoolOpvangCheck — periodeoverzicht", L, y); y+=7;
  doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.setTextColor(90);
  doc.text(periodeLabel(pd.start,D)+"  ·  "+(c.kindNaam? c.kindNaam+", ":"")+(c.schoolNaam||""), L, y); y+=5;
  doc.text("Periode "+pd.start+" t.e.m. "+pd.einde+". Eigen registratie, geen officieel document van "+(c.opvangNaam||"de opvang")+".", L, y); y+=9;

  doc.setTextColor(20); doc.setFont("helvetica","bold"); doc.setFontSize(11);
  doc.text("Samenvatting", L, y); y+=6;
  doc.setFont("helvetica","normal"); doc.setFontSize(10);
  var sam=[["Opvangdagen",String(s.dagen)],["Totale opvangduur", duur(s.opvangMin)]];
  if(s.ochtend>0) sam.push(["Waarvan voorschools", duur(s.ochtend)]);
  if(s.avond>0) sam.push(["Waarvan naschools", duur(s.avond)]);
  sam.push(["Aangerekende tijd", duur(s.betaalMin)+" ("+s.halfuren+" begonnen halve uren)"]);
  sam.push(["Tarief", eur(c.tariefHalfuur*(c.sociaalTarief?c.sociaalFactor:1))+" per begonnen half uur"+(c.sociaalTarief?" (sociaal tarief)":"")]);
  sam.push(["Geschatte kost", eur(s.totaal)+(s.toeslag>0? " (incl. "+eur(s.toeslag)+" toeslag)":"")]);
  var fac=state.facturen[pd.start];
  if(fac && fac.bedrag!=null){
    sam.push(["Factuur"+(fac.nummer? " "+fac.nummer:""), eur(+fac.bedrag)]);
    sam.push(["Verschil", ((+fac.bedrag-s.totaal)>=0?"+ ":"− ")+eur(Math.abs(+fac.bedrag-s.totaal))]);
  }
  sam.forEach(function(r){ doc.setTextColor(90); doc.text(r[0],L,y); doc.setTextColor(20); doc.text(r[1],L+64,y); y+=5.4; });
  y+=5;

  doc.setFont("helvetica","bold"); doc.setFontSize(11); doc.text("Opvangmomenten", L, y); y+=6;
  var X=[L, L+24, L+46, L+68, L+112, L+140, L+158];
  doc.setFontSize(8); doc.setTextColor(120);
  ["Dag","Afgezet","Opgehaald","Door","Aangerekend","1/2 u","Kost"].forEach(function(t,i){ doc.text(t, X[i], y); });
  y+=2; doc.setDrawColor(200); doc.line(L,y,W-L,y); y+=4;
  doc.setFontSize(9);
  pd.rows.forEach(function(x){
    if(y>272){ doc.addPage(); y=20; }
    var r=x.reg,b=x.b;
    doc.setTextColor(30); doc.text(dateShort(r.datum), X[0], y);
    doc.text(r.ochtendTijd? uur(r.ochtendTijd):"—", X[1], y);
    doc.text(r.avondTijd? uur(r.avondTijd):"—", X[2], y);
    doc.text(String(r.avondDoor||r.ochtendDoor||"—").slice(0,20), X[3], y);
    doc.text(duur(b.betaalMin), X[4], y);
    doc.text(String(b.halfuren), X[5], y);
    doc.text(eur(b.totaal), X[6], y);
    y+=5;
    if(r.opmerking){ doc.setTextColor(130); doc.setFontSize(8);
      doc.text(String(r.opmerking).slice(0,110), X[3], y); y+=4.2; doc.setFontSize(9); }
  });
  if(y>268){ doc.addPage(); y=20; }
  doc.setDrawColor(120); doc.line(L,y,W-L,y); y+=5;
  doc.setFont("helvetica","bold"); doc.setTextColor(20);
  doc.text("Totaal", X[0], y); doc.text(duur(s.betaalMin), X[4], y);
  doc.text(String(s.halfuren), X[5], y); doc.text(eur(s.totaal), X[6], y);
  doc.save("opvangrapport-"+pd.start+".pdf");
}

/* ======================= start ======================= */
if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

})();
