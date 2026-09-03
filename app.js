/* Opvangwacht — app.
   Gegevens staan in een Google Sheet; deze app praat ermee via Apps Script.
   Zonder verbinding blijft alles werken: registraties wachten in een wachtrij
   op dit toestel en vertrekken zodra er weer netwerk is. */
(function () {
"use strict";

/* ======================= hulpjes ======================= */
var DAGEN = ["zondag","maandag","dinsdag","woensdag","donderdag","vrijdag","zaterdag"];
var DAGKORT = ["zo","ma","di","wo","do","vr","za"];
var MAANDEN = ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"];

function pad(n){ return (n<10?"0":"")+n; }
function toMin(t){ if(!t) return null; var p=String(t).split(":"); return (+p[0])*60+(+p[1]); }
function fromMin(m){ m=Math.max(0,Math.round(m)); return pad(Math.floor(m/60))+":"+pad(m%60); }
function uur(t){ return t ? String(t).replace(":","u") : "—"; }
function duur(m){ if(m==null) return "—"; var h=Math.floor(m/60), r=m%60; return h>0?(h+"u"+pad(r)):(r+" min"); }
function eur(v){ if(v==null||isNaN(v)) return "—"; return "€ "+(Math.round(v*100)/100).toFixed(2).replace(".",","); }
function isoVan(d){ return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate()); }
function isoToday(){ return isoVan(new Date()); }
function nowTime(){ var d=new Date(); return pad(d.getHours())+":"+pad(d.getMinutes()); }
function parseISO(s){ var p=String(s).split("-"); return new Date(+p[0], +p[1]-1, +p[2], 12,0,0); }
function dateLong(iso){ var d=parseISO(iso); return DAGEN[d.getDay()]+" "+d.getDate()+" "+MAANDEN[d.getMonth()]; }
function dateShort(iso){ var d=parseISO(iso); return DAGKORT[d.getDay()]+" "+pad(d.getDate())+"/"+pad(d.getMonth()+1); }
function dagenInMaand(j,m){ return new Date(j,m+1,0).getDate(); }
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
function initials(n){ if(!n) return "?"; var p=String(n).trim().split(/\s+/); return (p[0][0]+(p[1]?p[1][0]:"")).toUpperCase(); }
function el(id){ return document.getElementById(id); }
function toast(m){ var t=document.createElement("div"); t.className="toast"; t.textContent=m;
  document.body.appendChild(t); setTimeout(function(){ t.remove(); }, 2600); }

/* ======================= periodes ======================= */
/* Een periode wordt benoemd met haar startdatum (ISO).
   Startdag 1 = gewone kalendermaand. */
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
  return (+p[2])+" "+MAANDEN[+p[1]-1].slice(0,3)+" – "+(+e[2])+" "+MAANDEN[+e[1]-1].slice(0,3)+" "+e[0];
}

/* ======================= opslag op dit toestel ======================= */
var LS = {
  get:function(k,d){ try{ var v=localStorage.getItem(k); return v==null?d:JSON.parse(v); }catch(e){ return d; } },
  set:function(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); }catch(e){} },
  del:function(k){ try{ localStorage.removeItem(k); }catch(e){} }
};

/* ======================= standaardinstellingen ======================= */
var STANDAARD = {
  kindNaam:"", schoolNaam:"GBS Jongslag, Dilbeek",
  einduren:{"1":"15:30","2":"15:30","3":"12:00","4":"15:30","5":"15:30"},
  gratisMinuten:15, tariefHalfuur:1.40, sociaalTarief:false, sociaalFactor:0.20,
  administratiebijdrage:20.50, sluitingsuur:"18:00", toeslagLaat:7.50, toeslagActief:true,
  maandbudget:60, ophalers:["Mama","Papa","Oma langs mama","Oma langs papa","Tante"],
  gpsActief:false, schoolLat:null, schoolLon:null, gpsRadius:250,
  periodeStartDag:1, rapportDag:1
};

var state = {
  cfg: JSON.parse(JSON.stringify(STANDAARD)),
  regs: {},         // datum -> registratie
  facturen: {},     // periodestart -> factuur
  wie: null,
  token: null,
  hPeriode: null,
  rPeriode: null,
  sync: "ok",
  syncMsg: "bijgewerkt",
  bezig: false
};

/* ======================= verbinding met het Sheet ======================= */
var outbox = [];

function apiUrl(){ return (window.OPVANG_API||"").trim(); }

function haal(){
  if(!apiUrl() || apiUrl().indexOf("PLAK-HIER")===0) return Promise.reject(new Error("geen-url"));
  return fetch(apiUrl()+"?token="+encodeURIComponent(state.token)+"&t="+Date.now(), {method:"GET"})
    .then(function(r){ return r.json(); })
    .then(function(j){ if(!j.ok) throw new Error(j.fout||"fout"); return j.data; });
}

function stuur(opdrachten){
  return fetch(apiUrl(), {
    method:"POST",
    headers:{"Content-Type":"text/plain;charset=utf-8"},
    body: JSON.stringify({token:state.token, actie:"batch", data:opdrachten})
  }).then(function(r){ return r.json(); })
    .then(function(j){ if(!j.ok) throw new Error(j.fout||"fout"); return j.data; });
}

function zetSync(s, msg){
  state.sync=s; state.syncMsg=msg;
  var d=el("syncdot"); if(d){ d.setAttribute("data-s", s); el("syncmsg").textContent = msg; }
}

function neemOver(data){
  if(!data) return;
  var cfg = JSON.parse(JSON.stringify(STANDAARD));
  if(data.instellingen) for(var k in cfg){ if(data.instellingen[k]!==undefined && data.instellingen[k]!==null) cfg[k]=data.instellingen[k]; }
  state.cfg = cfg;
  var regs={}; (data.registraties||[]).forEach(function(r){ if(r && r.datum) regs[r.datum]=r; });
  state.regs = regs;
  var f={}; (data.facturen||[]).forEach(function(x){ if(x && x.periode) f[x.periode]=x; });
  state.facturen = f;
  LS.set("ow.cache", {instellingen:data.instellingen, registraties:data.registraties, facturen:data.facturen, op:Date.now()});
  herstelPeriodes();
}

function herstelPeriodes(){
  var D = +state.cfg.periodeStartDag || 1;
  var nu = periodeStart(isoToday(), D);
  if(!state.hPeriode) state.hPeriode = nu;
  if(!state.rPeriode) state.rPeriode = nu;
}

function duw(actie, data){
  outbox.push({actie:actie, data:data});
  LS.set("ow.outbox", outbox);
  render();
  flush();
}

var flushBezig = false;
function flush(){
  if(flushBezig) return Promise.resolve();
  if(!outbox.length){ if(state.sync!=="fout") zetSync("ok","bijgewerkt"); return Promise.resolve(); }
  if(!navigator.onLine){ zetSync("wacht", outbox.length+" wachten op verbinding"); return Promise.resolve(); }
  flushBezig = true;
  var pakket = outbox.slice();
  zetSync("wacht","bezig met bewaren…");
  return stuur(pakket).then(function(data){
    outbox = outbox.slice(pakket.length);
    LS.set("ow.outbox", outbox);
    neemOver(data);
    zetSync(outbox.length?"wacht":"ok", outbox.length? outbox.length+" wachten" : "bewaard");
    render();
  }).catch(function(){
    zetSync("wacht", outbox.length+" wachten — geen verbinding");
  }).then(function(){ flushBezig=false; });
}

function ververs(stil){
  if(!navigator.onLine) { zetSync("wacht","offline — lokale kopie"); return Promise.resolve(); }
  return haal().then(function(data){
    if(outbox.length) return;           // eigen wijzigingen eerst wegschrijven
    neemOver(data); render();
    if(!stil) zetSync("ok","bijgewerkt");
  }).catch(function(e){
    if(String(e.message)==="token"){ vergeetSleutel("Die sleutel klopt niet."); return; }
    zetSync("fout","niet bereikbaar");
  });
}

/* ======================= berekening ======================= */
function bereken(reg, cfg){
  var wd = parseISO(reg.datum).getDay();
  var einde = reg.einduur || (cfg.einduren||{})[String(wd)] || null;
  var r = {einde:einde, opvangMin:null, betaalMin:null, halfuren:0, kost:0, toeslag:0, totaal:0, geenLes:false};
  if(!einde){ r.geenLes=true; return r; }
  var e=toMin(einde), u=toMin(reg.tijd);
  if(u==null) return r;
  r.opvangMin = Math.max(0, u-e);
  r.betaalMin = Math.max(0, u-e-(+cfg.gratisMinuten||0));
  r.halfuren = Math.ceil(r.betaalMin/30);
  r.kost = r.halfuren * (+cfg.tariefHalfuur||0) * (cfg.sociaalTarief ? (+cfg.sociaalFactor||0.2) : 1);
  if(cfg.toeslagActief){
    var s=toMin(cfg.sluitingsuur);
    if(s!=null && u>s) r.toeslag = Math.ceil((u-s)/30) * (+cfg.toeslagLaat||0);
  }
  r.totaal = r.kost + r.toeslag;
  return r;
}

function periodeData(start){
  var D = +state.cfg.periodeStartDag || 1;
  var einde = periodeEinde(start, D);
  var lijst = Object.keys(state.regs).filter(function(k){ return k>=start && k<=einde; }).sort();
  var rows = lijst.map(function(k){ return {reg:state.regs[k], b:bereken(state.regs[k], state.cfg)}; });
  var som = {dagen:rows.length, opvangMin:0, betaalMin:0, halfuren:0, kost:0, toeslag:0, totaal:0, vroeg:null, laat:null};
  rows.forEach(function(x){
    som.opvangMin += x.b.opvangMin||0; som.betaalMin += x.b.betaalMin||0;
    som.halfuren += x.b.halfuren; som.kost += x.b.kost; som.toeslag += x.b.toeslag; som.totaal += x.b.totaal;
    var u=toMin(x.reg.tijd);
    if(u!=null){ if(som.vroeg==null||u<som.vroeg) som.vroeg=u; if(som.laat==null||u>som.laat) som.laat=u; }
  });
  return {rows:rows, som:som, start:start, einde:einde};
}

/* ======================= opstarten ======================= */
function boot(){
  // sleutel uit de link (#t=...) of uit dit toestel
  var h = location.hash || "";
  var m = h.match(/[#&]t=([^&]+)/);
  if(m){
    state.token = decodeURIComponent(m[1]);
    LS.set("ow.token", state.token);
    history.replaceState(null, "", location.pathname + location.search);
  } else {
    state.token = LS.get("ow.token", null);
  }
  if(!state.token){ toonPoort(); return; }
  start();
}

function toonPoort(fout){
  el("gate").hidden=false; el("app").hidden=true;
  if(fout) el("gate-fout").textContent = fout;
  el("gate-ok").onclick = function(){
    var v = el("gate-token").value.trim();
    if(!v) return;
    state.token=v; LS.set("ow.token", v);
    el("gate").hidden=true; start();
  };
  el("gate-token").addEventListener("keydown", function(e){ if(e.key==="Enter") el("gate-ok").click(); });
}

function vergeetSleutel(reden){
  LS.del("ow.token"); state.token=null;
  el("app").hidden=true; toonPoort(reden||"");
}

function start(){
  el("app").hidden=false; el("gate").hidden=true;
  state.wie = LS.get("ow.wie", null);
  outbox = LS.get("ow.outbox", []) || [];
  var cache = LS.get("ow.cache", null);
  if(cache) neemOver(cache); else herstelPeriodes();

  bindStatic();
  render();
  tick(); setInterval(tick, 20000);
  ververs();
  setInterval(function(){ if(document.visibilityState==="visible") ververs(true); }, 90000);
  document.addEventListener("visibilitychange", function(){ if(document.visibilityState==="visible"){ flush(); ververs(true); } });
  window.addEventListener("online", function(){ flush(); ververs(); });
  window.addEventListener("offline", function(){ zetSync("wacht","offline"); });
  if("serviceWorker" in navigator){ navigator.serviceWorker.register("sw.js").catch(function(){}); }
  flush();
}

function tick(){ var c=el("clock"); if(c) c.textContent = nowTime().replace(":","u"); }

/* ======================= vaste bindingen ======================= */
function bindStatic(){
  ["registreren","historiek","rapport","instellingen"].forEach(function(t){
    el("tab-"+t).onclick = function(){ setTab(t); };
  });
  el("whochip").onclick = function(){ setTab("registreren"); state.wie=null; LS.set("ow.wie",null); render(); window.scrollTo(0,0); };
  el("h-prev").onclick = function(){ state.hPeriode = periodeVerschuif(state.hPeriode,-1,+state.cfg.periodeStartDag||1); renderHistoriek(); };
  el("h-next").onclick = function(){ state.hPeriode = periodeVerschuif(state.hPeriode, 1,+state.cfg.periodeStartDag||1); renderHistoriek(); };
  el("r-prev").onclick = function(){ state.rPeriode = periodeVerschuif(state.rPeriode,-1,+state.cfg.periodeStartDag||1); renderRapport(); };
  el("r-next").onclick = function(){ state.rPeriode = periodeVerschuif(state.rPeriode, 1,+state.cfg.periodeStartDag||1); renderRapport(); };
  el("btn-add").onclick = voegToe;
  el("btn-save-detail").onclick = bewaarDetail;
  el("btn-del-vandaag").onclick = function(){
    var iso=isoToday();
    if(state.regs[iso] && confirm("De registratie van vandaag verwijderen?")){
      delete state.regs[iso]; duw("verwijder",{datum:iso}); toast("Verwijderd.");
    }
  };
  el("btn-factuur").onclick = bewaarFactuur;
  el("btn-csv").onclick = exportCSV;
  el("btn-pdf").onclick = exportPDF;
  el("btn-print").onclick = function(){ window.print(); };
  el("btn-sync").onclick = function(){ flush().then(function(){ return ververs(); }).then(function(){ toast("Bijgewerkt."); }); };
  el("btn-backup").onclick = backup;
  el("btn-forget").onclick = function(){ if(confirm("De sleutel van dit toestel wissen?")) vergeetSleutel(); };
  el("btn-ophaler-add").onclick = function(){
    var v=el("s-nieuw").value.trim(); if(!v) return;
    if(state.cfg.ophalers.indexOf(v)<0){ state.cfg.ophalers = state.cfg.ophalers.concat([v]); bewaarCfg(); }
    el("s-nieuw").value="";
  };
  el("btn-gps-set").onclick = zetSchoolGPS;
  el("a-datum").value = isoToday();
  el("a-tijd").value = nowTime();

  var tekst = {"s-kind":"kindNaam","s-school":"schoolNaam","s-sluit":"sluitingsuur"};
  var getal = {"s-gratis":"gratisMinuten","s-tarief":"tariefHalfuur","s-admin":"administratiebijdrage",
               "s-toeslag":"toeslagLaat","s-budget":"maandbudget","s-startdag":"periodeStartDag","s-rapportdag":"rapportDag"};
  document.addEventListener("change", function(ev){
    var id = ev.target && ev.target.id; if(!id) return;
    if(tekst[id]){ state.cfg[tekst[id]] = ev.target.value; bewaarCfg(); }
    else if(getal[id]){
      var v = ev.target.value===""?0:+ev.target.value;
      if(id==="s-startdag"||id==="s-rapportdag") v = Math.min(28, Math.max(1, Math.round(v)||1));
      state.cfg[getal[id]] = v;
      if(id==="s-startdag"){ var D=v; state.hPeriode=periodeStart(isoToday(),D); state.rPeriode=state.hPeriode; }
      bewaarCfg();
    }
    else if(id==="s-sociaal"){ state.cfg.sociaalTarief = ev.target.checked; bewaarCfg(); }
    else if(id==="s-toeslagaan"){ state.cfg.toeslagActief = ev.target.checked; bewaarCfg(); }
    else if(id==="s-gps"){ state.cfg.gpsActief = ev.target.checked; bewaarCfg(); }
  });
}

function setTab(t){
  ["registreren","historiek","rapport","instellingen"].forEach(function(x){
    el("tab-"+x).setAttribute("aria-selected", x===t?"true":"false");
    el("panel-"+x).classList.toggle("on", x===t);
  });
  window.scrollTo(0,0);
}

function bewaarCfg(){ duw("instellingen", state.cfg); }

/* ======================= render ======================= */
function render(){
  renderChrome(); renderRegistreren(); renderHistoriek(); renderRapport(); renderInstellingen();
}

function banner(kind,titel,tekst){
  var dot = kind==="warn"?"▲":(kind==="bad"?"●":(kind==="good"?"✓":"i"));
  return '<div class="banner '+kind+'"><span>'+dot+'</span><div><span class="bt">'+esc(titel)+'</span>'+esc(tekst)+'</div></div>';
}

function renderChrome(){
  var c=state.cfg;
  el("brandsub").textContent = (c.kindNaam? c.kindNaam+" · ":"")+(c.schoolNaam||"buitenschoolse opvang");
  el("whoname").textContent = state.wie || "niemand";
  el("whoinit").textContent = initials(state.wie);
  var b=el("topbanners"), h="";
  if(!apiUrl() || apiUrl().indexOf("PLAK-HIER")===0){
    h += banner("bad","De app is nog niet verbonden","In config.js staat nog geen web-app-URL van Apps Script.");
  }
  if(outbox.length){
    h += banner("warn", outbox.length+" wijziging"+(outbox.length===1?"":"en")+" wachten",
      "Ze staan veilig op dit toestel en vertrekken zodra er weer verbinding is.");
  }
  b.innerHTML = h ? '<div class="stack">'+h+'</div>' : "";
  zetSync(state.sync, state.syncMsg);
}

function renderRegistreren(){
  var iso=isoToday(), c=state.cfg, d=parseISO(iso);
  el("todaydate").textContent = dateLong(iso);
  var einde = c.einduren[String(d.getDay())];
  el("todayschool").textContent = einde
    ? "Lessen gedaan om "+uur(einde)+" · eerste "+c.gratisMinuten+" minuten opvang zijn gratis"
    : "Geen lesdag ingesteld voor "+DAGEN[d.getDay()]+".";
  vulOphalers(el("d-ophaler")); vulOphalers(el("a-ophaler"));

  var slot = el("registerslot"), reg = state.regs[iso];

  if(!state.wie){
    slot.innerHTML = '<div style="margin-top:18px"><div class="label" style="margin-bottom:8px">Wie ben jij?</div>'+
      '<div class="people">'+ c.ophalers.map(function(n){
        return '<button class="person" type="button" data-n="'+esc(n)+'">'+esc(n)+'</button>'; }).join("")+'</div>'+
      '<div class="hint" style="margin-top:10px">Deze keuze blijft op dit toestel bewaard, zodat registreren daarna één druk op de knop is.</div></div>';
    Array.prototype.forEach.call(slot.querySelectorAll(".person"), function(btn){
      btn.onclick = function(){ state.wie = btn.getAttribute("data-n"); LS.set("ow.wie", state.wie); render(); };
    });
    el("detailcard").style.display="none"; renderHerinnering(); return;
  }

  if(reg){
    slot.innerHTML = '<button class="bigbtn done" type="button" id="bigbtn"><span>✓ Geregistreerd om '+esc(uur(reg.tijd))+'</span>'+
      '<small>door '+esc(reg.ophaler||"—")+' · tik om het uur op nu te zetten</small></button>';
  } else {
    slot.innerHTML = '<button class="bigbtn" type="button" id="bigbtn"><span>Afhaling registreren</span>'+
      '<small>'+esc(dateLong(iso))+' om '+esc(uur(nowTime()))+'</small></button>';
  }
  el("bigbtn").onclick = registreerNu;

  if(reg){
    el("detailcard").style.display="";
    zetVeld("d-tijd", reg.tijd||"");
    if(document.activeElement!==el("d-ophaler")) el("d-ophaler").value = reg.ophaler || state.wie;
    zetVeld("d-opm", reg.opmerking||"");
    el("d-gps").innerHTML = gpsTekst(reg);
    el("d-receipt").innerHTML = bonHTML(reg);
  } else { el("detailcard").style.display="none"; }
  renderHerinnering();
}

function gpsTekst(reg){
  if(!reg.gps) return state.cfg.gpsActief ? '<span class="muted">Geen positie vastgelegd.</span>' : "";
  if(reg.gps.fout) return '<span class="pill warn">GPS niet beschikbaar</span>';
  if(reg.gps.afstand==null) return '<span class="pill">Positie bewaard</span>';
  var m=Math.round(reg.gps.afstand), ok = m <= (state.cfg.gpsRadius||250);
  return '<span class="pill '+(ok?"good":"warn")+'">'+(ok?"✓ aan de school":"⚠ ver van de school")+' — '+
    (m<1000? m+" m" : (m/1000).toFixed(1).replace(".",",")+" km")+'</span>';
}

function bonHTML(reg){
  var b=bereken(reg,state.cfg), c=state.cfg;
  if(b.geenLes) return '<div class="hint">Voor '+DAGEN[parseISO(reg.datum).getDay()]+' is geen einduur ingesteld. Vul dat in bij Instellingen.</div>';
  var L=[["Lessen gedaan", uur(b.einde)],["Afgehaald om", uur(reg.tijd)],["In de opvang", duur(b.opvangMin)],
         ["Gratis kwartier","− "+c.gratisMinuten+" min"],["Aangerekende tijd", duur(b.betaalMin)],
         ["Begonnen halve uren", b.halfuren+" × "+eur(c.tariefHalfuur*(c.sociaalTarief?c.sociaalFactor:1))]];
  if(b.toeslag>0) L.push(["Toeslag na "+uur(c.sluitingsuur), eur(b.toeslag)]);
  return L.map(function(x){ return '<div class="line"><span>'+esc(x[0])+'</span><span class="v">'+esc(x[1])+'</span></div>'; }).join("")+
    '<div class="line total"><span>Geschatte kost deze dag</span><span class="v">'+esc(eur(b.totaal))+'</span></div>';
}

function renderHerinnering(){
  var s=el("reminderslot"); s.innerHTML="";
  var iso=isoToday(), d=parseISO(iso), einde=state.cfg.einduren[String(d.getDay())];
  if(!einde || state.regs[iso]) return;
  if(toMin(nowTime()) > toMin(einde)+30){
    s.innerHTML = banner("warn","Nog niets geregistreerd vandaag",
      "De lessen zijn om "+uur(einde)+" gedaan en er staat nog geen afhaling voor "+dateLong(iso)+".");
  }
}

function registreerNu(){
  var iso=isoToday(), oud=state.regs[iso];
  var reg = {datum:iso, tijd:nowTime(), ophaler: state.wie || (oud&&oud.ophaler) || "",
             opmerking:(oud&&oud.opmerking)||"", einduur:(oud&&oud.einduur)||"",
             gps:(oud&&oud.gps)||null, bewaardDoor: state.wie||"", bewaardOp:new Date().toISOString()};
  state.regs[iso]=reg;
  duw("registratie", reg);
  toast("Afhaling geregistreerd om "+uur(reg.tijd));
  if(state.cfg.gpsActief) meetGPS(iso);
}

function meetGPS(iso){
  if(!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(function(pos){
    var reg=state.regs[iso]; if(!reg) return;
    var g={lat:pos.coords.latitude, lon:pos.coords.longitude, afstand:null};
    if(state.cfg.schoolLat!=null && state.cfg.schoolLon!=null)
      g.afstand = haversine(g.lat,g.lon,state.cfg.schoolLat,state.cfg.schoolLon);
    reg.gps=g; duw("registratie", reg);
  }, function(){
    var reg=state.regs[iso]; if(!reg) return;
    reg.gps={fout:true}; duw("registratie", reg);
  }, {enableHighAccuracy:true, timeout:8000, maximumAge:60000});
}

function haversine(a1,o1,a2,o2){
  var R=6371000, t=Math.PI/180, dLat=(a2-a1)*t, dLon=(o2-o1)*t;
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
  reg.tijd = el("d-tijd").value || reg.tijd;
  reg.ophaler = el("d-ophaler").value;
  reg.opmerking = el("d-opm").value;
  reg.bewaardDoor = state.wie||""; reg.bewaardOp = new Date().toISOString();
  duw("registratie", reg); toast("Bewaard.");
}

function voegToe(){
  var datum=el("a-datum").value, tijd=el("a-tijd").value, wie=el("a-ophaler").value;
  if(!datum||!tijd){ toast("Vul een datum en een uur in."); return; }
  if(state.regs[datum] && !confirm("Voor "+dateLong(datum)+" bestaat al een registratie om "+uur(state.regs[datum].tijd)+". Overschrijven?")) return;
  var reg={datum:datum, tijd:tijd, ophaler:wie, opmerking:"", einduur:"", gps:null,
           bewaardDoor:state.wie||"", bewaardOp:new Date().toISOString()};
  state.regs[datum]=reg; duw("registratie", reg);
  state.hPeriode = periodeStart(datum, +state.cfg.periodeStartDag||1);
  toast("Toegevoegd.");
}

function vulOphalers(sel){
  if(!sel) return;
  var cur = sel.value;
  sel.innerHTML = state.cfg.ophalers.map(function(n){ return '<option value="'+esc(n)+'">'+esc(n)+'</option>'; }).join("");
  if(cur && state.cfg.ophalers.indexOf(cur)>=0) sel.value=cur;
  else if(state.wie && state.cfg.ophalers.indexOf(state.wie)>=0) sel.value=state.wie;
}

function zetVeld(id,v){ var e=el(id); if(e && document.activeElement!==e) e.value = (v==null?"":v); }

/* ---------- historiek ---------- */
function renderHistoriek(){
  var D=+state.cfg.periodeStartDag||1;
  el("h-label").textContent = periodeLabel(state.hPeriode, D);
  var pd = periodeData(state.hPeriode), body=el("h-body");
  var n = Object.keys(state.regs).length;
  el("h-lede").textContent = n===0 ? "Nog geen registraties." : n+" geregistreerd"+(n===1?" moment":"e momenten")+" in totaal.";
  if(!pd.rows.length){
    body.innerHTML = '<div class="empty"><div class="big">Geen registraties in deze periode</div>Blader naar een andere periode, of voeg een dag toe bij Registreren.</div>';
    return;
  }
  var h = '<div class="tablewrap"><table><thead><tr><th>Dag</th><th>Afgehaald</th><th>Lessen tot</th><th>Opgehaald door</th>'+
    '<th class="n">In opvang</th><th class="n">½ uren</th><th class="n">Kost</th><th></th></tr></thead><tbody>';
  pd.rows.forEach(function(x){
    var r=x.reg,b=x.b;
    h += '<tr data-iso="'+esc(r.datum)+'"><td>'+esc(dateShort(r.datum))+'</td>'+
      '<td class="num">'+esc(uur(r.tijd))+'</td><td class="num muted">'+esc(uur(b.einde))+'</td>'+
      '<td>'+esc(r.ophaler||"—")+(r.opmerking?'<span class="opm">'+esc(r.opmerking)+'</span>':"")+'</td>'+
      '<td class="n">'+esc(duur(b.opvangMin))+'</td><td class="n">'+b.halfuren+'</td>'+
      '<td class="n">'+esc(eur(b.totaal))+'</td>'+
      '<td class="n"><button class="rowbtn" data-edit="'+esc(r.datum)+'">wijzig</button></td></tr>';
  });
  body.innerHTML = h+'</tbody></table></div>';
  Array.prototype.forEach.call(body.querySelectorAll("[data-edit]"), function(b){
    b.onclick = function(){ openEdit(b.getAttribute("data-edit")); };
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
  td.innerHTML =
    '<div class="grid3">'+
      '<div class="field"><label>Uur</label><input type="time" class="e-tijd" value="'+esc(reg.tijd||"")+'"></div>'+
      '<div class="field"><label>Opgehaald door</label><select class="e-wie">'+
        state.cfg.ophalers.map(function(n){ return '<option'+(n===reg.ophaler?" selected":"")+'>'+esc(n)+'</option>'; }).join("")+'</select></div>'+
      '<div class="field"><label>Einduur lessen (alleen deze dag)</label><input type="time" class="e-einde" value="'+esc(reg.einduur||"")+'"></div>'+
    '</div>'+
    '<div class="field" style="margin-top:10px"><label>Opmerking</label><input type="text" class="e-opm" value="'+esc(reg.opmerking||"")+'"></div>'+
    '<div class="row" style="margin-top:12px; justify-content:space-between">'+
      '<button class="btn ghost sm e-del" type="button">Deze dag verwijderen</button>'+
      '<button class="btn primary sm e-ok" type="button">Bewaren</button></div>';
  row.appendChild(td); tr.parentNode.insertBefore(row, tr.nextSibling);
  td.querySelector(".e-ok").onclick = function(){
    reg.tijd = td.querySelector(".e-tijd").value || reg.tijd;
    reg.ophaler = td.querySelector(".e-wie").value;
    reg.opmerking = td.querySelector(".e-opm").value;
    reg.einduur = td.querySelector(".e-einde").value || "";
    reg.bewaardDoor = state.wie||""; reg.bewaardOp=new Date().toISOString();
    duw("registratie", reg); toast("Bewaard.");
  };
  td.querySelector(".e-del").onclick = function(){
    if(confirm("De registratie van "+dateLong(iso)+" verwijderen?")){
      delete state.regs[iso]; duw("verwijder",{datum:iso}); toast("Verwijderd.");
    }
  };
}

/* ---------- rapport ---------- */
function renderRapport(){
  var D=+state.cfg.periodeStartDag||1, c=state.cfg;
  var start=state.rPeriode, lbl=periodeLabel(start,D), pd=periodeData(start), s=pd.som;
  el("r-label").textContent = lbl;
  el("r-title").textContent = "Rapport — "+lbl;
  el("r-sub").textContent = (c.kindNaam? c.kindNaam+", ":"")+(c.schoolNaam||"")+
    " · periode "+dateShort(pd.start)+" t.e.m. "+dateShort(pd.einde);

  el("r-kpis").innerHTML = '<div class="kpis">'+
    kpi("Opvangdagen", String(s.dagen), s.dagen? "met een registratie":"nog niets geregistreerd")+
    kpi("Totale opvangduur", duur(s.opvangMin), "vanaf het einde van de lessen")+
    kpi("Aangerekende tijd", duur(s.betaalMin), s.halfuren+" begonnen halve uren")+
    kpi("Geschatte kost", eur(s.totaal), s.toeslag>0? "incl. "+eur(s.toeslag)+" toeslag" :
        "aan "+eur(c.tariefHalfuur*(c.sociaalTarief?c.sociaalFactor:1))+" per half uur")+
    kpi("Eerste afhaling", s.vroeg!=null? uur(fromMin(s.vroeg)):"—", "vroegste uur")+
    kpi("Laatste afhaling", s.laat!=null? uur(fromMin(s.laat)):"—", "laatste uur")+
  '</div>';

  var bud=el("r-budget"); bud.innerHTML="";
  if(s.dagen>0 && c.maandbudget>0){
    bud.innerHTML = (s.totaal>c.maandbudget)
      ? banner("bad","Boven het budget","De geschatte kost van "+eur(s.totaal)+" ligt "+eur(s.totaal-c.maandbudget)+" boven je budget van "+eur(c.maandbudget)+".")
      : banner("good","Binnen het budget","Nog "+eur(c.maandbudget-s.totaal)+" te gaan tot je budget van "+eur(c.maandbudget)+".");
  }
  if(pd.start.slice(5,7)==="09" || pd.einde.slice(5,7)==="09"){
    bud.innerHTML += banner("info","Administratiebijdrage",
      "Ferm rekent eenmaal per schooljaar "+eur(c.administratiebijdrage)+" administratiekosten aan. Die zit niet in het bedrag hierboven.");
  }

  var chart=el("r-chart");
  if(!pd.rows.length){
    chart.innerHTML = '<div class="empty"><div class="big">Geen registraties in deze periode</div>Registreer een afhaling, of blader naar een andere periode.</div>';
    el("r-table").innerHTML="";
  } else {
    var max = Math.max.apply(null, pd.rows.map(function(x){ return x.b.betaalMin||0; }).concat([30]));
    chart.innerHTML = pd.rows.map(function(x){
      var pct = Math.round(((x.b.betaalMin||0)/max)*100);
      return '<div class="crow" data-over="'+(x.b.toeslag>0?1:0)+'" title="'+
        esc(dateLong(x.reg.datum)+" — afgehaald om "+uur(x.reg.tijd)+", "+x.b.halfuren+" halve uren, "+eur(x.b.totaal))+'">'+
        '<div class="cd">'+esc(dateShort(x.reg.datum))+'</div>'+
        '<div class="ct"><div class="cb" style="width:'+pct+'%"></div></div>'+
        '<div class="cv">'+esc(duur(x.b.betaalMin))+'</div></div>';
    }).join("");

    var h='<div class="tablewrap"><table><thead><tr><th>Dag</th><th>Lessen tot</th><th>Afgehaald</th><th>Opgehaald door</th>'+
      '<th class="n">In opvang</th><th class="n">Aangerekend</th><th class="n">½ uren</th><th class="n">Kost</th></tr></thead><tbody>';
    pd.rows.forEach(function(x){
      var r=x.reg,b=x.b;
      h += '<tr><td>'+esc(dateShort(r.datum))+'</td><td class="num muted">'+esc(uur(b.einde))+'</td>'+
        '<td class="num">'+esc(uur(r.tijd))+'</td>'+
        '<td>'+esc(r.ophaler||"—")+(r.opmerking?'<span class="opm">'+esc(r.opmerking)+'</span>':"")+'</td>'+
        '<td class="n">'+esc(duur(b.opvangMin))+'</td><td class="n">'+esc(duur(b.betaalMin))+'</td>'+
        '<td class="n">'+b.halfuren+'</td><td class="n">'+esc(eur(b.totaal))+'</td></tr>';
    });
    h += '</tbody><tfoot><tr><td colspan="4"><strong>Totaal</strong></td>'+
      '<td class="n"><strong>'+esc(duur(s.opvangMin))+'</strong></td>'+
      '<td class="n"><strong>'+esc(duur(s.betaalMin))+'</strong></td>'+
      '<td class="n"><strong>'+s.halfuren+'</strong></td>'+
      '<td class="n"><strong>'+esc(eur(s.totaal))+'</strong></td></tr></tfoot></table></div>';
    el("r-table").innerHTML = h;
  }

  var f = state.facturen[start] || {};
  zetVeld("f-bedrag", f.bedrag!=null? f.bedrag : "");
  zetVeld("f-halfuren", f.halfuren!=null? f.halfuren : "");
  zetVeld("f-dagen", f.dagen!=null? f.dagen : "");
  zetVeld("f-opm", f.opmerking||"");
  renderVergelijking(lbl, s, f);
}

function kpi(k,v,s){ return '<div class="kpi"><div class="k">'+esc(k)+'</div><div class="v">'+esc(v)+'</div><div class="s">'+esc(s)+'</div></div>'; }

function renderVergelijking(lbl, s, f){
  var box=el("f-result");
  if(f.bedrag==null || f.bedrag===""){
    box.innerHTML = '<div class="hint">Nog geen factuurbedrag ingevuld voor '+esc(lbl)+'.</div>'; return;
  }
  var fb=+f.bedrag, v=fb-s.totaal, pct = s.totaal>0? Math.abs(v)/s.totaal*100 : 100;
  var L=[["Eigen registratie", eur(s.totaal)],["Factuur van Ferm", eur(fb)]];
  if(f.halfuren!=null && f.halfuren!=="") L.push(["Halve uren — eigen / factuur", s.halfuren+" / "+f.halfuren]);
  if(f.dagen!=null && f.dagen!=="") L.push(["Dagen — eigen / factuur", s.dagen+" / "+f.dagen]);
  var bon = '<div class="receipt">'+L.map(function(x){
      return '<div class="line"><span>'+esc(x[0])+'</span><span class="v">'+esc(x[1])+'</span></div>'; }).join("")+
    '<div class="line total"><span>Verschil</span><span class="v">'+(v>=0?"+ ":"− ")+esc(eur(Math.abs(v)))+'</span></div></div>';
  var kop;
  if(Math.abs(v)<0.51) kop = banner("good","De factuur klopt","Het verschil is "+eur(Math.abs(v))+" — dat valt binnen de afrondingsmarge.");
  else if(v>0) kop = banner("bad","Ferm rekent meer aan dan je registreerde",
    "De factuur ligt "+eur(v)+" hoger ("+pct.toFixed(0)+"%). Neem de dagtabel mee als je dit navraagt.");
  else kop = banner("info","De factuur ligt lager dan je berekening",
    "Ferm rekent "+eur(Math.abs(v))+" minder aan. Dat kan kloppen, bijvoorbeeld door een korting of een dag die Ferm niet registreerde.");
  box.innerHTML = kop+'<div style="margin-top:14px">'+bon+'</div>'+
    (f.opmerking? '<div class="hint" style="margin-top:10px">Notitie: '+esc(f.opmerking)+'</div>':"");
}

function bewaarFactuur(){
  var b=el("f-bedrag").value;
  var obj = {periode: state.rPeriode,
    bedrag: b===""? null : +b,
    halfuren: el("f-halfuren").value===""? null : +el("f-halfuren").value,
    dagen: el("f-dagen").value===""? null : +el("f-dagen").value,
    opmerking: el("f-opm").value};
  state.facturen[state.rPeriode]=obj;
  duw("factuur", obj); toast("Factuurgegevens bewaard.");
}

/* ---------- instellingen ---------- */
function renderInstellingen(){
  var c=state.cfg;
  zetVeld("s-kind",c.kindNaam); zetVeld("s-school",c.schoolNaam);
  zetVeld("s-gratis",c.gratisMinuten); zetVeld("s-tarief",c.tariefHalfuur);
  zetVeld("s-admin",c.administratiebijdrage); zetVeld("s-sluit",c.sluitingsuur);
  zetVeld("s-toeslag",c.toeslagLaat); zetVeld("s-budget",c.maandbudget);
  zetVeld("s-startdag",c.periodeStartDag); zetVeld("s-rapportdag",c.rapportDag);
  el("s-sociaal").checked=!!c.sociaalTarief;
  el("s-toeslagaan").checked=!!c.toeslagActief;
  el("s-gps").checked=!!c.gpsActief;
  el("s-gpsinfo").textContent = (c.schoolLat!=null)
    ? "Schoolpoort vastgelegd op "+(+c.schoolLat).toFixed(5)+", "+(+c.schoolLon).toFixed(5)+"."
    : "Nog geen positie vastgelegd.";
  el("s-storage").textContent = "Sleutel bewaard op dit toestel. "+
    (outbox.length? outbox.length+" wijziging(en) wachten op verbinding." : "Alles is doorgestuurd naar het Sheet.");

  var D=+c.periodeStartDag||1;
  var nu = periodeStart(isoToday(), D);
  el("s-perioduitleg").textContent = (D===1)
    ? "De periode loopt van de 1e tot de laatste dag van de maand. Het rapport vertrekt op dag "+c.rapportDag+" en gaat over de vorige maand."
    : "De huidige periode loopt van "+dateLong(nu)+" t.e.m. "+dateLong(periodeEinde(nu,D))+". Het rapport vertrekt op dag "+c.rapportDag+" en gaat over de vorige, afgesloten periode.";

  if(!el("s-einduren").getAttribute("data-built")){
    el("s-einduren").innerHTML = [1,2,3,4,5].map(function(d){
      return '<div class="field"><label for="e'+d+'">'+DAGEN[d]+'</label><input type="time" id="e'+d+'"></div>'; }).join("");
    el("s-einduren").setAttribute("data-built","1");
    [1,2,3,4,5].forEach(function(d){
      el("e"+d).addEventListener("change", function(){
        var v=el("e"+d).value;
        if(v) state.cfg.einduren[String(d)]=v; else delete state.cfg.einduren[String(d)];
        bewaarCfg();
      });
    });
  }
  [1,2,3,4,5].forEach(function(d){ zetVeld("e"+d, c.einduren[String(d)]||""); });

  el("s-ophalers").innerHTML = c.ophalers.map(function(n,i){
    return '<div class="row" style="justify-content:space-between; border-bottom:1px solid var(--line); padding:7px 0">'+
      '<span>'+esc(n)+'</span><button class="rowbtn" data-del="'+i+'">verwijderen</button></div>'; }).join("");
  Array.prototype.forEach.call(el("s-ophalers").querySelectorAll("[data-del]"), function(b){
    b.onclick = function(){
      var i=+b.getAttribute("data-del");
      state.cfg.ophalers = state.cfg.ophalers.filter(function(_,j){ return j!==i; });
      bewaarCfg();
    };
  });
}

/* ---------- export ---------- */
function bewaarBestand(naam, inhoud, type){
  var blob = new Blob([inhoud], {type:type});
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href=url; a.download=naam; document.body.appendChild(a); a.click();
  setTimeout(function(){ URL.revokeObjectURL(url); a.remove(); }, 1500);
}

function csvVal(v){ var s=String(v==null?"":v); return /[";\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; }

function exportCSV(){
  var D=+state.cfg.periodeStartDag||1, pd=periodeData(state.rPeriode), s=pd.som, c=state.cfg;
  var uit=[];
  uit.push(["Opvangwacht — eigen registratie", periodeLabel(pd.start,D), c.kindNaam||"", c.schoolNaam||""].map(csvVal).join(";"));
  uit.push(["Periode", pd.start, "t.e.m.", pd.einde].map(csvVal).join(";"));
  uit.push("");
  uit.push(["Datum","Dag","Einde lessen","Uur afhaling","Opgehaald door","In opvang (min)","Aangerekend (min)","Begonnen halve uren","Kost (EUR)","Toeslag (EUR)","Totaal (EUR)","Opmerking"].join(";"));
  pd.rows.forEach(function(x){
    var r=x.reg,b=x.b;
    uit.push([r.datum, DAGEN[parseISO(r.datum).getDay()], b.einde||"", r.tijd, r.ophaler||"",
      b.opvangMin, b.betaalMin, b.halfuren,
      b.kost.toFixed(2).replace(".",","), b.toeslag.toFixed(2).replace(".",","), b.totaal.toFixed(2).replace(".",","),
      r.opmerking||""].map(csvVal).join(";"));
  });
  uit.push(["TOTAAL","","","","", s.opvangMin, s.betaalMin, s.halfuren,
    s.kost.toFixed(2).replace(".",","), s.toeslag.toFixed(2).replace(".",","), s.totaal.toFixed(2).replace(".",","), ""].map(csvVal).join(";"));
  var f=state.facturen[pd.start];
  if(f && f.bedrag!=null){
    uit.push("");
    uit.push(["Factuur Ferm (EUR)", String(f.bedrag).replace(".",",")].map(csvVal).join(";"));
    uit.push(["Verschil (factuur - eigen)", (f.bedrag-s.totaal).toFixed(2).replace(".",",")].map(csvVal).join(";"));
  }
  bewaarBestand("opvang-"+pd.start+".csv", "﻿"+uit.join("\r\n"), "text/csv;charset=utf-8");
}

function backup(){
  bewaarBestand("opvangwacht-reservekopie-"+isoToday()+".json",
    JSON.stringify({versie:1, instellingen:state.cfg, registraties:state.regs, facturen:state.facturen}, null, 2),
    "application/json");
}

function exportPDF(){
  if(!(window.jspdf && window.jspdf.jsPDF)){ toast("PDF is nu niet beschikbaar — gebruik Afdrukken."); return; }
  var D=+state.cfg.periodeStartDag||1, c=state.cfg, pd=periodeData(state.rPeriode), s=pd.som;
  var doc=new window.jspdf.jsPDF({unit:"mm", format:"a4"});
  var L=16, W=210, y=20;
  doc.setFont("times","bold"); doc.setFontSize(17);
  doc.text("Opvangwacht — periodeoverzicht", L, y); y+=7;
  doc.setFont("helvetica","normal"); doc.setFontSize(10); doc.setTextColor(90);
  doc.text(periodeLabel(pd.start,D)+"  ·  "+(c.kindNaam? c.kindNaam+", ":"")+(c.schoolNaam||""), L, y); y+=5;
  doc.text("Periode "+pd.start+" t.e.m. "+pd.einde+". Eigen registratie, geen officieel document van Ferm.", L, y); y+=9;

  doc.setTextColor(20); doc.setFont("helvetica","bold"); doc.setFontSize(11);
  doc.text("Samenvatting", L, y); y+=6;
  doc.setFont("helvetica","normal"); doc.setFontSize(10);
  var sam=[["Opvangdagen",String(s.dagen)],
    ["Totale opvangduur", duur(s.opvangMin)],
    ["Aangerekende tijd", duur(s.betaalMin)+" ("+s.halfuren+" begonnen halve uren)"],
    ["Eerste / laatste afhaling", (s.vroeg!=null?uur(fromMin(s.vroeg)):"—")+" / "+(s.laat!=null?uur(fromMin(s.laat)):"—")],
    ["Tarief", eur(c.tariefHalfuur*(c.sociaalTarief?c.sociaalFactor:1))+" per begonnen half uur"+(c.sociaalTarief?" (sociaal tarief)":"")],
    ["Geschatte kost", eur(s.totaal)+(s.toeslag>0? " (incl. "+eur(s.toeslag)+" toeslag)":"")]];
  var fac=state.facturen[pd.start];
  if(fac && fac.bedrag!=null){
    sam.push(["Factuur van Ferm", eur(+fac.bedrag)]);
    sam.push(["Verschil", ((+fac.bedrag-s.totaal)>=0?"+ ":"− ")+eur(Math.abs(+fac.bedrag-s.totaal))]);
  }
  sam.forEach(function(r){ doc.setTextColor(90); doc.text(r[0],L,y); doc.setTextColor(20); doc.text(r[1],L+62,y); y+=5.4; });
  y+=5;

  doc.setFont("helvetica","bold"); doc.setFontSize(11); doc.text("Afhaalmomenten", L, y); y+=6;
  var X=[L, L+25, L+48, L+71, L+118, L+143, L+156];
  doc.setFontSize(8); doc.setTextColor(120);
  ["Dag","Lessen tot","Afgehaald","Opgehaald door","In opvang","1/2 u","Kost"].forEach(function(t,i){ doc.text(t, X[i], y); });
  y+=2; doc.setDrawColor(200); doc.line(L,y,W-L,y); y+=4;
  doc.setFontSize(9);
  pd.rows.forEach(function(x){
    if(y>272){ doc.addPage(); y=20; }
    var r=x.reg,b=x.b;
    doc.setTextColor(30); doc.text(dateShort(r.datum), X[0], y);
    doc.setTextColor(120); doc.text(uur(b.einde), X[1], y);
    doc.setTextColor(30);
    doc.text(uur(r.tijd), X[2], y);
    doc.text(String(r.ophaler||"—").slice(0,22), X[3], y);
    doc.text(duur(b.opvangMin), X[4], y);
    doc.text(String(b.halfuren), X[5], y);
    doc.text(eur(b.totaal), X[6], y);
    y+=5;
    if(r.opmerking){ doc.setTextColor(130); doc.setFontSize(8);
      doc.text(String(r.opmerking).slice(0,110), X[3], y); y+=4.2; doc.setFontSize(9); }
  });
  if(y>268){ doc.addPage(); y=20; }
  doc.setDrawColor(120); doc.line(L,y,W-L,y); y+=5;
  doc.setFont("helvetica","bold"); doc.setTextColor(20);
  doc.text("Totaal", X[0], y);
  doc.text(duur(s.opvangMin), X[4], y);
  doc.text(String(s.halfuren), X[5], y);
  doc.text(eur(s.totaal), X[6], y);
  doc.save("opvangrapport-"+pd.start+".pdf");
}

/* ======================= start ======================= */
if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

})();
