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
function iconCls(t) { return {router:'ti ti-router',switch:'ti ti-network',server:'ti ti-server',wireless_ap:'ti ti-antenna',firewall:'ti ti-shield',printer:'ti ti-printer',ont:'ti ti-cable'}[t]||'ti ti-device-desktop'; }
function sColor(s) { return {up:'#2fb344',down:'#e53e3e',warning:'#f59f00',unknown:'#868a91'}[s]||'#868a91'; }
function fmtB(b) { if(!b) return '0 B'; var u=['B','KB','MB','GB','TB']; var i=Math.floor(Math.log(b)/Math.log(1024)); return (b/Math.pow(1024,i)).toFixed(2)+' '+u[i]; }
function fmtS(b) { if(!b) return '0 bps'; if(b>=1e9)return(b/1e9).toFixed(1)+' Gbps'; if(b>=1e6)return(b/1e6).toFixed(1)+' Mbps'; if(b>=1e3)return(b/1e3).toFixed(1)+' Kbps'; return b+' bps'; }
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
    socket.on('poll:results',function(r){if(currentPage==='dashboard')liveDash(r);if(currentPage==='topology')liveTopo(r);});
    socket.on('alert:new',function(a){toast(a.severity.toUpperCase()+': '+a.message,a.severity);if(currentPage==='alerts')loadAlerts();});
    socket.on('discovery:complete',function(r){toast('Found '+r.devicesFound+' in '+r.subnet,'success');if(currentPage==='discovery')loadDiscovery();});
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
  m.show();
}
function editDevice(id){api('/devices/'+id).then(function(d){openDevModal(d);}).catch(function(){});}
function delDevice(id){if(!confirm('Delete this device?'))return;api('/devices/'+id,{method:'DELETE'}).then(function(){toast('Deleted','success');loadDevices();});}
function viewDevice(id) {
  Promise.all([api('/devices/'+id),api('/devices/'+id+'/metrics?limit=100'),api('/devices/'+id+'/interfaces')]).then(function(a){
    var d=a[0],mx=a[1],ifc=a[2];
    pHTML('<div class="d-flex justify-content-between mb-3"><div class="d-flex align-items-center gap-2"><button class="btn btn-ghost btn-sm" onclick="loadDevices()"><i class="ti ti-arrow-left"></i></button><h3 class="mb-0">'+esc(d.name)+'</h3><span class="badge bg-'+(d.status==='up'?'success':'danger')+'">'+d.status+'</span></div><div class="d-flex gap-2"><button class="btn btn-primary btn-sm" onclick="editDevice('+d.id+')"><i class="ti ti-pencil"></i> Edit</button></div></div><div class="row mb-3"><div class="col-md-3"><div class="card"><div class="card-body"><div class="stat-label">IP</div><div class="fw-bold">'+d.ip_address+'</div></div></div></div><div class="col-md-3"><div class="card"><div class="card-body"><div class="stat-label">Type</div><div class="fw-bold">'+d.device_type+'</div></div></div></div><div class="col-md-3"><div class="card"><div class="card-body"><div class="stat-label">Last Seen</div><div class="fw-bold">'+(d.last_seen?new Date(d.last_seen).toLocaleString():'Never')+'</div></div></div></div><div class="col-md-3"><div class="card"><div class="card-body"><div class="stat-label">SNMP</div><div class="fw-bold">v'+d.snmp_version+'</div></div></div></div></div><div class="row mb-3"><div class="col-lg-6"><div class="card"><div class="card-header"><h3 class="card-title">Ping Latency</h3></div><div class="card-body"><div class="chart-container"><canvas id="ch-ping"></canvas></div></div></div></div><div class="col-lg-6"><div class="card"><div class="card-header"><h3 class="card-title">CPU & Memory</h3></div><div class="card-body"><div class="chart-container"><canvas id="ch-cpu"></canvas></div></div></div></div></div>'+(ifc.length?'<div class="card mb-3"><div class="card-header"><h3 class="card-title">Interfaces</h3></div><div class="table-responsive"><table class="table table-vcenter"><thead><tr><th>#</th><th>Name</th><th>Status</th><th>Speed</th><th>Rx</th><th>Tx</th><th>Err</th></tr></thead><tbody>'+ifc.map(function(i){return '<tr><td>'+i.if_index+'</td><td>'+esc(i.if_name||'')+'</td><td><span class="status-dot '+(i.if_oper_status===1?'up':'down')+'"></span>'+(i.if_oper_status===1?'Up':'Down')+'</td><td>'+fmtS(i.if_speed)+'</td><td>'+fmtB(i.if_in_octets)+'</td><td>'+fmtB(i.if_out_octets)+'</td><td>'+(i.if_in_errors+i.if_out_errors)+'</td></tr>';}).join('')+'</tbody></table></div></div>':'')+'<div class="card mb-3"><div class="card-header"><h3 class="card-title">Actions</h3></div><div class="card-body d-flex gap-2"><button class="btn btn-primary" onclick="pingDev('+d.id+')"><i class="ti ti-send"></i> Ping</button><button class="btn btn-secondary" onclick="navTool(\''+d.ip_address+'\',\'traceroute\')"><i class="ti ti-route"></i> Traceroute</button><button class="btn btn-secondary" onclick="navTool(\''+d.ip_address+'\',\'portscan\')"><i class="ti ti-network"></i> Port Scan</button></div></div>');
    var pd=mx.filter(function(m){return m.metric_type==='ping';}).reverse();
    var cd=mx.filter(function(m){return m.metric_type==='cpu';}).reverse();
    var md=mx.filter(function(m){return m.metric_type==='memory';}).reverse();
    dChart('ping');var pe=document.getElementById('ch-ping');if(pe&&pd.length)charts.ping=new Chart(pe,{type:'line',data:{labels:pd.map(function(m){return new Date(m.timestamp).toLocaleTimeString();}),datasets:[{label:'ms',data:pd.map(function(m){return m.value;}),borderColor:'#2fb344',backgroundColor:'#2fb34422',fill:true,tension:.3,pointRadius:2}]},options:{responsive:true,maintainAspectRatio:false,scales:{x:{display:false},y:{grid:{color:'#2d3139'},ticks:{color:'#868a91'}}},plugins:{legend:{labels:{color:'#c2c7d0'}}}}});
    dChart('cpu');var ce=document.getElementById('ch-cpu');if(ce)charts.cpu=new Chart(ce,{type:'line',data:{labels:cd.map(function(m){return new Date(m.timestamp).toLocaleTimeString();}),datasets:[{label:'CPU%',data:cd.map(function(m){return m.value;}),borderColor:'#f59f00',tension:.3,pointRadius:2},{label:'Mem%',data:md.map(function(m){return m.value;}),borderColor:'#ae3ec9',tension:.3,pointRadius:2}]},options:{responsive:true,maintainAspectRatio:false,scales:{x:{display:false},y:{min:0,max:100,grid:{color:'#2d3139'},ticks:{color:'#868a91'}}},plugins:{legend:{labels:{color:'#c2c7d0'}}}}});
  }).catch(function(e){console.error(e);toast('Error loading device','critical');});
}
function pingDev(id){toast('Pinging...','info');api('/devices/'+id+'/ping').then(function(r){toast('Ping: '+(r.reachable?'Reachable':'Down')+' '+r.latencyMs+'ms',r.reachable?'success':'critical');});}
document.getElementById('btn-save-dev').onclick=function(){
  var id=document.getElementById('df-id').value;
  var data={name:document.getElementById('df-name').value,ip_address:document.getElementById('df-ip').value,device_type:document.getElementById('df-type').value,snmp_version:document.getElementById('df-ver').value,snmp_community:document.getElementById('df-comm').value};
  if(!data.name||!data.ip_address){toast('Name and IP required','critical');return;}
  var p=id?api('/devices/'+id,{method:'PUT',body:data}):api('/devices',{method:'POST',body:data});
  p.then(function(){bootstrap.Modal.getInstance(document.getElementById('modal-device')).hide();toast(id?'Updated':'Created','success');loadDevices();}).catch(function(){toast('Error','critical');});
};

// ═══ TOPOLOGY ═══
function loadTopology() {
  api('/maps').then(function(maps){
    pHTML('<div class="topology-wrapper"><div class="topo-toolbar"><div class="d-flex gap-2 align-items-center"><select class="form-select" id="topo-sel" style="width:250px"><option value="">Select map...</option>'+maps.map(function(m){return '<option value="'+m.id+'">'+esc(m.title)+'</option>';}).join('')+'</select><button class="btn btn-secondary" onclick="new bootstrap.Modal(document.getElementById(\'modal-map\')).show()"><i class="ti ti-plus"></i> New Map</button></div><div class="d-flex gap-2" id="topo-tools" style="display:none"><button class="btn btn-sm btn-secondary" onclick="topoZoom(1)"><i class="ti ti-zoom-in"></i></button><button class="btn btn-sm btn-secondary" onclick="topoZoom(-1)"><i class="ti ti-zoom-out"></i></button><button class="btn btn-sm btn-secondary" onclick="if(cy)cy.fit(undefined,50)"><i class="ti ti-zoom-fit"></i> Fit</button></div></div><div style="position:relative"><div class="topology-container" id="cy-topo"></div><div id="topo-palette" class="map-node-palette"><div class="text-muted small mb-1">Click to add:</div><div id="palette-list"></div></div></div></div>');
    document.getElementById('topo-sel').onchange=function(e){if(e.target.value){selectedMapId=parseInt(e.target.value);document.getElementById('topo-tools').style.display='';loadMap(selectedMapId);}};
    if(maps.length){document.getElementById('topo-sel').value=maps[0].id;selectedMapId=maps[0].id;document.getElementById('topo-tools').style.display='';loadMap(maps[0].id);}
  });
}
function loadMap(mapId) {
  api('/maps/'+mapId).then(function(md){
    if(cy){cy.destroy();cy=null;}
    var els=[];
    md.nodes.forEach(function(n){els.push({data:{id:'n-'+n.id,mapNodeId:n.id,deviceId:n.device_id,name:n.custom_label||n.device_name||('Node '+n.id),ip:n.ip_address||'',lat:n.ip_address?'--':'',statusColor:sColor(n.device_status||'unknown'),deviceType:n.device_type||'generic'},position:{x:n.x_position,y:n.y_position},classes:n.device_type||'generic'});});
    md.links.forEach(function(l){els.push({data:{id:'l-'+l.id,source:'n-'+l.source_node_id,target:'n-'+l.target_node_id,label:l.label||''},classes:'device-link'});});
    cy=cytoscape({container:document.getElementById('cy-topo'),elements:els,layout:{name:'preset'},zoom:1,minZoom:0.1,maxZoom:4,boxSelectionEnabled:false,autoungrabify:false,autounselectify:false,userZoomingEnabled:true,userPanningEnabled:true,style:[
      {selector:'node',style:{'label':'data(label)','background-color':'#22262e','border-color':'data(statusColor)','border-width':3,'width':150,'height':70,'font-size':'12px','color':'#c2c7d0','text-valign':'center','text-halign':'center','text-wrap':'wrap','text-max-width':'140px','shape':'round-rectangle','text-outline-color':'#1a1d23','text-outline-width':2,'cursor':'grab'}},
      {selector:'node:grabbed',style:{'cursor':'grabbing','border-width':3,'border-color':'#357bfd'}},
      {selector:'node.router',style:{'background-color':'#16281b'}},
      {selector:'node.switch',style:{'background-color':'#141f33'}},
      {selector:'node.server',style:{'background-color':'#2a2110'}},
      {selector:'node.wireless_ap',style:{'background-color':'#271232','shape':'ellipse'}},
      {selector:'node.firewall',style:{'background-color':'#2c1416'}},
      {selector:'node.ont',style:{'background-color':'#102821'}},
      {selector:'node.generic',style:{'background-color':'#23262c'}},
      {selector:'node.up',style:{'border-color':'#2fb344','box-shadow':'0 0 12px #2fb34455'}},
      {selector:'node.down',style:{'border-color':'#e53e3e'}},
      {selector:'edge',style:{'width':2,'line-color':'#4a5060','target-arrow-color':'#4a5060','target-arrow-shape':'triangle','curve-style':'bezier','label':'data(label)','font-size':'10px','color':'#868a91','text-background-color':'#1a1d23','text-background-opacity':0.8}},
      {selector:'.down',style:{'line-color':'#e53e3e'}},
      {selector:'.up',style:{'line-color':'#2fb344'}},
      {selector:':selected',style:{'border-width':3,'border-color':'#357bfd'}}
    ]});
    cy.nodes().forEach(function(n){n.removeClass('down up');n.addClass(n.data('statusColor')==='#e53e3e'?'down':n.data('statusColor')==='#2fb344'?'up':'');});
    cy.nodes().forEach(renderNodeLabel);
    cy.fit(undefined, 60);
    cy.maxZoom(4); cy.minZoom(0.1);
    (function(){var cont=document.getElementById('cy-topo');if(cont)Array.prototype.slice.call(cont.childNodes).forEach(function(c){if(c.nodeName==='CANVAS')cont.removeChild(c);});if(cy.gridGuide)cy.gridGuide({drawGrid:true,panGrid:true,zoomDash:true,snapToGridOnRelease:false,snapToGridDuringDrag:false,snapToAlignmentLocationOnRelease:false,snapToAlignmentLocationDuringDrag:false,distributionGuidelines:false,geometricGuideline:false,initPosAlignment:false,centerToEdgeAlignment:false,resize:false,parentPadding:false,gridSpacing:40,gridColor:'rgba(148,163,184,0.45)',lineWidth:1,gridStackOrder:-1});})();
    cy.on('tap','node',function(e){if(_justDragged){_justDragged=false;return;}var did=e.target.data('deviceId');if(did)viewDevice(did);});
    var saveTimer=null;
    cy.on('drag','node',function(){_justDragged=true;});
    cy.on('dragfree','node',function(e){var n=e.target;var p=n.position();if(saveTimer)clearTimeout(saveTimer);saveTimer=setTimeout(function(){api('/maps/'+selectedMapId+'/nodes/'+n.data('mapNodeId'),{method:'PUT',body:{x_position:Math.round(p.x),y_position:Math.round(p.y)}}).catch(function(){});},400);});
  });
}
var _linkMode=false,_linkSrc=null,_justDragged=false;
function topoLinkMode(){_linkMode=!_linkMode;_linkSrc=null;toast(_linkMode?'Click source then target':'Link off','info');if(cy){cy.off('tap');cy.on('tap','node',function(e){if(_justDragged){_justDragged=false;return;}var did=e.target.data('deviceId');if(did)viewDevice(did);if(!_linkMode)return;var nid=e.target.id();if(!_linkSrc){_linkSrc=nid;toast('Source selected','info');}else if(nid!==_linkSrc){var sn=cy.getElementById(_linkSrc).data('mapNodeId');var tn=e.target.data('mapNodeId');api('/maps/'+selectedMapId+'/links',{method:'POST',body:{source_node_id:sn,target_node_id:tn}}).then(function(){toast('Link created','success');loadMap(selectedMapId);});_linkSrc=null;_linkMode=false;}});}}
function topoAddNode(){api('/devices').then(function(devs){var pl=document.getElementById('topo-palette');document.getElementById('palette-list').innerHTML=devs.map(function(d){return '<div class="palette-item" title="'+esc(d.name)+'" onclick="addNode('+selectedMapId+','+d.id+')"><div class="device-icon '+d.device_type+'" style="width:28px;height:28px;font-size:.7rem"><i class="'+iconCls(d.device_type)+'"></i></div></div>';}).join('');pl.classList.add('visible');});}
function addNode(mapId,devId){api('/maps/'+mapId+'/nodes',{method:'POST',body:{device_id:devId,x_position:100+Math.random()*400,y_position:100+Math.random()*300}}).then(function(){document.getElementById('topo-palette').classList.remove('visible');toast('Node added','success');loadMap(mapId);});}
document.getElementById('btn-save-map').onclick=function(){var t=document.getElementById('mf-title').value;if(!t)return;api('/maps',{method:'POST',body:{title:t}}).then(function(){bootstrap.Modal.getInstance(document.getElementById('modal-map')).hide();toast('Map created','success');loadTopology();});};
function renderNodeLabel(n){
  var lat=n.data('lat');
  var status=n.data('statusColor')==='#e53e3e'?'DOWN':(lat==='--'?'':'UP');
  var statusLine=status?('<span>'+status+'</span>'):'';
  n.data('label',n.data('name')+'\n'+n.data('ip')+'\n'+lat+'ms');
}
function liveTopo(r){if(!cy)return;r.forEach(function(x){cy.nodes().filter(function(n){return n.data('deviceId')===x.deviceId;}).forEach(function(n){var reach=(x.ping&&x.ping.reachable);n.data('statusColor',sColor(reach?'up':'down'));n.removeClass('down up').addClass(reach?'up':'down');n.data('lat',reach?Math.round(x.ping.latencyMs*10)/10:'DOWN');renderNodeLabel(n);});});}
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
    pHTML('<div class="d-flex justify-content-between mb-3"><h3>Alert Rules</h3><div class="d-flex gap-2"><button class="btn btn-secondary" onclick="loadAlerts()"><i class="ti ti-arrow-left"></i> Back</button><button class="btn btn-primary" onclick="new bootstrap.Modal(document.getElementById(\'modal-rule\')).show()"><i class="ti ti-plus"></i> Add</button></div></div><div class="card"><div class="table-responsive"><table class="table table-vcenter"><thead><tr><th>Name</th><th>Metric</th><th>Condition</th><th>Severity</th><th>Cooldown</th><th>Actions</th></tr></thead><tbody>'+rules.map(function(r){return '<tr><td class="fw-medium">'+esc(r.name)+'</td><td>'+r.metric_type+'</td><td><code>'+r.condition_op+' '+r.threshold+'</code></td><td><span class="badge bg-'+(r.severity==='critical'?'danger':'warning')+'">'+r.severity+'</span></td><td>'+r.cooldown_seconds+'s</td><td><button class="btn btn-ghost btn-sm text-danger" onclick="delRule('+r.id+')"><i class="ti ti-trash"></i></button></td></tr>';}).join('')+'</tbody></table></div></div><div class="modal fade" id="modal-rule" tabindex="-1"><div class="modal-dialog"><div class="modal-content"><div class="modal-header"><h5 class="modal-title">Alert Rule</h5><button class="btn-close" data-bs-dismiss="modal"></button></div><div class="modal-body"><div class="mb-3"><label class="form-label">Name</label><input type="text" class="form-control" id="rf-name"></div><div class="row"><div class="col-md-5 mb-3"><label class="form-label">Metric</label><select class="form-select" id="rf-met"><option value="ping">Ping Latency</option><option value="cpu">CPU</option><option value="memory">Memory</option><option value="packet_loss">Packet Loss</option><option value="status">Status</option></select></div><div class="col-md-3 mb-3"><label class="form-label">Op</label><select class="form-select" id="rf-op"><option value="gt">&gt;</option><option value="lt">&lt;</option><option value="ge">&ge;</option></select></div><div class="col-md-4 mb-3"><label class="form-label">Threshold</label><input type="number" class="form-control" id="rf-th" value="80"></div></div><div class="row"><div class="col-md-6 mb-3"><label class="form-label">Severity</label><select class="form-select" id="rf-sev"><option value="warning">Warning</option><option value="critical">Critical</option></select></div><div class="col-md-6 mb-3"><label class="form-label">Cooldown</label><input type="number" class="form-control" id="rf-cd" value="300"></div></div></div><div class="modal-footer"><button class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button class="btn btn-primary" onclick="saveRule()">Save</button></div></div></div></div>');
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
  pHTML('<div class="row"><div class="col-lg-6"><div class="card mb-3"><div class="card-header"><h3 class="card-title">General</h3></div><div class="card-body"><div class="mb-3"><label class="form-label">Polling Interval (ms)</label><input type="number" class="form-control" value="10000"></div><div class="mb-3"><label class="form-label">SNMP Timeout (ms)</label><input type="number" class="form-control" value="5000"></div><button class="btn btn-primary">Save</button></div></div></div><div class="col-lg-6"><div class="card mb-3"><div class="card-header"><h3 class="card-title">Notifications</h3></div><div class="card-body"><div class="mb-3"><label class="form-label">Webhook URL</label><input type="text" class="form-control" placeholder="https://hooks..."></div><div class="mb-3"><label class="form-label">Telegram Bot Token</label><input type="text" class="form-control" placeholder="Token"></div><div class="mb-3"><label class="form-label">Telegram Chat ID</label><input type="text" class="form-control" placeholder="Chat ID"></div><div class="mb-3"><label class="form-label">SMTP Host</label><input type="text" class="form-control" placeholder="smtp.example.com"></div><div class="mb-3"><label class="form-label">Alert Email To</label><input type="email" class="form-control" placeholder="admin@example.com"></div><button class="btn btn-primary">Save</button></div></div></div></div><div class="card"><div class="card-header"><h3 class="card-title">Data Retention</h3></div><div class="card-body"><div class="row"><div class="col-md-4 mb-3"><label class="form-label">Retain (days)</label><input type="number" class="form-control" value="365"></div><div class="col-md-4 mb-3"><label class="form-label">Aggregate after (days)</label><input type="number" class="form-control" value="30"></div></div><button class="btn btn-primary">Save</button></div></div>');
}

// ═══ BOOT ═══
if (AUTH_TOKEN) { try { startApp(); } catch(e){ showLogin(); } } else { showLogin(); }
