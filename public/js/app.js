var AUTH_TOKEN = localStorage.getItem('webnms_token');
var currentUser = null;
var socket = null;
var currentPage = '';
var cy = null;
var charts = {};
var selectedMapId = null;

function api(path, opts) {
  opts = opts || {};
  var h = { 'Authorization': 'Bearer ' + AUTH_TOKEN, 'Content-Type': 'application/json' };
  return fetch('/api' + path, { method: opts.method || 'GET', headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined })
    .then(function(r) { if (r.status === 401) { AUTH_TOKEN = null; localStorage.removeItem('webnms_token'); showLogin(); throw new Error('401'); } return r.json(); });
}
function toast(msg, sev) {
  sev = sev || 'info';
  var c = document.getElementById('toast-box');
  var t = document.createElement('div');
  t.className = 'toast show';
  t.innerHTML = '<div class="toast-body d-flex align-items-center gap-2"><span class="status-dot '+(sev==='success'?'up':sev==='critical'?'down':sev)+'"></span>' + esc(msg) + '</div>';
  c.appendChild(t);
  setTimeout(function(){ t.remove(); }, 5000);
}
function esc(s) { var d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
if(!window._tpmBound){window._tpmBound=true;document.addEventListener('mousedown',function(e){var m=document.getElementById('tpm-menu');if(m&&!m.contains(e.target))m.remove();},true);document.addEventListener('keydown',function(e){if(e.key==='Escape'){var m=document.getElementById('tpm-menu');if(m)m.remove();if(_linkMode){topoLinkOff();toast('Link off','info');}}});}
function iconCls(t) { return {router:'ti ti-router',switch:'ti ti-network',server:'ti ti-server',wireless_ap:'ti ti-antenna',firewall:'ti ti-shield',printer:'ti ti-printer',ont:'ti ti-cable'}[t]||'ti ti-device-desktop'; }
function sColor(s) { return {up:'#2fb344',down:'#e53e3e',warning:'#f59f00',unknown:'#868a91'}[s]||'#868a91'; }
function fmtB(b) { if(!b) return '0 B'; var u=['B','KB','MB','GB','TB']; var i=Math.floor(Math.log(b)/Math.log(1024)); return (b/Math.pow(1024,i)).toFixed(2)+' '+u[i]; }
function fmtS(b) { if(b==null) return '-'; if(!b) return '0 bps'; if(b>=1e9)return(b/1e9).toFixed(1)+' Gbps'; if(b>=1e6)return(b/1e6).toFixed(1)+' Mbps'; if(b>=1e3)return(b/1e3).toFixed(1)+' Kbps'; return Math.round(b)+' bps'; }
function formatLinkLabel(rxBps,txBps) {
  if(rxBps==null && txBps==null) return '';
  return '\u25BC '+fmtS(rxBps)+' \u25B2 '+fmtS(txBps);
}
function dChart(k) { if(charts[k]){charts[k].destroy();charts[k]=null;} }
function pTitle(t) { var e=document.getElementById('page-title'); if(e)e.textContent=t; }
function pHTML(h) { var e=document.getElementById('page-content'); if(e)e.innerHTML=h; return e; }

// ═══ LOGIN ═══
function showLogin() {
  document.getElementById('app-root').style.display = 'none';
  var lr = document.getElementById('login-root');
  lr.style.display = '';
  lr.innerHTML = '<div class="login-page"><div class="login-card"><div class="text-center mb-4"><h2 style="color:#2fb344;font-weight:700">Web-NMS</h2><p class="text-muted">Network Management System</p></div><form id="login-form"><div class="mb-3"><label class="form-label">Username</label><input type="text" class="form-control" id="login-user" value="admin" required></div><div class="mb-3"><label class="form-label">Password</label><input type="password" class="form-control" id="login-pass" value="admin" required></div><div id="login-err" class="text-danger mb-3" style="display:none"></div><button type="submit" class="btn btn-primary w-100">Sign In</button></form></div></div>';
  document.getElementById('login-form').onsubmit = function(e) {
    e.preventDefault();
    document.getElementById('login-err').style.display = 'none';
    fetch('/api/auth/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.getElementById('login-user').value,password:document.getElementById('login-pass').value})}).then(function(r){return r.json()}).then(function(d){
      if(d.token){AUTH_TOKEN=d.token;localStorage.setItem('webnms_token',AUTH_TOKEN);currentUser=d.user;startApp();}
      else{document.getElementById('login-err').textContent=d.error||'Failed';document.getElementById('login-err').style.display='block';}
    }).catch(function(){document.getElementById('login-err').textContent='Connection error';document.getElementById('login-err').style.display='block';});
  };
}
function doLogout() { AUTH_TOKEN=null; currentUser=null; localStorage.removeItem('webnms_token'); if(socket){socket.disconnect();socket=null;} showLogin(); }

// ═══ INIT ═══
function startApp() {
  document.getElementById('login-root').style.display = 'none';
  document.getElementById('app-root').style.display = '';
  api('/auth/me').then(function(u){currentUser=u;}).catch(function(){});
  connectSocket(); bindNav(); navigateTo('dashboard');
}
function connectSocket() {
  if(socket) socket.disconnect();
  try {
    socket = io({auth:{token:AUTH_TOKEN}});
    socket.on('connect',function(){console.log('[WS] Connected');});
    socket.on('poll:results',function(r){if(currentPage==='dashboard')liveDash(r);if(currentPage==='topology')liveTopo(r);liveDevicePing(r);});
    socket.on('alert:new',function(a){toast(a.severity.toUpperCase()+': '+a.message,a.severity);if(currentPage==='alerts')loadAlerts();});
    socket.on('discovery:complete',function(r){toast('Found '+r.devicesFound+' in '+r.subnet,'success');if(currentPage==='discovery')loadDiscovery();});
    socket.on('poll:snmp',function(r){liveDeviceIf(r);updateLinkLabels(r);liveTopoSnmp(r);});
    socket.on('map:updated',applyMapUpdate);
  } catch(e){}
}
function bindNav() {
  var links = document.querySelectorAll('#nav-menu .nav-link');
  for(var i=0;i<links.length;i++){(function(l){l.addEventListener('click',function(e){e.preventDefault();navigateTo(l.getAttribute('data-page'));});})(links[i]);}
  document.getElementById('btn-logout').onclick = doLogout;
}
function navigateTo(page) {
  if(!page) return;
  currentPage = page;
  var links = document.querySelectorAll('#nav-menu .nav-link');
  for(var i=0;i<links.length;i++) links[i].classList.toggle('active',links[i].getAttribute('data-page')===page);
  var pc=document.getElementById('page-content-container');
  var ph=document.querySelector('.page-header');
  var ft=document.querySelector('.footer');
  if(page==='topology'){pc.classList.add('full-width');if(ph)ph.style.display='none';if(ft)ft.style.display='none';}
  else{pc.classList.remove('full-width');if(ph)ph.style.display='';if(ft)ft.style.display='';}
  var t={dashboard:'Dashboard',topology:'Topology Map',devices:'Devices',alerts:'Alerts & Alarms',discovery:'Discovery',tools:'Diagnostic Tools',logs:'Event Log',settings:'Settings'};
  pTitle(t[page]||page);
  var f={dashboard:loadDashboard,topology:loadTopology,devices:loadDevices,alerts:loadAlerts,discovery:loadDiscovery,tools:loadTools,logs:loadLogs,settings:loadSettings};
  if(f[page]) f[page]();
}

// ═══ DASHBOARD ═══
function loadDashboard() {
  pHTML('<div class="row row-deck row-cards mb-3"><div class="col-sm-6 col-lg-3"><div class="card stat-card"><div class="card-body"><div class="d-flex align-items-center justify-content-between mb-2"><div class="stat-label">Total</div><i class="ti ti-server text-muted"></i></div><div class="stat-value" id="s-total">-</div></div></div></div><div class="col-sm-6 col-lg-3"><div class="card stat-card"><div class="card-body"><div class="d-flex align-items-center justify-content-between mb-2"><div class="stat-label">Up</div><i class="ti ti-circle-check" style="color:#2fb344"></i></div><div class="stat-value" style="color:#2fb344" id="s-up">-</div></div></div></div><div class="col-sm-6 col-lg-3"><div class="card stat-card"><div class="card-body"><div class="d-flex align-items-center justify-content-between mb-2"><div class="stat-label">Down</div><i class="ti ti-circle-x" style="color:#e53e3e"></i></div><div class="stat-value" style="color:#e53e3e" id="s-down">-</div></div></div></div><div class="col-sm-6 col-lg-3"><div class="card stat-card"><div class="card-body"><div class="d-flex align-items-center justify-content-between mb-2"><div class="stat-label">Alerts</div><i class="ti ti-alert-triangle" style="color:#f59f00"></i></div><div class="stat-value" style="color:#f59f00" id="s-alerts">-</div></div></div></div></div><div class="row row-cards mb-3"><div class="col-lg-8"><div class="card"><div class="card-header"><h3 class="card-title">Traffic</h3> <span class="live-indicator"></span></div><div class="card-body"><div class="chart-container"><canvas id="ch-traffic"></canvas></div></div></div></div><div class="col-lg-4"><div class="card"><div class="card-header"><h3 class="card-title">Status</h3></div><div class="card-body"><div class="chart-container"><canvas id="ch-status"></canvas></div></div></div></div></div><div class="row row-cards mb-3"><div class="col-lg-6"><div class="card"><div class="card-header"><h3 class="card-title">Alerts</h3></div><div class="card-body p-0"><div id="d-alerts" style="max-height:300px;overflow-y:auto"></div></div></div></div><div class="col-lg-6"><div class="card"><div class="card-header"><h3 class="card-title">Devices</h3></div><div class="card-body p-0"><div id="d-devs" style="max-height:300px;overflow-y:auto"></div></div></div></div></div>');
  Promise.all([api('/dashboard/stats'),api('/alerts?status=active&limit=10'),api('/devices')]).then(function(a){
    var s=a[0],al=a[1],dv=a[2],e;
    e=document.getElementById('s-total');if(e)e.textContent=s.total;
    e=document.getElementById('s-up');if(e)e.textContent=s.up;
    e=document.getElementById('s-down');if(e)e.textContent=s.down;
    e=document.getElementById('s-alerts');if(e)e.textContent=s.activeAlerts;
    e=document.getElementById('d-alerts');if(e)e.innerHTML=al.length?al.map(function(a){return '<div class="d-flex align-items-center p-2 border-bottom"><span class="status-dot '+(a.severity==='critical'?'down':'up')+'"></span><div class="flex-fill"><div class="fw-medium">'+esc(a.message)+'</div><div class="text-muted small">'+esc(a.device_name||'System')+' &middot; '+new Date(a.created_at).toLocaleString()+'</div></div></div>';}).join(''):'<div class="p-3 text-muted text-center">No alerts</div>';
    e=document.getElementById('d-devs');if(e)e.innerHTML=dv.map(function(d){return '<div class="d-flex align-items-center p-2 border-bottom" style="cursor:pointer" onclick="viewDevice('+d.id+')"><div class="device-icon '+d.device_type+'"><i class="'+iconCls(d.device_type)+'"></i></div><div class="flex-fill ms-2"><div class="fw-medium">'+esc(d.name)+'</div><div class="text-muted small">'+d.ip_address+'</div></div><span class="status-dot '+d.status+'"></span></div>';}).join('');
    dChart('status');var se=document.getElementById('ch-status');if(se)charts.status=new Chart(se,{type:'doughnut',data:{labels:['Up','Down','Unknown'],datasets:[{data:[s.up,s.down,s.unknown],backgroundColor:['#2fb344','#e53e3e','#868a91'],borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{color:'#c2c7d0'}}}}});
    dChart('traffic');var te=document.getElementById('ch-traffic');if(te){var now=Date.now(),lb=[];for(var i=29;i>=0;i--)lb.push(new Date(now-i*60000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}));var rx=[],tx=[];for(var i=0;i<30;i++){rx.push(Math.random()*100);tx.push(Math.random()*80);}charts.traffic=new Chart(te,{type:'line',data:{labels:lb,datasets:[{label:'Rx',data:rx,borderColor:'#2fb344',backgroundColor:'#2fb34422',fill:true,tension:.3,pointRadius:0},{label:'Tx',data:tx,borderColor:'#357bfd',backgroundColor:'#357bfd22',fill:true,tension:.3,pointRadius:0}]},options:{responsive:true,maintainAspectRatio:false,scales:{x:{display:false},y:{grid:{color:'#2d3139'},ticks:{color:'#868a91'}}},plugins:{legend:{labels:{color:'#c2c7d0'}}}}});}
  }).catch(function(e){console.error('Dashboard:',e);});
}
function liveDash(r){var u=0,d=0;r.forEach(function(x){if(x.ping&&x.ping.reachable)u++;else d++;});var e;e=document.getElementById('s-up');if(e)e.textContent=u;e=document.getElementById('s-down');if(e)e.textContent=d;}

// ═══ DEVICES ═══
function loadDevices() {
  pHTML('<div class="d-flex justify-content-between mb-3"><input type="text" class="form-control" id="dev-search" placeholder="Search..." style="width:300px"><div class="d-flex gap-2"><button class="btn btn-primary" onclick="openDevModal()"><i class="ti ti-plus"></i> Add</button><button class="btn btn-secondary" onclick="doPoll()"><i class="ti ti-refresh"></i> Poll</button></div></div><div class="card"><div class="table-responsive"><table class="table table-vcenter"><thead><tr><th>Status</th><th>Name</th><th>IP</th><th>Type</th><th>SNMP</th><th>Last Seen</th><th>Actions</th></tr></thead><tbody id="dev-tb"></tbody></table></div></div>');
  api('/devices').then(function(dvs){
    var tb=document.getElementById('dev-tb');if(!tb)return;
    tb.innerHTML=dvs.map(function(d){return '<tr><td><span class="status-dot '+d.status+'"></span>'+d.status+'</td><td class="fw-medium">'+esc(d.name)+'</td><td><code>'+d.ip_address+'</code></td><td>'+d.device_type+'</td><td>v'+d.snmp_version+'</td><td>'+(d.last_seen?new Date(d.last_seen).toLocaleString():'Never')+'</td><td><div class="btn-list flex-nowrap"><button class="btn btn-ghost btn-sm" onclick="viewDevice('+d.id+')"><i class="ti ti-eye"></i></button><button class="btn btn-ghost btn-sm" onclick="editDevice('+d.id+')"><i class="ti ti-pencil"></i></button><button class="btn btn-ghost btn-sm text-danger" onclick="delDevice('+d.id+')"><i class="ti ti-trash"></i></button></div></td></tr>';}).join('');
    document.getElementById('dev-search').oninput=function(q){var v=q.target.value.toLowerCase();tb.querySelectorAll('tr').forEach(function(r){r.style.display=r.textContent.toLowerCase().indexOf(v)>=0?'':'none';});};
  }).catch(function(e){console.error(e);});
}
function doPoll(){api('/trigger-poll',{method:'POST'}).then(function(){toast('Poll triggered','success');loadDevices();}).catch(function(){toast('Poll failed','critical');});}
function openDevModal(dev){
  var m=new bootstrap.Modal(document.getElementById('modal-device'));
  document.getElementById('dev-modal-title').textContent=dev?'Edit Device':'Add Device';
  document.getElementById('df-id').value=dev?dev.id:'';
  document.getElementById('df-name').value=dev?dev.name:'';
  document.getElementById('df-ip').value=dev?dev.ip_address:'';
  document.getElementById('df-type').value=dev?dev.device_type:'generic';
  document.getElementById('df-ver').value=dev?dev.snmp_version:'2c';
  document.getElementById('df-comm').value=dev?(dev.snmp_community||'public'):'public';
  document.getElementById('df-port').value=dev?(dev.snmp_port||161):161;
  document.getElementById('df-user').value=dev?(dev.snmp_user||''):'';
  document.getElementById('df-authp').value=dev?(dev.snmp_auth_protocol||'none'):'none';
  document.getElementById('df-authpw').value=dev?(dev.snmp_auth_pass||''):'';
  document.getElementById('df-privp').value=dev?(dev.snmp_priv_protocol||'none'):'none';
  document.getElementById('df-privpw').value=dev?(dev.snmp_priv_pass||''):'';
  dfVerToggle();
  api('/snmp-profiles').then(function(list){_snmpProfiles=list||[];var s=document.getElementById('df-profile');if(s){s.innerHTML='<option value="">— Manual —</option>'+_snmpProfiles.map(function(p){return '<option value="'+p.id+'">'+esc(p.name)+' (v'+p.snmp_version+')</option>';}).join('');s.value='';}}).catch(function(){});
  m.show();
}
function editDevice(id){api('/devices/'+id).then(function(d){openDevModal(d);}).catch(function(){});}
function delDevice(id){if(!confirm('Delete this device?'))return;api('/devices/'+id,{method:'DELETE'}).then(function(){toast('Deleted','success');loadDevices();});}
function ifRow(i){
  var st=i.if_oper_status===1?['up','Up']:(i.if_oper_status===2?['down','Down']:['unknown','?']);
  return '<tr><td>'+i.if_index+'</td><td>'+esc(i.if_name||'')+'</td><td><span class="status-dot '+st[0]+'"></span>'+st[1]+'</td><td>'+fmtS(i.if_speed)+'</td><td>'+fmtB(i.if_in_octets)+'</td><td>'+fmtB(i.if_out_octets)+'</td><td>'+((i.if_in_errors||0)+(i.if_out_errors||0))+'</td></tr>';
}
function liveDeviceIf(results){
  if(!window._viewDevId)return;
  var tb=document.getElementById('dev-if-tb');
  (results||[]).forEach(function(x){
    if(x.deviceId!==window._viewDevId||!x.snmp)return;
    if(tb&&x.snmp.interfaces)tb.innerHTML=x.snmp.interfaces.map(ifRow).join('');
    if(charts.cpu){
      charts.cpu.data.labels.push(new Date().toLocaleTimeString());
      charts.cpu.data.datasets[0].data.push(x.snmp.cpuLoad!=null?x.snmp.cpuLoad:null);
      charts.cpu.data.datasets[1].data.push(x.snmp.memoryPct!=null?x.snmp.memoryPct:null);
      trimChart(charts.cpu,120);charts.cpu.update('none');
    }
  });
}
function liveDevicePing(results){
  if(!window._viewDevId||!charts.ping)return;
  (results||[]).forEach(function(x){
    if(x.deviceId!==window._viewDevId||!x.ping)return;
    charts.ping.data.labels.push(new Date().toLocaleTimeString());
    charts.ping.data.datasets[0].data.push(x.ping.reachable?x.ping.latencyMs:null);
    trimChart(charts.ping,120);charts.ping.update('none');
  });
}
function trimChart(c,n){while(c.data.labels.length>n){c.data.labels.shift();c.data.datasets.forEach(function(d){d.data.shift();});}}
function viewDevice(id) {
  window._viewDevId=id;
  Promise.all([api('/devices/'+id),api('/devices/'+id+'/metrics?limit=100'),api('/devices/'+id+'/interfaces')]).then(function(a){
    var d=a[0],mx=a[1],ifc=a[2];
    pHTML('<div class="d-flex justify-content-between mb-3"><div class="d-flex align-items-center gap-2"><button class="btn btn-ghost btn-sm" onclick="loadDevices()"><i class="ti ti-arrow-left"></i></button><h3 class="mb-0">'+esc(d.name)+'</h3><span class="badge bg-'+(d.status==='up'?'success':'danger')+'">'+d.status+'</span></div><div class="d-flex gap-2"><button class="btn btn-primary btn-sm" onclick="editDevice('+d.id+')"><i class="ti ti-pencil"></i> Edit</button></div></div><div class="row mb-3"><div class="col-md-3"><div class="card"><div class="card-body"><div class="stat-label">IP</div><div class="fw-bold">'+d.ip_address+'</div></div></div></div><div class="col-md-3"><div class="card"><div class="card-body"><div class="stat-label">Type</div><div class="fw-bold">'+d.device_type+'</div></div></div></div><div class="col-md-3"><div class="card"><div class="card-body"><div class="stat-label">Last Seen</div><div class="fw-bold">'+(d.last_seen?new Date(d.last_seen).toLocaleString():'Never')+'</div></div></div></div><div class="col-md-3"><div class="card"><div class="card-body"><div class="stat-label">SNMP</div><div class="fw-bold">v'+d.snmp_version+'</div></div></div></div></div><div class="row mb-3"><div class="col-lg-6"><div class="card"><div class="card-header"><h3 class="card-title">Ping Latency</h3></div><div class="card-body"><div class="chart-container"><canvas id="ch-ping"></canvas></div></div></div></div><div class="col-lg-6"><div class="card"><div class="card-header"><h3 class="card-title">CPU & Memory</h3></div><div class="card-body"><div class="chart-container"><canvas id="ch-cpu"></canvas></div></div></div></div></div>'+(ifc.length?'<div class="card mb-3"><div class="card-header"><h3 class="card-title">Interfaces <span class="live-indicator ms-1"></span></h3></div><div class="table-responsive"><table class="table table-vcenter"><thead><tr><th>#</th><th>Name</th><th>Status</th><th>Speed</th><th>Rx</th><th>Tx</th><th>Err</th></tr></thead><tbody id="dev-if-tb">'+ifc.map(ifRow).join('')+'</tbody></table></div></div>':'')+'<div class="card mb-3"><div class="card-header"><h3 class="card-title">Actions</h3></div><div class="card-body d-flex gap-2"><button class="btn btn-primary" onclick="pingDev('+d.id+')"><i class="ti ti-send"></i> Ping</button><button class="btn btn-secondary" onclick="navTool(\''+d.ip_address+'\',\'traceroute\')"><i class="ti ti-route"></i> Traceroute</button><button class="btn btn-secondary" onclick="navTool(\''+d.ip_address+'\',\'portscan\')"><i class="ti ti-network"></i> Port Scan</button></div></div>');
    var pd=mx.filter(function(m){return m.metric_type==='ping';}).reverse();
    var cd=mx.filter(function(m){return m.metric_type==='cpu';}).reverse();
    var md=mx.filter(function(m){return m.metric_type==='memory';}).reverse();
    dChart('ping');var pe=document.getElementById('ch-ping');if(pe)charts.ping=new Chart(pe,{type:'line',data:{labels:pd.map(function(m){return new Date(m.timestamp).toLocaleTimeString();}),datasets:[{label:'ms',data:pd.map(function(m){return m.value;}),borderColor:'#2fb344',backgroundColor:'#2fb34422',fill:true,tension:.3,pointRadius:2}]},options:{responsive:true,maintainAspectRatio:false,scales:{x:{display:false},y:{grid:{color:'#2d3139'},ticks:{color:'#868a91'}}},plugins:{legend:{labels:{color:'#c2c7d0'}}}}});
    dChart('cpu');var ce=document.getElementById('ch-cpu');if(ce)charts.cpu=new Chart(ce,{type:'line',data:{labels:cd.map(function(m){return new Date(m.timestamp).toLocaleTimeString();}),datasets:[{label:'CPU%',data:cd.map(function(m){return m.value;}),borderColor:'#f59f00',tension:.3,pointRadius:2},{label:'Mem%',data:md.map(function(m){return m.value;}),borderColor:'#ae3ec9',tension:.3,pointRadius:2}]},options:{responsive:true,maintainAspectRatio:false,scales:{x:{display:false},y:{min:0,max:100,grid:{color:'#2d3139'},ticks:{color:'#868a91'}}},plugins:{legend:{labels:{color:'#c2c7d0'}}}}});
  }).catch(function(e){console.error(e);toast('Error loading device','critical');});
}
function pingDev(id){toast('Pinging...','info');api('/devices/'+id+'/ping').then(function(r){toast('Ping: '+(r.reachable?'Reachable':'Down')+' '+r.latencyMs+'ms',r.reachable?'success':'critical');});}
function dfVerToggle(){var v=document.getElementById('df-ver').value;document.getElementById('df-v3-rows').style.display=v==='3'?'':'none';}
document.getElementById('df-ver').onchange=dfVerToggle;
document.getElementById('df-profile').onchange=function(){
  var pid=this.value;if(!pid)return;
  var p=_snmpProfiles.filter(function(x){return String(x.id)===String(pid);})[0];if(!p)return;
  document.getElementById('df-ver').value=p.snmp_version;
  document.getElementById('df-port').value=p.snmp_port||161;
  document.getElementById('df-comm').value=p.snmp_community||'public';
  document.getElementById('df-user').value=p.snmp_user||'';
  document.getElementById('df-authp').value=p.snmp_auth_protocol||'none';
  document.getElementById('df-authpw').value=p.snmp_auth_pass||'';
  document.getElementById('df-privp').value=p.snmp_priv_protocol||'none';
  document.getElementById('df-privpw').value=p.snmp_priv_pass||'';
  dfVerToggle();
  toast('Profile "'+p.name+'" applied','success');
};
document.getElementById('btn-save-dev').onclick=function(){
  var id=document.getElementById('df-id').value;
  var data={name:document.getElementById('df-name').value,ip_address:document.getElementById('df-ip').value,device_type:document.getElementById('df-type').value,snmp_version:document.getElementById('df-ver').value,snmp_community:document.getElementById('df-comm').value,snmp_port:parseInt(document.getElementById('df-port').value)||161,snmp_user:document.getElementById('df-user').value||null,snmp_auth_protocol:document.getElementById('df-authp').value,snmp_auth_pass:document.getElementById('df-authpw').value||null,snmp_priv_protocol:document.getElementById('df-privp').value,snmp_priv_pass:document.getElementById('df-privpw').value||null};
  if(!data.name||!data.ip_address){toast('Name and IP required','critical');return;}
  var p=id?api('/devices/'+id,{method:'PUT',body:data}):api('/devices',{method:'POST',body:data});
  p.then(function(){bootstrap.Modal.getInstance(document.getElementById('modal-device')).hide();toast(id?'Updated':'Created','success');if(currentPage==='topology'&&selectedMapId){loadMap(selectedMapId);}else{loadDevices();}}).catch(function(){toast('Error','critical');});
};

// ═══ TOPOLOGY ═══
function loadTopology() {
  api('/maps').then(function(maps){
    pHTML('<div class="topology-wrapper"><div class="topo-toolbar"><div class="d-flex gap-2 align-items-center"><select class="form-select" id="topo-sel" style="width:250px"><option value="">Select map...</option>'+maps.map(function(m){return '<option value="'+m.id+'">'+esc(m.title)+'</option>';}).join('')+'</select><button class="btn btn-secondary" onclick="new bootstrap.Modal(document.getElementById(\'modal-map\')).show()"><i class="ti ti-plus"></i> New Map</button></div><div class="d-flex gap-2" id="topo-tools" style="display:none"><button class="btn btn-sm btn-secondary" onclick="topoZoom(1)"><i class="ti ti-zoom-in"></i></button><button class="btn btn-sm btn-secondary" onclick="topoZoom(-1)"><i class="ti ti-zoom-out"></i></button><button class="btn btn-sm btn-secondary" onclick="if(cy)cy.fit(undefined,50)"><i class="ti ti-zoom-fit"></i> Fit</button></div></div><div style="position:relative" id="topo-wrap"><div class="topology-container" id="cy-topo"></div><div id="node-tip"></div><div id="link-tip"></div><div id="topo-palette" class="map-node-palette"><div class="text-muted small mb-1">Click to add:</div><div id="palette-list"></div></div></div></div>');
    var tsel=document.getElementById('topo-sel');if(!tsel)return;
    tsel.onchange=function(e){if(e.target.value){selectedMapId=parseInt(e.target.value);document.getElementById('topo-tools').style.display='';loadMap(selectedMapId);}};
    if(maps.length){tsel.value=maps[0].id;selectedMapId=maps[0].id;document.getElementById('topo-tools').style.display='';loadMap(maps[0].id);}
  });
}
function loadMap(mapId) {
  topoLinkOff();
  api('/maps/'+mapId).then(function(md){
    if(cy){cy.destroy();cy=null;}
    var els=[];
    md.nodes.forEach(function(n){els.push(topoNodeEl(n));});
    md.links.forEach(function(l){els.push(topoLinkEl(l));});
    cy=cytoscape({container:document.getElementById('cy-topo'),elements:els,layout:{name:'preset'},zoom:1,minZoom:0.1,maxZoom:4,boxSelectionEnabled:false,autoungrabify:false,autounselectify:false,userZoomingEnabled:true,userPanningEnabled:true,style:[
      {selector:'node',style:{'label':'data(label)','background-color':'data(statusColor)','border-color':'rgba(0,0,0,0.35)','border-width':1,'width':150,'height':70,'font-size':'12px','font-weight':'bold','color':'#fff','text-valign':'center','text-halign':'center','text-wrap':'wrap','text-max-width':'140px','shape':'round-rectangle','text-outline-width':0,'cursor':'grab'}},
      {selector:'node:grabbed',style:{'cursor':'grabbing','border-width':3,'border-color':'#357bfd'}},
      {selector:'node.wireless_ap',style:{'shape':'ellipse'}},
      {selector:'node.network',style:{'shape':'ellipse','background-color':'#152238','border-style':'dashed','border-color':'#5b8fd4'}},
      {selector:'node.submap',style:{'background-color':'#1d2440','border-style':'double','border-color':'#7c8aff'}},
      {selector:'node.static',style:{'shape':'ellipse','width':22,'height':22,'background-color':'#3a4152','border-color':'rgba(255,255,255,0.3)','font-size':'11px','text-max-width':'120px'}},
      {selector:'edge',style:{'width':2,'line-color':'#4a5060','target-arrow-color':'#4a5060','target-arrow-shape':'triangle','curve-style':'bezier','label':'data(label)','font-size':'10px','color':'#c2c7d0','text-background-color':'#1a1d23','text-background-opacity':0.9,'text-wrap':'wrap','edge-text-rotation':'autorotate','text-margin-y':-12,'text-outline-width':0}},
      {selector:'.down',style:{'line-color':'#e53e3e'}},
      {selector:'.up',style:{'line-color':'#2fb344'}},
      {selector:':selected',style:{'border-width':3,'border-color':'#357bfd'}}
    ]});
    cy.nodes().forEach(topoStyleNode);
    cy.fit(undefined, 60);
    cy.maxZoom(4); cy.minZoom(0.1);
    (function(){var cont=document.getElementById('cy-topo');if(cont)Array.prototype.slice.call(cont.childNodes).forEach(function(c){if(c.nodeName==='CANVAS')cont.removeChild(c);});if(cy.gridGuide)cy.gridGuide({drawGrid:true,panGrid:true,zoomDash:true,snapToGridOnRelease:false,snapToGridDuringDrag:false,snapToAlignmentLocationOnRelease:false,snapToAlignmentLocationDuringDrag:false,distributionGuidelines:false,geometricGuideline:false,initPosAlignment:false,centerToEdgeAlignment:false,resize:false,parentPadding:false,gridSpacing:40,gridColor:'rgba(148,163,184,0.45)',lineWidth:1,gridStackOrder:-1});})();
    bindTopoTap();
    cy.on('dblclick dbltap',function(e){
      if(e.target!==cy||!e.renderedPosition)return;
      var z0=cy.zoom(),z1=Math.min(4,z0*1.6),rp=e.renderedPosition,p0=cy.pan();
      var m={x:(rp.x-p0.x)/z0,y:(rp.y-p0.y)/z0};
      cy.stop(true,false);
      cy.animate({zoom:z1,pan:{x:rp.x-m.x*z1,y:rp.y-m.y*z1}},{duration:200});
    });
    cy.on('cxttap',function(e){
      if(!e.position)return;
      var oe=e.originalEvent,px=null,py=null;
      var w=document.getElementById('topo-wrap');
      if(oe&&oe.clientX!==undefined&&w){var r=w.getBoundingClientRect();px=oe.clientX-r.left;py=oe.clientY-r.top;}
      else if(e.renderedPosition){px=e.renderedPosition.x;py=e.renderedPosition.y;}
      else return;
      if(e.target===cy)showTopoMenu(px,py,e.position);
      else if(e.target.isNode&&e.target.isNode())showTopoElMenu(px,py,e.target);
      else if(e.target.isEdge&&e.target.isEdge())showTopoLinkMenu(px,py,e.target);
    });
    cy.on('mouseover','node',function(e){
      hideLinkTip();
      if(e.target.hasClass&&e.target.hasClass('static')){e.target.data('_hover',true);renderNodeLabel(e.target);}
      var tip=document.getElementById('node-tip');if(!tip)return;
      tip.innerHTML=nodeTipHTML(e.target);
      var rp=e.target.renderedPosition();
      var w=document.getElementById('topo-wrap'),cr=document.getElementById('cy-topo');
      var r=w.getBoundingClientRect(),c=cr.getBoundingClientRect();
      tip.style.display='block';
      tip.style.left=Math.min(Math.max(c.left-r.left+rp.x,110),Math.max(110,r.width-110))+'px';
      tip.style.top=Math.max(c.top-r.top+rp.y-12,148)+'px';
      tip.style.transform='translate(-50%,-100%)';
    });
    cy.on('mouseout grab','node',function(e){hideNodeTip();if(e.target&&e.target.hasClass&&e.target.hasClass('static')){e.target.data('_hover',false);renderNodeLabel(e.target);}});
    cy.on('pan zoom',function(){hideNodeTip();hideLinkTip();if(cy)cy.nodes('.static').forEach(function(n){n.data('_hover',false);renderNodeLabel(n);});});
    cy.on('mouseover','edge',showLinkTip);
    cy.on('mouseout','edge',hideLinkTip);
    var saveTimer=null;
    cy.on('drag','node',function(){_justDragged=true;});
    cy.on('dragfree','node',function(e){var n=e.target;var p=n.position();if(saveTimer)clearTimeout(saveTimer);saveTimer=setTimeout(function(){api('/maps/'+selectedMapId+'/nodes/'+n.data('mapNodeId'),{method:'PUT',body:{x_position:Math.round(p.x),y_position:Math.round(p.y)}}).catch(function(){});},400);});
  });
}
var _linkMode=false,_linkSrc=null,_linkSrcIf=null,_justDragged=false;
function hideTopoMenu(){var m=document.getElementById('tpm-menu');if(m)m.remove();}
function runTopoTool(title,promise){
  document.getElementById('tool-modal-title').textContent=title;
  document.getElementById('tool-out').textContent='Running...';
  new bootstrap.Modal(document.getElementById('modal-tool')).show();
  promise.then(function(out){document.getElementById('tool-out').textContent=out;}).catch(function(){document.getElementById('tool-out').textContent='Request failed.';});
}
var _pingRun=0,_pingActive=false,_pingStats=null,_pingTarget=null,_pingChart=null,_pingLabels=[],_pingLat=[];
function pingChartPush(lat){
  _pingLabels.push(new Date().toLocaleTimeString());
  _pingLat.push(lat);
  if(_pingLabels.length>60){_pingLabels.shift();_pingLat.shift();}
  if(_pingChart){_pingChart.data.labels=_pingLabels.slice();_pingChart.data.datasets[0].data=_pingLat.slice();_pingChart.update('none');}
}
function pingChartInit(){
  if(_pingChart){_pingChart.destroy();_pingChart=null;}
  _pingLabels=[];_pingLat=[];
  var c=document.getElementById('ping-chart');
  if(c&&typeof Chart!=='undefined')_pingChart=new Chart(c,{type:'line',data:{labels:[],datasets:[{label:'ms',data:[],borderColor:'#2fb344',backgroundColor:'#2fb34422',fill:true,tension:.3,pointRadius:0}]},options:{responsive:true,maintainAspectRatio:false,animation:false,scales:{x:{display:false},y:{min:0,grid:{color:'#2d3139'},ticks:{color:'#868a91'}}},plugins:{legend:{display:false}}}});
}
function syncPingStats(){
  var s=_pingStats||{sent:0,ok:0,fail:0,latSum:0};
  document.getElementById('ping-sent').textContent=s.sent;
  document.getElementById('ping-ok').textContent=s.ok;
  document.getElementById('ping-fail').textContent=s.fail;
  document.getElementById('ping-loss').textContent=(s.sent?Math.round(s.fail/s.sent*100):0)+'%';
  document.getElementById('ping-avg').textContent=s.ok?(Math.round(s.latSum/s.ok*10)/10+' ms'):'-';
  document.getElementById('ping-bar-ok').style.width=(s.sent?Math.round(s.ok/s.sent*100):0)+'%';
  document.getElementById('ping-bar-fail').style.width=(s.sent?Math.round(s.fail/s.sent*100):0)+'%';
}
function syncPingBtn(){document.getElementById('btn-ping-toggle').textContent=_pingActive?'Stop':'Start';}
function runPingTool(name,did,ip){
  var run=++_pingRun;
  _pingActive=true;_pingTarget={name:name,did:did,ip:ip};_pingStats={sent:0,ok:0,fail:0,latSum:0};
  document.getElementById('ping-modal-title').textContent='PING - '+name+' ('+ip+')';
  document.getElementById('ping-out').textContent='';
  pingChartInit();
  syncPingStats();syncPingBtn();
  new bootstrap.Modal(document.getElementById('modal-ping')).show();
  pingTick(did,ip,run);
}
function pingTick(did,ip,run){
  if(run!==_pingRun)return;
  api('/devices/'+did+'/ping').then(function(r){
    if(run!==_pingRun)return;
    _pingStats.sent++;
    var out=document.getElementById('ping-out');
    if(r&&r.reachable){_pingStats.ok++;if(r.latencyMs!=null)_pingStats.latSum+=r.latencyMs;pingChartPush(r.latencyMs!=null?r.latencyMs:null);out.textContent+='Reply from '+ip+': '+(r.latencyMs!=null?'time='+r.latencyMs+'ms':'ok')+'\n';}
    else{_pingStats.fail++;pingChartPush(null);out.textContent+='Request timed out.\n';}
    var lines=out.textContent.split('\n');if(lines.length>201)out.textContent=lines.slice(lines.length-201).join('\n');
    out.scrollTop=out.scrollHeight;
    syncPingStats();
  }).catch(function(){
    if(run!==_pingRun)return;
    _pingStats.sent++;_pingStats.fail++;pingChartPush(null);
    var out=document.getElementById('ping-out');out.textContent+='Request failed.\n';out.scrollTop=out.scrollHeight;
    syncPingStats();
  }).then(function(){if(run===_pingRun&&_pingActive)setTimeout(function(){pingTick(did,ip,run);},1000);});
}
document.getElementById('btn-ping-toggle').onclick=function(){
  if(_pingActive){_pingActive=false;_pingRun++;syncPingBtn();}
  else if(_pingTarget){runPingTool(_pingTarget.name,_pingTarget.did,_pingTarget.ip);}
};
document.getElementById('modal-ping').addEventListener('hidden.bs.modal',function(){_pingActive=false;_pingRun++;syncPingBtn();});
var _mtrRun=0,_mtrActive=false;
var _snmpRun=0,_snmpActive=false;
function syncToolStop(){document.getElementById('btn-tool-stop').style.display=(_mtrActive||_snmpActive)?'':'none';}
function stopToolLoops(){_mtrActive=false;_mtrRun++;_snmpActive=false;_snmpRun++;syncToolStop();}
function snmpTable(r,round){
  var h='<div class="small text-muted mb-2">HOST: '+esc(r.ip||'')+' &middot; round '+round+' &middot; updated '+new Date().toLocaleTimeString()+'</div>';
  h+='<div class="d-flex gap-3 mb-2 small"><span>CPU: <b class="text-white">'+(r.cpuLoad!=null?r.cpuLoad+' %':'-')+'</b></span><span>Memory: <b class="text-white">'+(r.memoryPct!=null?r.memoryPct+' %':'-')+'</b></span><span>Interfaces: <b class="text-white">'+(r.interfaces?r.interfaces.length:0)+'</b></span></div>';
  h+='<div class="small text-muted mb-1">'+esc(r.sysName||'')+(r.sysDescr?' &middot; '+esc(String(r.sysDescr).slice(0,120)):'')+'</div>';
  h+='<div class="table-responsive"><table class="table table-sm table-vcenter mb-0"><thead><tr><th>#</th><th>Name</th><th>Status</th><th>Speed</th><th>Rx</th><th>Tx</th><th>Err</th></tr></thead><tbody>';
  (r.interfaces||[]).forEach(function(i){
    var op=i.if_oper_status==1?'<span class="text-success">up</span>':(i.if_oper_status==2?'<span class="text-danger">down</span>':'?');
    h+='<tr><td>'+i.if_index+'</td><td><code>'+esc(i.if_name||'')+'</code></td><td>'+op+'</td><td>'+fmtS(i.if_speed||0)+'</td><td>'+fmtB(i.if_in_octets||0)+'</td><td>'+fmtB(i.if_out_octets||0)+'</td><td>'+((i.if_in_errors||0)+(i.if_out_errors||0))+'</td></tr>';
  });
  return h+'</tbody></table></div>';
}
function runSnmpTool(name,did){
  var run=++_snmpRun;_mtrRun++;_snmpActive=true;
  document.getElementById('tool-modal-title').textContent='SNMP poller - '+name;
  syncToolStop();
  new bootstrap.Modal(document.getElementById('modal-tool')).show();
  snmpTick(did,run,0);
}
function snmpTick(did,run,round){
  if(run!==_snmpRun||!_snmpActive)return;
  if(round===0)document.getElementById('tool-out').textContent='Running...';
  api('/devices/'+did+'/snmp').then(function(r){
    if(run!==_snmpRun||!_snmpActive)return;
    if(!r||r.error){document.getElementById('tool-out').textContent='SNMP query failed'+(r&&r.error?': '+r.error:'')+'.\nCheck community/credentials and that the device allows SNMP.';stopToolLoops();return;}
    document.getElementById('tool-out').innerHTML=snmpTable(r,round+1);
    setTimeout(function(){snmpTick(did,run,round+1);},5000);
  }).catch(function(){if(run!==_snmpRun||!_snmpActive)return;document.getElementById('tool-out').textContent='Request failed.';stopToolLoops();});
}
function mtrTable(ip,hops,round){
  var h='<div class="small text-muted mb-2">HOST: '+esc(ip)+' &middot; round '+round+' &middot; stats over last 4 probes</div>';
  h+='<div class="table-responsive"><table class="table table-sm table-vcenter mb-0"><thead><tr><th>#</th><th>Address</th><th>Loss</th><th>Sent</th><th>Last</th><th>Avg</th><th>Best</th><th>Worst</th></tr></thead><tbody>';
  hops.forEach(function(x){
    h+='<tr><td>'+x.hop+'</td><td><code>'+esc(x.host)+'</code></td><td class="'+(x.loss>0?'text-danger':'text-success')+'">'+(x.loss%1===0?x.loss:x.loss.toFixed(1))+'%</td><td>'+x.sent+'</td><td>'+x.last+' ms</td><td>'+x.avg+' ms</td><td>'+x.best+' ms</td><td>'+x.worst+' ms</td></tr>';
  });
  return h+'</tbody></table></div>';
}
function runMtrTool(name,ip){
  var run=++_mtrRun;_snmpRun++;_mtrActive=true;
  document.getElementById('tool-modal-title').textContent='Traceroute (MTR) - '+name;
  syncToolStop();
  new bootstrap.Modal(document.getElementById('modal-tool')).show();
  mtrTick(ip,run,0);
}
function mtrTick(ip,run,round){
  if(run!==_mtrRun||!_mtrActive)return;
  if(round===0)document.getElementById('tool-out').textContent='Running...';
  api('/tools/mtr/'+encodeURIComponent(ip)+'?cycles=4').then(function(r){
    if(run!==_mtrRun||!_mtrActive)return;
    if(!r||!r.hops||!r.hops.length){document.getElementById('tool-out').textContent='MTR to '+ip+' failed'+(r&&r.error?': '+r.error:'')+'.';stopToolLoops();return;}
    document.getElementById('tool-out').innerHTML=mtrTable(ip,r.hops,round+1);
    mtrTick(ip,run,round+1);
  }).catch(function(){if(run!==_mtrRun||!_mtrActive)return;document.getElementById('tool-out').textContent='Request failed.';stopToolLoops();});
}
document.getElementById('btn-tool-stop').onclick=function(){stopToolLoops();};
document.getElementById('modal-tool').addEventListener('hidden.bs.modal',function(){stopToolLoops();});
function showTopoLinkMenu(px,py,edge){
  hideTopoMenu();hideNodeTip();
  var w=document.getElementById('topo-wrap');if(!w||!edge)return;
  var r=w.getBoundingClientRect();
  var m=document.createElement('div');m.id='tpm-menu';m.className='tpm-menu';
  m.style.left=Math.min(Math.max(0,px),Math.max(0,r.width-230))+'px';
  m.style.top=Math.min(Math.max(0,py),Math.max(0,r.height-120))+'px';
  var sn=cy.getElementById(edge.data('source')),tn=cy.getElementById(edge.data('target'));
  var label='Link'+(sn.length&&tn.length?': '+sn.data('name')+' → '+tn.data('name'):'');
  var statIf=edge.data('statIf'),rxBps=edge.data('rxBps'),txBps=edge.data('txBps');
  var rxOct=edge.data('rxOctets'),txOct=edge.data('txOctets');
  var statsHtml='';
  if(statIf) statsHtml+='<div class="small mb-1"><code>'+esc(statIf)+'</code></div>';
  if(rxBps!=null||txBps!=null) statsHtml+='<div class="small mb-1">\u25BC Rx '+esc(fmtS(rxBps))+' &nbsp; \u25B2 Tx '+esc(fmtS(txBps))+'</div>';
  else if(edge.data('srcIf')||edge.data('dstIf')) statsHtml+='<div class="small text-muted mb-1">Collecting stats…</div>';
  else statsHtml+='<div class="small text-muted mb-1">No interface bound — recreate with interface picker</div>';
  if(rxOct!=null||txOct!=null) statsHtml+='<div class="small text-muted mb-1">Total \u25BC '+esc(fmtB(rxOct))+' &nbsp; \u25B2 '+esc(fmtB(txOct))+'</div>';
  m.innerHTML='<div class="tpm-form"><div class="small text-muted mb-1">'+esc(label)+'</div>'+statsHtml+'<button class="tpm-item" data-act="del-link">Delete</button></div>';
  var linkId=String(edge.data('id')||'').replace(/^l-/,'');
  m.onclick=function(ev){
    var b=ev.target&&ev.target.closest?ev.target.closest('button'):null;if(!b||!m.contains(b))return;
    if(b.getAttribute('data-act')==='del-link'){
      if(!confirm('Delete this link?'))return;
      hideTopoMenu();
      api('/maps/'+selectedMapId+'/links/'+linkId,{method:'DELETE'}).then(function(){toast('Link deleted','success');});
    }
  };
  w.appendChild(m);
}
function openSubMap(mid){mid=parseInt(mid);if(!mid)return;var s=document.getElementById('topo-sel');if(s)s.value=mid;selectedMapId=mid;hideTopoMenu();var t=document.getElementById('topo-tools');if(t)t.style.display='';loadMap(mid);}
function showTopoElMenu(px,py,el){
  hideTopoMenu();hideNodeTip();
  var w=document.getElementById('topo-wrap');if(!w||!el)return;
  var r=w.getBoundingClientRect();
  var m=document.createElement('div');m.id='tpm-menu';m.className='tpm-menu';
  m.style.left=Math.min(Math.max(0,px),Math.max(0,r.width-230))+'px';
  m.style.top=Math.min(Math.max(0,py),Math.max(0,r.height-200))+'px';
  var did=el.data('deviceId'),nid=el.data('mapNodeId');
  var h='';
  if(did)h+='<button class="tpm-item" data-act="refresh">Refresh</button>';
  h+='<button class="tpm-item" data-act="delete">Delete</button>';
  h+='<button class="tpm-item" data-act="edit">Edit</button>';
  if(did)h+='<div class="tpm-sep"></div><button class="tpm-item" data-act="tool-ping">PING</button><button class="tpm-item" data-act="tool-snmp">SNMP poller</button><button class="tpm-item" data-act="tool-ports">Port Scanner</button><button class="tpm-item" data-act="tool-trace">Traceroute</button>';
  m.innerHTML=h;
  m.onclick=function(ev){
    var b=ev.target&&ev.target.closest?ev.target.closest('button'):null;if(!b||!m.contains(b))return;
    var act=b.getAttribute('data-act');if(!act)return;
    if(act==='refresh'&&did){hideTopoMenu();toast('Refreshing...','info');api('/devices/'+did+'/refresh',{method:'POST'}).then(function(rr){toast('Status: '+rr.status+(rr.latencyMs!=null?' '+rr.latencyMs+'ms':''),rr.status==='up'?'success':'critical');});return;}
    if(act==='tool-ping'&&did){hideTopoMenu();runPingTool(el.data('name'),did,el.data('ip'));return;}
    if(act==='tool-trace'&&did){hideTopoMenu();runMtrTool(el.data('name'),el.data('ip'));return;}
    if(act==='tool-snmp'&&did){hideTopoMenu();runSnmpTool(el.data('name'),did);return;}
    if(act==='tool-ports'&&did){hideTopoMenu();runTopoTool('Port Scanner - '+el.data('name'),api('/tools/portscan/'+encodeURIComponent(el.data('ip'))).then(function(r){
      var list=(r&&(r.ports||r))||[];
      if(!list.length)return 'Target : '+el.data('ip')+'\nNo results.';
      return 'Target : '+(r.target||el.data('ip'))+'\n\n'+list.map(function(x){return '  '+x.port+'/tcp  '+x.state;}).join('\n');
    }));return;}
    if(act==='delete'){if(!confirm('Remove this element from the map?'))return;hideTopoMenu();api('/maps/'+selectedMapId+'/nodes/'+nid,{method:'DELETE'}).then(function(){toast('Removed','success');});return;}
    if(act==='edit'){
      if(did){hideTopoMenu();editDevice(did);return;}
      var nm=String(el.data('name')||'').split('\n');
      var isNet=el.hasClass('network');
      m.innerHTML='<div class="tpm-form"><input id="tpm-name" placeholder="Label" autocomplete="off">'+(isNet?'<input id="tpm-cidr" placeholder="CIDR" autocomplete="off">':'')+'<button class="btn btn-primary btn-sm w-100 mb-1" data-act="go-label">Save</button><button class="tpm-item tpm-back" data-act="__backel">‹ Back</button></div>';
      m.querySelector('#tpm-name').value=nm[0]||'';
      if(isNet)m.querySelector('#tpm-cidr').value=nm.slice(1).join(' ')||'';
      return;
    }
    if(act==='__backel'){showTopoElMenu(px,py,el);return;}
    if(act==='go-label'){
      var lb=m.querySelector('#tpm-name').value.trim();if(!lb){toast('Label required','critical');return;}
      var ci=m.querySelector('#tpm-cidr');if(ci&&ci.value.trim())lb+='\n'+ci.value.trim();
      api('/maps/'+selectedMapId+'/nodes/'+nid,{method:'PUT',body:{custom_label:lb}}).then(function(){hideTopoMenu();toast('Updated','success');});return;
    }
  };
  w.appendChild(m);
}
function topoMenuMain(m,pos){
  m.innerHTML='<button class="tpm-item" data-act="device">+ Add device</button><button class="tpm-item" data-act="network">+ Add Network</button><button class="tpm-item" data-act="submap">+ Add Submap</button><button class="tpm-item" data-act="static">+ Add Static</button><button class="tpm-item" data-act="link">+ Add Link</button>';
}
function topoMenuAddNode(kind,label,extra,pos,m){
  var body={x_position:Math.round(pos.x),y_position:Math.round(pos.y),custom_label:label,icon_name:kind};
  if(extra)for(var k in extra)body[k]=extra[k];
  api('/maps/'+selectedMapId+'/nodes',{method:'POST',body:body}).then(function(){hideTopoMenu();toast('Added','success');loadMap(selectedMapId);});
}
function showTopoMenu(px,py,pos){
  hideTopoMenu();hideNodeTip();
  var w=document.getElementById('topo-wrap');if(!w||!pos)return;
  var r=w.getBoundingClientRect();
  var m=document.createElement('div');m.id='tpm-menu';m.className='tpm-menu';
  m.style.left=Math.min(Math.max(0,px),Math.max(0,r.width-230))+'px';
  m.style.top=Math.min(Math.max(0,py),Math.max(0,r.height-280))+'px';
  topoMenuMain(m,pos);
  m.onclick=function(ev){
    var b=ev.target&&ev.target.closest?ev.target.closest('button'):null;if(!b||!m.contains(b))return;
    if(b.hasAttribute('data-mid')){
      var mid=parseInt(b.getAttribute('data-mid'));
      topoMenuAddNode('submap',b.textContent,{sub_map_id:mid},pos,m);return;
    }
    var act=b.getAttribute('data-act');if(!act)return;
    if(act==='__back'){topoMenuMain(m,pos);return;}
    if(act==='device'){
      m.innerHTML='<div class="tpm-form"><input id="tpm-name" placeholder="Device name" autocomplete="off"><input id="tpm-ip" placeholder="IP address" autocomplete="off"><button class="btn btn-primary btn-sm w-100 mb-1" data-act="go-device">Add</button><button class="tpm-item tpm-back" data-act="__back">‹ Back</button></div>';return;
    }
    if(act==='go-device'){
      var dn=m.querySelector('#tpm-name').value.trim(),di=m.querySelector('#tpm-ip').value.trim();
      if(!dn||!di){toast('Name and IP required','critical');return;}
      api('/devices',{method:'POST',body:{name:dn,ip_address:di}}).then(function(r){
        if(!r||!r.id){toast(r&&r.error?r.error:'Error creating device','critical');return;}
        api('/maps/'+selectedMapId+'/nodes',{method:'POST',body:{device_id:r.id,x_position:Math.round(pos.x),y_position:Math.round(pos.y)}}).then(function(){hideTopoMenu();toast('Device added','success');loadMap(selectedMapId);});
      });return;
    }
    if(act==='link'){hideTopoMenu();topoLinkLineHide();_linkSrc=null;_linkSrcIf=null;if(!_linkMode)topoLinkMode();else toast('Source cleared — click source element','info');return;}
    if(act==='go-network'){
      var nm=m.querySelector('#tpm-name').value.trim(),cidr=m.querySelector('#tpm-cidr').value.trim();
      if(!nm){toast('Name required','critical');return;}
      topoMenuAddNode('network',nm+(cidr?'\n'+cidr:''),null,pos,m);return;
    }
    if(act==='go-static'){
      var lb=m.querySelector('#tpm-name').value.trim();
      if(!lb){toast('Label required','critical');return;}
      topoMenuAddNode('static',lb,null,pos,m);return;
    }
    if(act==='network'){
      m.innerHTML='<div class="tpm-form"><input id="tpm-name" placeholder="Network name" autocomplete="off"><input id="tpm-cidr" placeholder="CIDR e.g. 192.168.1.0/24" autocomplete="off"><button class="btn btn-primary btn-sm w-100 mb-1" data-act="go-network">Add</button><button class="tpm-item tpm-back" data-act="__back">‹ Back</button></div>';return;
    }
    if(act==='static'){
      m.innerHTML='<div class="tpm-form"><input id="tpm-name" placeholder="Label" autocomplete="off"><button class="btn btn-primary btn-sm w-100 mb-1" data-act="go-static">Add</button><button class="tpm-item tpm-back" data-act="__back">‹ Back</button></div>';return;
    }
    if(act==='submap'){
      api('/maps').then(function(maps){
        maps=maps.filter(function(x){return x.id!==selectedMapId;});
        if(!maps.length){toast('No other maps yet','critical');return;}
        m.innerHTML='<div class="tpm-form">'+maps.map(function(x){return '<button class="tpm-item" data-mid="'+x.id+'">'+esc(x.title)+'</button>';}).join('')+'<button class="tpm-item tpm-back" data-act="__back">‹ Back</button></div>';
      });return;
    }
  };
  w.appendChild(m);
}
function bindTopoTap(){if(!cy)return;cy.off('tap');cy.on('tap','node',function(e){if(_justDragged){_justDragged=false;return;}var did=e.target.data('deviceId');if(did)viewDevice(did);else{var sm=e.target.data('subMapId');if(sm)openSubMap(sm);}});}
function topoLinkMode(){_linkMode=true;_linkSrc=null;_linkSrcIf=null;toast('Link mode: click source element','info');if(cy){cy.off('tap');cy.on('tap','node',topoLinkTap);}}
function topoLinkOff(){_linkMode=false;_linkSrc=null;_linkSrcIf=null;hideTopoMenu();topoLinkLineHide();bindTopoTap();}
var _linkLine=null;
function topoLinkLineShow(){
  topoLinkLineHide();
  var w=document.getElementById('topo-wrap');if(!w)return;
  var svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.id='link-ghost-svg';
  svg.setAttribute('style','position:absolute;inset:0;width:100%;height:100%;z-index:5;pointer-events:none');
  svg.innerHTML='<line id="link-ghost-line" x1="0" y1="0" x2="0" y2="0" stroke="#357bfd" stroke-width="2" stroke-dasharray="6 4"/><circle id="link-ghost-dot" r="4" fill="#357bfd"/>';
  w.appendChild(svg);
  _linkLine={mx:null,my:null};
  document.addEventListener('mousemove',topoLinkLineMove);
}
function topoLinkLineHide(){
  document.removeEventListener('mousemove',topoLinkLineMove);
  var s=document.getElementById('link-ghost-svg');if(s)s.remove();
  _linkLine=null;
}
function topoLinkLineMove(e){
  if(!_linkLine||!cy||!_linkSrc)return;
  var w=document.getElementById('topo-wrap');if(!w)return;
  var r=w.getBoundingClientRect();
  _linkLine.mx=e.clientX-r.left;_linkLine.my=e.clientY-r.top;
  topoLinkLineDraw();
}
function topoLinkLineDraw(){
  if(!_linkLine||!cy||!_linkSrc)return;
  var src=cy.getElementById('n-'+_linkSrc);
  if(!src.length){topoLinkOff();return;}
  var w=document.getElementById('topo-wrap'),cr=document.getElementById('cy-topo');
  if(!w||!cr)return;
  var r=w.getBoundingClientRect(),c=cr.getBoundingClientRect();
  var rp=src.renderedPosition();
  var x1=c.left-r.left+rp.x,y1=c.top-r.top+rp.y;
  var x2=_linkLine.mx!=null?_linkLine.mx:x1,y2=_linkLine.my!=null?_linkLine.my:y1;
  var line=document.getElementById('link-ghost-line'),dot=document.getElementById('link-ghost-dot');
  if(line){line.setAttribute('x1',x1);line.setAttribute('y1',y1);line.setAttribute('x2',x2);line.setAttribute('y2',y2);}
  if(dot){dot.setAttribute('cx',x2);dot.setAttribute('cy',y2);}
}
function topoLinkTap(e){
  if(_justDragged){_justDragged=false;return;}
  var n=e.target,mid=n.data('mapNodeId');
  if(mid==null)return;
  if(!_linkSrc){
    if(n.data('deviceId')){topoIfPicker(n,function(ifname){_linkSrc=mid;_linkSrcIf=ifname||null;topoLinkLineShow();toast('Source selected — click target element','info');});}
    else{_linkSrc=mid;_linkSrcIf=null;topoLinkLineShow();toast('Source selected — click target element','info');}
  }else if(mid===_linkSrc){toast('Link cancelled','info');topoLinkOff();}
  else if(n.data('deviceId')){topoIfPicker(n,function(ifname){topoCreateLink(_linkSrc,_linkSrcIf,mid,ifname||null);});}
  else topoCreateLink(_linkSrc,_linkSrcIf,mid,null);
}
function topoCreateLink(src,srcIf,dst,dstIf){
  api('/maps/'+selectedMapId+'/links',{method:'POST',body:{source_node_id:src,target_node_id:dst,source_interface:srcIf,target_interface:dstIf}}).then(function(r){
    topoLinkOff();
    if(r&&r.id&&cy&&!cy.getElementById('l-'+r.id).length&&cy.getElementById('n-'+src).length&&cy.getElementById('n-'+dst).length)cy.add(topoLinkEl({id:r.id,source_node_id:src,target_node_id:dst,source_interface:srcIf,target_interface:dstIf}));
    toast('Link created','success');
  });
}
function topoIfPicker(node,cb){
  hideTopoMenu();
  api('/devices/'+node.data('deviceId')+'/interfaces').then(function(list){
    list=list||[];
    var w=document.getElementById('topo-wrap');if(!w)return;
    var r=w.getBoundingClientRect();
    var rp=node.renderedPosition();
    var m=document.createElement('div');m.id='tpm-menu';m.className='tpm-menu';
    m.style.left=Math.min(Math.max(0,rp.x),Math.max(0,r.width-250))+'px';
    m.style.top=Math.min(Math.max(0,rp.y),Math.max(0,r.height-300))+'px';
    var h='<div class="tpm-form"><div class="small text-muted mb-1">'+esc(node.data('name'))+' — interface</div>';
    if(!list.length)h+='<div class="small text-muted mb-1">No interfaces polled yet</div>';
    list.forEach(function(i){h+='<button class="tpm-item" data-idx="'+i.if_index+'"><code>'+esc(i.if_name||('#'+i.if_index))+'</code><span class="text-muted ms-auto">'+(i.if_oper_status==1?'up':'down')+'</span></button>';});
    h+='<button class="tpm-item" data-idx="">No specific interface</button>';
    h+='<button class="tpm-item tpm-back" data-act="__cancel">Cancel</button></div>';
    m.innerHTML=h;
    m.onclick=function(ev){
      var b=ev.target&&ev.target.closest?ev.target.closest('button'):null;if(!b||!m.contains(b))return;
      if(b.getAttribute('data-act')==='__cancel'){topoLinkOff();toast('Link cancelled','info');return;}
      if(b.hasAttribute('data-idx')){var v=b.getAttribute('data-idx');hideTopoMenu();var f=v===''?null:(list.filter(function(x){return String(x.if_index)===v;})[0]||{}).if_name||null;cb(f);}
    };
    w.appendChild(m);
  });
}
function topoAddNode(){api('/devices').then(function(devs){var pl=document.getElementById('topo-palette');document.getElementById('palette-list').innerHTML=devs.map(function(d){return '<div class="palette-item" title="'+esc(d.name)+'" onclick="addNode('+selectedMapId+','+d.id+')"><div class="device-icon '+d.device_type+'" style="width:28px;height:28px;font-size:.7rem"><i class="'+iconCls(d.device_type)+'"></i></div></div>';}).join('');pl.classList.add('visible');});}
function addNode(mapId,devId){api('/maps/'+mapId+'/nodes',{method:'POST',body:{device_id:devId,x_position:100+Math.random()*400,y_position:100+Math.random()*300}}).then(function(){document.getElementById('topo-palette').classList.remove('visible');toast('Node added','success');loadMap(mapId);});}
document.getElementById('btn-save-map').onclick=function(){var t=document.getElementById('mf-title').value;if(!t)return;api('/maps',{method:'POST',body:{title:t}}).then(function(){bootstrap.Modal.getInstance(document.getElementById('modal-map')).hide();toast('Map created','success');loadTopology();});};
function topoNodeEl(n){return {data:{id:'n-'+n.id,mapNodeId:n.id,deviceId:n.device_id,subMapId:n.sub_map_id||null,name:n.custom_label||n.device_name||('Node '+n.id),ip:n.ip_address||'',mac:n.mac_address||'',lastSeen:n.last_seen||'',statusText:(n.device_status||'unknown'),lat:n.ip_address?'--':'',cpu:(n.cpu!=null?n.cpu:null),mem:(n.memory!=null?n.memory:null),disk:(n.disk!=null?n.disk:null),statusColor:sColor(n.device_status||'unknown'),deviceType:n.device_type||'generic'},position:{x:n.x_position,y:n.y_position},classes:n.device_id?(n.device_type||'generic'):((n.icon_name==='network'||n.icon_name==='submap')?n.icon_name:'static')};}
function topoLinkEl(l){return {data:{id:'l-'+l.id,source:'n-'+l.source_node_id,target:'n-'+l.target_node_id,srcIf:l.source_interface||null,dstIf:l.target_interface||null,statIf:l.stat_if_name||l.source_interface||l.target_interface||null,rxBps:(l.rx_bps!=null?l.rx_bps:null),txBps:(l.tx_bps!=null?l.tx_bps:null),rxOctets:(l.rx_octets!=null?l.rx_octets:null),txOctets:(l.tx_octets!=null?l.tx_octets:null),label:formatLinkLabel(l.rx_bps,l.tx_bps)},classes:'device-link'};}
var _linkPrev={};
function _linkKey(devId,ifName){return devId+'|'+ifName;}
function updateLinkLabels(results){
  if(!cy||!results||!results.length)return;
  var octByKey={};
  (results||[]).forEach(function(x){
    if(!x||!x.snmp||!x.snmp.interfaces||x.deviceId==null)return;
    x.snmp.interfaces.forEach(function(i){
      if(!i||!i.if_name) return;
      octByKey[_linkKey(x.deviceId,i.if_name)]={rx:Number(i.if_in_octets)||0,tx:Number(i.if_out_octets)||0,t:Date.now()};
    });
  });
  var now=Date.now();
  cy.edges().forEach(function(e){
    var lbl=null;
    try{
      var src=cy.getElementById(e.data('source')),tgt=cy.getElementById(e.data('target'));
      var srcDev=src&&src.length?src.data('deviceId'):null,tgtDev=tgt&&tgt.length?tgt.data('deviceId'):null;
      var srcIf=e.data('srcIf'),dstIf=e.data('dstIf');
      var dev=null,ifn=null;
      if(srcDev&&srcIf){dev=srcDev;ifn=srcIf;}
      else if(tgtDev&&dstIf){dev=tgtDev;ifn=dstIf;}
      if(dev==null||!ifn){return;}
      var cur=octByKey[_linkKey(dev,ifn)];
      if(!cur)return;
      var prev=_linkPrev[_linkKey(dev,ifn)+'>'+e.data('id')];
      _linkPrev[_linkKey(dev,ifn)+'>'+e.data('id')]=cur;
      var rxBps=e.data('rxBps'),txBps=e.data('txBps');
      if(prev&&now>prev.t){
        var dt=(now-prev.t)/1000;
        if(dt>0){
          var drx=cur.rx-prev.rx,dtx=cur.tx-prev.tx;
          rxBps=drx<0?0:Math.round(drx/dt*8);
          txBps=dtx<0?0:Math.round(dtx/dt*8);
        }
      } else if(rxBps==null&&txBps==null){
        return; // keep API-provided label until we have 2 samples
      }
      e.data('rxBps',rxBps);e.data('txBps',txBps);
      e.data('rxOctets',cur.rx);e.data('txOctets',cur.tx);
      lbl=formatLinkLabel(rxBps,txBps);
      if(lbl!==e.data('label'))e.data('label',lbl);
    }catch(err){}
  });
}
function topoStyleNode(n){n.removeClass('down up');n.addClass(n.data('statusColor')==='#e53e3e'?'down':n.data('statusColor')==='#2fb344'?'up':'');renderNodeLabel(n);}
function applyMapUpdate(u){
  if(!u||!cy||currentPage!=='topology'||u.mapId!==selectedMapId)return;
  var t=u.type;
  if(t==='node-added'&&u.node){
    if(cy.getElementById('n-'+u.node.id).length)return;
    var added=cy.add(topoNodeEl(u.node));topoStyleNode(added);cy.resize();
  }else if(t==='node-moved'&&u.node){
    var mv=cy.getElementById('n-'+u.node.id);
    if(mv.length){
      if(!mv.grabbed())mv.position({x:u.node.x_position,y:u.node.y_position});
      var nn=u.node.custom_label||u.node.device_name||('Node '+u.node.id);
      if(mv.data('name')!==nn)mv.data('name',nn);
      mv.data('statusColor',sColor(u.node.device_status||'unknown'));
      mv.data('statusText',(u.node.device_status||'unknown'));
      mv.data('mac',u.node.mac_address||'');mv.data('lastSeen',u.node.last_seen||'');
      topoStyleNode(mv);
    }
  }else if(t==='node-status'&&u.node){
    var st=cy.getElementById('n-'+u.node.id);
    if(st.length){st.data('statusColor',sColor(u.node.device_status||'unknown'));st.data('statusText',(u.node.device_status||'unknown'));st.data('lastSeen',u.node.last_seen||st.data('lastSeen'));if(u.latencyMs!=null)st.data('lat',Math.round(u.latencyMs*10)/10);topoStyleNode(st);}
  }else if(t==='node-deleted'&&u.id){
    cy.remove(cy.getElementById('n-'+u.id));
  }else if(t==='link-added'&&u.link){
    if(cy.getElementById('l-'+u.link.id).length)return;
    if(cy.getElementById('n-'+u.link.source_node_id).length&&cy.getElementById('n-'+u.link.target_node_id).length)cy.add(topoLinkEl(u.link));
  }else if(t==='link-deleted'&&u.id){
    cy.remove(cy.getElementById('l-'+u.id));
  }
}
function capTip(s){s=String(s||'');return s?s.charAt(0).toUpperCase()+s.slice(1):s;}
function hideNodeTip(){var t=document.getElementById('node-tip');if(t)t.style.display='none';}
var _linkTipChart=null,_linkTipRun=0,_linkTipCache={};
function hideLinkTip(){var t=document.getElementById('link-tip');if(t)t.style.display='none';if(_linkTipChart){try{_linkTipChart.destroy();}catch(e){}_linkTipChart=null;}}
function linkStatTarget(edge){
  if(!cy||!edge||!edge.length)return null;
  var src=cy.getElementById(edge.data('source')),tgt=cy.getElementById(edge.data('target'));
  var srcDev=src&&src.length?src.data('deviceId'):null,tgtDev=tgt&&tgt.length?tgt.data('deviceId'):null;
  var srcIf=edge.data('srcIf'),dstIf=edge.data('dstIf');
  if(srcDev&&srcIf)return {dev:srcDev,ifn:srcIf};
  if(tgtDev&&dstIf)return {dev:tgtDev,ifn:dstIf};
  return null;
}
function octetsToRates(rows){
  var asc=(rows||[]).slice().reverse(),labels=[],rates=[];
  for(var i=1;i<asc.length;i++){
    var t1=new Date(asc[i].timestamp).getTime(),t0=new Date(asc[i-1].timestamp).getTime();
    var dt=(t1-t0)/1000;
    if(!isFinite(dt)||dt<=0)continue;
    var d=(Number(asc[i].value)||0)-(Number(asc[i-1].value)||0);
    rates.push(d<0?0:Math.round(d/dt*8));
    labels.push(new Date(asc[i].timestamp).toLocaleTimeString());
  }
  return {labels:labels,rates:rates};
}
function showLinkTip(e){
  var edge=e.target;
  var tip=document.getElementById('link-tip');if(!tip||!edge)return;
  hideNodeTip();
  if(_linkTipChart){try{_linkTipChart.destroy();}catch(err){}_linkTipChart=null;}
  var run=++_linkTipRun;
  var tgt=linkStatTarget(edge);
  var w=document.getElementById('topo-wrap');if(!w)return;
  var r=w.getBoundingClientRect();
  var px=null,py=null,oe=e.originalEvent;
  if(oe&&oe.clientX!==undefined){px=oe.clientX-r.left+16;py=oe.clientY-r.top+16;}
  else if(edge.midpoint){var mp=edge.midpoint();var rp=edge.renderedPosition?edge.renderedPosition():null;if(rp){var cr=document.getElementById('cy-topo'),c=cr.getBoundingClientRect();px=c.left-r.left+rp.x+16;py=c.top-r.top+rp.y+16;}}
  if(px==null){px=r.width/2;py=60;}
  tip.style.left=Math.min(Math.max(4,px),Math.max(4,r.width-1290))+'px';
  tip.style.top=Math.min(Math.max(4,py),Math.max(4,r.height-620))+'px';
  tip.style.transform='none';
  if(!tgt){
    tip.innerHTML='<div class="fw-bold">Link</div><div class="text-muted">No interface bound — recreate with interface picker</div>';
    tip.style.display='block';
    return;
  }
  var rxNow=edge.data('rxBps'),txNow=edge.data('txBps');
  tip.innerHTML='<div class="fw-bold"><code>'+esc(tgt.ifn)+'</code></div>'
    +'<div class="small text-muted mb-1">\u25BC Rx '+esc(fmtS(rxNow))+' &nbsp; \u25B2 Tx '+esc(fmtS(txNow))+'</div>'
    +'<div class="small text-muted" id="link-tip-status">Loading graph…</div><canvas id="link-tip-chart"></canvas>';
  tip.style.display='block';
  var edgeId=edge.data('id');
  var cached=_linkTipCache[edgeId];
  var useCache=cached&&(Date.now()-cached.t<15000);
  var fetchP=useCache?Promise.resolve(cached.data):Promise.all([
    api('/devices/'+tgt.dev+'/metrics?metric_type=interface_rx&interface_name='+encodeURIComponent(tgt.ifn)+'&limit=120'),
    api('/devices/'+tgt.dev+'/metrics?metric_type=interface_tx&interface_name='+encodeURIComponent(tgt.ifn)+'&limit=120')
  ]).then(function(a){_linkTipCache[edgeId]={t:Date.now(),data:a};return a;});
  fetchP.then(function(a){
    if(run!==_linkTipRun)return;
    var st=document.getElementById('link-tip-status');
    var rx=octetsToRates(a[0]),tx=octetsToRates(a[1]);
    var n=Math.min(rx.rates.length,tx.rates.length);
    if(!n){if(st)st.textContent='No history yet — wait one SNMP cycle.';return;}
    if(st)st.remove();
    var labels=rx.labels.slice(-n),rxD=rx.rates.slice(-n),txD=tx.rates.slice(-n);
    var cv=document.getElementById('link-tip-chart');if(!cv)return;
    _linkTipChart=new Chart(cv,{type:'line',
      data:{labels:labels,datasets:[
        {label:'Rx',data:rxD,borderColor:'#2fb344',backgroundColor:'#2fb34422',fill:true,tension:.3,pointRadius:0,borderWidth:1.5},
        {label:'Tx',data:txD,borderColor:'#357bfd',backgroundColor:'#357bfd22',fill:true,tension:.3,pointRadius:0,borderWidth:1.5}]},
      options:{responsive:true,maintainAspectRatio:false,animation:false,
        scales:{x:{display:true,grid:{color:'#2d3139'},ticks:{color:'#868a91',maxTicksLimit:6,maxRotation:45,minRotation:0,font:{size:10}}},y:{min:0,grid:{color:'#2d3139'},ticks:{color:'#868a91',maxTicksLimit:4,callback:function(v){return fmtS(v);}}}},
        plugins:{legend:{position:'top',align:'end',labels:{color:'#c2c7d0',boxWidth:12,font:{size:10}}}}}});
  }).catch(function(){if(run!==_linkTipRun)return;var st=document.getElementById('link-tip-status');if(st)st.textContent='Graph unavailable.';});
}
function nodeTipHTML(n){
  var d=n.data();
  if(!d.deviceId){var kind=d.subMapId?'Submap':(n.hasClass('network')?'Network':'Static object');return '<div class="fw-bold">'+esc(d.name)+'</div><div class="text-muted">'+esc(kind)+'</div>';}
  var h='<div class="fw-bold">'+esc(d.name)+' ('+esc(d.deviceType||'generic')+')</div>';
  h+='<div>IP: '+esc(d.ip||'-')+'</div>';
  if(d.mac)h+='<div>MAC: '+esc(d.mac)+'</div>';
  if(d.lastSeen)h+='<div>Last seen: '+esc(d.lastSeen)+'</div>';
  h+='<div>Status: <span style="color:'+d.statusColor+';font-weight:600">'+esc(capTip(d.statusText||'unknown'))+'</span></div>';
  if(d.cpu!=null||d.mem!=null||d.disk!=null){
    h+='<div class="mt-1">'
      +(d.cpu!=null?'<div>CPU: <b class="text-white">'+d.cpu+' %</b></div>':'')
      +(d.mem!=null?'<div>Memory: <b class="text-white">'+d.mem+' %</b></div>':'')
      +(d.disk!=null?'<div>Disk: <b class="text-white">'+d.disk+' %</b></div>':'')
      +'</div>';
  }
  return h;
}
function renderNodeLabel(n){
  if(!n.data('deviceId')){
    // Static jointers: small dot, label only while hovered
    if(n.hasClass('static')){n.data('label',n.data('_hover')?n.data('name'):'');return;}
    n.data('label',n.data('name'));return;
  }
  var parts=[n.data('name'),n.data('ip')||''];
  var lat=n.data('lat');
  var status=n.data('statusColor')==='#e53e3e'?'DOWN':(lat==='--'?'':'UP');
  var line=status;
  if(status==='UP'&&typeof lat==='number')line+=' '+lat+'ms';
  if(line)parts.push(line);
  var stats=[];
  if(n.data('cpu')!=null)stats.push('CPU '+n.data('cpu')+'%');
  if(n.data('mem')!=null)stats.push('MEM '+n.data('mem')+'%');
  if(n.data('disk')!=null)stats.push('DISK '+n.data('disk')+'%');
  if(stats.length)parts.push(stats.join(' '));
  n.data('label',parts.join('\n'));
}
function liveTopo(r){if(!cy)return;r.forEach(function(x){cy.nodes().filter(function(n){return n.data('deviceId')===x.deviceId;}).forEach(function(n){var reach=(x.ping&&x.ping.reachable);n.data('statusColor',sColor(reach?'up':'down'));n.data('statusText',reach?'up':'down');n.removeClass('down up').addClass(reach?'up':'down');n.data('lat',reach?Math.round(x.ping.latencyMs*10)/10:'DOWN');renderNodeLabel(n);});});}
function liveTopoSnmp(results){
  if(!cy||!results||!results.length)return;
  (results||[]).forEach(function(x){
    if(!x||x.deviceId==null||!x.snmp)return;
    cy.nodes().filter(function(n){return n.data('deviceId')===x.deviceId;}).forEach(function(n){
      if(x.snmp.cpuLoad!=null)n.data('cpu',x.snmp.cpuLoad);
      if(x.snmp.memoryPct!=null)n.data('mem',x.snmp.memoryPct);
      if(x.snmp.diskPct!=null)n.data('disk',x.snmp.diskPct);
      renderNodeLabel(n);
    });
  });
}
function topoZoom(keys){
  if(!cy)return;
  var z=cy.zoom()*(Math.exp(keys/3));
  cy.zoom({level:Math.min(4,Math.max(0.1,z)),position:{x:cy.extent().x1+cy.extent().w/2,y:cy.extent().y1+cy.extent().h/2}});
}

// ═══ ALERTS ═══
function loadAlerts() {
  pHTML('<div class="d-flex justify-content-between mb-3"><div class="d-flex gap-2"><select class="form-select" id="af-st" style="width:150px"><option value="active">Active</option><option value="acknowledged">Acknowledged</option><option value="resolved">Resolved</option><option value="">All</option></select><select class="form-select" id="af-sev" style="width:150px"><option value="">All</option><option value="critical">Critical</option><option value="warning">Warning</option><option value="info">Info</option></select></div><button class="btn btn-secondary" onclick="loadAlertRules()"><i class="ti ti-settings"></i> Rules</button></div><div class="card"><div class="table-responsive"><table class="table table-vcenter"><thead><tr><th>Severity</th><th>Device</th><th>Message</th><th>Status</th><th>Time</th><th>Actions</th></tr></thead><tbody id="al-tb"></tbody></table></div></div>');
  document.getElementById('af-st').onchange=fetchAlerts;
  document.getElementById('af-sev').onchange=fetchAlerts;
  fetchAlerts();
}
function fetchAlerts(){
  var st=document.getElementById('af-st')?document.getElementById('af-st').value:'';
  var sv=document.getElementById('af-sev')?document.getElementById('af-sev').value:'';
  var u='/alerts?limit=100';if(st)u+='&status='+st;if(sv)u+='&severity='+sv;
  api(u).then(function(als){
    var tb=document.getElementById('al-tb');if(!tb)return;
    if(!als.length){tb.innerHTML='<tr><td colspan="6" class="text-center text-muted p-3">No alerts</td></tr>';return;}
    tb.innerHTML=als.map(function(a){return '<tr><td><span class="badge bg-'+(a.severity==='critical'?'danger':a.severity==='warning'?'warning':'info')+'">'+a.severity+'</span></td><td>'+esc(a.device_name||'System')+'</td><td>'+esc(a.message)+'</td><td><span class="badge bg-'+(a.status==='active'?'danger':a.status==='acknowledged'?'warning':'success')+'">'+a.status+'</span></td><td>'+new Date(a.created_at).toLocaleString()+'</td><td>'+(a.status==='active'?'<button class="btn btn-ghost btn-sm" onclick="ackAlert('+a.id+')"><i class="ti ti-check"></i></button> ':'')+(a.status!=='resolved'?'<button class="btn btn-ghost btn-sm" onclick="resolveAlert('+a.id+')"><i class="ti ti-circle-check"></i></button>':'')+'</td></tr>';}).join('');
  });
}
function ackAlert(id){api('/alerts/'+id+'/acknowledge',{method:'POST'}).then(fetchAlerts);}
function resolveAlert(id){api('/alerts/'+id+'/resolve',{method:'POST'}).then(fetchAlerts);}

function loadAlertRules(){
  api('/alert-rules').then(function(rules){
    pHTML('<div class="d-flex justify-content-between mb-3"><h3>Alert Rules</h3><div class="d-flex gap-2"><button class="btn btn-secondary" onclick="loadAlerts()"><i class="ti ti-arrow-left"></i> Back</button><button class="btn btn-primary" onclick="new bootstrap.Modal(document.getElementById(\'modal-rule\')).show()"><i class="ti ti-plus"></i> Add</button></div></div><div class="card"><div class="table-responsive"><table class="table table-vcenter"><thead><tr><th>Name</th><th>Metric</th><th>Condition</th><th>Severity</th><th>Cooldown</th><th>Actions</th></tr></thead><tbody>'+rules.map(function(r){return '<tr><td class="fw-medium">'+esc(r.name)+'</td><td>'+r.metric_type+'</td><td><code>'+r.condition_op+' '+r.threshold+'</code></td><td><span class="badge bg-'+(r.severity==='critical'?'danger':'warning')+'">'+r.severity+'</span></td><td>'+r.cooldown_seconds+'s</td><td><button class="btn btn-ghost btn-sm text-danger" onclick="delRule('+r.id+')"><i class="ti ti-trash"></i></button></td></tr>';}).join('')+'</tbody></table></div></div><div class="modal fade" id="modal-rule" tabindex="-1"><div class="modal-dialog"><div class="modal-content"><div class="modal-header"><h5 class="modal-title">Alert Rule</h5><button class="btn-close" data-bs-dismiss="modal"></button></div><div class="modal-body"><div class="mb-3"><label class="form-label">Name</label><input type="text" class="form-control" id="rf-name"></div><div class="row"><div class="col-md-5 mb-3"><label class="form-label">Metric</label><select class="form-select" id="rf-met"><option value="ping">Ping Latency</option><option value="cpu">CPU</option><option value="memory">Memory</option><option value="disk">Disk</option><option value="packet_loss">Packet Loss</option><option value="status">Status</option></select></div><div class="col-md-3 mb-3"><label class="form-label">Op</label><select class="form-select" id="rf-op"><option value="gt">&gt;</option><option value="lt">&lt;</option><option value="ge">&ge;</option></select></div><div class="col-md-4 mb-3"><label class="form-label">Threshold</label><input type="number" class="form-control" id="rf-th" value="80"></div></div><div class="row"><div class="col-md-6 mb-3"><label class="form-label">Severity</label><select class="form-select" id="rf-sev"><option value="warning">Warning</option><option value="critical">Critical</option></select></div><div class="col-md-6 mb-3"><label class="form-label">Cooldown</label><input type="number" class="form-control" id="rf-cd" value="300"></div></div></div><div class="modal-footer"><button class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button class="btn btn-primary" onclick="saveRule()">Save</button></div></div></div></div>');
  });
}
function saveRule(){
  api('/alert-rules',{method:'POST',body:{name:document.getElementById('rf-name').value,metric_type:document.getElementById('rf-met').value,condition_op:document.getElementById('rf-op').value,threshold:parseFloat(document.getElementById('rf-th').value),severity:document.getElementById('rf-sev').value,cooldown_seconds:parseInt(document.getElementById('rf-cd').value),notify_browser:true}}).then(function(){bootstrap.Modal.getInstance(document.getElementById('modal-rule')).hide();toast('Rule created','success');loadAlertRules();});
}
function delRule(id){if(!confirm('Delete rule?'))return;api('/alert-rules/'+id,{method:'DELETE'}).then(function(){toast('Deleted','success');loadAlertRules();});}

// ═══ DISCOVERY ═══
function loadDiscovery(){
  api('/discovery/jobs').then(function(jobs){
    pHTML('<div class="d-flex justify-content-between mb-3"><div class="d-flex gap-2"><input type="text" class="form-control" id="scan-cidr" placeholder="CIDR: 192.168.1.0/24" style="width:280px"><button class="btn btn-primary" onclick="startScan()"><i class="ti ti-scan"></i> Scan</button></div></div><div class="card"><div class="card-header"><h3 class="card-title">Scan Jobs</h3></div><div class="table-responsive"><table class="table table-vcenter"><thead><tr><th>Subnet</th><th>Status</th><th>Found</th><th>Total</th><th>Started</th><th>Done</th></tr></thead><tbody>'+jobs.map(function(j){return '<tr><td><code>'+j.subnet+'</code></td><td><span class="badge bg-'+(j.status==='completed'?'success':'secondary')+'">'+j.status+'</span></td><td>'+j.found_devices+'</td><td>'+j.total_ips+'</td><td>'+(j.started_at?new Date(j.started_at).toLocaleString():'-')+'</td><td>'+(j.completed_at?new Date(j.completed_at).toLocaleString():'-')+'</td></tr>';}).join('')+'</tbody></table></div></div>');
  });
}
function startScan(){var s=document.getElementById('scan-cidr').value;if(!s)return;api('/discovery/scan',{method:'POST',body:{subnet:s}}).then(function(){toast('Scan started','success');}).catch(function(){toast('Scan failed','critical');});}

// ═══ TOOLS ═══
function loadTools(){
  pHTML('<div class="card mb-3"><div class="card-body"><div class="d-flex gap-2"><select class="form-select" id="tool-type" style="width:180px"><option value="ping">Ping</option><option value="traceroute">Traceroute</option><option value="portscan">Port Scan</option></select><input type="text" class="form-control" id="tool-target" placeholder="Target IP" style="width:300px"><button class="btn btn-primary" onclick="runTool()"><i class="ti ti-player-play"></i> Run</button></div></div></div><div class="card"><div class="card-header"><h3 class="card-title" id="tool-title">Result</h3></div><div class="card-body" id="tool-res"></div></div>');
  document.getElementById('tool-target').onkeypress=function(e){if(e.key==='Enter')runTool();};
}
function navTool(ip,type){navigateTo('tools');setTimeout(function(){document.getElementById('tool-target').value=ip;document.getElementById('tool-type').value=type;runTool();},200);}
function runTool(){
  var type=document.getElementById('tool-type').value;
  var target=document.getElementById('tool-target').value;
  if(!target)return;
  var res=document.getElementById('tool-res');
  res.innerHTML='<div class="text-muted"><div class="spinner-border spinner-border-sm me-2"></div>Running...</div>';
  if(type==='ping'){
    api('/tools/ping/'+target).then(function(r){
      document.getElementById('tool-title').textContent='Ping: '+target;
      res.innerHTML='<div class="tool-output">PING '+target+' 56(84) bytes of data.\n'+(r.reachable?'64 bytes from '+target+': icmp_seq=1 time='+r.latencyMs+'ms':'Request timeout')+'\n\n--- '+target+' ping statistics ---\n3 packets transmitted, '+Math.round(3*(100-r.packetLoss)/100)+' received, '+r.packetLoss+'% packet loss\n'+(r.reachable?'rtt min/avg/max = '+r.latencyMs+'/'+r.latencyMs+'/'+r.latencyMs+' ms':'')+'</div>';
    });
  } else if(type==='traceroute'){
    api('/tools/traceroute/'+target).then(function(r){
      document.getElementById('tool-title').textContent='Traceroute: '+target;
      if(!r.hops.length){res.innerHTML='<div class="text-muted">No hops</div>';return;}
      var mx=Math.max.apply(null,r.hops.map(function(h){return h.avgMs||0;}));
      if(mx<1)mx=1;
      res.innerHTML=r.hops.map(function(h){return '<div class="traceroute-hop"><span class="hop-num">'+h.hop+'</span><span class="hop-ip">'+h.ip+'</span><div class="hop-bar"><div class="hop-bar-fill" style="width:'+(h.avgMs?(h.avgMs/mx*100):0)+'%"></div></div><span class="text-muted small">'+(h.avgMs?h.avgMs.toFixed(1)+'ms':'*')+'</span></div>';}).join('');
    });
  } else if(type==='portscan'){
    api('/tools/portscan/'+target).then(function(r){
      document.getElementById('tool-title').textContent='Port Scan: '+target;
      res.innerHTML='<table class="table table-vcenter"><thead><tr><th>Port</th><th>State</th></tr></thead><tbody>'+r.ports.map(function(p){return '<tr><td>'+p.port+'</td><td class="'+(p.state==='open'?'port-open':p.state==='closed'?'port-closed':'port-filtered')+'">'+p.state+'</td></tr>';}).join('')+'</tbody></table>';
    });
  }
}

// ═══ LOGS ═══
function loadLogs(){
  pHTML('<div class="d-flex justify-content-between mb-3"><select class="form-select" id="log-type" style="width:150px"><option value="">All</option><option value="alert">Alert</option><option value="syslog">Syslog</option><option value="trap">Trap</option><option value="system">System</option></select><div><span class="live-indicator"></span> <span class="text-muted small">Live</span></div></div><div class="card"><div class="card-body p-0"><div id="log-box" style="max-height:600px;overflow-y:auto"></div></div></div>');
  api('/events?limit=100').then(renderLogs);
  document.getElementById('log-type').onchange=function(e){api('/events?limit=100'+(e.target.value?'&event_type='+e.target.value:'')).then(renderLogs);};
}
function renderLogs(logs){var b=document.getElementById('log-box');if(!b)return;b.innerHTML=logs.map(function(l){return '<div class="log-entry severity-'+l.severity+'"><span class="text-muted">'+new Date(l.created_at).toLocaleTimeString()+'</span> <span class="badge bg-'+(l.severity==='critical'?'danger':l.severity==='warning'?'warning':'secondary')+' me-1">'+l.event_type+'</span> '+esc(l.device_name||'System')+' '+esc(l.message)+'</div>';}).join('');}

// ═══ SETTINGS ═══
function loadSettings(){
  pHTML('<div class="row"><div class="col-lg-6"><div class="card mb-3"><div class="card-header"><h3 class="card-title">General</h3></div><div class="card-body"><div class="mb-3"><label class="form-label">Ping Interval (ms)</label><input type="number" class="form-control" id="set-ping-int" value="5000"></div><div class="mb-3"><label class="form-label">SNMP Interval (ms)</label><input type="number" class="form-control" id="set-snmp-int" value="5000"></div><div class="mb-3"><label class="form-label">SNMP Timeout (ms)</label><input type="number" class="form-control" value="5000"></div><button class="btn btn-primary" id="btn-save-poll">Save</button></div></div></div><div class="col-lg-6"><div class="card mb-3"><div class="card-header"><h3 class="card-title">Notifications</h3></div><div class="card-body"><div class="mb-3"><label class="form-label">Webhook URL</label><input type="text" class="form-control" placeholder="https://hooks..."></div><div class="mb-3"><label class="form-label">Telegram Bot Token</label><input type="text" class="form-control" placeholder="Token"></div><div class="mb-3"><label class="form-label">Telegram Chat ID</label><input type="text" class="form-control" placeholder="Chat ID"></div><div class="mb-3"><label class="form-label">SMTP Host</label><input type="text" class="form-control" placeholder="smtp.example.com"></div><div class="mb-3"><label class="form-label">Alert Email To</label><input type="email" class="form-control" placeholder="admin@example.com"></div><button class="btn btn-primary">Save</button></div></div></div></div><div class="card"><div class="card-header"><h3 class="card-title">Data Retention</h3></div><div class="card-body"><div class="row"><div class="col-md-4 mb-3"><label class="form-label">Retain (days)</label><input type="number" class="form-control" value="365"></div><div class="col-md-4 mb-3"><label class="form-label">Aggregate after (days)</label><input type="number" class="form-control" value="30"></div></div><button class="btn btn-primary">Save</button></div></div><div class="card mt-3"><div class="card-header"><h3 class="card-title">SNMP Profiles</h3><div class="ms-auto"><button class="btn btn-primary btn-sm" onclick="openSnmpModal()"><i class="ti ti-plus"></i> Add Profile</button></div></div><div class="table-responsive"><table class="table table-vcenter"><thead><tr><th>Name</th><th>Version</th><th>Community / User</th><th>Port</th><th>Actions</th></tr></thead><tbody id="snmp-tb"></tbody></table></div></div>');
  loadSnmpProfiles();
  loadPollSettings();
  document.getElementById('btn-save-poll').onclick=function(){
    var body={ping_interval_ms:parseInt(document.getElementById('set-ping-int').value),snmp_interval_ms:parseInt(document.getElementById('set-snmp-int').value)};
    if(!(body.ping_interval_ms>=2000&&body.ping_interval_ms<=3600000)||!(body.snmp_interval_ms>=2000&&body.snmp_interval_ms<=3600000)){toast('Intervals must be 2000-3600000 ms','critical');return;}
    api('/settings',{method:'PUT',body:body}).then(function(){toast('Polling intervals updated','success');loadPollSettings();}).catch(function(){toast('Save failed','critical');});
  };
}

// ═══ POLL SETTINGS ═══
function loadPollSettings(){
  api('/settings').then(function(s){
    var p=document.getElementById('set-ping-int');if(p&&s.ping_interval_ms)p.value=s.ping_interval_ms;
    var q=document.getElementById('set-snmp-int');if(q&&s.snmp_interval_ms)q.value=s.snmp_interval_ms;
  }).catch(function(){});
}

// ═══ SNMP PROFILES ═══
var _snmpProfiles=[];
function loadSnmpProfiles(){
  api('/snmp-profiles').then(function(list){
    _snmpProfiles=list||[];
    var tb=document.getElementById('snmp-tb');if(!tb)return;
    tb.innerHTML=_snmpProfiles.map(function(p){return '<tr><td class="fw-medium">'+esc(p.name)+'</td><td>v'+p.snmp_version+'</td><td><code>'+esc(p.snmp_version==='3'?(p.snmp_user||'-'):(p.snmp_community||'-'))+'</code></td><td>'+p.snmp_port+'</td><td><div class="btn-list flex-nowrap"><button class="btn btn-ghost btn-sm" onclick="openSnmpModal('+p.id+')"><i class="ti ti-pencil"></i></button><button class="btn btn-ghost btn-sm text-danger" onclick="delSnmpProfile('+p.id+')"><i class="ti ti-trash"></i></button></div></td></tr>';}).join('')||'<tr><td colspan="5" class="text-muted text-center">No profiles</td></tr>';
  }).catch(function(){});
}
function snmpVerToggle(){var v=document.getElementById('sp-ver').value;document.getElementById('sp-v3-rows').style.display=v==='3'?'':'none';document.getElementById('sp-comm-row').style.display=v==='3'?'none':'';}
function openSnmpModal(id){
  var p=id?_snmpProfiles.filter(function(x){return x.id===id;})[0]:null;
  document.getElementById('snmp-modal-title').textContent=p?'Edit SNMP Profile':'Add SNMP Profile';
  document.getElementById('sp-id').value=p?p.id:'';
  document.getElementById('sp-name').value=p?p.name:'';
  document.getElementById('sp-ver').value=p?p.snmp_version:'2c';
  document.getElementById('sp-port').value=p?p.snmp_port:161;
  document.getElementById('sp-comm').value=p?(p.snmp_community||'public'):'public';
  document.getElementById('sp-user').value=p?(p.snmp_user||''):'';
  document.getElementById('sp-authp').value=p?(p.snmp_auth_protocol||'none'):'none';
  document.getElementById('sp-authpw').value=p?(p.snmp_auth_pass||''):'';
  document.getElementById('sp-privp').value=p?(p.snmp_priv_protocol||'none'):'none';
  document.getElementById('sp-privpw').value=p?(p.snmp_priv_pass||''):'';
  snmpVerToggle();
  new bootstrap.Modal(document.getElementById('modal-snmp')).show();
}
function delSnmpProfile(id){if(!confirm('Delete this SNMP profile?'))return;api('/snmp-profiles/'+id,{method:'DELETE'}).then(function(){toast('Deleted','success');loadSnmpProfiles();});}
document.getElementById('btn-save-snmp').onclick=function(){
  var id=document.getElementById('sp-id').value;
  var data={name:document.getElementById('sp-name').value.trim(),snmp_version:document.getElementById('sp-ver').value,snmp_port:parseInt(document.getElementById('sp-port').value)||161,snmp_community:document.getElementById('sp-comm').value,snmp_user:document.getElementById('sp-user').value,snmp_auth_protocol:document.getElementById('sp-authp').value,snmp_auth_pass:document.getElementById('sp-authpw').value,snmp_priv_protocol:document.getElementById('sp-privp').value,snmp_priv_pass:document.getElementById('sp-privpw').value};
  if(!data.name){toast('Name required','critical');return;}
  var p=id?api('/snmp-profiles/'+id,{method:'PUT',body:data}):api('/snmp-profiles',{method:'POST',body:data});
  p.then(function(){bootstrap.Modal.getInstance(document.getElementById('modal-snmp')).hide();toast(id?'Updated':'Created','success');loadSnmpProfiles();}).catch(function(e){toast('Error: duplicate name?','critical');});
};

// ═══ BOOT ═══
if (AUTH_TOKEN) { try { startApp(); } catch(e){ showLogin(); } } else { showLogin(); }
